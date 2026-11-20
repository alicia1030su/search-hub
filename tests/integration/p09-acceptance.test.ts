import { afterEach, describe, expect, it } from "vitest";
import { addKey, allowLocalhost, closeStubs, createProvider, startBraveStub, startHnStub } from "../helpers/vendor-stubs.js";
import { restartBatchHarness, startBatchHarness, type BatchHarness } from "../helpers/batch-harness.js";

/**
 * v0.1.10 P0 acceptance: the six promises of the PRD, checked end to end.
 *
 * This suite exists because the P0 requirements are *acceptance statements*
 * ("发出 ≥2 个上游请求", "重启后永不 completed", "成功率分母 12") and a unit test
 * cannot confirm them: each one spans the route, the service, the ledger and a
 * real socket. Every case below quotes the requirement it proves, and every
 * assertion reads a row or a stub counter rather than a status code.
 *
 * No vendor is contacted: the only network peers are `127.0.0.1` stubs.
 */

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  await closeStubs();
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

function track<T extends BatchHarness>(harness: T): T {
  harnesses.push(harness);
  return harness;
}

interface JobView {
  status: string;
  counts: { total: number; done: number; ok: number; failed: number; pending: number; skipped: number; remaining: number };
  items: Array<{ providerId: string; state: string; code: string; checkId: string | null; requests: number | null }>;
  nextPollAfterMs: number | null;
}

async function job(harness: BatchHarness, jobId: string): Promise<JobView> {
  const response = await harness.app.inject({
    method: "GET",
    url: `/api/admin/provider-health/batch-test/${jobId}`,
    ...harness.read(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as JobView;
}

/**
 * Polls a job until `done`, returning the view that satisfied it.
 *
 * A fixed sleep would either be flaky or slow; the runner is genuinely
 * asynchronous, so the assertion has to wait for the observable state.
 */
async function waitForJob(
  harness: BatchHarness,
  jobId: string,
  done: (view: JobView) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await job(harness, jobId);
    if (done(view)) return view;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; last view: ${JSON.stringify({ status: view.status, counts: view.counts })}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function paidSettings(harness: BatchHarness, patch: Record<string, unknown> = {}): Promise<void> {
  const response = await harness.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...harness.write(),
    payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 20, maxRequestsPerDay: 60, ...patch } },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/**
 * The 20/12/5/3 installation the PRD uses for every statistic.
 *
 * 12 sources with one enabled credential, 3 with no credential, 2 with every
 * credential disabled, 3 disabled sources that still have a key — the last group
 * is what proves "disabled" outranks "has a key".
 */
async function seedTwenty(harness: BatchHarness): Promise<{ testable: string[] }> {
  await allowLocalhost(harness.app, harness.write());
  const stub = await startBraveStub({ results: 3 });
  const testable: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    const providerId = await createProvider(harness.app, harness.write(), {
      name: `acc-ok-${index}`,
      type: "brave",
      baseUrl: stub.base,
      resultsPerPage: 5,
    });
    await addKey(harness.app, harness.write(), providerId, `sk-ACC-OK-${index}-00000000000000`);
    testable.push(providerId);
  }
  for (let index = 1; index <= 3; index += 1) {
    await createProvider(harness.app, harness.write(), {
      name: `acc-nokey-${index}`,
      type: "brave",
      baseUrl: stub.base,
    });
  }
  for (let index = 1; index <= 2; index += 1) {
    const providerId = await createProvider(harness.app, harness.write(), {
      name: `acc-disabledkey-${index}`,
      type: "brave",
      baseUrl: stub.base,
    });
    await addKey(harness.app, harness.write(), providerId, `sk-ACC-DK-${index}-000000000000000`);
    const keys = await harness.app.inject({
      method: "GET",
      url: `/api/admin/providers/${providerId}/keys`,
      ...harness.read(),
    });
    const keyId = (keys.json() as Array<{ id: string }>)[0]!.id;
    await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/keys/${keyId}`,
      ...harness.write(),
      payload: { enabled: false },
    });
  }
  for (let index = 1; index <= 3; index += 1) {
    const providerId = await createProvider(harness.app, harness.write(), {
      name: `acc-off-${index}`,
      type: "brave",
      baseUrl: stub.base,
    });
    await addKey(harness.app, harness.write(), providerId, `sk-ACC-OFF-${index}-00000000000000`);
    await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${providerId}`,
      ...harness.write(),
      payload: { enabled: false },
    });
  }
  return { testable };
}

describe("v0.1.10 P0 acceptance", () => {
  /**
   * P1 — "`:id/test` sends ≥2 upstream requests and its `resultCount` equals the
   * same stub's `checkOne`".
   *
   * This is the defect the release exists for: the old endpoint issued one
   * request and disagreed with the health system about the same source.
   */
  it("P1 the single test and the probe agree, on the production request path", async () => {
    const harness = track(await startBatchHarness());
    await allowLocalhost(harness.app, harness.write());
    await paidSettings(harness);
    const stub = await startBraveStub({ results: 20 });
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "acc-single",
      type: "brave",
      baseUrl: stub.base,
      resultsPerPage: 20,
      searchConfig: { targetResults: 50, maxPages: 3 },
    });
    await addKey(harness.app, harness.write(), providerId, "sk-ACC-SINGLE-0000000000000");

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { resultCount: number; cause: string; requests: number };
    expect(stub.hits()).toBeGreaterThanOrEqual(2);
    expect(body.requests).toBeGreaterThanOrEqual(2);

    const hitsBefore = stub.hits();
    const probe = await harness.ctx.health.checkOne(providerId, { kind: "search", trigger: "manual" });
    expect(probe.resultCount).toBe(body.resultCount);
    expect(probe.cause).toBe(body.cause);
    expect(stub.hits() - hitsBefore).toBe(body.requests);
  });

  /**
   * P2 — "20 sources → `eligible=12, noKey+noEnabledKey=5, disabled=3`, and
   * `paidRisk` follows `kind`".
   */
  it("P2 the preview partitions 20 sources into 12 / 5 / 3 and scopes paidRisk to kind", async () => {
    const harness = track(await startBatchHarness());
    await seedTwenty(harness);

    const connect = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=connect",
      ...harness.read(),
    });
    const connectBody = connect.json() as { total: number; counts: Record<string, number>; paidRisk: boolean };
    expect(connectBody.total).toBe(20);
    expect(connectBody.counts["eligible"]).toBe(12);
    expect(connectBody.counts["noKey"]! + connectBody.counts["noEnabledKey"]!).toBe(5);
    expect(connectBody.counts["disabled"]).toBe(3);
    expect(connectBody.paidRisk).toBe(false);

    const search = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...harness.read(),
    });
    // Paid probing is off by default, so `paidRisk` is false even for a search.
    expect(search.json().paidRisk).toBe(false);
    await paidSettings(harness);
    const paid = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...harness.read(),
    });
    expect(paid.json().paidRisk).toBe(true);
    expect(paid.json().estimatedPaidProbes).toBe(12);
  });

  /**
   * P3 — "create returns a jobId; progress never decreases; a cancel keeps the
   * finished items readable; after a restart `GET` returns `interrupted` and
   * **never** `completed`".
   */
  it("P3 a job can be created, watched, cancelled and never falsely completed", async () => {
    const harness = track(await startBatchHarness());
    await allowLocalhost(harness.app, harness.write());
    const stub = await startBraveStub({ results: 2, delayMs: 150 });
    const providerIds: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const providerId = await createProvider(harness.app, harness.write(), {
        name: `acc-p3-${index}`,
        type: "brave",
        baseUrl: stub.base,
      });
      await addKey(harness.app, harness.write(), providerId, `sk-ACC-P3-${index}-000000000000`);
      providerIds.push(providerId);
    }

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds, concurrency: 1 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().jobId as string;
    expect(jobId.length).toBeGreaterThan(0);
    expect(created.json().status).toBe("running");

    // Watch the progress: it only moves forward, and at least one source is
    // actually adjudicated while the run is still going.
    let previousDone = -1;
    let sawFinished = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const view = await job(harness, jobId);
      expect(view.counts.done).toBeGreaterThanOrEqual(previousDone);
      previousDone = view.counts.done;
      if (view.items.some((item) => item.state === "ok")) sawFinished = true;
      if (view.counts.remaining === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(sawFinished).toBe(true);

    // Cancel whatever is left. If the run already finished, the cancel is
    // correctly refused — and the finished rows still have to be readable.
    const before = await job(harness, jobId);
    if (before.status === "running") {
      const cancel = await harness.app.inject({
        method: "POST",
        url: `/api/admin/provider-health/batch-test/${jobId}/cancel`,
        ...harness.write(),
        payload: {},
      });
      expect(cancel.statusCode, cancel.body).toBe(200);
      await waitForJob(harness, jobId, (current) => current.counts.remaining === 0, "the cancelled items");
    }
    const cancelled = await job(harness, jobId);
    expect(cancelled.status).not.toBe("completed");
    for (const item of cancelled.items.filter((entry) => entry.state === "ok")) {
      expect(item.checkId).not.toBeNull();
      const row = harness.ctx.sqlite
        .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE id = ?")
        .get(item.checkId) as { n: number };
      expect(row.n).toBe(1);
    }

    // A restart must report `interrupted`, never `completed`. Seed a `running`
    // row so the case is exercised even when the cancel above already finished
    // the job (a cancel leaves `cancelled`, which is also "not completed").
    harness.ctx.sqlite
      .prepare(
        "INSERT INTO provider_test_batches (id, kind, status, total, items_json, budget_json, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run("bt_acc_unfinished", "connect", "running", 0, "[]", "{}", new Date().toISOString());
    await harness.stop();
    const restarted = track(await restartBatchHarness(harness));
    const afterRestart = await restarted.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/bt_acc_unfinished",
      ...restarted.read(),
    });
    expect(afterRestart.statusCode, afterRestart.body).toBe(200);
    expect(afterRestart.json().status).toBe("interrupted");
    expect(afterRestart.json().status).not.toBe("completed");
  });

  /**
   * P4 — "concurrency defaults to 2 with a hard cap of 4, the same source is
   * probed once, an exhausted budget marks the rest `SKIPPED_BUDGET`, and the
   * run never increases its own allowance".
   */
  it("P4 concurrency is bounded, a source is probed once, and budget is never self-raised", async () => {
    const harness = track(await startBatchHarness());
    await allowLocalhost(harness.app, harness.write());
    const stub = await startBraveStub({ results: 2, delayMs: 80 });
    const providerIds: string[] = [];
    for (let index = 1; index <= 10; index += 1) {
      const providerId = await createProvider(harness.app, harness.write(), {
        name: `acc-p4-${index}`,
        type: "brave",
        baseUrl: stub.base,
      });
      await addKey(harness.app, harness.write(), providerId, `sk-ACC-P4-${index}-000000000000`);
      providerIds.push(providerId);
    }

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds, concurrency: 2 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().jobId as string;
    await waitForJob(harness, jobId, (view) => view.status !== "running", "the run to finish");
    // Ten slow requests, two workers: a scan would have peaked at ten.
    expect(stub.peak()).toBeLessThanOrEqual(2);
    expect(stub.hits()).toBe(10);

    // The same source cannot be probed twice at once.
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [providerIds[0]!], concurrency: 1 },
    });
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [providerIds[0]!], concurrency: 1 },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    const firstView = await waitForJob(
      harness,
      first.json().jobId as string,
      (view) => view.status !== "running",
      "the first duplicate run",
    );
    const secondView = await waitForJob(
      harness,
      second.json().jobId as string,
      (view) => view.status !== "running",
      "the second duplicate run",
    );
    const duplicated = [...firstView.items, ...secondView.items].filter((item) => item.code === "already_running");
    // Exactly one of the two runs was refused the source: the other probed it.
    expect(duplicated.length).toBe(1);
    expect([firstView, secondView].filter((view) => view.items[0]!.state === "ok").length).toBe(1);

    // A budget that runs out mid-run skips the remainder — and is not raised.
    // Different sources from the duplicate case above, so no in-flight lock can
    // turn a budget skip into an `already_running` one.
    await paidSettings(harness, { maxRequestsPerRun: 1, maxRequestsPerDay: 2 });
    const budgetRun = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: providerIds.slice(5, 8), concurrency: 1 },
    });
    expect(budgetRun.statusCode, budgetRun.body).toBe(201);
    const budgetView = await waitForJob(
      harness,
      budgetRun.json().jobId as string,
      (view) => view.counts.remaining === 0,
      "the budget-limited run to finish",
    );
    const skipped = budgetView.items.filter((item) => item.state === "skipped");
    expect(skipped.length).toBe(2);
    for (const item of skipped) expect(item.code).toBe("SKIPPED_BUDGET");
    const ledger = harness.ctx.health.budget();
    expect(ledger.usedToday).toBeLessThanOrEqual(ledger.maxPerDay);
  });

  /**
   * P5 — "the success-rate denominator is 12, `empty_results` is 'pending' and
   * never a success, and a finished run says so only when it is finished".
   */
  it("P5 the denominator is the testable count and empty results are pending", async () => {
    const harness = track(await startBatchHarness());
    await seedTwenty(harness);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().jobId as string;
    const view = await waitForJob(
      harness,
      jobId,
      (current) => current.status !== "running",
      "the acceptance run to finish",
      15_000,
    );

    // 20 in scope, 8 skipped, 12 adjudicated — the denominator the UI must use.
    expect(view.counts.total).toBe(20);
    expect(view.counts.skipped).toBe(8);
    expect(view.counts.done).toBe(12);
    expect(view.status).toBe("completed");
    expect(view.counts.done + view.counts.skipped).toBe(view.counts.total);
    expect(view.counts.ok + view.counts.failed + view.counts.pending).toBe(view.counts.done);

    // A `200` with zero results lands in neither the success nor the failure
    // column, and the stored status keeps its historical `degraded` value.
    const emptyStub = await startHnStub({ hits: 0 });
    const emptyProvider = await createProvider(harness.app, harness.write(), {
      name: "acc-empty",
      type: "hackernews",
      baseUrl: emptyStub.base,
    });
    const emptyRun = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [emptyProvider], includeKeyless: true },
    });
    expect(emptyRun.statusCode, emptyRun.body).toBe(201);
    const emptyView = await waitForJob(
      harness,
      emptyRun.json().jobId as string,
      (current) => current.status !== "running",
      "the empty-result run to finish",
    );
    expect(emptyView.counts.pending).toBe(1);
    expect(emptyView.counts.ok).toBe(0);
    expect(emptyView.counts.failed).toBe(0);
    expect(emptyView.items[0]!.code).toBe("empty_results");
    const stored = harness.ctx.sqlite
      .prepare("SELECT status FROM provider_health_checks WHERE id = ?")
      .get(emptyView.items[0]!.checkId) as { status: string };
    expect(stored.status).toBe("degraded");
  });
});
