import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProbeBudget } from "../../apps/api/src/services/health-budget.js";
import {
  restartBatchHarness,
  startBatchHarness,
  type BatchHarness,
} from "../helpers/batch-harness.js";
import {
  addKey,
  allowLocalhost,
  closeStubs,
  createProvider,
  startBraveStub,
} from "../helpers/vendor-stubs.js";

const KEY = "sk-CONNECT-BUDGET-TEST-0000000000";
const harnesses: BatchHarness[] = [];
const redirectServers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    redirectServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await closeStubs();
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

function track<T extends BatchHarness>(harness: T): T {
  harnesses.push(harness);
  return harness;
}

async function harness(): Promise<BatchHarness> {
  const value = track(await startBatchHarness());
  await allowLocalhost(value.app, value.write());
  return value;
}

async function setHealth(value: BatchHarness, health: Record<string, unknown>): Promise<void> {
  const response = await value.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...value.write(),
    payload: { health },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function setUpBrave(
  value: BatchHarness,
  baseUrl: string,
  options: { searchConfig?: Record<string, unknown> } = {},
): Promise<{ providerId: string; keyId: string }> {
  const providerId = await createProvider(value.app, value.write(), {
    name: "connect-budget-brave",
    type: "brave",
    baseUrl,
    resultsPerPage: 20,
    ...(options.searchConfig ? { searchConfig: options.searchConfig } : {}),
  });
  await addKey(value.app, value.write(), providerId, KEY);
  const row = value.ctx.sqlite
    .prepare("SELECT id FROM api_keys WHERE provider_id = ?")
    .get(providerId) as { id: string };
  return { providerId, keyId: row.id };
}

function keyFacts(value: BatchHarness, keyId: string) {
  return value.ctx.sqlite
    .prepare(
      "SELECT status, cooldown_until, last_error_code, failure_count, consecutive_failures, request_count FROM api_keys WHERE id = ?",
    )
    .get(keyId) as {
    status: string;
    cooldown_until: string | null;
    last_error_code: string | null;
    failure_count: number;
    consecutive_failures: number;
    request_count: number;
  };
}

function healthRows(value: BatchHarness, providerId: string) {
  return value.ctx.sqlite
    .prepare(
      "SELECT kind, status, detail_json FROM provider_health_checks WHERE provider_id = ? ORDER BY checked_at, id",
    )
    .all(providerId) as Array<{ kind: string; status: string; detail_json: string }>;
}

function billingRows(value: BatchHarness, providerId: string) {
  return value.ctx.sqlite
    .prepare(
      "SELECT health_check_id, budget_kind, budget_day, classification, credential_used, spent FROM provider_health_billing WHERE health_check_id IN (SELECT id FROM provider_health_checks WHERE provider_id = ?) ORDER BY health_check_id",
    )
    .all(providerId) as Array<{
    health_check_id: string;
    budget_kind: string;
    budget_day: string;
    classification: string;
    credential_used: number;
    spent: number;
  }>;
}

function ledgerUsed(value: BatchHarness, kind: string): number {
  const row = value.ctx.sqlite
    .prepare("SELECT used FROM health_probe_budget WHERE kind = ?")
    .get(kind) as { used: number } | undefined;
  return row?.used ?? 0;
}

interface RedirectStub {
  base: string;
  hits(): number;
  targetHits(): number;
  paths(): string[];
}

async function startRedirectStub(
  options: { path?: string; shape?: "brave" | "generic"; onFirstRequest?: () => void } = {},
): Promise<RedirectStub> {
  let hits = 0;
  let targetHits = 0;
  const paths: string[] = [];
  const path = options.path ?? "/res/v1/web/search";
  const server = createServer((request, response) => {
    hits += 1;
    paths.push(request.url ?? "");
    if (request.url?.startsWith(path)) {
      options.onFirstRequest?.();
      response.writeHead(302, { location: "/redirect-target" });
      response.end();
      return;
    }
    if (request.url === "/redirect-target") {
      targetHits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(options.shape === "generic"
          ? { results: [{ title: "redirect target", url: "https://example.org/redirected" }] }
          : {
              web: {
                results: [{ title: "redirect target", url: "https://example.org/redirected" }],
              },
            }),
      );
      return;
    }
    response.writeHead(404).end("not found");
  });
  redirectServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    targetHits: () => targetHits,
    paths: () => [...paths],
  };
}

describe("connectivity probe physical-hop budgets", () => {
  it("S11 a credentialed Brave connect probe uses the search endpoint but only the connect bucket", async () => {
    const value = await harness();
    const stub = await startBraveStub({ results: 2 });
    const { providerId, keyId } = await setUpBrave(value, stub.base);
    await setHealth(value, {
      paidProbesEnabled: true,
      maxRequestsPerRun: 1,
      maxRequestsPerDay: 1,
      connectMaxRequestsPerProbe: 5,
      connectMaxRequestsPerDay: 50,
    });

    const result = await value.ctx.health.checkOne(providerId, { kind: "connect" });

    expect(stub.hits()).toBe(1);
    expect(stub.lastHeaders()["x-subscription-token"]).toBe(KEY);
    expect(result).toMatchObject({
      providerId,
      keyId,
      kind: "connect",
      status: "healthy",
      cause: "ok",
      requests: 1,
      billingUnit: "unknown",
      spent: false,
    });
    expect(value.ctx.health.budget()).toMatchObject({
      usedToday: 0,
      connectUsedToday: 1,
      remainingToday: 1,
      connectRemainingToday: 49,
    });
    expect(
      value.ctx.sqlite.prepare("SELECT kind, used FROM health_probe_budget ORDER BY kind").all(),
    ).toEqual([{ kind: "connect", used: 1 }]);

    const rows = healthRows(value, providerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "connect", status: "healthy" });
    expect(JSON.parse(rows[0]!.detail_json)).toMatchObject({
      cause: "ok",
      requests: 1,
      billingUnit: "unknown",
    });
    expect(billingRows(value, providerId)).toEqual([
      {
        health_check_id: expect.any(String),
        budget_kind: "connect",
        budget_day: value.ctx.health.budget().day,
        classification: "exact",
        credential_used: 1,
        // Billing `spent` means a physical request was attempted, not that the
        // vendor billed one call. The paid bucket above remains untouched.
        spent: 1,
      },
    ]);
  });

  it("S12a Brave pagination stops after two hops and the local refusal is a 429, not a provider failure", async () => {
    const value = await harness();
    const stub = await startBraveStub({ results: 20 });
    const { providerId, keyId } = await setUpBrave(value, stub.base, {
      searchConfig: { targetResults: 50, maxPages: 3, maxRequestsPerSearch: 3 },
    });
    await setHealth(value, {
      connectMaxRequestsPerProbe: 2,
      connectMaxRequestsPerDay: 50,
    });

    const response = await value.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...value.write(),
      payload: { kind: "connect" },
    });

    expect(response.statusCode, response.body).toBe(429);
    expect(response.json().error).toMatchObject({
      code: "quota_exceeded",
      message: expect.stringContaining("2 physical HTTP hops"),
      details: expect.objectContaining({ localBudget: true, limit: 2 }),
    });
    expect(stub.hits()).toBe(2);
    expect(ledgerUsed(value, "connect")).toBe(2);
    expect(healthRows(value, providerId)).toEqual([]);
    expect(billingRows(value, providerId)).toEqual([]);
    expect(value.ctx.health.blockedProviders().has(providerId)).toBe(false);
    expect(keyFacts(value, keyId)).toMatchObject({
      status: "unknown",
      cooldown_until: null,
      last_error_code: null,
      failure_count: 0,
      consecutive_failures: 0,
    });
  });

  it("S12b a redirect consumes one hop and is refused before the redirect target is followed", async () => {
    const value = await harness();
    const stub = await startRedirectStub();
    const { providerId, keyId } = await setUpBrave(value, stub.base);
    await setHealth(value, {
      connectMaxRequestsPerProbe: 1,
      connectMaxRequestsPerDay: 50,
    });

    const response = await value.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...value.write(),
      payload: { kind: "connect" },
    });

    expect(response.statusCode, response.body).toBe(429);
    expect(response.json().error).toMatchObject({
      code: "quota_exceeded",
      message: expect.stringContaining("1 physical HTTP hops"),
      details: expect.objectContaining({ localBudget: true, limit: 1 }),
    });
    expect(stub.hits()).toBe(1);
    expect(stub.targetHits()).toBe(0);
    expect(stub.paths()).toHaveLength(1);
    expect(stub.paths()[0]).toContain("/res/v1/web/search");
    expect(ledgerUsed(value, "connect")).toBe(1);
    expect(healthRows(value, providerId)).toEqual([]);
    expect(billingRows(value, providerId)).toEqual([]);
    expect(keyFacts(value, keyId)).toMatchObject({
      status: "unknown",
      cooldown_until: null,
      last_error_code: null,
      failure_count: 0,
      consecutive_failures: 0,
    });
  });

  it("S12c anonymous generic-http connect is also capped by physical hops", async () => {
    const value = await harness();
    const stub = await startRedirectStub({ path: "/search", shape: "generic" });
    const providerId = await createProvider(value.app, value.write(), {
      name: "anonymous-generic-connect",
      type: "generic-http",
      baseUrl: stub.base,
      config: { path: "/search", resultsPath: "results" },
    });
    await setHealth(value, {
      anonymousMaxRequestsPerRun: 5,
      anonymousMaxRequestsPerDay: 20,
      connectMaxRequestsPerProbe: 1,
      connectMaxRequestsPerDay: 50,
    });

    const response = await value.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...value.write(),
      payload: { kind: "connect" },
    });
    expect(response.statusCode, response.body).toBe(429);
    expect(response.json().error).toMatchObject({
      code: "quota_exceeded",
      message: expect.stringContaining("1 physical HTTP hops"),
    });
    expect(stub.hits()).toBe(1);
    expect(stub.targetHits()).toBe(0);
    expect(ledgerUsed(value, "connect")).toBe(1);
    // The anonymous logical-search reservation is kept because one physical
    // request was sent; the connect reservation is independent.
    expect(ledgerUsed(value, "search_anonymous")).toBe(1);
    expect(healthRows(value, providerId)).toEqual([]);
    expect(billingRows(value, providerId)).toEqual([]);
  });

  it("S12d a connect probe stops at the UTC day boundary instead of charging yesterday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T23:59:59.900Z"));
    try {
      const value = await harness();
      const stub = await startRedirectStub({
        onFirstRequest: () => vi.setSystemTime(new Date("2026-11-22T00:00:00.100Z")),
      });
      const { providerId, keyId } = await setUpBrave(value, stub.base);
      await setHealth(value, {
        connectMaxRequestsPerProbe: 5,
        connectMaxRequestsPerDay: 50,
      });

      const response = await value.app.inject({
        method: "POST",
        url: `/api/admin/providers/${providerId}/test`,
        ...value.write(),
        payload: { kind: "connect" },
      });
      expect(response.statusCode, response.body).toBe(429);
      expect(response.json().error).toMatchObject({
        code: "quota_exceeded",
        message: expect.stringContaining("UTC day boundary"),
      });
      expect(stub.hits()).toBe(1);
      expect(stub.targetHits()).toBe(0);
      expect(
        value.ctx.sqlite.prepare("SELECT day, used FROM health_probe_budget WHERE kind = 'connect'").all(),
      ).toEqual([{ day: "2026-11-21", used: 1 }]);
      expect(healthRows(value, providerId)).toEqual([]);
      expect(billingRows(value, providerId)).toEqual([]);
      expect(keyFacts(value, keyId)).toMatchObject({ status: "unknown", last_error_code: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("S13 the daily connect cap allows one hop, returns 429 on the next probe, and reports a budget skip", async () => {
    const value = await harness();
    const stub = await startBraveStub({ results: 2 });
    const { providerId, keyId } = await setUpBrave(value, stub.base);
    await setHealth(value, {
      connectMaxRequestsPerProbe: 5,
      connectMaxRequestsPerDay: 1,
    });

    const first = await value.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...value.write(),
      payload: { kind: "connect" },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ kind: "connect", requests: 1, cause: "ok" });
    expect(stub.hits()).toBe(1);
    const keyBeforeRefusal = keyFacts(value, keyId);

    const second = await value.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...value.write(),
      payload: { kind: "connect" },
    });
    expect(second.statusCode, second.body).toBe(429);
    expect(second.json().error).toMatchObject({
      code: "quota_exceeded",
      message: expect.stringContaining("1/1"),
    });
    expect(stub.hits()).toBe(1);

    const run = await value.ctx.health.checkMany([providerId], {
      kind: "connect",
      concurrency: 1,
      gapMs: 0,
    });
    expect(run.results).toEqual([]);
    expect(run.skipped).toEqual([
      {
        providerId,
        code: "SKIPPED_BUDGET",
        reason: "budget_exhausted:connect_http_limit",
      },
    ]);
    expect(run.budget).toMatchObject({ connectUsedToday: 1, connectRemainingToday: 0 });
    expect(stub.hits()).toBe(1);
    expect(ledgerUsed(value, "connect")).toBe(1);
    expect(healthRows(value, providerId)).toHaveLength(1);
    expect(keyFacts(value, keyId)).toEqual(keyBeforeRefusal);
  });

  it("S14 one hundred concurrent checkOne calls produce one physical hop and 99 already_running refusals", async () => {
    const value = await harness();
    const stub = await startBraveStub({ results: 2 });
    const { providerId, keyId } = await setUpBrave(value, stub.base);
    await setHealth(value, {
      connectMaxRequestsPerProbe: 5,
      connectMaxRequestsPerDay: 50,
    });

    // All callers enter checkOne in the same turn. The first owns the in-flight
    // slot before its first await; the other 99 must be refused without a timer,
    // socket, budget reservation, health row, or key lease.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, () => value.ctx.health.checkOne(providerId, { kind: "connect" })),
    );
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof value.ctx.health.checkOne>>> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({
      providerId,
      kind: "connect",
      requests: 1,
      billingUnit: "unknown",
      spent: false,
    });
    expect(rejected).toHaveLength(99);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: "already_running", status: 409 });
    }
    expect(stub.hits()).toBe(1);
    expect(stub.peak()).toBe(1);
    expect(ledgerUsed(value, "connect")).toBe(1);
    expect(healthRows(value, providerId)).toHaveLength(1);
    expect(billingRows(value, providerId)).toHaveLength(1);
    expect(keyFacts(value, keyId)).toMatchObject({
      status: "healthy",
      cooldown_until: null,
      last_error_code: null,
      failure_count: 0,
      consecutive_failures: 0,
      request_count: 1,
    });
  });

  it("S14b ProbeBudget admits only the remaining daily slots under 100 concurrent reservations", async () => {
    const value = await harness();
    const ledger = new ProbeBudget(value.ctx.db);
    const options = {
      paidProbesEnabled: false,
      maxPerRun: 100,
      maxPerDay: 100,
      connectMaxPerProbe: 5,
      connectMaxPerDay: 7,
    };

    const reservations = await Promise.all(
      Array.from({ length: 100 }, async () => ledger.reserve({ kind: "connect", ...options })),
    );

    expect(reservations.filter((reservation) => reservation.ok)).toHaveLength(7);
    const denied = reservations.filter((reservation) => !reservation.ok);
    expect(denied).toHaveLength(93);
    for (const reservation of denied) expect(reservation.reason).toBe("day_limit");
    expect(ledger.snapshot(options)).toMatchObject({
      connectUsedToday: 7,
      connectRemainingToday: 0,
    });
  });

  it("S15 connectUsedToday survives a harness restart on the same SQLite file", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T12:00:00.000Z"));
    try {
      const value = await harness();
      const stub = await startBraveStub({ results: 2 });
      const { providerId, keyId } = await setUpBrave(value, stub.base);
      await setHealth(value, {
        connectMaxRequestsPerProbe: 5,
        connectMaxRequestsPerDay: 1,
      });

      const first = await value.ctx.health.checkOne(providerId, { kind: "connect" });
      expect(first.requests).toBe(1);
      expect(stub.hits()).toBe(1);
      const day = value.ctx.health.budget().day;
      const keyBeforeRestart = keyFacts(value, keyId);
      await value.stop();

      const restarted = track(await restartBatchHarness(value));
      expect(restarted.dbPath).toBe(value.dbPath);
      expect(restarted.ctx.health.budget()).toMatchObject({
        day,
        connectMaxPerDay: 1,
        connectUsedToday: 1,
        connectRemainingToday: 0,
        usedToday: 0,
      });
      expect(
        restarted.ctx.sqlite
          .prepare("SELECT day, kind, used FROM health_probe_budget WHERE kind = 'connect'")
          .get(),
      ).toEqual({ day, kind: "connect", used: 1 });

      const refused = await restarted.app.inject({
        method: "POST",
        url: `/api/admin/providers/${providerId}/test`,
        ...restarted.write(),
        payload: { kind: "connect" },
      });
      expect(refused.statusCode, refused.body).toBe(429);
      expect(refused.json().error.code).toBe("quota_exceeded");
      expect(stub.hits()).toBe(1);
      expect(healthRows(restarted, providerId)).toHaveLength(1);
      expect(keyFacts(restarted, keyId)).toEqual(keyBeforeRestart);
    } finally {
      vi.useRealTimers();
    }
  });
});
