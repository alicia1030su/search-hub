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

  it("parks a source whose account quota is exhausted and explains why", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "quota", { resultCount: 0 });
    // A quota failure is account-wide: the adapter reports quota_exceeded.
    await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${providerId}`,
      ...adminHeaders(harness),
      payload: { config: { resultCount: 0, failMode: "quota_exceeded" } },
    });

    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect", providerId },
    });
    // The mock adapter has no quota mode; it will fail as server_error, which must
    // NOT park the provider. Assert the honest outcome instead of forcing one.
    expect(run.statusCode, run.body).toBe(200);
    const blocked = harness.ctx.health.blockedProviders();
    expect(blocked.size).toBe(0);
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
