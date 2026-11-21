import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, resolveMigrationsDir, type DbHandle, type SearchHubDb } from "@search-hub/db";
import { providerInstances } from "@search-hub/db";
import { SearchHubError, type Logger } from "@search-hub/shared";
import {
  ProviderBatchService,
  type BatchDependencies,
  type BatchJobView,
} from "../../apps/api/src/services/provider-batch.js";
import type { HealthCheckResult, HealthService } from "../../apps/api/src/services/health.js";
import { waitFor } from "../helpers/batch-harness.js";

type CheckMany = BatchDependencies["health"]["checkMany"];
type CheckManyOptions = NonNullable<Parameters<CheckMany>[1]>;
type Budget = ReturnType<HealthService["budget"]>;

function requireIds(ids: string[] | null): string[] {
  if (ids === null) throw new Error("controlled checkMany expected an explicit provider id list");
  return ids;
}

function requireOptions(options: CheckManyOptions | undefined): CheckManyOptions {
  if (options === undefined) throw new Error("controlled checkMany expected run options");
  return options;
}

function requireSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) throw new Error("controlled checkMany expected an abort signal");
  return signal;
}

function firstProviderId(ids: string[]): string {
  const first = ids[0];
  if (first === undefined) throw new Error("controlled checkMany expected at least one provider");
  return first;
}

interface RaceHarness {
  handle: DbHandle;
  db: SearchHubDb;
  dir: string;
  providerIds: string[];
  budget: Budget;
  makeService(checkMany: CheckMany, db?: SearchHubDb): ProviderBatchService;
  dispose(): void;
}

const harnesses: RaceHarness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function budgetSnapshot(): Budget {
  return {
    day: "2026-01-01",
    maxPerRun: 10,
    maxPerDay: 100,
    usedToday: 0,
    connectUsedToday: 0,
    anonymousSearchUsedToday: 0,
    anonymousMaxPerRun: 10,
    anonymousMaxPerDay: 100,
    connectMaxPerProbe: 5,
    connectMaxPerDay: 50,
    anonymousRemainingToday: 100,
    connectRemainingToday: 50,
    remainingToday: 100,
    paidProbesEnabled: false,
    scheduledEnabled: false,
    intervalMinutes: 360,
  };
}

function resultFor(providerId: string): HealthCheckResult {
  return {
    id: `hc_${providerId}`,
    providerId,
    providerName: providerId,
    providerType: "mock",
    keyId: null,
    kind: "connect",
    status: "healthy",
    cause: "ok",
    errorCode: null,
    latencyMs: 1,
    resultCount: 1,
    healthScore: 100,
    message: "ok",
    checkedAt: "2026-01-01T00:00:00.000Z",
    trigger: "manual",
    cooldownUntil: null,
    requests: 0,
  };
}

function cancelledError(): Error & { code: string } {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

function createRaceHarness(): RaceHarness {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-batch-cancel-"));
  const handle = createDb({ file: join(dir, "cancel.db") });
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const now = "2026-01-01T00:00:00.000Z";
  const providerIds = ["p-cancel-a", "p-cancel-b", "p-cancel-c"];
  for (const id of providerIds) {
    handle.db
      .insert(providerInstances)
      .values({ id, name: id, type: "mock", enabled: true, createdAt: now, updatedAt: now })
      .run();
  }

  const services: ProviderBatchService[] = [];
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
  const budget = budgetSnapshot();
  const settings = {
    get: () => ({ health: { concurrency: 1, includeUnverified: true, paidProbesEnabled: false } }),
  };
  const providers = {
    resolveKey: () => undefined,
    keyAvailability: (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            total: 0,
            enabled: 0,
            decryptable: 0,
            available: 0,
            invalid: 0,
            quotaExhausted: 0,
            coolingUntil: null,
            accountQuotaExhausted: false,
          },
        ]),
      ),
  };

  const harness: RaceHarness = {
    handle,
    db: handle.db,
    dir,
    providerIds,
    budget,
    makeService(checkMany: CheckMany, db = handle.db) {
      const service = new ProviderBatchService(
        { db, settings, providers, health: { checkMany, budget: () => budget }, appLogger: logger },
        () => Date.parse("2026-01-01T00:00:00.000Z"),
      );
      services.push(service);
      return service;
    },
    dispose() {
      for (const service of services) service.shutdown();
      try {
        handle.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

async function startJob(
  service: ProviderBatchService,
  providerIds: string[],
): Promise<string> {
  const input = { kind: "connect" as const, providerIds, includeKeyless: true, actor: "test" };
  const job = await service.startBatch(input);
  return job.jobId;
}

function rowViaSqlite(harness: RaceHarness, jobId: string): {
  status: string;
  total: number;
  done: number;
  ok_count: number;
  failed_count: number;
  pending_count: number;
  skipped_count: number;
  finished_at: string | null;
  items_json: string;
} {
  return harness.handle.sqlite
    .prepare(
      "SELECT status, total, done, ok_count, failed_count, pending_count, skipped_count, finished_at, items_json " +
        "FROM provider_test_batches WHERE id = ?",
    )
    .get(jobId) as {
    status: string;
    total: number;
    done: number;
    ok_count: number;
    failed_count: number;
    pending_count: number;
    skipped_count: number;
    finished_at: string | null;
    items_json: string;
  };
}

function expectSettledCancelled(job: BatchJobView, total: number): void {
  expect(job.status).toBe("cancelled");
  expect(job.counts.remaining).toBe(0);
  expect(job.counts.skipped).toBe(total);
  expect(job.counts.done).toBe(0);
  expect(job.nextPollAfterMs).toBeNull();
  expect(job.finishedAt).not.toBeNull();
  expect(job.items.every((item) => item.state === "skipped" && item.code === "SKIPPED_CANCELLED")).toBe(true);
}

describe("atomic batch cancellation races", () => {
  it("H61 normal cancel commits items and counters before returning", async () => {
    const harness = createRaceHarness();
    const service = harness.makeService(async () => new Promise(() => undefined));
    const jobId = await startJob(service, harness.providerIds);

    const result = service.cancelBatch(jobId);
    expect(result).toEqual({ jobId, status: "cancelled", skippedRemaining: 3 });
    expectSettledCancelled(service.getJob(jobId), 3);

    const row = rowViaSqlite(harness, jobId);
    expect(row).toMatchObject({ status: "cancelled", total: 3, done: 0, skipped_count: 3 });
    expect(JSON.parse(row.items_json).every((item: { state: string }) => item.state === "skipped")).toBe(true);
  });

  it("H62 cancel after the first item preserves that conclusion and cancels only unknown rows", async () => {
    const harness = createRaceHarness();
    const gate = deferred();
    const service = harness.makeService(async (ids, options) => {
      const providerIds = requireIds(ids);
      const runOptions = requireOptions(options);
      const first = resultFor(firstProviderId(providerIds));
      runOptions.onItem?.({ providerId: first.providerId, result: first });
      await gate.promise;
      return { results: [first], skipped: [], budget: harness.budget };
    });
    const jobId = await startJob(service, harness.providerIds);
    await waitFor(() => service.getJob(jobId).counts.done === 1, { label: "first item to persist" });

    expect(service.cancelBatch(jobId).skippedRemaining).toBe(2);
    const afterCancel = service.getJob(jobId);
    expect(afterCancel.status).toBe("cancelled");
    expect(afterCancel.counts).toMatchObject({ done: 1, ok: 1, skipped: 2, remaining: 0 });
    expect(afterCancel.items[0]).toMatchObject({ state: "ok", checkId: `hc_${harness.providerIds[0]}` });
    expect(afterCancel.items.slice(1).every((item) => item.code === "SKIPPED_CANCELLED")).toBe(true);

    gate.resolve();
    await waitFor(() => !service.isRunning(jobId), { label: "stale runner to return" });
    expect(service.getJob(jobId)).toEqual(afterCancel);
  });

  it("H63 cancel during a request aborts outside the transaction and a late rejection cannot overwrite it", async () => {
    const harness = createRaceHarness();
    let transactionDepth = 0;
    let abortDepth = -1;
    const originalTransaction = harness.db.transaction.bind(harness.db);
    harness.db.transaction = ((callback: (tx: SearchHubDb) => unknown) =>
      originalTransaction((tx) => {
        transactionDepth += 1;
        try {
          return callback(tx);
        } finally {
          transactionDepth -= 1;
        }
      })) as typeof harness.db.transaction;

    const service = harness.makeService(async (_ids, options) => {
      const signal = requireSignal(requireOptions(options).signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abortDepth = transactionDepth;
            reject(cancelledError());
          },
          { once: true },
        );
      });
    });
    const jobId = await startJob(service, harness.providerIds);
    service.cancelBatch(jobId);
    expect(abortDepth).toBe(0);
    expectSettledCancelled(service.getJob(jobId), 3);

    await waitFor(() => !service.isRunning(jobId), { label: "aborted runner to settle" });
    expect(service.getJob(jobId).status).toBe("cancelled");
    expect(rowViaSqlite(harness, jobId).skipped_count).toBe(3);
  });

  it("H64 cancel immediately after the last result returns wins over finalise", async () => {
    const harness = createRaceHarness();
    const gate = deferred();
    const service = harness.makeService(async (ids, options) => {
      const providerIds = requireIds(ids);
      const runOptions = requireOptions(options);
      const results = providerIds.map(resultFor);
      for (const result of results) runOptions.onItem?.({ providerId: result.providerId, result });
      await gate.promise;
      return { results, skipped: [], budget: harness.budget };
    });
    const jobId = await startJob(service, harness.providerIds);
    await waitFor(() => service.getJob(jobId).counts.done === 3, { label: "all item callbacks" });

    gate.resolve();
    service.cancelBatch(jobId);
    await waitFor(() => !service.isRunning(jobId), { label: "runner continuation" });
    const job = service.getJob(jobId);
    expect(job.status).toBe("cancelled");
    expect(job.counts).toMatchObject({ done: 3, ok: 3, skipped: 0, remaining: 0 });
  });

  it("H65 cancel versus finalise is serialized in both orders", async () => {
    const harness = createRaceHarness();
    const gate = deferred();
    const runner = harness.makeService(async (ids, options) => {
      const providerIds = requireIds(ids);
      const runOptions = requireOptions(options);
      const results = providerIds.map(resultFor);
      for (const result of results) runOptions.onItem?.({ providerId: result.providerId, result });
      await gate.promise;
      return { results, skipped: [], budget: harness.budget };
    });
    const canceller = harness.makeService(async () => ({ results: [], skipped: [], budget: harness.budget }));
    const jobId = await startJob(runner, harness.providerIds);
    await waitFor(() => runner.getJob(jobId).counts.done === 3, { label: "all results before finalise" });

    canceller.cancelBatch(jobId);
    gate.resolve();
    await waitFor(() => !runner.isRunning(jobId), { label: "stale finalise" });
    expect(runner.getJob(jobId).status).toBe("cancelled");

    const completedGate = deferred();
    const finisher = harness.makeService(async (ids, options) => {
      const providerIds = requireIds(ids);
      const runOptions = requireOptions(options);
      const results = providerIds.map(resultFor);
      for (const result of results) runOptions.onItem?.({ providerId: result.providerId, result });
      await completedGate.promise;
      return { results, skipped: [], budget: harness.budget };
    });
    const completedId = await startJob(finisher, harness.providerIds);
    await waitFor(() => finisher.getJob(completedId).counts.done === 3, { label: "second job results" });
    completedGate.resolve();
    await waitFor(() => !finisher.isRunning(completedId), { label: "finalise to commit" });
    expect(finisher.getJob(completedId).status).toBe("completed");
    expect(() => canceller.cancelBatch(completedId)).toThrowError(SearchHubError);
    try {
      canceller.cancelBatch(completedId);
    } catch (error) {
      expect((error as SearchHubError).code).toBe("conflict");
    }
  });

  it("H66 an immediate refresh after cancel already reports remaining=0", async () => {
    const harness = createRaceHarness();
    const service = harness.makeService(async () => new Promise(() => undefined));
    const jobId = await startJob(service, harness.providerIds);
    service.cancelBatch(jobId);

    const refreshed = service.getJob(jobId);
    expectSettledCancelled(refreshed, 3);
    expect(rowViaSqlite(harness, jobId)).toMatchObject({ status: "cancelled", skipped_count: 3, done: 0 });
  });

  it("normalizes a legacy terminal row to remaining=0 without rewriting it", () => {
    const harness = createRaceHarness();
    const service = harness.makeService(async () => ({ results: [], skipped: [], budget: harness.budget }));
    const jobId = "bt_legacy_terminal_unknown";
    const first = firstProviderId(harness.providerIds);
    const second = harness.providerIds[1];
    if (second === undefined) throw new Error("legacy fixture expected a second provider");
    const items = [
      {
        providerId: first,
        providerName: first,
        providerType: "mock",
        keyCount: 0,
        state: "ok",
        code: "ok",
        latencyMs: 1,
        resultCount: 1,
        requests: 0,
        checkId: "hc_legacy",
        reason: null,
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        providerId: second,
        providerName: second,
        providerType: "mock",
        keyCount: 0,
        state: "unknown",
        code: "unknown",
        latencyMs: null,
        resultCount: null,
        requests: null,
        checkId: null,
        reason: null,
        checkedAt: null,
      },
    ];
    harness.handle.sqlite
      .prepare(
        "INSERT INTO provider_test_batches (id, kind, status, total, done, ok_count, items_json, budget_json, created_at, finished_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        jobId,
        "connect",
        "completed",
        2,
        1,
        1,
        JSON.stringify(items),
        JSON.stringify(harness.budget),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
      );

    const view = service.getJob(jobId);
    expect(view.counts).toMatchObject({ total: 2, done: 1, skipped: 1, remaining: 0 });
    expect(view.items[1]).toMatchObject({ state: "skipped", code: "SKIPPED_INTERRUPTED" });
    expect(view.nextPollAfterMs).toBeNull();
    const stored = harness.handle.sqlite
      .prepare("SELECT items_json FROM provider_test_batches WHERE id = ?")
      .get(jobId) as { items_json: string };
    expect(JSON.parse(stored.items_json)[1].state).toBe("unknown");
  });

  it("H67 a crash-triggered rollback during cancel leaves the whole running row intact", async () => {
    const harness = createRaceHarness();
    const service = harness.makeService(async () => new Promise(() => undefined));
    const jobId = await startJob(service, harness.providerIds);
    harness.handle.sqlite.exec(`
      CREATE TRIGGER fail_cancel BEFORE UPDATE OF status ON provider_test_batches
      WHEN NEW.status = 'cancelled'
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END
    `);

    expect(() => service.cancelBatch(jobId)).toThrow(/simulated crash/);
    const rolledBack = rowViaSqlite(harness, jobId);
    expect(rolledBack).toMatchObject({ status: "running", done: 0, skipped_count: 0, finished_at: null });
    expect(JSON.parse(rolledBack.items_json).every((item: { state: string }) => item.state === "unknown")).toBe(true);

    harness.handle.sqlite.exec("DROP TRIGGER fail_cancel");
    service.cancelBatch(jobId);
    expectSettledCancelled(service.getJob(jobId), 3);
  });

  it("H68 restart after cancel preserves the terminal snapshot and never resurrects the run", async () => {
    const harness = createRaceHarness();
    const service = harness.makeService(async (_ids, options) => {
      const signal = requireSignal(requireOptions(options).signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
      });
    });
    const jobId = await startJob(service, harness.providerIds);
    service.cancelBatch(jobId);
    await waitFor(() => !service.isRunning(jobId), { label: "runner to stop" });
    const before = service.getJob(jobId);
    service.shutdown();
    harness.handle.close();

    const reopened = createDb({ file: join(harness.dir, "cancel.db") });
    runMigrations(reopened.sqlite, resolveMigrationsDir());
    try {
      const restarted = harness.makeService(async () => ({ results: [], skipped: [], budget: harness.budget }), reopened.db);
      expect(restarted.getJob(jobId)).toEqual(before);
      expect(restarted.sweepInterrupted()).toBe(0);
      expect(rowViaSqlite({ ...harness, handle: reopened }, jobId).finished_at).toBe(before.finishedAt);
    } finally {
      reopened.close();
    }
  });

  it("H69 one hundred concurrent cancel requests produce exactly one winner", async () => {
    const harness = createRaceHarness();
    const service = harness.makeService(async () => new Promise(() => undefined));
    const jobId = await startJob(service, harness.providerIds);

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, async () => {
        try {
          return { ok: true, result: service.cancelBatch(jobId) };
        } catch (error) {
          return { ok: false, code: (error as SearchHubError).code };
        }
      }),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok && outcome.code === "conflict")).toHaveLength(99);
    expectSettledCancelled(service.getJob(jobId), 3);
    expect(rowViaSqlite(harness, jobId)).toMatchObject({ status: "cancelled", skipped_count: 3 });
  });

  it("sweepInterrupted resolves unknown items and is idempotent", async () => {
    const harness = createRaceHarness();
    const gate = deferred();
    const service = harness.makeService(async (ids, options) => {
      const providerIds = requireIds(ids);
      const runOptions = requireOptions(options);
      const first = resultFor(firstProviderId(providerIds));
      runOptions.onItem?.({ providerId: first.providerId, result: first });
      await gate.promise;
      return { results: [first], skipped: [], budget: harness.budget };
    });
    const jobId = await startJob(service, harness.providerIds);
    await waitFor(() => service.getJob(jobId).counts.done === 1, { label: "one item before sweep" });

    expect(service.sweepInterrupted(Date.parse("2026-01-01T01:00:00.000Z"))).toBe(1);
    const interrupted = service.getJob(jobId);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.counts).toMatchObject({ done: 1, ok: 1, skipped: 2, remaining: 0 });
    expect(interrupted.items.slice(1).every((item) => item.code === "SKIPPED_INTERRUPTED")).toBe(true);
    expect(interrupted.nextPollAfterMs).toBeNull();
    expect(service.sweepInterrupted(Date.parse("2026-01-01T02:00:00.000Z"))).toBe(0);
    expect(service.getJob(jobId).finishedAt).toBe(interrupted.finishedAt);

    gate.resolve();
    await waitFor(() => !service.isRunning(jobId), { label: "stale runner after sweep" });
    expect(service.getJob(jobId)).toEqual(interrupted);
  });
});
