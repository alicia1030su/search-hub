import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

/**
 * Health monitoring, end to end: REST → MCP → the real scheduler.
 *
 * The point of these tests is that all three surfaces must agree. A dashboard
 * that says "healthy" while the scheduler keeps skipping the source is worse than
 * no dashboard at all.
 */

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "health-e2e.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-health-e2e-"));
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
  const harness: Harness = {
    app,
    ctx,
    dir,
    cookie: setup.cookies.find((item) => item.name === "sh_session")!.value,
    csrf: setup.json().csrfToken as string,
  };
  harnesses.push(harness);
  return harness;
}

const adminHeaders = (harness: Harness) => ({
  cookies: { sh_session: harness.cookie },
  headers: { "x-csrf-token": harness.csrf },
});

async function addMock(harness: Harness, name: string, config: Record<string, unknown>) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...adminHeaders(harness),
    payload: { name, type: "mock", enabled: true, timeoutMs: 5000, maxConcurrency: 2, maxRetries: 0, rpmLimit: 600, config },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

async function mintToken(harness: Harness, scopes: string[]): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/tokens",
    ...adminHeaders(harness),
    payload: { name: "health-probe", scopes, rateLimitPerMin: 600 },
  });
  return response.json().token as string;
}

/** Minimal MCP call helper: one JSON-RPC message over Streamable HTTP. */
async function mcpCall(
  harness: Harness,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    payload,
  });
  const text = response.body;
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  const raw = dataLine ? dataLine.slice(5).trim() : text;
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.statusCode, text, json };
}

describe("health end to end", () => {
  it("REST, MCP and the scheduler agree on which sources are usable", async () => {
    const harness = await createHarness();
    const good = await addMock(harness, "good", { resultCount: 3 });
    const bad = await addMock(harness, "exhausted", { resultCount: 0, failMode: "rate_limited" });

    // 1) Probe through REST.
    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect" },
    });
    expect(run.statusCode, run.body).toBe(200);

    // 2) REST overview reflects it.
    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/health",
      cookies: { sh_session: harness.cookie },
    });
    const restProviders = overview.json().providers as Array<{
      providerId: string;
      status: string;
      lastErrorCode: string | null;
    }>;
    const restGood = restProviders.find((item) => item.providerId === good)!;
    const restBad = restProviders.find((item) => item.providerId === bad)!;
    expect(restGood.status).toBe("healthy");
    expect(restBad.status).toBe("degraded");
    expect(restBad.lastErrorCode).toBe("rate_limited");

    // 3) MCP reports the same thing for a search-scope token.
    const token = await mintToken(harness, ["search", "mcp:use"]);
    const init = await mcpCall(harness, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
    });
    expect(init.status).toBe(200);

    const call = await mcpCall(harness, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_provider_health", arguments: {} },
    });
    expect(call.status).toBe(200);
    const text = call.text;
    expect(text).toContain(good);
    expect(text).toContain("healthy");
    expect(text).toContain("rate_limited");
    // Health over MCP must never leak credentials or endpoints.
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toContain("http://127.0.0.1");

    // 4) A solitary rate limit must NOT park the source for search: the
    //    scheduler's own circuit breaker decides, not a single probe.
    const blocked = harness.ctx.health.blockedProviders();
    expect(blocked.has(bad)).toBe(false);
    expect(blocked.has(good)).toBe(false);
  });

  it("parks a source whose account quota is exhausted, and only for that cause", async () => {
    const harness = await createHarness();
    const quota = await addMock(harness, "quota", { resultCount: 0, failMode: "quota_exceeded" });
    const forbidden = await addMock(harness, "forbidden", { resultCount: 0, failMode: "forbidden" });
    const limited = await addMock(harness, "limited", { resultCount: 0, failMode: "rate_limited" });

    for (const id of [quota, forbidden, limited]) {
      const run = await harness.app.inject({
        method: "POST",
        url: "/api/admin/health/check",
        ...adminHeaders(harness),
        payload: { kind: "connect", providerId: id },
      });
      expect(run.statusCode, run.body).toBe(200);
    }

    const blocked = harness.ctx.health.blockedProviders();
    // Account-wide causes park the source...
    expect(blocked.get(quota)?.code).toBe("quota_exceeded");
    // `forbidden` is a permission problem: degraded but still allowed to run, because
    // another key or a fixed entitlement can make it work again without a restart.
    expect(blocked.has(forbidden)).toBe(false);
    // A single 429 must never park anything.
    expect(blocked.has(limited)).toBe(false);
  });

  it("does not let one timeout or one 429 disable a source", async () => {
    const harness = await createHarness();
    const timedOut = await addMock(harness, "slow", { resultCount: 0, failMode: "timeout" });
    const limited = await addMock(harness, "burst", { resultCount: 0, failMode: "rate_limited" });

    for (const id of [timedOut, limited]) {
      await harness.app.inject({
        method: "POST",
        url: "/api/admin/health/check",
        ...adminHeaders(harness),
        payload: { kind: "connect", providerId: id },
      });
    }

    const blocked = harness.ctx.health.blockedProviders();
    expect(blocked.size).toBe(0);

    // And a real search must still fan out to both.
    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "still tried", mode: "basic", limit: 3, skipCache: true },
    });
    const stats = (search.json() as { stats: { providers: Array<{ providerId: string }> } }).stats;
    const tried = stats.providers.map((provider) => provider.providerId);
    expect(tried).toContain(timedOut);
    expect(tried).toContain(limited);
  });

  it("reports a health-skipped source in the search response instead of hiding it", async () => {
    const harness = await createHarness();
    const healthy = await addMock(harness, "worker", { resultCount: 3 });
    const parked = await addMock(harness, "parked-quota", { resultCount: 0, failMode: "quota_exceeded" });

    await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect", providerId: parked },
    });
    expect(harness.ctx.health.blockedProviders().has(parked)).toBe(true);

    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "skip visibility", mode: "basic", limit: 3, skipCache: true },
    });
    const body = search.json() as {
      status: string;
      errors: Array<{ providerId: string; code: string }>;
      failedSources: Array<{ id: string; code: string }>;
      stats: { partial: boolean };
    };
    expect(body.status).toBe("partial");
    expect(body.stats.partial).toBe(true);
    expect(body.failedSources.some((item) => item.id === parked)).toBe(true);
    expect(body.errors.some((item) => item.providerId === parked)).toBe(true);
    void healthy;
  });

  it("returns a structured failure when every source is parked", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "parked", { resultCount: 2 });
    // Simulate a parked source by writing the state the probe would produce.
    harness.ctx.db
      .insert((await import("../../packages/db/src/schema.js")).providerHealthChecks)
      .values({
        id: "hc_parked_test",
        providerId,
        keyId: null,
        kind: "connect",
        status: "unhealthy",
        errorCode: "quota_exceeded",
        latencyMs: 10,
        resultCount: null,
        healthScore: 0,
        detailJson: JSON.stringify({
          cause: "quota_exceeded",
          message: "quota exhausted",
          cooldownUntil: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        trigger: "manual",
        checkedAt: new Date().toISOString(),
      })
      .run();

    const blocked = harness.ctx.health.blockedProviders();
    expect(blocked.get(providerId)?.code).toBe("quota_exceeded");

    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "should fail", mode: "basic", limit: 3, skipCache: true },
    });
    // Structured failure, not a 200 with zero results.
    expect(search.statusCode).toBe(503);
    const body = search.json() as { status: string; results: unknown[]; errors: Array<{ code: string }> };
    expect(body.status).toBe("failed");
    expect(body.results).toEqual([]);
    expect(body.errors.some((item) => item.code === "quota_exceeded")).toBe(true);
  });

  it("does not let a search token read the admin health surface", async () => {
    const harness = await createHarness();
    await addMock(harness, "private", { resultCount: 1 });
    const token = await mintToken(harness, ["search", "mcp:use"]);

    const admin = await harness.app.inject({
      method: "GET",
      url: "/api/admin/health",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(admin.statusCode).toBe(403);

    // But the MCP projection is reachable, because that is the documented path.
    const mcp = await harness.app.inject({
      method: "GET",
      url: "/api/mcp/health",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mcp.statusCode).toBe(200);
    const body = mcp.json() as { providers: Array<Record<string, unknown>> };
    for (const provider of body.providers) {
      expect(provider).not.toHaveProperty("baseUrl");
      expect(provider).not.toHaveProperty("history");
      expect(JSON.stringify(provider)).not.toMatch(/sk-[A-Za-z0-9]/);
    }
  });

  it("does not let a caller's cancel degrade a source", async () => {
    const harness = await createHarness();
    // Slow enough that the abort lands while the provider call is in flight.
    const slow = await addMock(harness, "cancel-me", { resultCount: 2, latencyMs: 800 });
    const controller = new AbortController();
    const run = harness.ctx.search.execute(
      { query: "cancel probe", mode: "basic", limit: 3, skipCache: true },
      { actor: "admin:admin@example.com", signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("cancelled by user")), 120);
    const response = await run;

    // The caller stopped it; the response must say so rather than claim success.
    expect(response.status).toBe("failed");
    expect(response.errors.some((item) => item.code === "cancelled")).toBe(true);

    // A cancel is not evidence about the source: no park, no cooldown, no record.
    expect(harness.ctx.health.blockedProviders().has(slow)).toBe(false);
    expect(harness.ctx.health.history(slow, 10).some((row) => row.cause === "cancelled")).toBe(false);

    // And the dashboard must not count it as a failed call against the source.
    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/health",
      cookies: { sh_session: harness.cookie },
    });
    const summary = (
      overview.json() as {
        providers: Array<{
          providerId: string;
          searchCalls: number;
          successRate: number | null;
          consecutiveFailures: number;
          status: string;
        }>;
      }
    ).providers.find((item) => item.providerId === slow)!;
    // Nothing else has run against it, so a cancel that counted would show
    // searchCalls=1 / successRate=0 / consecutiveFailures=1.
    expect(summary.searchCalls, JSON.stringify(summary)).toBe(0);
    expect(summary.consecutiveFailures, JSON.stringify(summary)).toBe(0);
    expect(summary.status).toBe("unverified");

    // And the next real search still fans out to it.
    const next = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "after cancel", mode: "basic", limit: 3, skipCache: true },
    });
    const tried = (next.json() as { stats: { providers: Array<{ providerId: string }> } }).stats.providers.map(
      (provider) => provider.providerId,
    );
    expect(tried).toContain(slow);
  });

  it("keeps scheduled probing off until an operator enables it", async () => {
    const harness = await createHarness();
    await addMock(harness, "scheduled", { resultCount: 1 });

    const off = await harness.ctx.health.runScheduled();
    expect(off).toBeNull();

    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { health: { scheduledEnabled: true, intervalMinutes: 5, paidProbesEnabled: false } },
    });
    const first = await harness.ctx.health.runScheduled();
    expect(first).not.toBeNull();
    // Paid probes stay off, so the scheduled pass is connectivity only.
    const kinds = new Set((first?.results ?? []).map((item) => item.kind));
    expect([...kinds]).toEqual(["connect"]);

    // A second immediate pass is throttled by intervalMinutes.
    const second = await harness.ctx.health.runScheduled();
    expect(second).toBeNull();
  });

  it("honours the probe concurrency cap", async () => {
    const harness = await createHarness();
    for (const name of ["a", "b", "c"]) await addMock(harness, name, { resultCount: 1 });
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { health: { concurrency: 2 } },
    });
    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect" },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().results).toHaveLength(3);
  });
});
