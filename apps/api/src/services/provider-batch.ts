/**
 * Bulk provider test: a run ledger, an eligibility gate and a fire-and-forget
 * runner.
 *
 * Three rules shape this module:
 *
 * 1. **The database is the truth; memory is a cache.** Progress is written after
 *    every completed item, so a `GET` during a run reads real state and a `GET`
 *    after a restart reads the last real state. Nothing about progress lives in
 *    a class field that a reader could consult instead.
 * 2. **A restart can never claim success.** Any row still `running` when the
 *    process starts is rewritten to `interrupted` by `sweepInterrupted()`, which
 *    runs in the constructor. The runner additionally only finalises a row that
 *    is *still* `running`, so a stale runner cannot resurrect a status another
 *    writer already decided.
 * 3. **Cancel is a status, not a rollback.** Finished items keep their
 *    conclusion (`checkId` included); unfinished ones become
 *    `SKIPPED_CANCELLED`; nothing is re-probed and no budget is refunded.
 *
 * Health facts stay in `provider_health_checks` (each row carries this run's
 * `batch_id`). This table answers only "how far did this run get".
 *
 * The item rows additionally copy three *display* facts — the adapter type, the
 * size of the credential pool and the probe's `checkedAt` — so one read renders a
 * complete table. They are denormalised deliberately: a source can be deleted or
 * re-typed after a run, and the ledger has to describe the run that happened. No
 * key material, key id or ciphertext is ever copied here.
 */
import { and, eq } from "drizzle-orm";
import type { SearchHubDb } from "@search-hub/db";
import { providerInstances, providerTestBatches, type ProviderTestBatchRow } from "@search-hub/db";
import { SearchHubError } from "@search-hub/shared";
import { newId } from "../security/crypto.js";
import type { Logger } from "@search-hub/shared";
import type { HealthCause, HealthProbeKind } from "./health-classify.js";
import type { HealthCheckResult, HealthService } from "./health.js";
import {
  loadEligibilityFacts,
  previewBatch,
  type EligibilityCode,
  type PreviewCounts,
} from "./provider-eligibility.js";

/**
 * Refuses a read or cancel on a job that belongs to a different account.
 *
 * Same rule the evaluation lab applies to `cancelRun` (quality.ts:1375): one
 * actor cannot stop, or inspect, another actor's work. A job with no recorded
 * owner predates this rule and is left readable rather than becoming
 * unreachable — refusing it would strand a run nobody could ever finish.
 */
function assertOwnedBy(row: { createdBy: string | null }, actor: string | undefined): void {
  if (actor === undefined) return;
  if (row.createdBy === null) return;
  if (row.createdBy === actor) return;
  throw new SearchHubError("forbidden", "This test job belongs to another account");
}

export type BatchState = "ok" | "failed" | "pending" | "skipped" | "unknown";
export type BatchStatus = "running" | "completed" | "partial" | "cancelled" | "interrupted";

export interface BatchItem {
  providerId: string;
  providerName: string;
  /**
   * The adapter type, copied at run time.
   *
   * Denormalised on purpose: the operator reads a row long after the source may
   * have been deleted or re-typed, and the ledger has to describe the run that
   * happened rather than today's configuration.
   */
  providerType: string | null;
  /**
   * How many credentials this source had when the run was created.
   *
   * A count, never key material: this number travels to the browser and into the
   * ledger, so it must not be derivable back to a secret or an id. `null` means
   * "not recorded" (a row written before this column existed).
   */
  keyCount: number | null;
  state: BatchState;
  /** External code: a canonical classification or a `SKIPPED_*` code. */
  code: string;
  latencyMs: number | null;
  resultCount: number | null;
  /** Physical upstream requests, or `null` when none was sent. */
  requests: number | null;
  /** Health row id, when this item produced one. */
  checkId: string | null;
  reason: string | null;
  /** When the probe finished, from the health row; `null` for a skipped item. */
  checkedAt: string | null;
}

export interface BatchCounts {
  total: number;
  /** Finished probes: `ok + failed + pending`. */
  done: number;
  ok: number;
  failed: number;
  /** `empty_results`: answered, but nothing came back. */
  pending: number;
  /** Never probed (disabled / no key / cooling / budget / cancelled). */
  skipped: number;
  /** `total - done - skipped`, i.e. items still `unknown`. */
  remaining: number;
}

export interface BatchJobView {
  jobId: string;
  status: BatchStatus;
  kind: HealthProbeKind;
  counts: BatchCounts;
  items: BatchItem[];
  budget: ReturnType<HealthService["budget"]>;
  concurrency: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** `1000` while running, `null` once the run stopped; the UI polls on it. */
  nextPollAfterMs: number | null;
}

export interface BatchPreview {
  kind: HealthProbeKind;
  total: number;
  counts: PreviewCounts;
  budget: ReturnType<HealthService["budget"]> & { remainingRun: number };
  /** True when starting this run may spend vendor quota. */
  paidRisk: boolean;
  /** How many eligible sources would send a credentialed search. */
  estimatedPaidProbes: number;
}

export interface BatchDependencies {
  db: SearchHubDb;
  settings: { get(): { health: { concurrency: number; includeUnverified: boolean; paidProbesEnabled: boolean } } };
  providers: { resolveKey(keyId: string): string | undefined };
  health: Pick<HealthService, "checkMany" | "budget">;
  appLogger: Logger;
}

/**
 * A run in flight: the abort controller and the ids still to probe.
 *
 * This is *control* state, not progress state — it disappears on restart, which
 * is exactly why a restart marks the row `interrupted` instead of pretending the
 * run continues.
 */
interface ActiveRun {
  controller: AbortController;
  providerIds: string[];
}

const STATUSES: readonly BatchStatus[] = ["running", "completed", "partial", "cancelled", "interrupted"];

/**
 * Maps an internal `HealthCause` onto the canonical external code.
 *
 * The mapping is fixed and total: the vocabulary in PRD §6 is what the API and
 * the UI promise, while the stored enum keeps its historical names. Renaming the
 * enum would rewrite history and every existing assertion; a translation table
 * costs nothing and cannot drift.
 */
const EXTERNAL_CODE: Partial<Record<HealthCause, string>> = {
  dns: "dns_error",
  tls: "tls_error",
  network: "network_error",
  bad_response: "invalid_response",
  config_incomplete: "configuration_error",
};

export function externalCodeFor(cause: string): string {
  return EXTERNAL_CODE[cause as HealthCause] ?? cause;
}

/**
 * Item state for a probe conclusion.
 *
 * `empty_results` becomes `pending` ("answered but nothing came back"), which
 * is neither a success nor a failure: counting it as either would misreport a
 * broken index as healthy, or a healthy vendor as broken. `no_credential` is
 * likewise not a failure — nothing was sent — so it is recorded as a skip.
 *
 * `keyCount` is passed through rather than read here: a `HealthCheckResult`
 * carries the key *id* it used, not the size of the pool, and the pool is a
 * fact about the pre-flight, not about the probe.
 */
export function itemForResult(result: HealthCheckResult, keyCount: number | null = null): BatchItem {
  const cause = result.cause;
  const base = {
    providerId: result.providerId,
    providerName: result.providerName,
    providerType: result.providerType,
    keyCount,
    latencyMs: result.latencyMs,
    resultCount: result.resultCount,
    requests: result.requests,
    checkId: result.id,
    reason: result.message,
    checkedAt: result.checkedAt,
  };

  if (cause === "cancelled") {
    return { ...base, state: "skipped", code: "SKIPPED_CANCELLED", latencyMs: null, resultCount: null };
  }
  if (cause === "no_credential") {
    return { ...base, state: "skipped", code: "SKIPPED_NO_KEY" };
  }
  if (cause === "ok") return { ...base, state: "ok", code: "ok" };
  if (cause === "empty_results") return { ...base, state: "pending", code: "empty_results" };
  return { ...base, state: "failed", code: externalCodeFor(cause) };
}

/**
 * Item state for a skip that never sent a request.
 *
 * `facts` carries what the pre-flight already knows about the source (its type
 * and how many credentials it has). They are optional so the runner, which
 * re-classifies an item it already recorded, can stay silent about them.
 */
export function itemForSkip(
  providerId: string,
  providerName: string,
  code: string,
  reason: string,
  facts: { providerType?: string | null; keyCount?: number | null } = {},
): BatchItem {
  // `already_running` is a skip even though its code has no `SKIPPED_` prefix:
  // another probe was on the source, so this run learned nothing about it and
  // must not report it as a failure.
  const skipped = code.startsWith("SKIPPED_") || code === "already_running";
  return {
    providerId,
    providerName,
    providerType: facts.providerType ?? null,
    keyCount: facts.keyCount ?? null,
    state: skipped ? "skipped" : "failed",
    code,
    latencyMs: null,
    resultCount: null,
    requests: null,
    checkId: null,
    reason,
    // Nothing was probed, so there is no check time to report. Keeping it `null`
    // (rather than the run's start time) is what lets the UI print an em dash.
    checkedAt: null,
  };
}

/** Counts for a set of items. Never derived from a separate counter. */
export function countItems(items: BatchItem[]): BatchCounts {
  const counts: BatchCounts = {
    total: items.length,
    done: 0,
    ok: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    remaining: 0,
  };
  for (const item of items) {
    switch (item.state) {
      case "ok":
        counts.ok += 1;
        counts.done += 1;
        break;
      case "failed":
        counts.failed += 1;
        counts.done += 1;
        break;
      case "pending":
        counts.pending += 1;
        counts.done += 1;
        break;
      case "skipped":
        counts.skipped += 1;
        break;
      case "unknown":
        counts.remaining += 1;
        break;
    }
  }
  return counts;
}

/**
 * Reads the item ledger, tolerating rows written by older versions.
 *
 * `itemsJson` is a JSON column, so a row created before a field existed simply
 * lacks that key. The three display-only columns (`providerType`, `keyCount`,
 * `checkedAt`) are therefore normalised to `null` here instead of being trusted
 * to exist: a reader that saw `undefined` would have to render it, and every
 * call site would need its own "is this old?" branch.
 */
function parseItems(json: string): BatchItem[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is BatchItem =>
          typeof item === "object" && item !== null && typeof (item as BatchItem).providerId === "string",
      )
      .map((item) => ({
        ...item,
        providerType: item.providerType ?? null,
        keyCount: typeof item.keyCount === "number" ? item.keyCount : null,
        checkedAt: item.checkedAt ?? null,
      }));
  } catch {
    return [];
  }
}

function parseBudget(json: string): ReturnType<HealthService["budget"]> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null) return parsed as ReturnType<HealthService["budget"]>;
  } catch {
    /* fall through */
  }
  // A malformed snapshot must not become a claim about today's budget; the
  // caller renders "unknown" rather than a zero it would read as "exhausted".
  return {
    day: "",
    maxPerRun: 0,
    maxPerDay: 0,
    usedToday: 0,
    connectUsedToday: 0,
    anonymousSearchUsedToday: 0,
    remainingToday: 0,
    paidProbesEnabled: false,
    scheduledEnabled: false,
    intervalMinutes: 0,
  };
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(Math.round(value), 4));
}

export class ProviderBatchService {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly ctx: BatchDependencies,
    private readonly clock: () => number = () => Date.now(),
  ) {
    // Startup sweep, before the service is handed to any route: a row left
    // `running` by a crash is rewritten to `interrupted` once, so a reader can
    // never be told a dead run is still going — or worse, that it completed.
    try {
      const swept = this.sweepInterrupted();
      if (swept > 0) {
        this.ctx.appLogger.warn({ count: swept }, "marked previously running provider test batches as interrupted");
      }
    } catch (error) {
      // A failed sweep must not stop the server from starting; the rows simply
      // stay `running` until the next boot, and the runner refuses to finalise
      // anything it did not start in this process.
      this.ctx.appLogger.warn({ err: error }, "could not sweep interrupted provider test batches");
    }
  }

  private get db(): SearchHubDb {
    return this.ctx.db;
  }

  private healthPolicy(): { concurrency: number; includeUnverified: boolean; paidProbesEnabled: boolean } {
    return this.ctx.settings.get().health;
  }

  /**
   * The provider ids a request covers.
   *
   * `null`/`undefined` means **every configured source**, including disabled
   * ones, because that is the set the preview just described: the UI shows
   * "20 sources, 3 disabled, 8 skipped" and then starts a run whose `total` must
   * be the same 20. Scoping the run to enabled sources would make the numbers the
   * operator confirmed silently wrong.
   *
   * An explicit array — even an empty one — is taken literally. "Nothing
   * selected" must not quietly become "all of them": that reading would spend
   * the operator's quota on a scope they did not choose.
   */
  private resolveScope(providerIds: string[] | null | undefined): string[] {
    if (providerIds) {
      // Deduplicate: the same id twice would report one source twice in the
      // totals and make the progress identities unreachable.
      return [...new Set(providerIds)];
    }
    return this.db
      .select({ id: providerInstances.id })
      .from(providerInstances)
      .all()
      .map((row) => row.id);
  }

  /**
   * How many sources a paid run *would* probe.
   *
   * Computed with an ample budget on purpose: `SKIPPED_BUDGET` is a consequence
   * of the counters being exhausted, and asking "would this spend money if it
   * could" is a different question from "will the counters allow it". The
   * preview has to answer both — the first decides whether to warn about cost,
   * the second decides whether the run can start at all.
   */
  private paidCandidates(
    facts: ReturnType<typeof loadEligibilityFacts>,
    ids: string[],
    kind: HealthProbeKind,
    includeKeyless: boolean,
  ): number {
    if (kind !== "search") return 0;
    const budget = this.ctx.health.budget();
    return previewBatch(facts, ids, {
      kind: "search",
      includeKeyless,
      budget: {
        ...budget,
        remainingToday: Math.max(1, budget.maxPerDay),
        maxPerRun: Math.max(1, budget.maxPerRun),
      },
      nowMs: this.clock(),
    }).counts.eligible;
  }

  /**
   * What a run over this scope would do, without writing anything.
   *
   * Reads only: T08 asserts that a preview leaves both tables untouched, and
   * that is a property of this method, not of the route.
   */
  preview(kind: HealthProbeKind, providerIds?: string[] | null): BatchPreview {
    const ids = this.resolveScope(providerIds);
    const policy = this.healthPolicy();
    const budget = this.ctx.health.budget();
    const facts = loadEligibilityFacts(this.db, this.ctx.providers, ids);
    const result = previewBatch(facts, ids, {
      kind,
      includeKeyless: policy.includeUnverified,
      budget,
      nowMs: this.clock(),
    });

    // Only a *paid* search can spend the operator's quota: a connectivity probe
    // and an anonymous search cannot, and neither can a paid run that the paid
    // switch forbids. `estimatedPaidProbes` therefore reports the probes that
    // would actually be billed — `0` when nothing can be billed, so the dialog
    // never warns about a cost that will not happen.
    const candidates = this.paidCandidates(facts, ids, kind, policy.includeUnverified);
    const paidRisk = kind === "search" && candidates > 0 && budget.paidProbesEnabled;

    return {
      kind,
      total: result.total,
      counts: result.counts,
      budget: { ...budget, remainingRun: budget.maxPerRun },
      paidRisk,
      estimatedPaidProbes: paidRisk ? candidates : 0,
    };
  }

  /**
   * Starts a run and returns immediately.
   *
   * The pre-flight refusals happen *before* the insert, so a rejected request
   * cannot leave a `running` row behind that a later reader would wait on.
   */
  async startBatch(input: {
    kind?: HealthProbeKind;
    providerIds?: string[] | null;
    concurrency?: number;
    actor: string;
  }): Promise<BatchJobView> {
    const kind = input.kind ?? "search";
    const ids = this.resolveScope(input.providerIds);
    if (ids.length === 0) {
      // An empty selection is a request defect, not an empty run: a job with
      // nothing in it would poll "0/0" forever and mean nothing.
      throw new SearchHubError(
        "validation_error",
        input.providerIds
          ? "No providers were selected, so there is nothing to test."
          : "No providers are configured, so there is nothing to test.",
      );
    }
    const policy = this.healthPolicy();
    const budget = this.ctx.health.budget();
    const facts = loadEligibilityFacts(this.db, this.ctx.providers, ids);
    const preview = previewBatch(facts, ids, {
      kind,
      includeKeyless: policy.includeUnverified,
      budget,
      nowMs: this.clock(),
    });

    // Refuse before writing anything. Both refusals are `validation_error` at
    // 409: the request is well-formed but the instance's health policy forbids
    // spending, and the UI has to be able to say which.
    const candidates = this.paidCandidates(facts, ids, kind, policy.includeUnverified);
    if (kind === "search" && candidates > 0) {
      if (!budget.paidProbesEnabled) {
        throw new SearchHubError(
          "validation_error",
          "Paid search probes are disabled. Enable them in Settings → Provider health, or run a connectivity test instead.",
          { status: 409 },
        );
      }
      if (budget.remainingToday <= 0) {
        throw new SearchHubError(
          "validation_error",
          `Paid probe budget exhausted: ${budget.usedToday}/${budget.maxPerDay} used today. ` +
            "Nothing was probed. Raise the daily limit or wait for the next UTC day.",
          { status: 409 },
        );
      }
    }

    const jobId = newId("bt");
    const createdAt = new Date(this.clock()).toISOString();
    const concurrency = clampConcurrency(input.concurrency ?? policy.concurrency ?? 2);

    // Every source in scope is present from the first write, so a reader can
    // tell "not started" (`unknown`) from "deliberately skipped".
    //
    // The type and the credential count come from the facts the eligibility gate
    // already loaded, not from a second query per item: the table has to be able
    // to describe a source even when it was skipped and no probe ever ran.
    const factsById = new Map(facts.providers.map((provider) => [provider.id, provider] as const));
    const items: BatchItem[] = [];
    const eligibleIds: string[] = [];
    for (const decision of preview.decisions) {
      const factsForItem = {
        providerType: factsById.get(decision.providerId)?.type ?? null,
        keyCount: facts.anyKeyCounts.get(decision.providerId) ?? 0,
      };
      if (decision.enqueue) {
        items.push({
          providerId: decision.providerId,
          providerName: decision.providerName,
          ...factsForItem,
          state: "unknown",
          code: "unknown",
          latencyMs: null,
          resultCount: null,
          requests: null,
          checkId: null,
          reason: null,
          checkedAt: null,
        });
        eligibleIds.push(decision.providerId);
        continue;
      }
      if (decision.code === "CONFIG_ERROR") {
        // A configuration error is adjudicated at pre-flight: it counts as a
        // failure (and appears in "retry the failures"), and no request is sent.
        items.push(
          itemForSkip(
            decision.providerId,
            decision.providerName,
            "configuration_error",
            decision.reason,
            factsForItem,
          ),
        );
        continue;
      }
      items.push(
        itemForSkip(
          decision.providerId,
          decision.providerName,
          decision.code as EligibilityCode,
          decision.reason,
          factsForItem,
        ),
      );
    }

    const counts = countItems(items);
    this.db
      .insert(providerTestBatches)
      .values({
        id: jobId,
        kind,
        status: "running",
        total: counts.total,
        done: counts.done,
        okCount: counts.ok,
        failedCount: counts.failed,
        pendingCount: counts.pending,
        skippedCount: counts.skipped,
        concurrency,
        optionsJson: JSON.stringify({
          providerIds: input.providerIds ? ids : null,
          includeKeyless: policy.includeUnverified,
        }),
        itemsJson: JSON.stringify(items),
        budgetJson: JSON.stringify(budget),
        createdBy: input.actor,
        createdAt,
        startedAt: createdAt,
        finishedAt: null,
      })
      .run();

    const controller = new AbortController();
    this.active.set(jobId, { controller, providerIds: eligibleIds });

    // Fire and forget: the HTTP handler must not wait for a run that may take
    // minutes. The runner persists its own progress and catches its own errors.
    void this.run(jobId, kind, eligibleIds, concurrency, controller.signal).catch((error: unknown) => {
      this.ctx.appLogger.warn({ err: error, jobId }, "provider test batch runner failed");
      try {
        this.finalise(jobId);
      } catch {
        // Nothing else to do: the row stays `running` and the next boot sweeps it
        // to `interrupted`, which is the honest outcome.
      }
    });

    return this.getJob(jobId);
  }

  /**
   * Reads one run. Never consults memory, so a restart cannot change the answer.
   *
   * `actor` is optional for internal callers (the runner reads its own row by
   * id). The HTTP layer always passes it: a job spends vendor quota on behalf of
   * the account that started it, so reading another account's job would expose
   * which vendors they configured and what those vendors answered.
   */
  getJob(jobId: string, actor?: string): BatchJobView {
    const row = this.db
      .select()
      .from(providerTestBatches)
      .where(eq(providerTestBatches.id, jobId))
      .get();
    if (!row) throw new SearchHubError("not_found", "Provider test job not found");
    assertOwnedBy(row, actor);

    const items = parseItems(row.itemsJson);
    const counts = countItems(items);
    const status = STATUSES.includes(row.status as BatchStatus) ? (row.status as BatchStatus) : "interrupted";

    return {
      jobId: row.id,
      status,
      kind: row.kind as HealthProbeKind,
      counts,
      items,
      budget: parseBudget(row.budgetJson),
      concurrency: row.concurrency,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      // Polling interval only while something can still change.
      nextPollAfterMs: status === "running" ? 1000 : null,
    };
  }

  /**
   * Stops a running job.
   *
   * Writes the status first, then aborts: a reader that arrives in between sees
   * "cancelled" rather than a run that still looks alive. `skippedRemaining` is
   * what the runner will account for as `SKIPPED_CANCELLED`; finished items are
   * never touched, so their conclusions stay readable (T13).
   */
  cancelBatch(jobId: string, actor?: string): { jobId: string; status: "cancelled"; skippedRemaining: number } {
    const row = this.db
      .select()
      .from(providerTestBatches)
      .where(eq(providerTestBatches.id, jobId))
      .get();
    if (!row) throw new SearchHubError("not_found", "Provider test job not found");
    assertOwnedBy(row, actor);
    if (row.status !== "running") {
      throw new SearchHubError(
        "conflict",
        `This job already stopped (${row.status}); there is nothing to cancel.`,
      );
    }

    const items = parseItems(row.itemsJson);
    const skippedRemaining = items.filter((item) => item.state === "unknown").length;

    this.db
      .update(providerTestBatches)
      .set({ status: "cancelled", finishedAt: new Date(this.clock()).toISOString() })
      .where(and(eq(providerTestBatches.id, jobId), eq(providerTestBatches.status, "running")))
      .run();

    const run = this.active.get(jobId);
    if (run) {
      // The abort reason carries `code: "cancelled"` so a probe already on the
      // wire is classified as a cancellation rather than as a timeout.
      run.controller.abort(Object.assign(new Error("cancelled"), { code: "cancelled" }));
    }

    return { jobId, status: "cancelled", skippedRemaining };
  }

  /**
   * Rewrites every leftover `running` row to `interrupted`.
   *
   * One statement, idempotent: a second call matches zero rows. Returns the
   * affected row count so a caller (or a test) can prove idempotence.
   */
  sweepInterrupted(nowMs?: number): number {
    const finishedAt = new Date(nowMs ?? this.clock()).toISOString();
    const result = this.db
      .update(providerTestBatches)
      .set({ status: "interrupted", finishedAt })
      .where(eq(providerTestBatches.status, "running"))
      .run();
    return Number(result.changes ?? 0);
  }

  /** Aborts every run in flight. Called on shutdown so no probe outlives teardown. */
  shutdown(): void {
    for (const [jobId, run] of this.active) {
      run.controller.abort(Object.assign(new Error("cancelled"), { code: "cancelled" }));
      this.active.delete(jobId);
    }
  }

  /** True while this process is running the job (used by tests and the UI). */
  isRunning(jobId: string): boolean {
    return this.active.has(jobId);
  }

  /**
   * The runner.
   *
   * Delegates the actual probing to `HealthService.checkMany`, which is the only
   * place that knows about in-flight de-duplication and the paid budget, and
   * persists after every item. No queue, no worker pool and no second
   * de-duplication set lives here: the batch layer adds bookkeeping, not a
   * parallel execution path.
   */
  private async run(
    jobId: string,
    kind: HealthProbeKind,
    eligibleIds: string[],
    concurrency: number,
    signal: AbortSignal,
  ): Promise<void> {
    const row = this.db
      .select()
      .from(providerTestBatches)
      .where(eq(providerTestBatches.id, jobId))
      .get();
    const items = parseItems(row?.itemsJson ?? "[]");
    const byId = new Map(items.map((item) => [item.providerId, item] as const));

    const persist = (): void => {
      const counts = countItems(items);
      this.db
        .update(providerTestBatches)
        .set({
          total: counts.total,
          done: counts.done,
          okCount: counts.ok,
          failedCount: counts.failed,
          pendingCount: counts.pending,
          skippedCount: counts.skipped,
          itemsJson: JSON.stringify(items),
        })
        .where(eq(providerTestBatches.id, jobId))
        .run();
    };

    await this.ctx.health.checkMany(eligibleIds, {
      kind,
      trigger: "manual",
      // The worker count is the throttle here: a fixed inter-probe gap would
      // make a 200-source run take two minutes for no reason.
      gapMs: 0,
      concurrency,
      signal,
      batchId: jobId,
      onItem: (item) => {
        const entry = byId.get(item.providerId);
        if (!entry) return;
        if (item.result) {
          // `entry.keyCount` is passed through: it describes the pool the run
          // started with, while the probe only reports which single key it
          // picked.
          Object.assign(entry, itemForResult(item.result, entry.keyCount));
        } else if (item.skip) {
          // Reuse the same mapping the pre-flight uses, so `already_running`
          // and `SKIPPED_*` are classified identically in both paths.
          const next = itemForSkip(entry.providerId, entry.providerName, item.skip.code, item.skip.reason, {
            providerType: entry.providerType,
            keyCount: entry.keyCount,
          });
          entry.state = next.state;
          entry.code = next.code;
          entry.reason = next.reason;
          entry.checkId = null;
          entry.checkedAt = null;
          entry.latencyMs = null;
          entry.resultCount = null;
          entry.requests = null;
        } else {
          return;
        }
        // One write per completed item. The alternative — batching writes —
        // would leave a reader looking at a stale progress bar for the whole
        // duration of a slow vendor.
        persist();
      },
    });

    this.active.delete(jobId);
    this.finalise(jobId);
  }

  /**
   * Writes the terminal status for a run this process just finished.
   *
   * The `WHERE status = 'running'` guard is the safety net for a status another
   * writer already decided (a cancel, or the sweep of another process): a run
   * that was cancelled must not end up reported as `completed` just because the
   * old runner eventually returned.
   */
  private finalise(jobId: string): void {
    const row = this.db
      .select()
      .from(providerTestBatches)
      .where(eq(providerTestBatches.id, jobId))
      .get();
    if (!row) return;
    const items = parseItems(row.itemsJson);
    const allResolved = items.length > 0 && items.every((item) => item.state !== "unknown");

    this.db
      .update(providerTestBatches)
      .set({
        status: allResolved ? "completed" : "partial",
        finishedAt: new Date(this.clock()).toISOString(),
      })
      .where(and(eq(providerTestBatches.id, jobId), eq(providerTestBatches.status, "running")))
      .run();
  }
}

/** Exposed for the route layer and the tests: the row shape a query returns. */
export type BatchRow = ProviderTestBatchRow;
