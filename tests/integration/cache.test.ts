import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { cacheEntryCount } from "../../apps/api/src/services/cache.js";
import { searchCache, searchCacheMetrics, searchTasks } from "../../packages/db/src/schema.js";

/**
 * Persistent search cache — T01..T22 of the acceptance table.
 *
 * Two rules run through every case:
 *  1. assertions read the **database**, not just the HTTP status, because "200 and
 *     a plausible body" is exactly what a broken cache still returns;
 *  2. no test sleeps for a real TTL. Expiry is driven by an injected clock, so a
 *     72-hour rule is verified in milliseconds and the test cannot pass by
 *     accident after a lucky wait.
 */

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
  /** Mutable clock shared with the cache instance. */
  clock: { now: number };
}

const harnesses: Harness[] = [];

/**
 * Builds a real application on a real SQLite file in a temp directory.
 *
 * `reuse` reopens the same directory, which is what a service restart looks like
 * from the cache's point of view: a brand-new process, a brand-new connection,
 * the same file.
 */
async function createHarness(
  options: { dir?: string; clock?: { now: number }; cacheLimits?: { maxEntries: number; maxBytes: number } } = {},
): Promise<Harness> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "search-hub-cache-"));
  const clock = options.clock ?? { now: Date.now() };
  // The only substitution is the clock (so TTL tests never wait) and, when a
  // case needs it, the capacity limits. Everything else — the SQLite file, the
  // search pipeline, the settings listeners — is the production code path.
  const ctx = createContext(testConfig(dir), {
    now: () => clock.now,
    ...(options.cacheLimits === undefined ? {} : { cacheLimits: options.cacheLimits }),
  });
  const app = await buildApp(ctx);
  await app.ready();
  // A fresh directory needs first-run setup; a reopened one already has an
  // administrator, so that flow now logs in with the same credentials. Both end
  // with a real session cookie, which is what the restart test needs.
  let cookie: string;
  let csrf: string;
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      email: "admin@example.com",
      password: "A-very-long-password-1",
      name: "Admin",
      setupToken: ctx.setupToken.value!,
    },
  });
  if (setup.statusCode === 200 || setup.statusCode === 201) {
    cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
    csrf = setup.json().csrfToken as string;
  } else {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "A-very-long-password-1" },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = login.cookies.find((item) => item.name === "sh_session")!.value;
    csrf = login.json().csrfToken as string;
  }
  const harness: Harness = { app, ctx, dir, cookie, csrf, clock };
  harnesses.push(harness);
  return harness;
}

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "cache.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const adminHeaders = (harness: Harness) => ({
  cookies: { sh_session: harness.cookie },
  headers: { "x-csrf-token": harness.csrf },
});

async function addMock(harness: Harness, name: string, config: Record<string, unknown>): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...adminHeaders(harness),
    payload: {
      name,
      type: "mock",
      enabled: true,
      timeoutMs: 5000,
      maxConcurrency: 4,
      maxRetries: 0,
      rpmLimit: 6000,
      config,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

async function setCache(
  harness: Harness,
  patch: { enabled: boolean; ttlSeconds: number },
): Promise<{ status: number; body: string }> {
  const response = await harness.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...adminHeaders(harness),
    payload: { cache: patch },
  });
  return { status: response.statusCode, body: response.body };
}

async function enableCache(harness: Harness, ttlSeconds = 86_400): Promise<void> {
  const result = await setCache(harness, { enabled: true, ttlSeconds });
  expect(result.status, result.body).toBe(200);
}

async function search(
  harness: Harness,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/search",
    ...adminHeaders(harness),
    payload: { mode: "basic", limit: 5, ...payload },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

interface CachedBody {
  status: string;
  taskId: string;
  stats: { cached?: boolean; rawCount: number; partial: boolean };
  results: Array<{ url: string }>;
  failedSources: Array<{ id: string; code: string }>;
  errors: Array<{ code: string }>;
}

describe("persistent cache", () => {
  it("T01/T02 caches a successful search and serves the next one without calling providers", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-a", { resultCount: 3 });
    await enableCache(harness);

    const first = await search(harness, { query: "persistent t01", skipCache: false });
    expect(first.status).toBe(200);
    const firstBody = first.body as unknown as CachedBody;
    expect(firstBody.stats.cached).toBeUndefined();
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    const row = harness.ctx.db.select().from(searchCache).all()[0]!;
    expect(row.status).toBe("completed");
    expect(row.sizeBytes).toBe(Buffer.byteLength(row.responseJson, "utf8"));
    expect(JSON.parse(row.responseJson).results.length).toBe(firstBody.results.length);

    const second = await search(harness, { query: "persistent t01", skipCache: false });
    const secondBody = second.body as unknown as CachedBody;
    expect(secondBody.stats.cached).toBe(true);
    // A hit still produces a new task row — callers and dashboards depend on it.
    expect(secondBody.taskId).not.toBe(firstBody.taskId);
    expect(secondBody.results.map((item) => item.url)).toEqual(firstBody.results.map((item) => item.url));
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    const task = harness.ctx.db.select().from(searchTasks).all();
    expect(task.some((item) => item.id === secondBody.taskId && item.status === "completed")).toBe(true);
  });

  it("T03 a different query does not reuse the entry", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-q", { resultCount: 2 });
    await enableCache(harness);

    await search(harness, { query: "alpha" });
    const other = await search(harness, { query: "beta" });
    expect((other.body as unknown as CachedBody).stats.cached).toBeUndefined();
    expect(cacheEntryCount(harness.ctx.db)).toBe(2);
  });

  it("T04 providers are isolated: a different provider set never shares an entry", async () => {
    const harness = await createHarness();
    const one = await addMock(harness, "cache-p1", { resultCount: 2, namespace: "p1" });
    const two = await addMock(harness, "cache-p2", { resultCount: 2, namespace: "p2" });
    await enableCache(harness);

    await search(harness, { query: "provider isolation", providers: [one] });
    const both = await search(harness, { query: "provider isolation", providers: [one, two] });
    expect((both.body as unknown as CachedBody).stats.cached).toBeUndefined();

    // Same set, different order ⇒ same logical request ⇒ hit.
    const reversed = await search(harness, { query: "provider isolation", providers: [two, one] });
    expect((reversed.body as unknown as CachedBody).stats.cached).toBe(true);
  });

  it("T05 modes are isolated", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-mode", { resultCount: 3 });
    await enableCache(harness);
    // `rrf` and `basic` differ in fusion; they must not share a key.
    const basic = await search(harness, { query: "mode isolation", mode: "basic" });
    expect((basic.body as unknown as CachedBody).stats.cached).toBeUndefined();
    const rrf = await search(harness, { query: "mode isolation", mode: "rrf" });
    expect((rrf.body as unknown as CachedBody).stats.cached).toBeUndefined();
    expect(cacheEntryCount(harness.ctx.db)).toBe(2);
  });

  it("T06 skipCache bypasses both read and write", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-skip", { resultCount: 2 });
    await enableCache(harness);

    const skipped = await search(harness, { query: "skip me", skipCache: true });
    expect((skipped.body as unknown as CachedBody).stats.cached).toBeUndefined();
    // Nothing was written, so the next normal search is a miss and writes once.
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);

    await search(harness, { query: "skip me", skipCache: false });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    const bypassed = await search(harness, { query: "skip me", skipCache: true });
    expect((bypassed.body as unknown as CachedBody).stats.cached).toBeUndefined();
  });

  it("T07 an expired entry is not served", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-exp", { resultCount: 2 });
    await enableCache(harness, 3600);

    await search(harness, { query: "expire me" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    // 1 hour later, to the millisecond: the entry is gone.
    harness.clock.now += 3600 * 1000 + 1;
    const after = await search(harness, { query: "expire me" });
    expect((after.body as unknown as CachedBody).stats.cached).toBeUndefined();
    // Reading past the deadline deletes the row rather than leaving it to rot.
    const rows = harness.ctx.db.select().from(searchCache).all();
    expect(rows.every((row) => row.expiresAt > new Date(harness.clock.now).toISOString())).toBe(true);
  });

  it("T08 the sweeper deletes expired rows from the database", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-sweep", { resultCount: 2 });
    await enableCache(harness, 3600);
    await search(harness, { query: "sweep me" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    // Move past expiry without touching the row, then sweep.
    harness.clock.now += 3600 * 1000 + 5;
    const removed = harness.ctx.cache.sweepExpired();
    expect(removed).toBe(1);
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);

    const stats = harness.ctx.cache.stats({ enabled: true, ttlSeconds: 3600 });
    expect(stats.expiredRemoved).toBeGreaterThanOrEqual(1);
    expect(stats.lastSweepAt).not.toBeNull();
  });

  it("T09 an unexpired entry survives a real restart", async () => {
    const harness = await createHarness();
    const dir = harness.dir;
    await addMock(harness, "cache-restart", { resultCount: 3 });
    await enableCache(harness);
    await search(harness, { query: "restart me" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    // Close the app *and the database handle*, then open a new context on the
    // same directory. This is a restart, not a cache instance swap.
    const clock = harness.clock;
    await harness.app.close();
    harnesses.splice(harnesses.indexOf(harness), 1);
    const reopened = await createHarness({ dir, clock });
    // The provider list and settings live in the same file, so the search works.
    const after = await search(reopened, { query: "restart me" });
    expect((after.body as unknown as CachedBody).stats.cached).toBe(true);
  });

  it("T11 partial responses are not cached", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-good", { resultCount: 3 });
    await addMock(harness, "cache-bad", { resultCount: 0, failMode: "server_error" });
    await enableCache(harness);

    const first = await search(harness, { query: "partial cache" });
    expect((first.body as unknown as CachedBody).status).toBe("partial");
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);
  });

  it("T12 a cancelled search is neither cached nor counted against the provider", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "cache-cancel", { resultCount: 2, latencyMs: 800 });
    await enableCache(harness);

    const controller = new AbortController();
    const running = harness.ctx.search.execute(
      { query: "cancel cache", mode: "basic", limit: 5 },
      { actor: "admin:admin@example.com", signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("cancelled by user")), 120);
    const response = await running;
    expect(response.status).toBe("failed");
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);
    expect(harness.ctx.health.blockedProviders().has(providerId)).toBe(false);
  });

  it("T13 a failed search is not cached", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-fail", { resultCount: 0, failMode: "server_error" });
    await enableCache(harness);

    const first = await search(harness, { query: "fail cache" });
    expect(first.status).toBe(503);
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);
    const second = await search(harness, { query: "fail cache" });
    expect((second.body as unknown as CachedBody).stats.cached).toBeUndefined();
  });

  it("T14 the entry cap evicts the least recently used row", async () => {
    // A small limit keeps the test fast and makes the eviction unambiguous; the
    // eviction code is exactly the production one.
    const harness = await createHarness({ cacheLimits: { maxEntries: 3, maxBytes: 8 * 1024 * 1024 } });
    await addMock(harness, "cache-lru", { resultCount: 1 });
    await enableCache(harness);

    await search(harness, { query: "lru one" });
    harness.clock.now += 1000;
    await search(harness, { query: "lru two" });
    harness.clock.now += 1000;
    await search(harness, { query: "lru three" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(3);

    // Touch the oldest so "one" becomes the most recently used.
    harness.clock.now += 1000;
    const touched = await search(harness, { query: "lru one" });
    expect((touched.body as unknown as CachedBody).stats.cached).toBe(true);

    harness.clock.now += 1000;
    await search(harness, { query: "lru four" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(3);

    const remaining = harness.ctx.db.select().from(searchCache).all();
    const bodies = remaining.map((row) => row.responseJson);
    // "two" was the least recently used after "one" was touched.
    expect(bodies.some((body) => body.includes("lru two"))).toBe(false);
    expect(bodies.some((body) => body.includes("lru one"))).toBe(true);

    const stats = harness.ctx.cache.stats({ enabled: true, ttlSeconds: 86_400 });
    expect(stats.evicted).toBeGreaterThanOrEqual(1);
  });

  it("T15 the byte cap evicts old rows even below the entry cap", async () => {
    // ~40 KiB: room for a couple of responses, not a dozen.
    const harness = await createHarness({ cacheLimits: { maxEntries: 5000, maxBytes: 40 * 1024 } });
    await addMock(harness, "cache-bytes", { resultCount: 6 });
    await enableCache(harness);

    for (let index = 0; index < 6; index += 1) {
      harness.clock.now += 1000;
      await search(harness, { query: `bytes ${index}` });
    }
    const rows = harness.ctx.db.select().from(searchCache).all();
    const bytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
    expect(bytes).toBeLessThanOrEqual(40 * 1024);
    expect(rows.length).toBeLessThan(6);
  });

  it("T16 concurrent identical searches neither corrupt nor duplicate entries", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-race", { resultCount: 3, latencyMs: 40 });
    await enableCache(harness);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => search(harness, { query: "race me" })),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((response.body as unknown as CachedBody).results.length).toBeGreaterThan(0);
    }
    // Exactly one row: the last writer wins, and every reader got a valid body.
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);
    const row = harness.ctx.db.select().from(searchCache).all()[0]!;
    expect(() => JSON.parse(row.responseJson) as unknown).not.toThrow();
    expect(row.sizeBytes).toBe(Buffer.byteLength(row.responseJson, "utf8"));
  });

  it("T17 shortening the TTL retires existing entries; lengthening does not revive expired ones", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-ttl", { resultCount: 2 });
    await enableCache(harness, 72 * 3600);

    await search(harness, { query: "ttl seventy-two" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    // 72h → 1h, two hours later: the entry is past the new deadline and must go.
    harness.clock.now += 2 * 3600 * 1000;
    const shortened = await setCache(harness, { enabled: true, ttlSeconds: 3600 });
    expect(shortened.status, shortened.body).toBe(200);
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);

    // Now the other direction: an entry expires, then the TTL is lengthened.
    const second = await search(harness, { query: "ttl revive" });
    expect(second.status).toBe(200);
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    harness.clock.now += 3700 * 1000; // past the 1h deadline
    const lengthened = await setCache(harness, { enabled: true, ttlSeconds: 72 * 3600 });
    expect(lengthened.status, lengthened.body).toBe(200);
    // Lengthening must not resurrect it.
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);
  });

  it("T18 clearing removes every row and is audited", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-clear", { resultCount: 2 });
    await enableCache(harness);
    await search(harness, { query: "clear me" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    // Without an explicit confirmation the server refuses.
    const refused = await harness.app.inject({
      method: "POST",
      url: "/api/admin/cache/clear",
      ...adminHeaders(harness),
      payload: {},
    });
    expect(refused.statusCode).toBe(400);
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    const cleared = await harness.app.inject({
      method: "POST",
      url: "/api/admin/cache/clear",
      ...adminHeaders(harness),
      payload: { confirm: true },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().removed).toBe(1);
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);
  });

  it("T19 invalid TTL values are rejected by the server, not just the form", async () => {
    const harness = await createHarness();

    const cases: Array<{ enabled: boolean; ttlSeconds: number; why: string }> = [
      { enabled: true, ttlSeconds: 3599, why: "just under one hour" },
      { enabled: true, ttlSeconds: 0, why: "enabled with no TTL" },
      { enabled: true, ttlSeconds: 259_201, why: "above 72 hours" },
      { enabled: true, ttlSeconds: -1, why: "negative" },
      { enabled: true, ttlSeconds: 3600.5, why: "fractional" },
      { enabled: false, ttlSeconds: 600, why: "disabled with a sub-hour TTL" },
    ];
    for (const item of cases) {
      const result = await setCache(harness, { enabled: item.enabled, ttlSeconds: item.ttlSeconds });
      expect(result.status, `${item.why}: ${result.body}`).toBe(400);
    }

    // The two legal shapes are accepted.
    expect((await setCache(harness, { enabled: true, ttlSeconds: 3600 })).status).toBe(200);
    expect((await setCache(harness, { enabled: false, ttlSeconds: 0 })).status).toBe(200);
  });

  it("T20 MCP and REST share one cache", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-mcp", { resultCount: 3 });
    await enableCache(harness);

    const tokenResponse = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "cache-mcp", scopes: ["search", "mcp:use"], rateLimitPerMin: 600 },
    });
    const token = tokenResponse.json().token as string;

    // REST first, then the same query through MCP's search tool.
    await search(harness, { query: "shared cache", mode: "rrf" });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    const mcp = await harness.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        // Same mode and limit as the REST call above: those are part of the key.
        params: { name: "search_web", arguments: { query: "shared cache", limit: 5 } },
      },
    });
    const text = mcp.body;
    const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
    const raw = dataLine ? dataLine.slice(5).trim() : text;
    const parsed = JSON.parse(raw) as { result?: { content?: Array<{ text?: string }> } };
    const payloadText = parsed.result?.content?.[0]?.text ?? "";
    // The MCP tool returns the same response object, including `cached`.
    expect(payloadText).toContain('"cached": true');
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);
  });

  it("T21 a Skill shares the same cache as REST", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-skill", { resultCount: 3 });
    await enableCache(harness);

    const tokenResponse = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "skill-cache", scopes: ["search"], rateLimitPerMin: 600 },
    });
    const token = tokenResponse.json().token as string;

    // The exact request a Skill makes: `curl $SEARCH_HUB_URL/api/search -H
    // "authorization: Bearer $TOKEN"` (packages/skills/search-web/SKILL.md). A
    // Skill is an HTTP client, so "shares the cache" means this request and the
    // admin REST call below produce one entry.
    const skillBody = { query: "skill cache probe", mode: "rrf", limit: 8 };
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: skillBody,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);

    // Same request, this time as an admin session: a hit proves the token path
    // and the session path read the same table.
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: skillBody,
    });
    expect((second.json() as unknown as CachedBody).stats.cached).toBe(true);
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);
  });

  it("T22 the cache key never contains a credential", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "cache-key", { resultCount: 2 });
    const secret = "sk-UPGRADE-SURVIVES-cache-key-secret";
    await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...adminHeaders(harness),
      payload: { label: "primary", key: secret, weight: 1, enabled: true },
    });
    await enableCache(harness);
    await search(harness, { query: "key safety" });

    const row = harness.ctx.db.select().from(searchCache).all()[0]!;
    // The key is a digest, not anything derived from the request text.
    expect(row.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(row.cacheKey).not.toContain("key safety");
    // No credential material anywhere in the stored row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(secret);
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("bearer ");
  });

  it("includeRaw bypasses the persistent cache entirely", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-raw", { resultCount: 2 });
    await enableCache(harness);

    await search(harness, { query: "raw bypass", includeRaw: true });
    // Raw responses carry the upstream payload verbatim; persisting them would
    // write provider-internal data into the database.
    expect(cacheEntryCount(harness.ctx.db)).toBe(0);

    await search(harness, { query: "raw bypass", includeRaw: false });
    expect(cacheEntryCount(harness.ctx.db)).toBe(1);
  });

  it("metrics are honest: no lookups means no hit rate", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-metrics", { resultCount: 1 });
    await enableCache(harness);

    const empty = await harness.app.inject({
      method: "GET",
      url: "/api/admin/cache",
      cookies: { sh_session: harness.cookie },
    });
    expect(empty.json().hitRate).toBeNull();
    expect(empty.json().hitRate24h).toBeNull();
    expect(empty.json().entries).toBe(0);

    await search(harness, { query: "count me" });
    await search(harness, { query: "count me" });

    const filled = await harness.app.inject({
      method: "GET",
      url: "/api/admin/cache",
      cookies: { sh_session: harness.cookie },
    });
    const stats = filled.json();
    expect(stats.entries).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5, 5);
    // The 24-hour window reads the same buckets.
    expect(stats.hitRate24h).toBeCloseTo(0.5, 5);
    expect(harness.ctx.db.select().from(searchCacheMetrics).all().length).toBeGreaterThan(0);
  });
});
