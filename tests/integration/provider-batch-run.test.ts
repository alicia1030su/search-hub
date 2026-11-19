import { afterEach, describe, expect, it } from "vitest";
import { addKey, allowLocalhost, closeStubs, createProvider, startBraveStub, startHnStub } from "../helpers/vendor-stubs.js";
import {
  restartBatchHarness,
  rowCount,
  startBatchHarness,
  waitFor,
  type BatchHarness,
} from "../helpers/batch-harness.js";

/**
 * The bulk run itself: progress, ordering, cancellation, the budget and what a
 * restart does to a run that was still going.
 *
 * Every assertion reads the database or a real local stub — never an HTTP 200
 * alone. A response can be right for the wrong reason (a runner that wrote
 * nothing still returns a plausible `counts` object), so the tests check the
 * row the response claims to describe.
 */

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  await closeStubs();
  // Reverse order: a restarted harness shares the first one's database file, so
  // it has to be closed before the owner deletes the directory.
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

function track<T extends BatchHarness>(harness: T): T {
  harnesses.push(harness);
  return harness;
}

interface ItemView {
  providerId: string;
  providerName: string;
  state: "ok" | "failed" | "pending" | "skipped" | "unknown";
  code: string;
  latencyMs: number | null;
  resultCount: number | null;
  requests: number | null;
  checkId: string | null;
  reason: string | null;
}

interface JobView {
  jobId: string;
  status: string;
  kind: string;
  counts: { total: number; done: number; ok: number; failed: number; pending: number; skipped: number; remaining: number };
  items: ItemView[];
  concurrency: number;
  startedAt: string | null;
  finishedAt: string | null;
  nextPollAfterMs: number | null;
}

async function getJob(harness: BatchHarness, jobId: string): Promise<JobView> {
  const response = await harness.app.inject({
    method: "GET",
    url: `/api/admin/provider-health/batch-test/${jobId}`,
    ...harness.read(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as JobView;
}

async function startJob(
  harness: BatchHarness,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/provider-health/batch-test",
    ...harness.write(),
    payload,
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** Enables paid probing with a generous budget. */
async function enablePaid(harness: BatchHarness, patch: Record<string, unknown> = {}): Promise<void> {
  await harness.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...harness.write(),
    payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 10, maxRequestsPerDay: 50, ...patch } },
  });
}

async function allowLocal(harness: BatchHarness): Promise<void> {
  await allowLocalhost(harness.app, harness.write());
}

/** Providers all sharing one Brave-shaped stub, each with its own key. */
async function addBraveGroup(
  harness: BatchHarness,
  names: string[],
  options: { delayMs?: number; results?: number } = {},
): Promise<{ providerIds: string[]; stub: Awaited<ReturnType<typeof startBraveStub>> }> {
  const stub = await startBraveStub({ results: options.results ?? 2, ...(options.delayMs ? { delayMs: options.delayMs } : {}) });
  const providerIds: string[] = [];
  for (const [index, name] of names.entries()) {
    const providerId = await createProvider(harness.app, harness.write(), {
      name,
      type: "brave",
      baseUrl: stub.base,
      resultsPerPage: 5,
    });
    await addKey(harness.app, harness.write(), providerId, `sk-BATCH-${index}-${name}-0000000000`);
    providerIds.push(providerId);
  }
  return { providerIds, stub };
}

describe("batch run lifecycle", () => {
  /** T10 — a run is created and immediately pollable. */
  it("T10 create returns a jobId, running status and the concurrency in use", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds, stub } = await addBraveGroup(harness, ["t10-a", "t10-b"]);

    const created = await startJob(harness, {
      kind: "connect",
      providerIds,
      concurrency: 2,
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(String(created.body["jobId"]).length).toBeGreaterThan(0);
    expect(created.body["status"]).toBe("running");
    expect(created.body["total"]).toBe(2);
    expect(created.body["concurrency"]).toBe(2);

    // The row it claims to describe really exists, with the same total.
    const row = harness.ctx.sqlite
      .prepare("SELECT total, concurrency, status FROM provider_test_batches WHERE id = ?")
      .get(created.body["jobId"]) as { total: number; concurrency: number; status: string };
    expect(row.total).toBe(2);
    expect(row.concurrency).toBe(2);
    expect(row.status).toBe("running");

    const view = await getJob(harness, created.body["jobId"] as string);
    expect(view.counts.total).toBe(2);
    expect(view.nextPollAfterMs).toBe(1000);
    await waitFor(() => stub.hits() >= 2, { label: "both probes to reach the stub" });
  });

  /**
   * T11 — a finished item is readable while the run is still going.
   *
   * This is the property that makes the progress table useful at all: without it
   * the operator stares at an empty table for the whole run.
   */
  it("T11 finished items are readable while the run is still running", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    // A slow stub + one worker: the first item is guaranteed to finish before the
    // last one starts.
    const { providerIds } = await addBraveGroup(harness, ["t11-a", "t11-b", "t11-c"], { delayMs: 250 });
    const created = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const jobId = created.body["jobId"] as string;

    const view = await waitForJob(harness, jobId, (current) => current.counts.done >= 1, "one completed item");
    expect(view.status).toBe("running");
    const finished = view.items.filter((item) => item.state === "ok");
    expect(finished.length).toBeGreaterThanOrEqual(1);
    // The item carries a health row id the operator can open, and a request count.
    expect(finished[0]!.checkId).not.toBeNull();
    expect(finished[0]!.requests).toBeGreaterThanOrEqual(1);

    // …and that health row exists: the conclusion lives in the probe log, not in
    // the batch table.
    const health = harness.ctx.sqlite
      .prepare("SELECT id, batch_id, detail_json FROM provider_health_checks WHERE id = ?")
      .get(finished[0]!.checkId) as { id: string; batch_id: string | null; detail_json: string };
    expect(health.batch_id).toBe(jobId);
    expect(JSON.parse(health.detail_json).cause).toBe("ok");

    await waitFor(() => view.counts.remaining > 0, { label: "at least one item still pending" });
  });

  /**
   * T12 — counters never go backwards and never over-claim.
   *
   * A progress bar built on a decreasing counter is worse than no progress bar:
   * it tells the operator the run is further along than it is.
   */
  it("T12 counts are monotonic and never exceed the total", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds } = await addBraveGroup(harness, ["t12-a", "t12-b", "t12-c", "t12-d"], { delayMs: 120 });
    const created = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const jobId = created.body["jobId"] as string;

    let previousDone = -1;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const view = await getJob(harness, jobId);
      expect(view.counts.done).toBeGreaterThanOrEqual(previousDone);
      expect(view.counts.done + view.counts.skipped).toBeLessThanOrEqual(view.counts.total);
      previousDone = view.counts.done;
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    expect(previousDone).toBeGreaterThanOrEqual(0);
  });

  /**
   * T13 — cancelling ends the run without erasing what it already learned.
   *
   * A cancel is an operational decision, not a reason to discard evidence: the
   * operator who cancels a slow run still wants to know which sources answered.
   */
  it("T13 cancel keeps finished items readable and marks the rest cancelled", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds } = await addBraveGroup(
      harness,
      ["t13-a", "t13-b", "t13-c", "t13-d", "t13-e"],
      { delayMs: 200 },
    );
    const created = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const jobId = created.body["jobId"] as string;

    const before = await waitForJob(harness, jobId, (view) => view.counts.done >= 1, "one completed item");
    expect(before.status).toBe("running");
    const finished = before.items.filter((item) => item.state === "ok");

    const cancel = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/batch-test/${jobId}/cancel`,
      ...harness.write(),
      payload: {},
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
    expect(cancel.json().skippedRemaining).toBeGreaterThan(0);

    // The tracker records the cancellation for every unfinished source…
    const after = await waitForJob(
      harness,
      jobId,
      (view) => view.counts.remaining === 0,
      "the remaining items to be reported as cancelled",
    );
    expect(after.status).toBe("cancelled");
    expect(after.status).not.toBe("completed");
    const cancelled = after.items.filter((item) => item.code === "SKIPPED_CANCELLED");
    expect(cancelled.length).toBeGreaterThan(0);
    for (const item of cancelled) {
      expect(item.state).toBe("skipped");
      // Cancelled items were never adjudicated, so they carry no conclusion.
      expect(item.checkId).toBeNull();
    }

    // …and the finished ones are untouched: same check id, still readable.
    for (const item of finished) {
      const row = after.items.find((entry) => entry.providerId === item.providerId)!;
      expect(row.state).toBe("ok");
      expect(row.checkId).toBe(item.checkId);
      const health = harness.ctx.sqlite
        .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE id = ?")
        .get(row.checkId) as { n: number };
      expect(health.n).toBe(1);
    }
  });

  /**
   * T14 — a restart marks a run in progress as interrupted, never completed.
   *
   * This is the single most important promise of the ledger: a process that died
   * mid-run must not be reported as having finished, because a "completed" run
   * with half its sources unprobed is a lie the UI would repeat.
   */
  it("T14 a restart marks the run interrupted and never completed", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds } = await addBraveGroup(harness, ["t14-a", "t14-b", "t14-c"], { delayMs: 300 });
    const created = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const jobId = created.body["jobId"] as string;

    // Wait until the run has genuinely started and made progress, then kill it
    // the way a crash does: no graceful finalisation, no closing handshake.
    await waitForJob(harness, jobId, (view) => view.counts.done >= 1, "one completed item");
    const beforeCrash = harness.ctx.sqlite
      .prepare("SELECT status FROM provider_test_batches WHERE id = ?")
      .get(jobId) as { status: string };
    expect(beforeCrash.status).toBe("running");

    await harness.stop();

    // A new process on the same database: the constructor sweeps the row.
    const restarted = track(await restartBatchHarness(harness));
    const view = await getJob(restarted, jobId);
    expect(view.status).toBe("interrupted");
    expect(view.status).not.toBe("completed");
    expect(view.finishedAt).not.toBeNull();
    // The completed items are still there; the rest were never resolved.
    expect(view.counts.done).toBeGreaterThanOrEqual(1);
    expect(view.counts.remaining).toBeGreaterThan(0);
    expect(view.nextPollAfterMs).toBeNull();
  });

  /**
   * T15 — the sweep is idempotent.
   *
   * Running it every boot must not keep rewriting `finished_at`, which would
   * make the recorded end time drift on every restart.
   */
  it("T15 the startup sweep is idempotent", async () => {
    const harness = track(await startBatchHarness());
    const jobId = "bt_manual_running";
    harness.ctx.sqlite
      .prepare(
        "INSERT INTO provider_test_batches (id, kind, status, total, items_json, budget_json, created_at) " +
          "VALUES (?,?,?,?,?,?,?)",
      )
      .run(jobId, "connect", "running", 0, "[]", "{}", new Date().toISOString());

    const first = harness.ctx.batch.sweepInterrupted(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(first).toBe(1);
    const firstRow = harness.ctx.sqlite
      .prepare("SELECT status, finished_at FROM provider_test_batches WHERE id = ?")
      .get(jobId) as { status: string; finished_at: string };
    expect(firstRow.status).toBe("interrupted");
    expect(firstRow.finished_at).toBe("2026-01-01T00:00:00.000Z");

    // Second call: nothing left to match, and nothing changes.
    const second = harness.ctx.batch.sweepInterrupted(Date.parse("2026-01-01T01:00:00.000Z"));
    expect(second).toBe(0);
    const secondRow = harness.ctx.sqlite
      .prepare("SELECT status, finished_at FROM provider_test_batches WHERE id = ?")
      .get(jobId) as { status: string; finished_at: string };
    expect(secondRow.status).toBe("interrupted");
    expect(secondRow.finished_at).toBe(firstRow.finished_at);
  });
});

describe("batch run concurrency and budget", () => {
  /** T16 — the in-flight count never exceeds the configured concurrency. */
  it("T16 in-flight probes never exceed the configured concurrency", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const names = Array.from({ length: 12 }, (_, index) => `t16-${index + 1}`);
    const { providerIds, stub } = await addBraveGroup(harness, names, { delayMs: 90 });

    const created = await startJob(harness, { kind: "connect", providerIds, concurrency: 2 });
    const jobId = created.body["jobId"] as string;
    await waitForJob(harness, jobId, (view) => view.status === "completed", "the run to finish", 20_000);

    // Two workers, twelve slow requests: a run that fired them all at once would
    // have shown a peak of twelve.
    expect(stub.peak()).toBeLessThanOrEqual(2);
    expect(stub.hits()).toBe(12);
  });

  /** T17 — the concurrency ceiling is enforced at the edge and clamped in the runner. */
  it("T17 rejects concurrency above 4 and accepts exactly 4", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds } = await addBraveGroup(harness, ["t17-a", "t17-b", "t17-c", "t17-d", "t17-e"], {
      delayMs: 60,
    });

    const tooMany = await startJob(harness, { kind: "connect", providerIds, concurrency: 5 });
    expect(tooMany.statusCode, JSON.stringify(tooMany.body)).toBe(400);
    const error = tooMany.body as { error?: { code?: string } };
    expect(error.error?.code).toBe("validation_error");
    // Nothing was written: a rejected request must not leave a run behind.
    expect(rowCount(harness.ctx, "provider_test_batches")).toBe(0);

    const exact = await startJob(harness, { kind: "connect", providerIds, concurrency: 4 });
    expect(exact.statusCode, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body["concurrency"]).toBe(4);
    const row = harness.ctx.sqlite
      .prepare("SELECT concurrency FROM provider_test_batches WHERE id = ?")
      .get(exact.body["jobId"]) as { concurrency: number };
    expect(row.concurrency).toBe(4);
  });

  /**
   * T18 — one source is probed by one run at a time.
   *
   * Two concurrent bulk runs over the same source would pay twice for one
   * answer; the second must be recorded as `already_running`, not re-sent.
   */
  it("T18 a second job records the shared source as already_running", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds, stub } = await addBraveGroup(harness, ["t18-shared"], { delayMs: 300 });

    const first = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const firstId = first.body["jobId"] as string;
    await waitFor(() => harness.ctx.health.isProbing(providerIds[0]!), {
      label: "the first probe to hold the lock",
    });
    // Wait for the first request to actually arrive, so the count below is a
    // fixed baseline rather than "one request has maybe been sent".
    await waitFor(() => stub.hits() >= 1, { label: "the first request to reach the stub" });
    const hitsBeforeSecond = stub.hits();

    const second = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const secondId = second.body["jobId"] as string;
    const secondView = await waitForJob(
      harness,
      secondId,
      (view) => view.counts.remaining === 0,
      "the second job to resolve its only item",
    );

    const item = secondView.items[0]!;
    expect(item.code).toBe("already_running");
    expect(item.state).toBe("skipped");
    expect(item.checkId).toBeNull();
    // The duplicate never reached the wire: the stub's hit count did not move
    // while the second job ran.
    expect(stub.hits()).toBe(hitsBeforeSecond);

    const firstView = await waitForJob(harness, firstId, (view) => view.status === "completed", "the first job", 10_000);
    expect(firstView.items[0]!.state).toBe("ok");
    // Exactly one request for one answer, even though two runs asked for it.
    expect(stub.hits()).toBe(1);
  });

  /**
   * T19 — an exhausted run budget turns the remainder into skips, not failures.
   *
   * Calling a budget skip a failure would make a healthy source look broken and
   * would pollute the "retry the failures" set.
   */
  it("T19 budget exhaustion skips the remainder with budget_exhausted", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds } = await addBraveGroup(harness, ["t19-a", "t19-b", "t19-c"]);
    // Two paid probes allowed in total: the first one succeeds, the rest cannot
    // be afforded — while the run itself is still allowed to start.
    await enablePaid(harness, { maxRequestsPerRun: 1, maxRequestsPerDay: 2 });

    const created = await startJob(harness, { kind: "search", providerIds, concurrency: 1 });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const jobId = created.body["jobId"] as string;
    const view = await waitForJob(harness, jobId, (current) => current.counts.remaining === 0, "the run to finish", 10_000);

    const skipped = view.items.filter((item) => item.state === "skipped");
    expect(skipped.length).toBe(2);
    for (const item of skipped) {
      expect(item.code).toBe("SKIPPED_BUDGET");
      expect(item.reason).toContain("budget_exhausted");
    }
    expect(view.counts.ok).toBe(1);
    // The ledger was not overspent: one probe for the run, and the day counter
    // reflects exactly that.
    const budget = harness.ctx.health.budget();
    expect(budget.usedToday).toBe(1);
    expect(budget.usedToday).toBeLessThanOrEqual(budget.maxPerDay);
  });
});

describe("batch run classification", () => {
  /** T20 — the success-rate denominator excludes skips. */
  it("T20 the denominator is the testable count, not the scope", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    await enablePaid(harness, { maxRequestsPerRun: 20, maxRequestsPerDay: 50 });
    await addBraveGroup(harness, ["t20-ok"]);
    // One keyless source (testable), one source with no key (skipped), one
    // disabled source (skipped).
    const keyless = await startHnStub({ hits: 2 });
    await createProvider(harness.app, harness.write(), {
      name: "t20-keyless",
      type: "hackernews",
      baseUrl: keyless.base,
    });
    await createProvider(harness.app, harness.write(), {
      name: "t20-nokey",
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });
    const disabled = await addBraveGroup(harness, ["t20-disabled"]);
    await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${disabled.providerIds[0]!}`,
      ...harness.write(),
      payload: { enabled: false },
    });

    const created = await startJob(harness, { kind: "connect" });
    const jobId = created.body["jobId"] as string;
    const view = await waitForJob(harness, jobId, (current) => current.status !== "running", "the run to finish", 10_000);

    const preview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=connect",
      ...harness.read(),
    });
    const previewBody = preview.json() as { total: number; counts: Record<string, number> };
    const testable = previewBody.counts["eligible"]! + previewBody.counts["configError"]!;
    const skipped = previewBody.counts["disabled"]! + previewBody.counts["noKey"]! + previewBody.counts["noEnabledKey"]!;

    expect(view.counts.total).toBe(previewBody.total);
    expect(skipped).toBe(2);
    expect(testable).toBe(2);
    // The run's own numbers must agree with the preview it was confirmed from.
    expect(view.counts.skipped).toBe(skipped);
    expect(view.counts.done).toBe(testable);
    // A success rate over the whole scope would be 2/4; over the testable sources
    // it is 2/2. The run reports `done`, so the UI divides by the testable count.
    expect(view.counts.ok + view.counts.failed + view.counts.pending).toBe(testable);
  });

  /** T21 — `empty_results` is "pending", in neither the success nor the failure count. */
  it("T21 a 200 with zero results becomes pending, not ok and not failed", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds } = await addBraveGroup(harness, ["t21-empty"], { results: 0 });

    const created = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const jobId = created.body["jobId"] as string;
    const view = await waitForJob(harness, jobId, (current) => current.status !== "running", "the run to finish");

    const item = view.items[0]!;
    expect(item.state).toBe("pending");
    expect(item.code).toBe("empty_results");
    expect(view.counts.pending).toBe(1);
    expect(view.counts.ok).toBe(0);
    expect(view.counts.failed).toBe(0);
    expect(view.counts.done).toBe(1);
    // The stored status is unchanged (`degraded`): the "pending" bucket exists
    // only in the batch view, so history keeps its existing meaning.
    const health = harness.ctx.sqlite
      .prepare("SELECT status, detail_json FROM provider_health_checks WHERE id = ?")
      .get(item.checkId) as { status: string; detail_json: string };
    expect(health.status).toBe("degraded");
    expect(JSON.parse(health.detail_json).cause).toBe("empty_results");
  });

  /**
   * T22 — an undecryptable credential is a configuration failure, and nothing
   * about it leaks.
   *
   * The failure is adjudicated before any request, so the item carries no
   * `checkId`: there is no observation to record. It does count as a failure, so
   * "retry the failures" includes it and the operator can fix it.
   */
  it("T22 an undecryptable credential fails as configuration_error without leaking", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const stub = await startBraveStub({ results: 2 });
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "t22-bad-cipher",
      type: "brave",
      baseUrl: stub.base,
    });
    await addKey(harness.app, harness.write(), providerId, "sk-T22-PLAINTEXT-MUST-NOT-LEAK");
    // Break the stored ciphertext the way a lost master key does: the value is
    // no longer decryptable, and the row keeps its own unusable material.
    const cipher = "corrupt-ciphertext-do-not-echo";
    harness.ctx.sqlite
      .prepare("UPDATE api_keys SET key_ciphertext = ?, key_iv = ?, key_tag = ? WHERE provider_id = ?")
      .run(cipher, "corrupt-iv", "corrupt-tag", providerId);

    const created = await startJob(harness, { kind: "connect", providerIds: [providerId], concurrency: 1 });
    const jobId = created.body["jobId"] as string;
    const view = await waitForJob(harness, jobId, (current) => current.status !== "running", "the run to finish");

    const item = view.items[0]!;
    expect(item.state).toBe("failed");
    expect(item.code).toBe("configuration_error");
    expect(view.counts.failed).toBe(1);
    expect(item.checkId).toBeNull();

    // Nothing resolved: no request was sent, and no health verdict was invented.
    expect(stub.hits()).toBe(0);
    const rows = harness.ctx.sqlite
      .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ?")
      .get(providerId) as { n: number };
    expect(rows.n).toBe(0);

    // Neither the plaintext, the corrupted ciphertext nor its prefix may appear
    // anywhere in the response or in the stored items.
    const raw = await harness.app.inject({
      method: "GET",
      url: `/api/admin/provider-health/batch-test/${jobId}`,
      ...harness.read(),
    });
    expect(raw.body).not.toContain("PLAINTEXT");
    expect(raw.body).not.toContain(cipher);
    expect(raw.body).not.toContain("corrupt-iv");
  });

  /**
   * T23 — HTTP 200 with an unusable body is a failure.
   *
   * An adapter that silently returned "no results" for a malformed response
   * would make a broken vendor look like an empty index.
   */
  it("T23 an invalid response body is a failed item, not an empty one", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const stub = await startHnStub({ invalid: true });
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "t23-invalid",
      type: "hackernews",
      baseUrl: stub.base,
    });

    const created = await startJob(harness, { kind: "connect", providerIds: [providerId], concurrency: 1 });
    const jobId = created.body["jobId"] as string;
    const view = await waitForJob(harness, jobId, (current) => current.status !== "running", "the run to finish");

    const item = view.items[0]!;
    expect(item.state).toBe("failed");
    expect(item.code).toBe("invalid_response");
    expect(view.counts.failed).toBe(1);
    expect(view.counts.ok).toBe(0);
    expect(view.counts.pending).toBe(0);
    // The stored cause keeps its historical name; the external code is the
    // documented one. Both must be true at once.
    const health = harness.ctx.sqlite
      .prepare("SELECT status, detail_json FROM provider_health_checks WHERE id = ?")
      .get(item.checkId) as { status: string; detail_json: string };
    expect(JSON.parse(health.detail_json).cause).toBe("bad_response");
    expect(health.status).toBe("degraded");
  });

  /**
   * T24 — a run in progress must be describable as partial.
   *
   * The invariant the UI needs is `done + skipped + remaining === total`: with it,
   * "partial (3/12)" is arithmetic rather than guesswork.
   */
  it("T24 a running job satisfies the progress identities and is not completed", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const { providerIds } = await addBraveGroup(
      harness,
      ["t24-a", "t24-b", "t24-c", "t24-d", "t24-e", "t24-f"],
      { delayMs: 150 },
    );
    const created = await startJob(harness, { kind: "connect", providerIds, concurrency: 1 });
    const jobId = created.body["jobId"] as string;

    const view = await waitForJob(harness, jobId, (current) => current.counts.done >= 1, "one completed item");
    expect(view.status).toBe("running");
    expect(view.status).not.toBe("completed");
    // The identity the progress bar relies on.
    expect(view.counts.done + view.counts.skipped + view.counts.remaining).toBe(view.counts.total);
    expect(view.counts.ok + view.counts.failed + view.counts.pending).toBe(view.counts.done);
    // …and it is genuinely unfinished, so "partial (n/total)" is truthful.
    expect(view.counts.done + view.counts.skipped).toBeLessThan(view.counts.total);
    expect(view.nextPollAfterMs).toBe(1000);

    await waitForJob(harness, jobId, (current) => current.status !== "running", "the run to finish", 10_000);
    const finished = await getJob(harness, jobId);
    expect(finished.status).toBe("completed");
    expect(finished.counts.done + finished.counts.skipped).toBe(finished.counts.total);
    expect(finished.nextPollAfterMs).toBeNull();
  });
});

/**
 * Polls a job until `predicate` holds, returning the last view.
 *
 * Polling (rather than a fixed sleep) is the only way to assert on a real
 * asynchronous runner without either a flaky test or an artificially slow one.
 */
async function waitForJob(
  harness: BatchHarness,
  jobId: string,
  predicate: (view: JobView) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<JobView> {
  let last: JobView | null = null;
  try {
    await waitFor(
      async () => {
        last = await getJob(harness, jobId);
        return predicate(last);
      },
      { timeoutMs, label },
    );
  } catch (error) {
    // A failed wait is far easier to diagnose with the state that was reached.
    if (last) {
      throw new Error(
        `${(error as Error).message}; last view: ${JSON.stringify({
          status: (last as JobView).status,
          counts: (last as JobView).counts,
        })}`,
      );
    }
    throw error;
  }
  return last as unknown as JobView;
}
