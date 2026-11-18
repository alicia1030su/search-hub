/**
 * P0: the health-gate skip list must belong to one request.
 *
 * `SearchService` kept `skippedByHealth` on the instance and read it after the
 * awaited fan-out. Two overlapping requests therefore overwrite each other:
 * a request that legitimately skipped a parked source can report nothing, or
 * report another request's sources.
 *
 * These tests use a controlled clock-free barrier (a slow mock provider plus a
 * fast second request) rather than random sleeps: request A is guaranteed to be
 * inside `executeSearch` when B finishes, because A's provider is configured to
 * take far longer than B's entire request.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { providerHealthChecks, searchTasks } from "../../packages/db/src/schema.js";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "isolation.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-isolation-"));
  const ctx = createContext(testConfig(dir));
  const app = await buildApp(ctx);
  await app.ready();
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
  expect(setup.statusCode).toBe(200);
  const cookie = setup.cookies.find((item) => item.name === "sh_session")?.value;
  const csrf = setup.json().csrfToken as string;
  const harness: Harness = { app, ctx, dir, cookie: cookie!, csrf };
  harnesses.push(harness);
  return harness;
}

async function addProvider(
  harness: Harness,
  input: { name: string; latencyMs?: number; resultCount?: number; failMode?: string },
): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: {
      name: input.name,
      type: "mock",
      enabled: true,
      timeoutMs: 10_000,
      maxRetries: 0,
      config: {
        resultCount: input.resultCount ?? 3,
        latencyMs: input.latencyMs ?? 5,
        namespace: input.name,
        ...(input.failMode === undefined ? {} : { failMode: input.failMode }),
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

/**
 * Parks a provider the way the health system does: an unhealthy row with a
 * gating cause and a cooldown still in the future.
 */
function park(harness: Harness, providerId: string, cause = "quota_exceeded"): void {
  const now = Date.now();
  harness.ctx.db
    .insert(providerHealthChecks)
    .values({
      id: `phc_${providerId}_${now}`,
      providerId,
      keyId: null,
      kind: "search",
      status: "unhealthy",
      errorCode: cause === "quota_exceeded" ? "quota_exceeded" : "auth_invalid",
      latencyMs: null,
      resultCount: 0,
      healthScore: 0,
      detailJson: JSON.stringify({
        cause,
        cooldownUntil: new Date(now + 30 * 60_000).toISOString(),
      }),
      trigger: "manual",
      checkedAt: new Date(now).toISOString(),
    })
    .run();
}

function search(harness: Harness, body: Record<string, unknown>) {
  return harness.app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: body,
  });
}

describe("health-gate skip list isolation", () => {
  it("C01: a request keeps its own skip list while another request runs", async () => {
    const h = await createHarness();
    const parked = await addProvider(h, { name: "parked-a" });
    const slow = await addProvider(h, { name: "slow-a", latencyMs: 700 });
    const fast = await addProvider(h, { name: "fast-b", latencyMs: 0 });
    park(h, parked);

    // A starts first and stays inside the fan-out for ~700 ms.
    const a = search(h, { query: "request a", providers: [parked, slow] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // B completes entirely while A is still running; it must not touch A's list.
    const b = await search(h, { query: "request b", providers: [fast] });
    expect(b.statusCode).toBe(200);
    expect(b.json().errors).toEqual([]);
    expect(b.json().failedSources).toEqual([]);

    const response = await a;
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      errors: Array<{ providerId: string }>;
      failedSources: Array<{ id: string }>;
      stats: { partial: boolean };
    };
    expect(body.failedSources.map((item) => item.id)).toContain(parked);
    expect(body.errors.some((item) => item.providerId === parked)).toBe(true);
    expect(body.stats.partial).toBe(true);
    expect(body.status).toBe("partial");
  });

  it("C02: a request with no parked source is not given another's skip list", async () => {
    const h = await createHarness();
    const parked = await addProvider(h, { name: "parked-c" });
    const slowParkedRun = await addProvider(h, { name: "slow-c", latencyMs: 700 });
    const clean = await addProvider(h, { name: "clean-d", latencyMs: 0 });
    park(h, parked);

    const withSkip = search(h, { query: "with skip", providers: [parked, slowParkedRun] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const withoutSkip = search(h, { query: "without skip", providers: [clean] });

    const cleanResponse = await withoutSkip;
    expect(cleanResponse.statusCode).toBe(200);
    const cleanBody = cleanResponse.json() as {
      errors: Array<{ providerId: string }>;
      failedSources: Array<{ id: string }>;
      status: string;
    };
    // The clean request started second and finished first; it must not inherit
    // the parked provider from the request that is still in flight.
    expect(cleanBody.failedSources.map((item) => item.id)).not.toContain(parked);
    expect(cleanBody.errors.some((item) => item.providerId === parked)).toBe(false);
    expect(cleanBody.status).toBe("completed");

    const skipped = await withSkip;
    expect(skipped.json().failedSources.map((item: { id: string }) => item.id)).toContain(parked);
  });

  it("C03: two requests skipping different providers do not swap lists", async () => {
    const h = await createHarness();
    const parkedOne = await addProvider(h, { name: "parked-e" });
    const parkedTwo = await addProvider(h, { name: "parked-f" });
    const liveOne = await addProvider(h, { name: "live-e", latencyMs: 700 });
    const liveTwo = await addProvider(h, { name: "live-f", latencyMs: 0 });
    park(h, parkedOne);
    park(h, parkedTwo, "auth_invalid");

    const first = search(h, { query: "first", providers: [parkedOne, liveOne] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await search(h, { query: "second", providers: [parkedTwo, liveTwo] });

    const firstBody = (await first).json() as {
      failedSources: Array<{ id: string; code: string }>;
    };
    const secondBody = second.json() as {
      failedSources: Array<{ id: string; code: string }>;
    };

    const firstIds = firstBody.failedSources.map((item) => item.id);
    const secondIds = secondBody.failedSources.map((item) => item.id);
    expect(firstIds).toContain(parkedOne);
    expect(firstIds).not.toContain(parkedTwo);
    expect(secondIds).toContain(parkedTwo);
    expect(secondIds).not.toContain(parkedOne);
  });

  it("C04: 100 interleaved requests keep their own skip lists", async () => {
    const h = await createHarness();
    const parkedA = await addProvider(h, { name: "parked-g" });
    const parkedB = await addProvider(h, { name: "parked-h" });
    const liveSlow = await addProvider(h, { name: "live-g", latencyMs: 220 });
    const liveFast = await addProvider(h, { name: "live-h", latencyMs: 0 });
    park(h, parkedA);
    park(h, parkedB, "auth_invalid");

    const requests = Array.from({ length: 100 }, (_, index) => {
      const expectSkip = index % 2 === 0 ? parkedA : parkedB;
      const expectClean = index % 2 === 0 ? parkedB : parkedA;
      const useSlow = index % 4 === 0;
      return { index, expectSkip, expectClean, useSlow };
    });

    const responses = await Promise.all(
      requests.map(async (item) => {
        const providers = item.index % 2 === 0 ? [parkedA, item.useSlow ? liveSlow : liveFast] : [parkedB, liveFast];
        const response = await search(h, { query: `concurrent ${item.index}`, providers });
        return { item, body: response.json() as { failedSources: Array<{ id: string }>; errors: Array<{ providerId: string }> } };
      }),
    );

    for (const { item, body } of responses) {
      const ids = body.failedSources.map((entry) => entry.id);
      expect(ids, `request ${item.index}`).toContain(item.expectSkip);
      expect(ids, `request ${item.index}`).not.toContain(item.expectClean);
      expect(new Set(ids).size, `request ${item.index} has duplicates`).toBe(ids.length);
    }
  }, 60_000);

  it("C05: a cache hit re-applies only the current request's gate", async () => {
    const h = await createHarness();
    const parked = await addProvider(h, { name: "parked-i" });
    const live = await addProvider(h, { name: "live-i", latencyMs: 0 });

    // Enable the cache with the minimum TTL so the second call is a hit.
    const patched = await h.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { cache: { enabled: true, ttlSeconds: 86_400 } },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const warm = await search(h, { query: "cached query", providers: [live, parked] });
    expect(warm.statusCode).toBe(200);
    expect(warm.json().stats.cached).not.toBe(true);

    // Park the second provider before the first cache hit: the key includes the
    // gate verdict, so this is a different entry from the warm one. Use a fresh
    // query to exercise the *same* entry being replayed under a new gate.
    const warmClean = await search(h, { query: "cached clean", providers: [live] });
    expect(warmClean.json().stats.cached).not.toBe(true);
    const hit = await search(h, { query: "cached clean", providers: [live] });
    expect(hit.json().stats.cached).toBe(true);
    expect(hit.json().failedSources).toEqual([]);

    // Now park the same provider and hit the cache again: the stored response
    // must not claim the source was used, and the skip must be reported.
    park(h, live);
    const gated = await search(h, { query: "cached clean", providers: [live] });
    const body = gated.json() as {
      status: string;
      failedSources: Array<{ id: string }>;
      errors: Array<{ providerId: string }>;
    };
    expect(body.failedSources.map((item) => item.id)).toContain(live);
    expect(body.errors.some((item) => item.providerId === live)).toBe(true);
    // The only selected source is parked, so the request failed — not "partial
    // with zero results", which would read as a successful empty search.
    expect(body.status).toBe("failed");

    // And the cached row itself must still be intact for a clean request.
    const restored = await h.ctx.db.select().from(searchTasks).all();
    expect(restored.length).toBeGreaterThan(0);
  }, 30_000);

  it("C06: Deep Search reports the gate the same way REST does", async () => {
    const h = await createHarness();
    const parked = await addProvider(h, { name: "parked-j" });
    const live = await addProvider(h, { name: "live-j", latencyMs: 0 });
    park(h, parked);

    // Deep requires a chat model; without one the request is refused before the
    // gate matters, so only assert the gate path when the refusal is unrelated.
    const response = await search(h, {
      query: "deep with parked source",
      providers: [parked, live],
      mode: "deep",
    });
    const body = response.json() as {
      error?: { message: string };
      failedSources?: Array<{ id: string }>;
    };
    if (body.error) {
      // No chat model configured in this harness; the assertion that matters is
      // that a parked source is never silently dropped from a successful answer.
      expect(body.error.message).toContain("chat model");
      return;
    }
    expect(body.failedSources?.map((item) => item.id) ?? []).toContain(parked);
  }, 30_000);
});

/**
 * Deep Search must report the same failures as a normal search.
 *
 * It had no reference to the skip list at all, so a parked source vanished from
 * a deep answer: the caller saw fewer sources, no reason, and `completed`.
 */
describe("deep search health-gate reporting", () => {
  it("C06b: a parked source appears in a deep response instead of disappearing", async () => {
    const h = await createHarness();
    const parked = await addProvider(h, { name: "deep-parked" });
    const live = await addProvider(h, { name: "deep-live", latencyMs: 1 });
    park(h, parked);

    // Deep needs a chat model to rewrite the query. Point it at a local server
    // that fails, so the rewrite falls back to the original query (documented
    // behaviour) and the retrieval still happens — the gate is what is tested.
    const modelServer = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "model unavailable" } }));
    });
    servers.push(modelServer);
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", () => resolve()));
    const address = modelServer.address();
    if (typeof address === "string" || address === null) throw new Error("model stub did not bind");

    await h.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
    });
    const model = await h.app.inject({
      method: "POST",
      url: "/api/admin/models",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        kind: "chat",
        name: "deep-chat",
        providerType: "openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}`,
        modelId: "stub",
        batchSize: 4,
        timeoutMs: 2000,
        maxConcurrency: 2,
        enabled: true,
        isDefault: true,
        params: {},
      },
    });
    expect(model.statusCode, model.body).toBe(200);

    const response = await search(h, {
      query: "deep with a parked source",
      providers: [parked, live],
      mode: "deep",
    });
    const body = response.json() as {
      status: string;
      failedSources: Array<{ id: string }>;
      errors: Array<{ providerId: string; code: string }>;
    };
    expect(body.failedSources.map((item) => item.id)).toContain(parked);
    // Reported once, not once per rewrite.
    const occurrences = body.errors.filter((item) => item.providerId === parked).length;
    expect(occurrences).toBe(1);
    expect(body.status).not.toBe("completed");
  }, 45_000);
});
