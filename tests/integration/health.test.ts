import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import {
  classifyError,
  cooldownFor,
  decideBudget,
  errorCodeFor,
  isAccountWide,
  parseRetryAfterMs,
  percentile,
  scoreFor,
  statusFor,
} from "../../apps/api/src/services/health-classify.js";

/**
 * Health classification + probe behaviour.
 *
 * The assertions focus on the distinctions that matter operationally: a quota
 * problem must not be treated as a rate limit, a missing key must not read as
 * healthy, and a paid probe must be refused before it spends anything.
 */

describe("health classification", () => {
  it("separates quota exhaustion from rate limiting", () => {
    expect(classifyError(Object.assign(new Error("insufficient balance"), { code: "quota_exceeded" }))).toBe(
      "quota_exceeded",
    );
    expect(classifyError(Object.assign(new Error("quota exceeded for today"), { code: "rate_limited" }))).toBe(
      "quota_exceeded",
    );
    expect(classifyError(Object.assign(new Error("HTTP 429 too many requests"), { code: "rate_limited" }))).toBe(
      "rate_limited",
    );
  });

  it("classifies auth, permission and network failures distinctly", () => {
    expect(classifyError(Object.assign(new Error("invalid key"), { code: "auth_invalid" }))).toBe("auth_invalid");
    expect(classifyError(Object.assign(new Error("no entitlement"), { code: "blocked" }))).toBe("forbidden");
    expect(classifyError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe("dns");
    expect(classifyError(new Error("self signed certificate in certificate chain"))).toBe("tls");
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("timeout");
    expect(classifyError(Object.assign(new Error("boom"), { code: "server_error" }))).toBe("server_error");
  });

  it("maps causes onto the API error vocabulary", () => {
    expect(errorCodeFor("auth_invalid")).toBe("auth_invalid");
    expect(errorCodeFor("quota_exceeded")).toBe("quota_exceeded");
    expect(errorCodeFor("rate_limited")).toBe("rate_limited");
    expect(errorCodeFor("dns")).toBe("network");
    expect(errorCodeFor("ok")).toBeNull();
  });

  it("never reports a missing credential as healthy", () => {
    expect(statusFor("no_credential")).toBe("unverified");
    expect(statusFor("config_incomplete")).toBe("unverified");
    expect(statusFor("ok")).toBe("healthy");
    expect(statusFor("quota_exceeded")).toBe("unhealthy");
    expect(statusFor("rate_limited")).toBe("degraded");
  });

  it("parks a quota-exhausted key far longer than a rate limit", () => {
    const rate = cooldownFor("rate_limited")!;
    const quota = cooldownFor("quota_exceeded")!;
    expect(quota).toBeGreaterThan(rate);
    // Retrying a quota problem in a minute only fails again and costs a request.
    expect(quota).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(cooldownFor("ok")).toBeNull();
  });

  it("honours the vendor's Retry-After over the default cooldown", () => {
    expect(cooldownFor("rate_limited", 5_000)).toBe(5_000);
    // but never beyond a sane ceiling
    expect(cooldownFor("rate_limited", 48 * 60 * 60 * 1000)).toBe(6 * 60 * 60 * 1000);
  });

  it("parses Retry-After as seconds or as an HTTP date", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    const future = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfterMs(future)).toBeGreaterThan(8_000);
  });

  it("treats quota and permission problems as account-wide", () => {
    // Rotating keys inside one account cannot fix either.
    expect(isAccountWide("quota_exceeded")).toBe(true);
    expect(isAccountWide("forbidden")).toBe(true);
    expect(isAccountWide("rate_limited")).toBe(false);
  });

  it("scores a healthy fast source above a slow or failing one", () => {
    expect(scoreFor("ok", 120)).toBe(100);
    expect(scoreFor("ok", 20_000)).toBeLessThan(scoreFor("ok", 120));
    expect(scoreFor("auth_invalid", null)).toBe(0);
    expect(scoreFor("rate_limited", 50)).toBeLessThan(scoreFor("ok", 50));
  });

  it("computes P50/P95 with interpolation", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([100], 95)).toBe(100);
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(48);
  });

  it("refuses a probe that would exceed the per-run or per-day budget", () => {
    expect(decideBudget({ maxPerRun: 3, maxPerDay: 20, usedToday: 0 }, 4)).toMatchObject({
      allowed: false,
      reason: "run_limit",
    });
    expect(decideBudget({ maxPerRun: 3, maxPerDay: 20, usedToday: 20 }, 1)).toMatchObject({
      allowed: false,
      reason: "day_limit",
    });
    expect(decideBudget({ maxPerRun: 3, maxPerDay: 20, usedToday: 18 }, 3)).toMatchObject({
      allowed: false,
      reason: "day_limit",
    });
    expect(decideBudget({ maxPerRun: 3, maxPerDay: 20, usedToday: 10 }, 3).allowed).toBe(true);
  });
});

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
    dbPath: join(dir, "health.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-health-"));
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

describe("health probes", () => {
  it("reports unverified before any probe ran", async () => {
    const harness = await createHarness();
    await addMock(harness, "fresh", { resultCount: 2 });
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/health",
      cookies: { sh_session: harness.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().totals.unverified).toBe(1);
    expect(response.json().providers[0].status).toBe("unverified");
    // Nothing was probed, so there is no latency claim to make either.
    expect(response.json().providers[0].p50LatencyMs).toBeNull();
  });

  it("marks a working source healthy and a failing one degraded", async () => {
    const harness = await createHarness();
    await addMock(harness, "good", { resultCount: 3 });
    await addMock(harness, "limited", { resultCount: 0, failMode: "rate_limited" });

    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect" },
    });
    expect(run.statusCode, run.body).toBe(200);
    const body = run.json() as { results: Array<{ providerName: string; status: string; cause: string }> };
    const good = body.results.find((item) => item.providerName === "good")!;
    const limited = body.results.find((item) => item.providerName === "limited")!;
    expect(good.status).toBe("healthy");
    expect(limited.status).toBe("degraded");
    expect(limited.cause).toBe("rate_limited");

    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/health",
      cookies: { sh_session: harness.cookie },
    });
    expect(overview.json().totals).toMatchObject({ healthy: 1, degraded: 1, unverified: 0 });
  });

  it("treats an HTTP 200 with zero results as degraded, not healthy", async () => {
    const harness = await createHarness();
    await addMock(harness, "empty", { resultCount: 0 });
    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect" },
    });
    const result = run.json().results[0];
    expect(result.status).toBe("degraded");
    expect(result.cause).toBe("empty_results");
  });

  it("classifies a dead credential as unhealthy and parks the key", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "auth-fail", { resultCount: 0, failMode: "auth_invalid" });
    // The mock adapter requires no key, so attach one so the key annotation path runs.
    const key = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...adminHeaders(harness),
      payload: { label: "probe", key: "sk-HEALTH-TEST-KEY" },
    });
    expect(key.statusCode, key.body).toBe(200);

    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect", providerId },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().results[0].status).toBe("unhealthy");
    expect(run.json().results[0].errorCode).toBe("auth_invalid");
  });

  it("refuses a paid probe while paid probes are disabled", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "paid", { resultCount: 2 });
    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "search", providerId },
    });
    // A 400, not a silent downgrade: the caller must know no request was spent.
    expect(run.statusCode).toBe(400);
    expect(run.body).toContain("Paid search probes are disabled");
  });

  it("stops spending once the daily paid-probe budget is exhausted", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "budget", { resultCount: 2 });
    // Enable paid probes but allow exactly one.
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 3, maxRequestsPerDay: 1 } },
    });

    const first = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "search", providerId },
    });
    expect(first.statusCode, first.body).toBe(200);

    const second = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "search", providerId },
    });
    expect(second.statusCode).toBe(429);
    expect(second.body).toContain("budget exhausted");
  });

  it("skips the remaining providers once the run budget is used up", async () => {
    const harness = await createHarness();
    await addMock(harness, "one", { resultCount: 1 });
    await addMock(harness, "two", { resultCount: 1 });
    await addMock(harness, "three", { resultCount: 1 });
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 1, maxRequestsPerDay: 10 } },
    });

    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "search" },
    });
    expect(run.statusCode, run.body).toBe(200);
    // The run budget is one *paid* probe: the first provider is checked, the
    // rest are reported as skipped rather than silently downgraded.
    expect(run.json().results.length + run.json().skipped.length).toBe(3);
    expect(run.json().results).toHaveLength(1);
    expect(run.json().skipped.length).toBe(2);
    expect(run.json().skipped[0].reason).toContain("budget_exhausted");
  });

  it("records history with the cause and error code", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "hist", { resultCount: 0, failMode: "server_error" });
    await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect", providerId },
    });
    const history = await harness.app.inject({
      method: "GET",
      url: `/api/admin/health/history?providerId=${providerId}`,
      cookies: { sh_session: harness.cookie },
    });
    expect(history.statusCode).toBe(200);
    const checks = history.json().checks as Array<{ cause: string; errorCode: string; kind: string }>;
    expect(checks).toHaveLength(1);
    expect(checks[0]!.cause).toBe("server_error");
    expect(checks[0]!.errorCode).toBe("server_error");
    expect(checks[0]!.kind).toBe("connect");
  });

  it("does not expose health to a search-scope token", async () => {
    const harness = await createHarness();
    await addMock(harness, "authz", { resultCount: 1 });
    const minted = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "searcher", scopes: ["search"], rateLimitPerMin: 600 },
    });
    const token = minted.json().token as string;
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/health",
      headers: { authorization: `Bearer ${token}` },
    });
    // Source inventory and key validity are admin data.
    expect(response.statusCode).toBe(403);
  });

  it("keeps probe latency out of the live-traffic P50/P95", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "traffic", { resultCount: 2 });
    // A real search, so there is traffic to measure.
    await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "health traffic", mode: "basic", limit: 3, skipCache: true },
    });
    await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect", providerId },
    });
    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/health",
      cookies: { sh_session: harness.cookie },
    });
    const provider = overview.json().providers.find((item: { providerId: string }) => item.providerId === providerId);
    expect(provider.searchCalls).toBe(1);
    expect(provider.successRate).toBe(1);
    // Only the search produced a latency sample, so P50 exists and is a number.
    expect(typeof provider.p50LatencyMs).toBe("number");
  });
});
