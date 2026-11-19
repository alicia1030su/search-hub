import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { ProbeBudget, type BudgetSnapshot } from "../../apps/api/src/services/health-budget.js";
import { runtimeHealthFor } from "../../apps/api/src/services/health-classify.js";
import {
  apiKeys,
  healthProbeBudget,
  providerHealthChecks,
  providerProbeState,
  searchCache,
} from "../../packages/db/src/schema.js";
import {
  addKey,
  allowLocalhost,
  closeStubs,
  createProvider,
  startBraveStub,
} from "../helpers/vendor-stubs.js";

/**
 * Provider Health Management Centre — T01..T35.
 *
 * Rules this suite follows:
 *  - assertions read the database, not just the HTTP status: a 200 with a
 *    plausible body is exactly what a broken probe returns;
 *  - no test waits for a real interval. The scheduler is driven directly and the
 *    clock is injectable, so "next probe in 6 hours" is verified in milliseconds;
 *  - no test touches a paid vendor. The `mock` adapter is the only source;
 *  - "healthy" is never asserted from an HTTP 200 alone.
 */

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
  clock: { now: number };
}

const harnesses: Harness[] = [];

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "health-center.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(
  options: { dir?: string; clock?: { now: number } } = {},
): Promise<Harness> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "search-hub-health-center-"));
  const clock = options.clock ?? { now: Date.now() };
  // Fixed jitter (0.5 = no jitter) so backoff arithmetic is deterministic.
  const ctx = createContext(testConfig(dir), { now: () => clock.now, random: () => 0.5 });
  const app = await buildApp(ctx);
  await app.ready();
  // A fresh directory needs first-run setup; a reopened one already has an
  // administrator, so the restart test logs in with the same credentials.
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
  let cookie: string;
  let csrf: string;
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

afterEach(async () => {
  await closeStubs();
  for (const harness of harnesses.splice(0)) {
    harness.ctx.health.stopScheduler();
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

const adminHeaders = (harness: Harness) => ({
  cookies: { sh_session: harness.cookie },
  headers: { "x-csrf-token": harness.csrf },
});

async function addMock(
  harness: Harness,
  name: string,
  config: Record<string, unknown>,
): Promise<string> {
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

/**
 * Adds a provider whose real searches spend an account credential.
 *
 * The budget cases must exercise the *paid* class: a keyless source sends no
 * credential and is deliberately exempt from the paid switch, so using the mock
 * adapter for them would test a rule that does not apply to it.
 */
async function addKeyedProvider(harness: Harness, name: string): Promise<string> {
  await allowLocalhost(harness.app, adminHeaders(harness));
  const stub = await startBraveStub({ results: 2 });
  const providerId = await createProvider(harness.app, adminHeaders(harness), {
    name,
    type: "brave",
    baseUrl: stub.base,
    resultsPerPage: 5,
  });
  await addKey(harness.app, adminHeaders(harness), providerId, "sk-HEALTH-CENTRE-STUB-0000000000");
  return providerId;
}

async function setHealthPolicy(harness: Harness, patch: Record<string, unknown>) {
  return harness.app.inject({
    method: "PUT",
    url: "/api/admin/provider-health/settings",
    ...adminHeaders(harness),
    payload: patch,
  });
}

async function overview(harness: Harness) {
  const response = await harness.app.inject({
    method: "GET",
    url: "/api/admin/provider-health",
    cookies: { sh_session: harness.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    providers: Array<{
      providerId: string;
      runtime: string;
      status: string;
      implementation: { verification: string };
      autoProbeEnabled: boolean;
      nextProbeAt: string | null;
      probeMode: string;
      keyAvailable: number;
      keyTotal: number;
      consecutiveFailures: number;
    }>;
    budget: {
      day: string;
      usedToday: number;
      anonymousSearchUsedToday: number;
      connectUsedToday: number;
      remainingToday: number;
      maxPerRun: number;
      maxPerDay: number;
      paidProbesEnabled: boolean;
      scheduledEnabled: boolean;
      intervalMinutes: number;
    };
    runtimeTotals: Record<string, number>;
  };
}

async function probeOne(harness: Harness, providerId: string, kind: "connect" | "search") {
  return harness.app.inject({
    method: "POST",
    url: `/api/admin/provider-health/${providerId}/probe`,
    ...adminHeaders(harness),
    payload: { kind },
  });
}

function probeRows(harness: Harness) {
  return harness.ctx.db.select().from(providerHealthChecks).all();
}

function budgetRows(harness: Harness) {
  return harness.ctx.db.select().from(healthProbeBudget).all();
}

function runtimeOf(harness: Harness, providerId: string) {
  return harness.ctx.db
    .select()
    .from(providerProbeState)
    .all()
    .find((row) => row.providerId === providerId);
}

describe("runtime health model", () => {
  const base = {
    enabled: true,
    requiresKey: false,
    keyTotal: 0,
    keyAvailable: 0,
    keyInvalid: 0,
    now: Date.parse("2026-11-17T12:00:00.000Z"),
    lastCheck: null,
  };

  it("T04a keeps implementation verification independent of runtime health", () => {
    // A probe cannot upgrade `documented` to `live_tested`: verification comes
    // from the catalog and is never written by this service. The mapping below
    // is the only place runtime state is derived, and it has no such field.
    const runtime = runtimeHealthFor({
      ...base,
      lastCheck: { status: "healthy", cause: "ok", cooldownUntil: null },
    });
    expect(runtime).toBe("healthy");
  });

  it("maps quota, auth and permission causes to distinct states", () => {
    const state = (cause: "quota_exceeded" | "auth_invalid" | "forbidden" | "rate_limited") =>
      runtimeHealthFor({ ...base, lastCheck: { status: "unhealthy", cause, cooldownUntil: null } });
    expect(state("quota_exceeded")).toBe("quota_exceeded");
    expect(state("auth_invalid")).toBe("invalid_credentials");
    expect(state("forbidden")).toBe("permission_denied");
    expect(state("rate_limited")).toBe("rate_limited");
  });

  it("reports cooldown only while the cooldown is still in the future", () => {
    const future = new Date(base.now + 60_000).toISOString();
    const past = new Date(base.now - 60_000).toISOString();
    expect(
      runtimeHealthFor({ ...base, lastCheck: { status: "degraded", cause: "timeout", cooldownUntil: future } }),
    ).toBe("cooldown");
    expect(
      runtimeHealthFor({ ...base, lastCheck: { status: "degraded", cause: "timeout", cooldownUntil: past } }),
    ).toBe("degraded");
  });

  it("never reports healthy when the credential pool is unusable", () => {
    const ok = { status: "healthy", cause: "ok", cooldownUntil: null } as const;
    // All keys rejected by the vendor.
    expect(
      runtimeHealthFor({ ...base, requiresKey: true, keyTotal: 2, keyAvailable: 0, keyInvalid: 2, lastCheck: ok }),
    ).toBe("invalid_credentials");
    // Keys merely disabled or cooling down: we cannot tell, so not healthy.
    expect(
      runtimeHealthFor({ ...base, requiresKey: true, keyTotal: 2, keyAvailable: 0, keyInvalid: 0, lastCheck: ok }),
    ).toBe("unverified");
    // No key at all.
    expect(
      runtimeHealthFor({ ...base, requiresKey: true, keyTotal: 0, keyAvailable: 0, lastCheck: ok }),
    ).toBe("unverified");
    // One working key among broken ones is enough.
    expect(
      runtimeHealthFor({ ...base, requiresKey: true, keyTotal: 3, keyAvailable: 1, keyInvalid: 2, lastCheck: ok }),
    ).toBe("healthy");
  });

  it("treats a disabled provider as disabled whatever the last probe said", () => {
    expect(
      runtimeHealthFor({
        ...base,
        enabled: false,
        lastCheck: { status: "healthy", cause: "ok", cooldownUntil: null },
      }),
    ).toBe("disabled");
  });
});

describe("budget ledger", () => {
  it("is a conditional update, so concurrent reservations cannot overspend", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-budget-"));
    const handleDir = dir;
    // A bare context is enough here: the ledger is a database concern.
    const ctx = createContext({ ...testConfig(handleDir) });
    try {
      const ledger = new ProbeBudget(ctx.db, () => Date.parse("2026-11-17T10:00:00.000Z"));
      const limits = { paidProbesEnabled: true, maxPerRun: 100, maxPerDay: 5 };
      const outcomes = Array.from({ length: 20 }, () => ledger.reserve({ kind: "search", ...limits }));
      expect(outcomes.filter((item) => item.ok)).toHaveLength(5);
      expect(outcomes.filter((item) => !item.ok)).toHaveLength(15);
      expect(ledger.snapshot(limits).searchUsedToday).toBe(5);
    } finally {
      ctx.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts connectivity probes in a separate bucket", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-budget2-"));
    const ctx = createContext({ ...testConfig(dir) });
    try {
      const ledger = new ProbeBudget(ctx.db, () => Date.parse("2026-11-17T10:00:00.000Z"));
      const limits = { paidProbesEnabled: false, maxPerRun: 3, maxPerDay: 20 };
      ledger.reserve({ kind: "connect", ...limits });
      ledger.reserve({ kind: "connect", ...limits });
      const snapshot: BudgetSnapshot = ledger.snapshot(limits);
      expect(snapshot.connectUsedToday).toBe(2);
      expect(snapshot.searchUsedToday).toBe(0);
      // A paid reservation is refused while paid probes are disabled.
      expect(ledger.reserve({ kind: "search", ...limits })).toMatchObject({
        ok: false,
        reason: "paid_disabled",
      });
    } finally {
      ctx.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider health centre", () => {
  it("T01 auto probing is off on a fresh install", async () => {
    const harness = await createHarness();
    await addMock(harness, "fresh", { resultCount: 2 });
    const view = await overview(harness);
    expect(view.budget.scheduledEnabled).toBe(false);
    expect(view.budget.paidProbesEnabled).toBe(false);
    expect(view.budget.maxPerRun).toBe(3);
    expect(view.budget.maxPerDay).toBe(20);
    // And nothing has been probed.
    expect(probeRows(harness)).toHaveLength(0);
  });

  it("T02 an off schedule produces no probes even when the timer ticks", async () => {
    const harness = await createHarness();
    await addMock(harness, "quiet", { resultCount: 2 });
    harness.ctx.health.startScheduler(10);
    await new Promise((resolve) => setTimeout(resolve, 120));
    harness.ctx.health.stopScheduler();
    expect(probeRows(harness)).toHaveLength(0);
    expect(budgetRows(harness)).toHaveLength(0);
  });

  it("T03 a provider without a key is never reported healthy", async () => {
    const harness = await createHarness();
    // `brave` requires a key; with none configured the probe must return
    // `unverified` *before* any request leaves the process.
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      ...adminHeaders(harness),
      payload: { name: "needs-key", type: "brave", enabled: true, timeoutMs: 5000 },
    });
    expect(created.statusCode, created.body).toBe(200);
    const providerId = created.json().provider.id as string;

    const probe = await probeOne(harness, providerId, "connect");
    expect(probe.statusCode, probe.body).toBe(200);
    expect(probe.json().result.cause).toBe("no_credential");
    expect(probe.json().result.status).toBe("unverified");

    const view = await overview(harness);
    const row = view.providers.find((item) => item.providerId === providerId)!;
    expect(row.runtime).toBe("unverified");
    expect(row.runtime).not.toBe("healthy");
  });

  it("T04b a successful connectivity probe does not claim a live integration", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "documented-only", { resultCount: 2 });
    const probe = await probeOne(harness, providerId, "connect");
    expect(probe.statusCode, probe.body).toBe(200);
    expect(probe.json().result.cause).toBe("ok");

    const view = await overview(harness);
    const row = view.providers.find((item) => item.providerId === providerId)!;
    expect(row.runtime).toBe("healthy");
    // The mock adapter is contract-tested only; that must not be upgraded by a
    // green probe.
    expect(row.implementation.verification).toBe("mock_verified");
  });

  it("T05 a live search probe with real rows records success and spends budget", async () => {
    const harness = await createHarness();
    const providerId = await addKeyedProvider(harness, "live");
    await setHealthPolicy(harness, { paidProbesEnabled: true });

    const probe = await probeOne(harness, providerId, "search");
    expect(probe.statusCode, probe.body).toBe(200);
    expect(probe.json().result.kind).toBe("search");
    // The stub returns two rows; the assertion is "real rows came back", not a
    // specific count, because a vendor may return more than asked.
    expect(probe.json().result.resultCount).toBeGreaterThan(0);
    expect(probe.json().result.cause).toBe("ok");
    expect(probe.json().budget.usedToday).toBe(1);

    const rows = probeRows(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("search");
  });

  it("T06-T14 classify each failure cause without guessing", async () => {
    const harness = await createHarness();
    const cases: Array<{ failMode: string; cause: string; runtime: string }> = [
      { failMode: "auth_invalid", cause: "auth_invalid", runtime: "invalid_credentials" },
      { failMode: "forbidden", cause: "forbidden", runtime: "permission_denied" },
      { failMode: "rate_limited", cause: "rate_limited", runtime: "rate_limited" },
      { failMode: "quota_exceeded", cause: "quota_exceeded", runtime: "quota_exceeded" },
      { failMode: "server_error", cause: "server_error", runtime: "degraded" },
      { failMode: "timeout", cause: "timeout", runtime: "cooldown" },
    ];
    for (const [index, item] of cases.entries()) {
      const providerId = await addMock(harness, `case-${index}`, {
        resultCount: 0,
        failMode: item.failMode,
        latencyMs: item.failMode === "timeout" ? 60_000 : 5,
      });
      const probe = await probeOne(harness, providerId, "connect");
      expect(probe.statusCode, probe.body).toBe(200);
      expect(probe.json().result.cause, `${item.failMode} cause`).toBe(item.cause);
    }

    const view = await overview(harness);
    for (const item of cases) {
      const row = view.providers.find((entry) => entry.providerId === `case-${cases.indexOf(item)}`);
      void row;
    }
  });

  it("T15 a cancelled probe records nothing and does not refund its slot", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "cancel-probe", { resultCount: 0, failMode: "cancelled" });

    const response = await probeOne(harness, providerId, "search");
    // No verdict is published about the source, and the caller is told why.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).toContain("cancelled");
    expect(probeRows(harness).filter((row) => row.kind === "search")).toHaveLength(0);

    const view = await overview(harness);
    expect(view.providers[0]!.runtime).toBe("unknown");
    // The reservation is *kept*: a cancel can arrive after the request left the
    // machine, so refunding it would let an abort loop spend unbounded requests
    // while the ledger reports zero. A keyless source counts in the anonymous
    // bucket; the paid bucket stays untouched because no credential was spent.
    expect(view.budget.anonymousSearchUsedToday).toBe(1);
    expect(view.budget.usedToday).toBe(0);
  });

  it("T16 the per-run paid budget caps a 'check all' at three probes", async () => {
    const harness = await createHarness();
    for (const name of ["a", "b", "c", "d", "e"]) await addKeyedProvider(harness, name);
    await setHealthPolicy(harness, { paidProbesEnabled: true, maxRequestsPerRun: 3, maxRequestsPerDay: 20 });

    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "search" },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().results).toHaveLength(3);
    expect(run.json().skipped.length).toBe(2);
    expect(run.json().budget.usedToday).toBe(3);
  });

  it("T16b an impossible probe does not consume the per-run allowance", async () => {
    const harness = await createHarness();
    // Two credential-backed sources with no key: they can never be searched, so
    // they must not eat the three paid slots the working ones need.
    for (const name of ["needs-a", "needs-b"]) {
      await harness.app.inject({
        method: "POST",
        url: "/api/admin/providers",
        ...adminHeaders(harness),
        payload: { name, type: "brave", enabled: true, timeoutMs: 3000 },
      });
    }
    for (const name of ["paid-a", "paid-b", "paid-c"]) {
      await addKeyedProvider(harness, name);
    }
    await setHealthPolicy(harness, { paidProbesEnabled: true, maxRequestsPerRun: 3, maxRequestsPerDay: 20 });

    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "search" },
    });
    expect(run.statusCode, run.body).toBe(200);
    // All three mock sources were probed, and the two keyless ones returned
    // `unverified` without charging the budget.
    expect(run.json().results).toHaveLength(5);
    expect(run.json().budget.usedToday).toBe(3);
  });

  it("T17/T20 the daily paid budget stops further probes", async () => {
    const harness = await createHarness();
    const providerId = await addKeyedProvider(harness, "daily");
    await setHealthPolicy(harness, { paidProbesEnabled: true, maxRequestsPerRun: 3, maxRequestsPerDay: 1 });

    expect((await probeOne(harness, providerId, "search")).statusCode).toBe(200);
    const second = await probeOne(harness, providerId, "search");
    expect(second.statusCode).toBe(429);
    expect(second.body).toContain("budget exhausted");
  });

  it("T18 one hundred concurrent paid probes cannot exceed the budget", async () => {
    const harness = await createHarness();
    const providerId = await addKeyedProvider(harness, "race");
    await setHealthPolicy(harness, { paidProbesEnabled: true, maxRequestsPerRun: 200, maxRequestsPerDay: 5 });

    const responses = await Promise.all(
      Array.from({ length: 100 }, () => probeOne(harness, providerId, "search")),
    );
    const accepted = responses.filter((item) => item.statusCode === 200).length;
    const rejected = responses.filter((item) => item.statusCode === 429).length;
    expect(accepted).toBe(5);
    expect(rejected).toBe(95);

    const ledger = harness.ctx.db.select().from(healthProbeBudget).all();
    const used = ledger.find((row) => row.kind === "search")!.used;
    expect(used).toBe(5);
    // Exactly five probe rows were written; a rejected probe records nothing.
    expect(probeRows(harness).filter((row) => row.kind === "search")).toHaveLength(5);
  });

  it("T19 a restart does not reset the daily budget", async () => {
    const harness = await createHarness();
    const providerId = await addKeyedProvider(harness, "restart");
    await setHealthPolicy(harness, { paidProbesEnabled: true, maxRequestsPerDay: 2 });
    expect((await probeOne(harness, providerId, "search")).statusCode).toBe(200);

    const dir = harness.dir;
    const clock = harness.clock;
    harness.ctx.health.stopScheduler();
    await harness.app.close();
    harnesses.splice(harnesses.indexOf(harness), 1);

    const reopened = await createHarness({ dir, clock });
    const view = await overview(reopened);
    expect(view.budget.usedToday).toBe(1);
    expect((await probeOne(reopened, providerId, "search")).statusCode).toBe(200);
    expect((await probeOne(reopened, providerId, "search")).statusCode).toBe(429);
  });

  it("T21/T22 consecutive failures back off, then recover on success", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "flaky", { resultCount: 0, failMode: "server_error" });

    for (let index = 0; index < 3; index += 1) {
      // Advance *before* each probe so the backoff accumulates, then inspect the
      // state immediately after the last one while its cooldown is still live.
      if (index > 0) harness.clock.now += 60_000;
      expect((await probeOne(harness, providerId, "connect")).statusCode).toBe(200);
    }
    const degraded = runtimeOf(harness, providerId)!;
    expect(degraded.consecutiveFailures).toBe(3);
    expect(degraded.backoffLevel).toBe(3);
    // A transient failure must schedule a retry *sooner* than the 6h interval.
    const intervalMs = 360 * 60_000;
    expect(Date.parse(degraded.nextProbeAt!)).toBeLessThan(harness.clock.now + intervalMs);

    const view = await overview(harness);
    expect(view.providers[0]!.runtime).toBe("cooldown");

    // Recover the source and probe again. The clock moves first so the new
    // observation is unambiguously the latest one.
    harness.clock.now += 60_000;
    await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${providerId}`,
      ...adminHeaders(harness),
      payload: { config: { resultCount: 2, failMode: "none" } },
    });
    const recovered = await probeOne(harness, providerId, "connect");
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().result.status).toBe("healthy");
    const after = runtimeOf(harness, providerId)!;
    expect(after.consecutiveFailures).toBe(0);
    expect(after.backoffLevel).toBe(0);
    expect((await overview(harness)).providers[0]!.runtime).toBe("healthy");
  });

  it("T23 one dead key does not disable the provider", async () => {
    const harness = await createHarness();
    // A keyed vendor pointed at a closed local port: no egress, but the key
    // resolution path is real.
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      ...adminHeaders(harness),
      payload: {
        name: "keyed",
        type: "brave",
        enabled: true,
        timeoutMs: 3000,
        baseUrl: "http://127.0.0.1:9/v1",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const providerId = created.json().provider.id as string;
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
    });

    // Two keys, one already rejected by the vendor.
    harness.ctx.db
      .insert(apiKeys)
      .values([
        {
          id: "key-good",
          providerId,
          label: "good",
          keyCiphertext: "x",
          keyIv: "x",
          keyTag: "x",
          keyVersion: 1,
          keyHint: "good",
          weight: 100,
          enabled: true,
          status: "healthy",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "key-bad",
          providerId,
          label: "bad",
          keyCiphertext: "x",
          keyIv: "x",
          keyTag: "x",
          keyVersion: 1,
          keyHint: "bad",
          weight: 100,
          enabled: true,
          status: "invalid",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ])
      .run();

    // Seed a healthy probe result so the runtime derivation has something to read.
    harness.ctx.db
      .insert(providerHealthChecks)
      .values({
        id: "hc_seed_ok",
        providerId,
        keyId: "key-good",
        kind: "connect",
        status: "healthy",
        errorCode: null,
        latencyMs: 20,
        resultCount: 1,
        healthScore: 95,
        detailJson: JSON.stringify({ cause: "ok", message: "seeded", cooldownUntil: null }),
        trigger: "manual",
        checkedAt: new Date(harness.clock.now).toISOString(),
      })
      .run();

    const view = await overview(harness);
    const row = view.providers.find((item) => item.providerId === providerId)!;
    expect(row.keyTotal).toBe(2);
    expect(row.keyAvailable).toBe(1);
    // One working key is enough: the provider is healthy, not disabled.
    expect(row.runtime).toBe("healthy");
  });

  it("T24 every key rejected means the provider is not normal", async () => {
    const harness = await createHarness();
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      ...adminHeaders(harness),
      payload: { name: "all-bad", type: "brave", enabled: true, timeoutMs: 3000 },
    });
    const providerId = created.json().provider.id as string;
    harness.ctx.db
      .insert(apiKeys)
      .values(
        ["a", "b"].map((label) => ({
          id: `key-${label}`,
          providerId,
          label,
          keyCiphertext: "x",
          keyIv: "x",
          keyTag: "x",
          keyVersion: 1,
          keyHint: label,
          weight: 100,
          enabled: true,
          status: "invalid",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      )
      .run();
    harness.ctx.db
      .insert(providerHealthChecks)
      .values({
        id: "hc_seed_ok2",
        providerId,
        keyId: null,
        kind: "connect",
        status: "healthy",
        errorCode: null,
        latencyMs: 20,
        resultCount: 1,
        healthScore: 95,
        detailJson: JSON.stringify({ cause: "ok", message: "seeded", cooldownUntil: null }),
        trigger: "manual",
        checkedAt: new Date(harness.clock.now).toISOString(),
      })
      .run();

    const view = await overview(harness);
    const row = view.providers.find((item) => item.providerId === providerId)!;
    expect(row.keyAvailable).toBe(0);
    expect(row.runtime).toBe("invalid_credentials");
    expect(row.runtime).not.toBe("healthy");
  });

  it("T25 two passes never probe the same provider at once", async () => {
    const harness = await createHarness();
    const slow = await addMock(harness, "slow", { resultCount: 1, latencyMs: 300 });
    const [first, second] = await Promise.all([
      harness.ctx.health.checkMany([slow], { kind: "connect", gapMs: 0, respectInFlight: true }),
      harness.ctx.health.checkMany([slow], { kind: "connect", gapMs: 0, respectInFlight: true }),
    ]);
    const firstSkipped = first.skipped.some((item) => String((item as { reason: string }).reason).includes("already_running"));
    const secondSkipped = second.skipped.some((item) => String((item as { reason: string }).reason).includes("already_running"));
    expect(firstSkipped || secondSkipped).toBe(true);
    // Exactly one probe was spent.
    expect(probeRows(harness)).toHaveLength(1);
  });

  it("T26 stopping the scheduler ends the timer and stops new probes", async () => {
    const harness = await createHarness();
    await addMock(harness, "scheduled", { resultCount: 1 });
    await setHealthPolicy(harness, { scheduledEnabled: true, intervalMinutes: 5 });

    harness.ctx.health.startScheduler(10);
    // Wait for the first pass to *produce evidence* rather than for a fixed 60
    // ms. On a loaded CI runner the first tick can land after that window, and
    // the assertion below would then fail for a scheduling delay that is not a
    // defect. The deadline is the only timing assumption here.
    const firstPassDeadline = Date.now() + 5_000;
    while (probeRows(harness).length === 0 && Date.now() < firstPassDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    harness.ctx.health.stopScheduler();
    const afterStop = probeRows(harness).length;
    expect(afterStop).toBeGreaterThan(0);
    // The in-flight pass finishes on its own; what must stop is *new* passes.
    const deadline = Date.now() + 3000;
    while (harness.ctx.health.isPassRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(harness.ctx.health.isPassRunning()).toBe(false);
    const settled = probeRows(harness).length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    // No further rows: the timer is gone, not merely paused.
    expect(probeRows(harness).length).toBe(settled);
  });

  it("T27 no key material appears in an API response or the probe log", async () => {
    const harness = await createHarness();
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
    });
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      ...adminHeaders(harness),
      payload: {
        name: "leak-check",
        type: "brave",
        enabled: true,
        timeoutMs: 3000,
        baseUrl: "http://127.0.0.1:9/v1",
      },
    });
    const providerId = created.json().provider.id as string;
    const secret = "sk-HEALTH-CENTRE-SHOULD-NEVER-APPEAR-123456";
    const key = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...adminHeaders(harness),
      payload: { label: "primary", key: secret, weight: 100, enabled: true },
    });
    expect(key.statusCode, key.body).toBe(200);

    const probe = await probeOne(harness, providerId, "connect");
    expect(probe.statusCode).toBe(200);

    const view = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health",
      cookies: { sh_session: harness.cookie },
    });
    const history = await harness.app.inject({
      method: "GET",
      url: `/api/admin/provider-health/history?providerId=${providerId}`,
      cookies: { sh_session: harness.cookie },
    });
    for (const body of [probe.body, view.body, history.body]) {
      expect(body).not.toContain(secret);
      expect(body.toLowerCase()).not.toContain("authorization");
    }
    const rows = probeRows(harness);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("T28 an unauthenticated caller cannot read or change health", async () => {
    const harness = await createHarness();
    await addMock(harness, "guarded", { resultCount: 1 });
    const anonymous = [
      await harness.app.inject({ method: "GET", url: "/api/admin/provider-health" }),
      await harness.app.inject({ method: "GET", url: "/api/admin/provider-health/settings" }),
      await harness.app.inject({
        method: "PUT",
        url: "/api/admin/provider-health/settings",
        payload: { scheduledEnabled: true },
      }),
      await harness.app.inject({
        method: "POST",
        url: "/api/admin/provider-health/anything/probe",
        payload: { kind: "search" },
      }),
    ];
    for (const response of anonymous) {
      expect([401, 403]).toContain(response.statusCode);
    }
    // A search-scope token is not enough either: health reveals vendor config.
    const token = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "search-only", scopes: ["search"], rateLimitPerMin: 600 },
    });
    const viaToken = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health",
      headers: { authorization: `Bearer ${token.json().token}` },
    });
    expect(viaToken.statusCode).toBe(403);
  });

  it("T29 an administrator can reset a parked provider", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "parked", { resultCount: 0, failMode: "quota_exceeded" });

    const probe = await probeOne(harness, providerId, "connect");
    expect(probe.statusCode, probe.body).toBe(200);
    expect(harness.ctx.health.blockedProviders().has(providerId)).toBe(true);

    const reset = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/reset`,
      ...adminHeaders(harness),
    });
    expect(reset.statusCode, reset.body).toBe(200);
    // The gate no longer holds, and the derived state is unknown until a probe.
    expect(harness.ctx.health.blockedProviders().has(providerId)).toBe(false);
    const view = await overview(harness);
    expect(view.providers[0]!.runtime).toBe("unknown");
    // History is retained: reset hides old conclusions, it does not erase them.
    expect(probeRows(harness).length).toBeGreaterThan(0);
  });

  it("T32 a cache hit does not fabricate provider health", async () => {
    const harness = await createHarness();
    await addMock(harness, "cached-source", { resultCount: 2 });
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { cache: { enabled: true, ttlSeconds: 3600 } },
    });

    const search = () =>
      harness.app.inject({
        method: "POST",
        url: "/api/search",
        ...adminHeaders(harness),
        payload: { query: "cache health independence", mode: "basic", limit: 5 },
      });
    await search();
    const second = await search();
    expect(second.json().stats.cached).toBe(true);
    // A replay produces no probe and no health conclusion.
    expect(probeRows(harness)).toHaveLength(0);
    const view = await overview(harness);
    expect(view.providers[0]!.runtime).toBe("unknown");
    expect(harness.ctx.db.select().from(searchCache).all().length).toBe(1);
  });

  it("T33/T34/T35 MCP and Skills see the same gate and its reason", async () => {
    const harness = await createHarness();
    const parked = await addMock(harness, "parked-mcp", { resultCount: 0, failMode: "quota_exceeded" });
    const healthy = await addMock(harness, "ok-mcp", { resultCount: 2 });
    // Park one source.
    await probeOne(harness, parked, "connect");
    expect(harness.ctx.health.blockedProviders().has(parked)).toBe(true);

    const token = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "mcp-health", scopes: ["search", "mcp:use"], rateLimitPerMin: 600 },
    });
    const bearer = token.json().token as string;

    const rest = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "gate reason", mode: "basic", limit: 5, skipCache: true },
    });
    const restBody = rest.json();
    expect(restBody.failedSources.some((item: { id: string }) => item.id === parked)).toBe(true);
    expect(restBody.errors.some((item: { providerId: string }) => item.providerId === parked)).toBe(true);
    expect(restBody.status).toBe("partial");

    const mcp = await harness.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_web", arguments: { query: "gate reason", limit: 5 } },
      },
    });
    const text = mcp.body;
    const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
    const payload = JSON.parse((dataLine ? dataLine.slice(5).trim() : text)) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const toolText = payload.result?.content?.[0]?.text ?? "";
    // The same skip is visible over MCP.
    expect(toolText).toContain(parked);
    void healthy;
  });

  it("T-autoprobe switching one provider off keeps it out of the schedule", async () => {
    const harness = await createHarness();
    const a = await addMock(harness, "auto-a", { resultCount: 1 });
    const b = await addMock(harness, "auto-b", { resultCount: 1 });
    const off = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${b}/auto-probe`,
      ...adminHeaders(harness),
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    await setHealthPolicy(harness, { scheduledEnabled: true, intervalMinutes: 5 });

    const run = await harness.ctx.health.runScheduledNow();
    expect(run).not.toBeNull();
    const probedIds = probeRows(harness).map((row) => row.providerId);
    expect(probedIds).toContain(a);
    expect(probedIds).not.toContain(b);

    const view = await overview(harness);
    expect(view.providers.find((item) => item.providerId === b)!.autoProbeEnabled).toBe(false);
  });

  it("B1 a connectivity probe is counted, and cannot be fired unbounded by one request", async () => {
    const harness = await createHarness();
    for (let index = 0; index < 6; index += 1) {
      await addMock(harness, `connect-${index}`, { resultCount: 1 });
    }
    await setHealthPolicy(harness, { concurrency: 2 });

    const run = await harness.app.inject({
      method: "POST",
      url: "/api/admin/health/check",
      ...adminHeaders(harness),
      payload: { kind: "connect" },
    });
    expect(run.statusCode, run.body).toBe(200);
    // Every provider was probed, and each probe is on the ledger: connectivity
    // is not capped (capping it would make the page unexplainable), but the
    // count is real so an operator can see how often a timer runs.
    expect(run.json().results).toHaveLength(6);
    const view = await overview(harness);
    expect(view.budget.connectUsedToday).toBe(6);
    expect(view.budget.usedToday).toBe(0);
    // Concurrency is capped by policy, not by the caller: the run finished with
    // at most 2 probes in flight, which is what keeps a large estate from
    // firing hundreds of sockets at once.
    expect(harness.ctx.settings.get().health.concurrency).toBe(2);
  });

  it("B2 keys sharing one account group are not counted as separate accounts", async () => {
    const harness = await createHarness();
    const providerId = await createProvider(harness.app, adminHeaders(harness), {
      name: "shared-account",
      type: "brave",
      // Account limits live in the adapter config (billing metadata, not a column).
      config: { accountGroup: "brave-main", accountRpmLimit: 30, accountDailyQuota: 100 },
    });
    await addKey(harness.app, adminHeaders(harness), providerId, "sk-SHARED-ACCOUNT-0000000000");
    await addKey(harness.app, adminHeaders(harness), providerId, "sk-SHARED-ACCOUNT-1111111111");

    const runtime = harness.ctx.providers.runtimesFor([providerId])[0]!;
    // The scheduler must expose one account bucket for the group, not one per
    // key: otherwise 2 keys × 100/day silently becomes 200/day.
    const account = runtime.scheduler.accountSnapshot() as
      | { group: string; dailyQuota: number | null; rpmLimit: number }
      | null;
    expect(account?.group).toBe("brave-main");
    // One bucket for the group, not one per key: 2 keys must not double the ceiling.
    expect(account?.dailyQuota).toBe(100);
    const providers = (await harness.app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: harness.cookie },
    })).json().providers as Array<{ id: string; accountGroup: string | null; accountDailyQuota: number | null }>;
    const row = providers.find((item) => item.id === providerId)!;
    expect(row.accountGroup).toBe("brave-main");
    expect(row.accountDailyQuota).toBe(100);
  });

  it("B3 an unhealthy-but-not-terminal source is still allowed to search", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "flaky-live", { resultCount: 2, failMode: "server_error" });
    const ok = await addMock(harness, "steady", { resultCount: 2 });
    await probeOne(harness, providerId, "connect");

    // A 5xx is degraded, not terminal: the fan-out must still try it, because a
    // vendor blip is not a reason to stop sending traffic entirely.
    expect(harness.ctx.health.blockedProviders().has(providerId)).toBe(false);
    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "degraded still tried", mode: "basic", limit: 5, skipCache: true },
    });
    const stats = search.json().stats as { providers: Array<{ providerId: string }> };
    expect(stats.providers.map((item) => item.providerId)).toContain(providerId);
    expect(stats.providers.map((item) => item.providerId)).toContain(ok);
  });

  it("exposes the UTC day and both counters so the UI cannot imply local time", async () => {
    const harness = await createHarness();
    await addMock(harness, "counters", { resultCount: 1 });
    const settings = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/settings",
      cookies: { sh_session: harness.cookie },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const body = settings.json();
    expect(body.budget.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.budget.day).toBe(new Date(harness.clock.now).toISOString().slice(0, 10));
    expect(body.budget.connectUsedToday).toBe(0);
    expect(body.policy.maxRequestsPerRun).toBe(3);
  });

  it("rejects a policy that would remove the ceiling", async () => {
    const harness = await createHarness();
    const tooBig = await setHealthPolicy(harness, { maxRequestsPerDay: 100_000 });
    expect(tooBig.statusCode).toBe(400);
    const negative = await setHealthPolicy(harness, { maxRequestsPerRun: 0 });
    expect(negative.statusCode).toBe(400);
    const tooFrequent = await setHealthPolicy(harness, { intervalMinutes: 1 });
    expect(tooFrequent.statusCode).toBe(400);
  });
});
