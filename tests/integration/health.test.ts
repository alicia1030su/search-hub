import { afterEach, describe, expect, it } from "vitest";
import { ProviderError, SearchHubError } from "@search-hub/shared";
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
import {
  addKey,
  allowLocalhost,
  closeStubs,
  createProvider,
  startBraveStub,
} from "../helpers/vendor-stubs.js";

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
    expect(
      classifyError(
        Object.assign(new Error("no entitlement"), {
          code: "blocked",
          details: { upstreamStatus: 403 },
        }),
      ),
    ).toBe("forbidden");
    expect(classifyError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe("dns");
    expect(classifyError(new Error("self signed certificate in certificate chain"))).toBe("tls");
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("timeout");
    expect(classifyError(Object.assign(new Error("boom"), { code: "server_error" }))).toBe("server_error");
  });

  it("prioritizes structured transport codes over misleading status text", () => {
    expect(classifyError(new SearchHubError("cancelled", "HTTP 403 cancelled", { status: 403 }))).toBe("cancelled");
    expect(classifyError(new SearchHubError("timeout", "HTTP 403 timeout", { status: 403 }))).toBe("timeout");
    expect(classifyError(new ProviderError("p", "brave", "network", "HTTP 403 network"))).toBe("network");
    expect(classifyError(new ProviderError("p", "brave", "auth_invalid", "HTTP 403 invalid"))).toBe("auth_invalid");
  });

  it("distinguishes local SSRF blocks from trusted upstream permission failures", () => {
    const local = new ProviderError("p", "brave", "blocked", "private address blocked", { statusCode: 403 });
    expect(classifyError(local)).toBe("network");
    const upstream = new ProviderError("p", "brave", "blocked", "No entitlement", {
      statusCode: 403,
      details: { upstreamStatus: 403 },
    });
    expect(classifyError(upstream)).toBe("forbidden");
    const vendorPermission = new ProviderError("p", "minimax", "blocked", "No Coding Plan entitlement", {
      details: { permissionDenied: true, vendorCode: 2038 },
    });
    expect(classifyError(vendorPermission)).toBe("forbidden");
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
    expect(parseRetryAfterMs(120_000)).toBe(120_000);
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
  await closeStubs();
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

/**
 * Adds a provider whose real searches are made *with a credential*.
 *
 * Budget assertions only mean something for such a provider: a keyless source
 * sends no credential, cannot consume account quota, and is deliberately exempt
 * from the paid switch. Using `mock` here made "paid probe" a fiction, so these
 * cases drive a local Brave-shaped stub instead — a real socket, a real key
 * header, no vendor call.
 */
async function addKeyedProvider(harness: Harness, name: string): Promise<string> {
  await allowLocalhost(harness.app, {
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
  });
  const stub = await startBraveStub({ results: 2 });
  const providerId = await createProvider(
    harness.app,
    { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } },
    { name, type: "brave", baseUrl: stub.base, resultsPerPage: 5 },
  );
  await addKey(
    harness.app,
    { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } },
    providerId,
    "sk-HEALTH-BUDGET-STUB-0000000000",
  );
  return providerId;
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
    const providerId = await addKeyedProvider(harness, "paid");
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
    const providerId = await addKeyedProvider(harness, "budget");
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
    await addKeyedProvider(harness, "one");
    await addKeyedProvider(harness, "two");
    await addKeyedProvider(harness, "three");
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

/**
 * Request counts and cancellation, on the probe path itself.
 *
 * Both are properties of *what actually reached the wire*, so they are asserted
 * through a real HTTP stub rather than a fake fetch: a count taken anywhere but
 * the fetch boundary cannot tell a page from a redirect from an attempt.
 */
describe("probe request accounting", () => {
  it("counts every physical request a paginated probe issues", async () => {
    const harness = await createHarness();
    await allowLocalhost(harness.app, {
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
    });
    // A Brave-shaped stub that always returns a full page: the adapter keeps
    // paging towards `targetResults` and each page is one physical request.
    const stub = await startBraveStub({ results: 20 });
    const providerId = await createProvider(
      harness.app,
      { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } },
      {
        name: "paged-accounting",
        type: "brave",
        baseUrl: stub.base,
        resultsPerPage: 20,
        searchConfig: { targetResults: 50, maxPages: 3 },
      },
    );
    await addKey(
      harness.app,
      { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } },
      providerId,
      "sk-HEALTH-ACCOUNTING-000000000",
    );
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 5, maxRequestsPerDay: 20 } },
    });

    const result = await harness.ctx.health.checkOne(providerId, { kind: "search", trigger: "manual" });
    expect(result.cause).toBe("ok");
    expect(result.requests).toBeGreaterThanOrEqual(2);

    // The count is a stored fact, not a view-time calculation: it must be in
    // `detail_json` so it survives a restart and is readable from history.
    const row = harness.ctx.sqlite
      .prepare("SELECT detail_json FROM provider_health_checks WHERE id = ?")
      .get(result.id) as { detail_json: string };
    const detail = JSON.parse(row.detail_json) as { requests?: number | null };
    expect(detail.requests).toBe(result.requests);
  });

  it("reports `null` rather than `0` when no request was ever sent", async () => {
    const harness = await createHarness();
    // A credentialed provider with no credential: nothing can be sent.
    const providerId = await createProvider(
      harness.app,
      { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } },
      { name: "no-credential-probe", type: "brave", baseUrl: "http://127.0.0.1:9" },
    );
    const result = await harness.ctx.health.checkOne(providerId, { kind: "connect", trigger: "manual" });
    expect(result.cause).toBe("no_credential");
    // `0` would claim we know the wire was untouched; `null` says "not measured".
    expect(result.requests).toBeNull();
  });

  it("H61 refunds a paid reservation when an adapter returns without a physical request", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "zero-wire-paid", {
      resultCount: 2,
      accountGroup: "zero-wire-account",
      accountDailyQuota: 5,
    });
    const added = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...adminHeaders(harness),
      payload: { label: "zero-wire", key: "sk-HEALTH-ZERO-WIRE-00000000000" },
    });
    expect(added.statusCode, added.body).toBe(200);
    const keyId = (harness.ctx.sqlite.prepare("SELECT id FROM api_keys WHERE provider_id = ?").get(providerId) as { id: string }).id;
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 1, maxRequestsPerDay: 1 } },
    });

    const result = await harness.ctx.health.checkOne(providerId, { kind: "search", keyId, trigger: "manual" });
    expect(result.requests).toBeNull();
    expect(result.spent).toBe(false);
    const key = harness.ctx.providers.listKeys(providerId)[0]!;
    expect(key).toMatchObject({ requestCount: 0, successCount: 0, failureCount: 0, inFlight: 0 });
    const account = harness.ctx.providers.runtimesFor([providerId])[0]!.scheduler.accountSnapshot();
    expect(account).toMatchObject({ group: "zero-wire-account", quotaUsedToday: 0, rpmUsed: 0 });
    expect(harness.ctx.health.budget()).toMatchObject({
      usedToday: 0,
      remainingToday: 1,
    });
    expect(
      harness.ctx.sqlite.prepare("SELECT budget_kind, budget_day, credential_used, spent FROM provider_health_billing WHERE health_check_id = ?").get(result.id),
    ).toEqual({ budget_kind: "search", budget_day: new Date().toISOString().slice(0, 10), credential_used: 1, spent: 0 });
  });

  it("H61 zero-request anonymous probes do not consume the run or day allowance", async () => {
    const harness = await createHarness();
    const ids = [
      await addMock(harness, "zero-wire-anonymous-1", { resultCount: 2 }),
      await addMock(harness, "zero-wire-anonymous-2", { resultCount: 2 }),
      await addMock(harness, "zero-wire-anonymous-3", { resultCount: 2 }),
    ];
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: {
        health: {
          paidProbesEnabled: false,
          anonymousMaxRequestsPerRun: 1,
          anonymousMaxRequestsPerDay: 1,
        },
      },
    });

    const run = await harness.ctx.health.checkMany(ids, { kind: "search", gapMs: 0, concurrency: 1 });
    expect(run.results).toHaveLength(3);
    expect(run.skipped).toEqual([]);
    expect(run.results.every((item) => item.requests === null)).toBe(true);
    expect(run.budget).toMatchObject({
      anonymousSearchUsedToday: 0,
      anonymousRemainingToday: 1,
      usedToday: 0,
    });
    expect(
      harness.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_billing WHERE budget_kind = ? AND spent = 0").get("search_anonymous"),
    ).toEqual({ n: 3 });
  });

  it("H64 a scheduler write failure after observation does not refund another probe's slot", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "schedule-write-failure", { resultCount: 2 });
    const day = harness.ctx.health.budget().day;
    harness.ctx.sqlite
      .prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?) ON CONFLICT(day, kind) DO UPDATE SET used=1, updated_at=excluded.updated_at")
      .run(day, "search_anonymous", 1, new Date().toISOString());
    harness.ctx.sqlite.exec(
      "CREATE TRIGGER fail_probe_schedule BEFORE INSERT ON provider_probe_state BEGIN SELECT RAISE(ABORT, 'schedule blocked'); END",
    );

    await expect(harness.ctx.health.checkOne(providerId, { kind: "search" })).rejects.toThrow(/schedule blocked/);
    expect(harness.ctx.health.budget().anonymousSearchUsedToday).toBe(1);
    expect(
      harness.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ?").get(providerId),
    ).toEqual({ n: 1 });
    expect(
      harness.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_billing WHERE health_check_id IN (SELECT id FROM provider_health_checks WHERE provider_id = ?)").get(providerId),
    ).toEqual({ n: 1 });
  });

  it("H64 a billing write failure does not retry the observation or refund another probe's slot", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "billing-write-failure", { resultCount: 2 });
    const day = harness.ctx.health.budget().day;
    harness.ctx.sqlite
      .prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?) ON CONFLICT(day, kind) DO UPDATE SET used=1, updated_at=excluded.updated_at")
      .run(day, "search_anonymous", 1, new Date().toISOString());
    harness.ctx.sqlite.exec(
      "CREATE TRIGGER fail_probe_billing BEFORE INSERT ON provider_health_billing BEGIN SELECT RAISE(ABORT, 'billing blocked'); END",
    );

    await expect(harness.ctx.health.checkOne(providerId, { kind: "search" })).rejects.toThrow(/billing blocked/);
    expect(harness.ctx.health.budget().anonymousSearchUsedToday).toBe(1);
    expect(
      harness.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ?").get(providerId),
    ).toEqual({ n: 1 });
    expect(
      harness.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_billing").get(),
    ).toEqual({ n: 0 });
  });

  it("H65 a ledger reservation failure releases the acquired key as notSent", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "reserve-write-failure", {
      resultCount: 2,
      accountGroup: "reserve-failure-account",
      accountDailyQuota: 5,
    });
    await addKey(
      harness.app,
      adminHeaders(harness),
      providerId,
      "sk-HEALTH-RESERVE-FAILURE-00000000",
    );
    const keyId = (harness.ctx.sqlite.prepare("SELECT id FROM api_keys WHERE provider_id = ?").get(providerId) as { id: string }).id;
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { health: { paidProbesEnabled: true } },
    });
    harness.ctx.sqlite.exec(
      "CREATE TRIGGER fail_probe_reservation BEFORE UPDATE ON health_probe_budget BEGIN SELECT RAISE(ABORT, 'reservation blocked'); END",
    );

    await expect(
      harness.ctx.health.checkOne(providerId, { kind: "search", keyId }),
    ).rejects.toThrow(/reservation blocked/);
    expect(harness.ctx.providers.listKeys(providerId)[0]).toMatchObject({
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      inFlight: 0,
    });
    expect(
      harness.ctx.providers.runtimesFor([providerId])[0]!.scheduler.accountSnapshot(),
    ).toMatchObject({ group: "reserve-failure-account", quotaUsedToday: 0, rpmUsed: 0 });
    expect(
      harness.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_checks").get(),
    ).toEqual({ n: 0 });
  });

  it("H66 overview does not report an undecryptable credential pool as healthy", async () => {
    const harness = await createHarness();
    const providerId = await addKeyedProvider(harness, "undecryptable-overview");
    const healthy = await harness.ctx.health.checkOne(providerId, { kind: "connect" });
    expect(healthy.cause).toBe("ok");
    expect(harness.ctx.health.overview().providers.find((item) => item.providerId === providerId)).toMatchObject({
      keyAvailable: 1,
      runtime: "healthy",
    });

    harness.ctx.sqlite.prepare("UPDATE api_keys SET key_ciphertext = ? WHERE provider_id = ?").run("broken", providerId);
    harness.ctx.providers.reload();
    expect(harness.ctx.health.overview().providers.find((item) => item.providerId === providerId)).toMatchObject({
      keyTotal: 1,
      keyAvailable: 0,
      runtime: "unverified",
    });
  });

  it("stops before the first request when the job is already cancelled", async () => {
    const harness = await createHarness();
    await allowLocalhost(harness.app, {
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
    });
    const stub = await startBraveStub({ results: 2 });
    const providerId = await createProvider(
      harness.app,
      { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } },
      { name: "cancelled-before-start", type: "brave", baseUrl: stub.base },
    );
    await addKey(
      harness.app,
      { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } },
      providerId,
      "sk-HEALTH-CANCEL-0000000000000",
    );
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("cancelled"), { code: "cancelled" }));

    const run = await harness.ctx.health.checkMany([providerId], {
      kind: "connect",
      trigger: "manual",
      gapMs: 0,
      signal: controller.signal,
    });
    // A cancellation is a skip with its own code, not a health verdict…
    expect(run.results).toHaveLength(0);
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0]!.code).toBe("SKIPPED_CANCELLED");
    // …and it provably never reached the vendor.
    expect(stub.hits()).toBe(0);
    const rows = harness.ctx.sqlite
      .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ?")
      .get(providerId) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("reports an in-flight cancellation as a timeout-free skip", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "slow-cancel", { resultCount: 2, latencyMs: 400 });
    const controller = new AbortController();
    const runPromise = harness.ctx.health.checkMany([providerId], {
      kind: "connect",
      trigger: "manual",
      gapMs: 0,
      signal: controller.signal,
    });
    // Cancel while the probe is in flight: the abort reason carries
    // `code: "cancelled"`, which is what keeps `classifyError`'s `/aborted/i`
    // fallback from recording a timeout against a healthy source.
    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort(Object.assign(new Error("cancelled"), { code: "cancelled" }));
    const run = await runPromise;

    expect(run.results).toHaveLength(0);
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0]!.code).toBe("SKIPPED_CANCELLED");
    // Nothing was recorded: a cancellation is not evidence about the source.
    const rows = harness.ctx.sqlite
      .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ?")
      .get(providerId) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("de-duplicates a concurrent probe of the same source", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "double-probe", { resultCount: 2, latencyMs: 250 });

    const first = harness.ctx.health.checkMany([providerId], { kind: "connect", gapMs: 0 });
    // Let the first probe acquire its slot before the second asks for it.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await harness.ctx.health.checkMany([providerId], { kind: "connect", gapMs: 0 });
    await first;

    // The second pass must not hit the same source while the first still holds
    // the lock: for a paid probe that would be paying twice for one answer.
    expect(second.results).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.code).toBe("already_running");
  });
});
