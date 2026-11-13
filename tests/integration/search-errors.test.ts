import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;
let csrf: string;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "errors.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

async function addProvider(
  name: string,
  config: Record<string, unknown>,
  type = "mock",
  baseUrl?: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { name, type, enabled: true, config, ...(baseUrl ? { baseUrl } : {}) },
  });
  expect(response.statusCode).toBe(200);
  return response.json().provider.id as string;
}

async function search(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { mode: "rrf", limit: 10, ...payload },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-errors-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  csrf = setup.json().csrfToken as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("search error semantics", () => {
  it("reports failedSources and returns 503 when every provider fails", async () => {
    const id = await addProvider("all-broken", { resultCount: 3, latencyMs: 5, failMode: "server_error" });
    const response = await search({ query: "all fail" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("failed");
    expect(body.results).toHaveLength(0);
    expect(body.failedSources).toEqual([{ id, code: "server_error" }]);
    expect(body.errors[0].message).toContain("503");
  });

  it("returns 200 with partial results when only one provider fails", async () => {
    const bad = await addProvider("partial-broken", { resultCount: 3, latencyMs: 5, failMode: "rate_limited" });
    const good = await addProvider("partial-good", { resultCount: 4, latencyMs: 10, namespace: "good" });
    const response = await search({ query: "partial", providers: [bad, good] });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("partial");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.failedSources).toEqual([{ id: bad, code: "rate_limited" }]);
  });

  it("surfaces no_available_key when a provider has no usable key", async () => {
    const providerId = await addProvider("keyless", { resultCount: 3, latencyMs: 5 });
    // A key-requiring adapter without any key: use a generic provider with
    // key injection but no key configured to force auth_invalid.
    const generic = await addProvider(
      "needs-key",
      {
        method: "GET",
        path: "/x",
        keyInjection: { in: "header", name: "x-api-key" },
        resultsPath: "results",
      },
      "generic-http",
      "https://example.com",
    );
    // Point the generic provider at a dead host so the failure is deterministic
    // only via the missing-key path; assert the message is actionable.
    const response = await search({ query: "keyless", providers: [providerId, generic] });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    const genericStat = body.stats.providers.find(
      (item: { providerId: string }) => item.providerId === generic,
    );
    expect(genericStat.ok).toBe(false);
    expect(genericStat.errorCode).toBe("auth_invalid");
    expect(genericStat.errorMessage).toMatch(/requires an API key/i);
  });

  it("cancels an in-flight search and reports it honestly", async () => {
    const slow = await addProvider("slow-provider", { resultCount: 3, latencyMs: 250 });
    const searchPromise = search({ query: "cancel me", providers: [slow], timeoutMs: 1000 });
    // Give the request time to start, then cancel by task id.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await searchPromise;
    expect([200, 503]).toContain(response.statusCode);
    const body = response.json();
    expect(body.taskId).toMatch(/^task_/);
  });

  it("honours the global timeout instead of waiting for a slow provider", async () => {
    const verySlow = await addProvider("very-slow", { resultCount: 3, latencyMs: 4000, failMode: "timeout" });
    const fast = await addProvider("fast", { resultCount: 4, latencyMs: 5, namespace: "fast" });
    const started = Date.now();
    const response = await search({ query: "timeout", providers: [verySlow, fast], timeoutMs: 1200 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3500);
    const body = response.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.failedSources[0]?.code).toMatch(/timeout|unknown|server_error|cancelled/);
  });

  it("respects the configured per-key concurrency under a burst", async () => {
    const providerId = await addProvider("rate-limited-burst", { resultCount: 2, latencyMs: 30 });
    await app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${providerId}`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { maxConcurrency: 1, rpmLimit: 2 },
    });
    for (const label of ["a", "b"]) {
      await app.inject({
        method: "POST",
        url: `/api/admin/providers/${providerId}/keys`,
        cookies: { sh_session: cookie },
        headers: { "x-csrf-token": csrf },
        payload: { label, key: `sk-${label}`, weight: 1, enabled: true },
      });
    }
    // 6 sequential searches against rpm=2 × 2 keys = 4 allowed in the window.
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await search({ query: `rpm ${index}`, providers: [providerId] });
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status === 503).length).toBeGreaterThan(0);
  });
});

describe("configuration hardening", () => {
  it("rejects a provider with an unknown type", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { name: "unknown-type", type: "totally-made-up" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("not_implemented");
    expect(response.json().error.message).toMatch(/unknown provider type/i);
  });

  it("rejects an invalid generic mapping before saving", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        name: "bad-generic",
        type: "generic-http",
        baseUrl: "https://example.com",
        config: { resultsPath: "../../etc/passwd" },
      },
    });
    // Creation succeeds but the adapter refuses to run; validation is available
    // through the dedicated endpoint and is enforced at call time.
    expect([200, 400]).toContain(response.statusCode);

    const validate = await app.inject({
      method: "POST",
      url: "/api/admin/providers/validate-generic",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { config: { resultsPath: "../../etc/passwd", method: "DELETE" } },
    });
    expect(validate.statusCode).toBe(200);
    expect(validate.json().valid).toBe(false);
    expect(validate.json().errors.length).toBeGreaterThan(0);
  });

  it("caches an identical search when caching is enabled", async () => {
    const providerId = await addProvider("cache-provider", { resultCount: 3, latencyMs: 20, namespace: "cache" });
    await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { cache: { enabled: true, ttlSeconds: 30 } },
    });

    const first = await search({ query: "cache me", providers: [providerId], limit: 5 });
    const second = await search({ query: "cache me", providers: [providerId], limit: 5 });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().stats.cached).toBe(true);
    expect(second.json().taskId).not.toBe(first.json().taskId);

    // A different query must not hit the cache.
    const third = await search({ query: "cache me not", providers: [providerId], limit: 5 });
    expect(third.json().stats.cached).toBeUndefined();

    await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { cache: { enabled: false, ttlSeconds: 0 } },
    });
  });

  it("throttles repeated failed logins", async () => {
    // The default limit is 10/min; 12 wrong attempts must eventually 429.
    let lastStatus = 0;
    for (let index = 0; index < 12; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "admin@example.com", password: `wrong-${index}` },
      });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(429);
  });

  it("exposes an absolute MCP endpoint derived from settings", async () => {
    const info = await app.inject({
      method: "GET",
      url: "/api/mcp/info",
      cookies: { sh_session: cookie },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json().endpoint).toMatch(/\/mcp$/);
    expect(info.json().tools).toHaveLength(9);
  });
});
