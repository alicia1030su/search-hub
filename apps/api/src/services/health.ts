/**
 * Provider health service.
 *
 * Two probe kinds, deliberately separate:
 *
 * - `connect` — cheapest possible request. Answers "is the endpoint reachable
 *   and is the credential accepted".
 * - `search` — a real search request. Costs money. Only runs when the operator
 *   enabled paid probes *and* the daily budget allows it.
 *
 * Everything here is budget-first: the budget is checked *before* the request,
 * so an exhausted budget produces `skipped`, never a billed failure.
 */
import { and, desc, eq, gte, lte, or, isNull } from "drizzle-orm";
import type { ProviderErrorCode } from "@search-hub/shared";
import { SearchHubError, redactSecrets, sanitizeUrl } from "@search-hub/shared";
import {
  apiKeys,
  providerHealthChecks,
  providerInstances,
  providerProbeState,
  searchEvents,
  type SearchHubDb,
} from "@search-hub/db";
import {
  buildManifest,
  getAdapter,
  getCatalogEntry,
  resolveSearchConfig,
} from "@search-hub/providers";
import { newId } from "../security/crypto.js";
import type { Logger, SafeFetch } from "@search-hub/shared";
import type { AcquireKeyResult, KeyAvailability, KeyProbeRelease } from "./providers.js";
import {
  classifyError,
  cooldownFor,
  decideBudget,
  errorCodeFor,
  parseRetryAfterMs,
  GATING_CAUSES,
  percentile,
  runtimeHealthFor,
  scoreFor,
  statusFor,
  type HealthCause,
  type HealthProbeKind,
  type HealthStatus,
  type HealthTrigger,
  type RuntimeHealth,
} from "./health-classify.js";
import { ProbeBudget, type LedgerKind, type Reservation } from "./health-budget.js";

/**
 * The exact slice of the application this service needs.
 *
 * Declared structurally rather than taking `AppContext`: the service is also
 * constructed by tests, and importing the context type would pull in a cycle
 * (context.ts builds this service).
 */
export interface HealthDependencies {
  db: SearchHubDb;
  settings: { get(): { health: HealthSettings } };
  providers: {
    providerRequiresKey(type: string, config: Record<string, unknown>): boolean;
    /** Redacts a persisted diagnostic using the current credential, when available. */
    redactKeyMessage?(keyId: string | null | undefined, message: string | null): string | null;
    /** Fallback for old rows whose key id is missing or was deleted. */
    redactProviderMessage?(providerId: string, message: string | null): string | null;
    keyAvailability(ids: string[]): Map<string, KeyAvailability>;
    acquireKey(
      providerId: string,
      options?: { keyId?: string; signal?: AbortSignal; maxWaitMs?: number; manual?: boolean },
    ): Promise<AcquireKeyResult>;
  };
  fetch: SafeFetch;
  appLogger: Logger;
}

export interface HealthCheckResult {
  id: string;
  providerId: string;
  providerName: string;
  providerType: string;
  keyId: string | null;
  kind: HealthProbeKind;
  status: HealthStatus;
  cause: HealthCause;
  errorCode: ProviderErrorCode | null;
  latencyMs: number | null;
  resultCount: number | null;
  healthScore: number;
  message: string;
  checkedAt: string;
  trigger: HealthTrigger;
  cooldownUntil: string | null;
  sample?: Array<{ title: string; url: string }>;
  /**
   * Physical upstream requests this probe issued (`null` when none was sent).
   *
   * Counted at the fetch boundary, so it includes every redirect hop and every
   * page of a paginated search. It is deliberately **not** derived from the
   * planned page count: a probe that never reached the vendor must report
   * "unknown", not a number the UI would present as evidence.
   */
  requests: number | null;
  /** Vendor billing unit is unknown; requests are never presented as billed calls. */
  billingUnit?: "unknown";
  /**
   * Whether this probe consumed a paid budget slot.
   *
   * `false` when the request never left the machine (no credential). The caller
   * refunds its per-run counter from this, so an impossible probe cannot make
   * "check all" stop early while nothing was actually spent.
   */
  spent?: boolean;
}

/**
 * Implementation verification, copied from the catalog and never inferred from
 * a probe. "The endpoint answered" says nothing about whether anyone has ever
 * run a real, credentialed search against the vendor.
 */
export interface ImplementationStatus {
  verification: "documented" | "live_tested" | "mock_verified" | "unverified" | "no_official_api";
  implementation: "builtin" | "generic" | "planned" | "unavailable";
  docsUrl: string | null;
}

export interface ProviderHealthSummary {
  providerId: string;
  providerName: string;
  providerType: string;
  enabled: boolean;
  /** Stored four-value status (kept for compatibility). */
  status: HealthStatus;
  /** Operator-facing state derived from status + cause + credentials. */
  runtime: RuntimeHealth;
  implementation: ImplementationStatus;
  /** Whether the scheduler may probe this provider. */
  autoProbeEnabled: boolean;
  /** When the scheduler will next consider it, if a schedule is enabled. */
  nextProbeAt: string | null;
  /** Probe kind the scheduler would use right now. */
  probeMode: HealthProbeKind;
  healthScore: number;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  /** Live search traffic only; health probes are excluded. */
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  searchCalls: number;
  keyAvailable: number;
  keyTotal: number;
  lastProbe: {
    kind: HealthProbeKind;
    status: HealthStatus;
    checkedAt: string;
    errorCode: string | null;
    resultCount: number | null;
  } | null;
  trend: Array<{ bucket: string; healthy: number; degraded: number; unhealthy: number }>;
}

export interface HealthOverview {
  generatedAt: string;
  providers: ProviderHealthSummary[];
  budget: {
    /** UTC day the counters belong to, so the API does not imply local time. */
    day: string;
    maxPerRun: number;
    maxPerDay: number;
    anonymousMaxPerRun: number;
    anonymousMaxPerDay: number;
    /** Paid searches reserved today. */
    usedToday: number;
    /** Physical connectivity HTTP hops reserved today. */
    connectUsedToday: number;
    /** Anonymous searches reserved today. */
    anonymousSearchUsedToday: number;
    remainingToday: number;
    anonymousRemainingToday: number;
    /** Physical HTTP hops allowed for one connectivity probe. */
    connectMaxPerProbe: number;
    /** Physical HTTP hops allowed for connectivity probes per UTC day. */
    connectMaxPerDay: number;
    connectRemainingToday: number;
    paidProbesEnabled: boolean;
    scheduledEnabled: boolean;
    intervalMinutes: number;
  };
  /** Counted by runtime state; `totals` keeps the four legacy buckets. */
  runtimeTotals: Record<RuntimeHealth, number>;
  totals: Record<HealthStatus, number>;
}

/** Mirror of `AppSettings["health"]`, repeated here to avoid the import cycle. */
export interface HealthSettings {
  scheduledEnabled: boolean;
  intervalMinutes: number;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  anonymousMaxRequestsPerRun: number;
  anonymousMaxRequestsPerDay: number;
  connectMaxRequestsPerProbe: number;
  connectMaxRequestsPerDay: number;
  paidProbesEnabled: boolean;
  includeUnverified: boolean;
  concurrency: number;
}

const TREND_BUCKETS = 24;

export class HealthService {
  private lastScheduledRun: string | null = null;
  private readonly budgetLedger: ProbeBudget;
  /** Providers with a probe in flight; the scheduler must never double-probe. */
  private readonly inFlight = new Set<string>();
  private queuedProbes = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly ctx: HealthDependencies,
    private readonly clock: () => number = () => Date.now(),
    /** Injectable for deterministic backoff assertions; never used for security. */
    private readonly random: () => number = Math.random,
  ) {
    this.budgetLedger = new ProbeBudget(ctx.db, clock);
  }

  private get db(): SearchHubDb {
    return this.ctx.db;
  }

  /**
   * Budget view for the API and the UI.
   *
   * Counts come from the durable ledger, not from counting probe rows: the row
   * is written *after* the request, so two concurrent probes would both read the
   * same pre-spend number and both pass.
   */
  budget() {
    const policy = this.ctx.settings.get().health;
    const snapshot = this.budgetLedger.snapshot({
      paidProbesEnabled: policy.paidProbesEnabled,
      maxPerRun: policy.maxRequestsPerRun,
      maxPerDay: policy.maxRequestsPerDay,
      anonymousMaxPerRun: policy.anonymousMaxRequestsPerRun,
      anonymousMaxPerDay: policy.anonymousMaxRequestsPerDay,
      connectMaxPerProbe: policy.connectMaxRequestsPerProbe,
      connectMaxPerDay: policy.connectMaxRequestsPerDay,
    });
    return {
      day: snapshot.day,
      maxPerRun: snapshot.maxPerRun,
      maxPerDay: snapshot.maxPerDay,
      anonymousMaxPerRun: snapshot.anonymousMaxPerRun,
      anonymousMaxPerDay: snapshot.anonymousMaxPerDay,
      connectMaxPerProbe: snapshot.connectMaxPerProbe,
      connectMaxPerDay: snapshot.connectMaxPerDay,
      usedToday: snapshot.searchUsedToday,
      connectUsedToday: snapshot.connectUsedToday,
      anonymousSearchUsedToday: snapshot.anonymousSearchUsedToday,
      remainingToday: snapshot.remainingToday,
      anonymousRemainingToday: snapshot.anonymousRemainingToday,
      connectRemainingToday: snapshot.connectRemainingToday,
      paidProbesEnabled: snapshot.paidProbesEnabled,
      scheduledEnabled: policy.scheduledEnabled,
      intervalMinutes: policy.intervalMinutes,
    };
  }

  /**
   * Probes one provider.
   *
   * `kind: "search"` is refused (not silently downgraded) when paid probes are
   * disabled or the budget is exhausted: the caller must be able to tell the
   * difference between "healthy" and "we chose not to spend a request".
   *
   * `signal` is the *job's* cancellation (a bulk run being cancelled). It is
   * combined with this probe's own timeout so either can stop the request, and
   * the abort reason keeps `code: "cancelled"` so the classifier reports a
   * cancellation rather than a timeout.
   */
  async checkOne(
    providerId: string,
    options: {
      kind?: HealthProbeKind;
      keyId?: string;
      /** 显式管理端重测：允许恢复 invalid/forbidden/cooldown/quota_exhausted。 */
      manual?: boolean;
      trigger?: HealthTrigger;
      signal?: AbortSignal;
      /** Bulk run this probe belongs to; written to `provider_health_checks`. */
      batchId?: string | null;
    } = {},
  ): Promise<HealthCheckResult> {
    const result = await this.probeWithLock(providerId, options);
    if (result === "already_running") {
      throw new SearchHubError(
        "already_running",
        "already_running: another health probe for this source is in flight",
      );
    }
    return result;
  }

  private async checkOneUnlocked(
    providerId: string,
    options: {
      kind?: HealthProbeKind;
      keyId?: string;
      manual?: boolean;
      trigger?: HealthTrigger;
      signal?: AbortSignal;
      batchId?: string | null;
    } = {},
  ): Promise<HealthCheckResult> {
    const row = this.db.select().from(providerInstances).where(eq(providerInstances.id, providerId)).get();
    if (!row) throw new SearchHubError("not_found", "Provider not found");
    const adapter = getAdapter(row.type);
    if (!adapter) throw new SearchHubError("unsupported", `Provider type "${row.type}" is not implemented`);

    const kind = options.kind ?? "connect";
    const trigger = options.trigger ?? "manual";
    const policy = this.ctx.settings.get().health;
    const catalogEntry = getCatalogEntry(row.type);

    // A caller that already gave up must not start a paid request.
    if (options.signal?.aborted) {
      throw cancelledError();
    }

    const providerConfig = safeJson(row.configJson);
    const requiresKey = this.ctx.providers.providerRequiresKey(row.type, providerConfig);
    if (row.type === "generic-http" && requiresKey && kind === "connect") {
      throw new SearchHubError(
        "validation_error",
        "Credentialed generic providers require a search probe; a connectivity probe is not supported.",
      );
    }

    // Key ownership/enabled/decryptability is validated by ProviderService before
    // the lease is exposed. The lease is taken before budget reservation so a
    // refused probe can return both Key and account slots with notSent.
    const availability = this.ctx.providers.keyAvailability([providerId]).get(providerId);
    let lease: Extract<AcquireKeyResult, { ok: true }> | undefined;
    let targetKeyId = options.keyId ?? null;
    if (options.keyId !== undefined || requiresKey) {
      const acquired = await this.ctx.providers.acquireKey(providerId, {
        ...(options.keyId === undefined ? {} : { keyId: options.keyId }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        manual: options.manual,
      });
      if (acquired.ok) {
        lease = acquired;
        targetKeyId = acquired.keyId;
      } else if (options.keyId !== undefined) {
        throw keyAcquisitionError(acquired);
      } else {
        const accountQuota = acquired.reason === "account_quota";
        return this.record({
          providerId,
          providerName: row.name,
          providerType: row.type,
          keyId: null,
          kind,
          status: accountQuota ? "unhealthy" : "unverified",
          cause: accountQuota ? "quota_exceeded" : (availability?.total ?? 0) === 0 ? "no_credential" : "config_incomplete",
          latencyMs: null,
          resultCount: null,
          message: acquired.message,
          trigger,
          spent: false,
          requests: null,
          batchId: options.batchId ?? null,
        });
      }
    }

    // A real search with no credential cannot consume the operator's account
    // quota. Anonymous generic connectivity also executes a search, so it belongs
    // in the anonymous bucket rather than the free builtin connectivity bucket.
    const anonymousSearch = lease === undefined && (kind === "search" || row.type === "generic-http");
    const ledgerKind = anonymousSearch ? "search_anonymous" : kind;
    let reservation: Reservation | undefined;
    let connectReservation: Reservation | undefined;
    let requests = 0;
    let timer: NodeJS.Timeout | undefined;
    let detached: ReturnType<typeof composeAbort> | undefined;
    let keyOutcome: KeyProbeRelease = { ok: false, notSent: true };
    let connectBudgetRefused = false;

    // One lifecycle owns both scarce resources. Anything that throws after the
    // lease is acquired — including a ledger failure, a billing write failure or
    // a scheduler write failure — must return the lease and a provably unused
    // budget slot exactly once.
    try {
      if (ledgerKind !== "connect") {
        reservation = this.budgetLedger.reserve({
          kind: ledgerKind,
          paidProbesEnabled: policy.paidProbesEnabled,
          maxPerRun: policy.maxRequestsPerRun,
          maxPerDay: policy.maxRequestsPerDay,
          anonymousMaxPerRun: policy.anonymousMaxRequestsPerRun,
          anonymousMaxPerDay: policy.anonymousMaxRequestsPerDay,
        });
        if (!reservation.ok) {
          if (kind === "search" && ledgerKind === "search") {
            if (reservation.reason === "paid_disabled") {
              throw new SearchHubError(
                "validation_error",
                "Paid search probes are disabled. Enable them in Settings → Provider health, or run a connectivity probe instead.",
              );
            }
            throw new SearchHubError(
              "quota_exceeded",
              `Health probe budget exhausted (${reservation.reason}). Paid probes used today: ${reservation.snapshot.searchUsedToday}/${policy.maxRequestsPerDay}.`,
            );
          }
          if (ledgerKind === "search_anonymous" && reservation.reason !== "ledger_unavailable") {
            throw new SearchHubError(
              "quota_exceeded",
              `Anonymous health probe budget exhausted (${reservation.reason}). Anonymous probes used today: ${reservation.snapshot.anonymousSearchUsedToday}/${reservation.snapshot.anonymousMaxPerDay}.`,
            );
          }
          throw new SearchHubError("internal_error", `Health probe budget is unavailable (${reservation.reason})`);
        }
      }

      /**
       * Physical requests issued by this probe.
       *
       * Incremented from the fetch boundary (`onRequest`), which fires per physical
       * request including redirect hops — the only place a count is accurate. It
       * stays `0` until a request is actually attempted, and is reported as `null`
       * in that case, so "never left the machine" is distinguishable from "one
       * request".
       */
      const countedFetch: SafeFetch = (url, init) =>
        this.ctx.fetch(url, {
          ...init,
          secrets: [...(init?.secrets ?? []), ...(lease ? [lease.secret] : [])],
          onRequest: (target) => {
            if (kind === "connect") {
              if (requests >= policy.connectMaxRequestsPerProbe) {
                connectBudgetRefused = true;
                throw new SearchHubError(
                  "quota_exceeded",
                  `Connectivity probe request limit reached (${policy.connectMaxRequestsPerProbe} physical HTTP hops).`,
                  { details: { localBudget: true, limit: policy.connectMaxRequestsPerProbe, requests } },
                );
              }
              // A connect reservation belongs to the UTC day on which each hop
              // is sent. Refuse a hop after midnight rather than silently
              // charging it to yesterday's bucket.
              const active = connectReservation ?? reservation;
              if (active && active.snapshot.day !== ProbeBudget.utcDay(this.clock())) {
                connectBudgetRefused = true;
                throw new SearchHubError(
                  "quota_exceeded",
                  "Connectivity probe stopped at the UTC day boundary; retry to use today's request budget.",
                  { details: { localBudget: true, reason: "day_changed", requests } },
                );
              }
              const next = this.budgetLedger.reserve({
                kind: "connect",
                paidProbesEnabled: policy.paidProbesEnabled,
                maxPerRun: policy.maxRequestsPerRun,
                maxPerDay: policy.maxRequestsPerDay,
                anonymousMaxPerRun: policy.anonymousMaxRequestsPerRun,
                anonymousMaxPerDay: policy.anonymousMaxRequestsPerDay,
                connectMaxPerProbe: policy.connectMaxRequestsPerProbe,
                connectMaxPerDay: policy.connectMaxRequestsPerDay,
              });
              if (!next.ok) {
                connectBudgetRefused = true;
                throw new SearchHubError(
                  "quota_exceeded",
                  `Connectivity probe budget exhausted (${next.reason}). Physical HTTP hops used today: ${next.snapshot.connectUsedToday}/${next.snapshot.connectMaxPerDay}.`,
                  { details: { localBudget: true, reason: next.reason, requests } },
                );
              }
              // The clock can cross midnight between the check above and the
              // conditional UPDATE. Refund the just-created new-day slot and
              // refuse the hop instead of mixing days in one probe.
              if (active && active.snapshot.day !== next.snapshot.day) {
                this.budgetLedger.release("connect", next.snapshot.day);
                connectBudgetRefused = true;
                throw new SearchHubError(
                  "quota_exceeded",
                  "Connectivity probe stopped at the UTC day boundary; retry to use today's request budget.",
                  { details: { localBudget: true, reason: "day_changed", requests } },
                );
              }
              if (ledgerKind === "connect") reservation ??= next;
              else connectReservation ??= next;
            }
            requests += 1;
            init?.onRequest?.(target);
          },
        });

      const started = this.clock();
      const controller = new AbortController();
      const timeoutMs = Math.min(row.timeoutMs, kind === "connect" ? 12_000 : 20_000);
      timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
      detached = composeAbort(controller.signal, options.signal);

      let result: Awaited<ReturnType<typeof adapter.search>>;
      try {
        result = await adapter.search(
          { query: probeQuery(row.type, kind), limit: kind === "connect" ? 1 : 3, signal: detached.signal },
          {
            fetch: countedFetch,
            ...(lease === undefined ? {} : { apiKey: lease.secret }),
            config: {
              id: row.id,
              name: row.name,
              type: row.type,
              baseUrl: row.baseUrl,
              timeoutMs,
              maxResults: row.resultsPerPage,
              language: row.language,
              freshness: row.freshness as never,
              model: null,
              maxRetries: 0,
              breakerThreshold: row.breakerThreshold,
              breakerCooldownMs: row.breakerCooldownMs,
              config: safeJson(row.configJson),
              // The search path resolves the platform parameters into a concrete
              // plan (`targetResults`, `maxPages`, `maxRequestsPerSearch`,
              // `pageSize`). Passing the raw settings object here made every
              // paginated adapter compute `Math.max(1, undefined) = NaN` pages,
              // issue no request at all, and report `empty_results` — a healthy
              // vendor marked degraded by the probe itself.
              search: resolveSearchConfig(
                catalogEntry ? buildManifest(catalogEntry) : buildManifest({ type: row.type } as never),
                safeJson(row.searchConfigJson),
              ),
            },
            signal: detached.signal,
            logger: this.ctx.appLogger,
          },
        );
      } catch (error) {
        if (connectBudgetRefused) {
          keyOutcome = requests === 0
            ? { ok: false, notSent: true }
            : { ok: false, cancelled: true };
          throw error;
        }
        const latencyMs = this.clock() - started;
        const cause = controller.signal.aborted && !options.signal?.aborted ? "timeout" : classifyError(error);
        // A cancelled probe is not evidence about the source: it says the caller
        // (or shutdown) stopped it, so nothing is recorded against the provider.
        // The lifecycle finally keeps a sent request's reservation and refunds
        // only a probe that provably never left the machine.
        if (cause === "cancelled" || detached.cancelled()) {
          keyOutcome = { ok: false, ...(requests === 0 ? { notSent: true } : { cancelled: true }) };
          throw cancelledError();
        }
        const retryAfterMs = parseRetryAfterMs((error as { retryAfterMs?: number } | null)?.retryAfterMs);
        const safeMessage = redactSecrets(
          error instanceof Error ? error.message : String(error),
          [lease?.secret],
        );
        const cooldown =
          cause === "quota_exceeded"
            ? nextUtcMidnight(this.clock()) + 1_000 - this.clock()
            : cooldownFor(cause, retryAfterMs);
        keyOutcome = requests === 0
          ? { ok: false, notSent: true }
          : { ok: false, code: cause, message: safeMessage, ...(retryAfterMs === null ? {} : { retryAfterMs }) };
        const recorded = this.record({
          providerId,
          providerName: row.name,
          providerType: row.type,
          keyId: targetKeyId,
          kind,
          status: statusFor(cause),
          cause,
          latencyMs,
          resultCount: null,
          message: safeMessage,
          trigger,
          cooldownMs: cooldown ?? undefined,
          spent: requests > 0 && kind === "search" && ledgerKind === "search",
          requests: requests > 0 ? requests : null,
          ...(reservation ? { billing: { kind: ledgerKind, day: reservation.snapshot.day } } : {}),
          credentialUsed: lease !== undefined,
          batchId: options.batchId ?? null,
        });
        this.advanceSchedule(providerId, cause);
        return recorded;
      }

      const latencyMs = this.clock() - started;
      const count = result.results.length;
      // HTTP 200 with no rows is a degraded answer, not a healthy one: the
      // vendor answered, but the source is not usable for searching right now.
      const cause: HealthCause = count > 0 ? "ok" : "empty_results";
      keyOutcome = requests === 0
        ? { ok: false, notSent: true }
        : count > 0
          ? { ok: true, latencyMs }
          : { ok: false, code: "empty_results", message: "Endpoint returned no results" };
      const recorded = this.record({
        providerId,
        providerName: row.name,
        providerType: row.type,
        keyId: targetKeyId,
        kind,
        status: statusFor(cause),
        cause,
        latencyMs,
        resultCount: count,
        message:
          count > 0
            ? `${count} result(s) in ${latencyMs}ms`
            : "Endpoint answered but returned no results; treated as degraded, not healthy.",
        trigger,
        sample: result.results.slice(0, 3).map((item) => ({
          title: redactSecrets(item.title, lease ? [lease.secret] : []),
          url: sanitizeUrl(item.url, lease ? [lease.secret] : []),
        })),
        spent: requests > 0 && kind === "search" && ledgerKind === "search",
        requests: requests > 0 ? requests : null,
        ...(reservation ? { billing: { kind: ledgerKind, day: reservation.snapshot.day } } : {}),
        credentialUsed: lease !== undefined,
        batchId: options.batchId ?? null,
      });
      this.advanceSchedule(providerId, cause);
      return recorded;
    } finally {
      try {
        if (timer) clearTimeout(timer);
        detached?.dispose();
        if (reservation?.ok && requests === 0) {
          this.budgetLedger.release(ledgerKind, reservation.snapshot.day);
        }
        if (connectReservation?.ok && requests === 0) {
          this.budgetLedger.release("connect", connectReservation.snapshot.day);
        }
      } finally {
        // Key state has one writer: the scheduler lease. release() waits for the
        // dirty snapshot to reach SQLite before this API result is returned, and
        // also runs when reservation, observation or scheduling writes fail.
        if (lease) await lease.release(keyOutcome);
      }
    }
  }

  /**
   * Moves the provider's next scheduled probe.
   *
   * Success resets the backoff to the normal interval. A transient failure
   * retries sooner (bounded exponential), because waiting a full interval for a
   * DNS blip is how a source stays "down" for hours after it recovered. A
   * terminal failure (quota, bad credential) waits for the normal interval —
   * retrying those in a minute only spends more.
   *
   * The jitter keeps every provider from probing on the same tick after a
   * synchronized deploy or restart.
   */
  private advanceSchedule(providerId: string, cause: HealthCause): void {
    const policy = this.ctx.settings.get().health;
    const intervalMs = Math.max(5, policy.intervalMinutes) * 60_000;
    const now = this.clock();
    const prior = this.db
      .select()
      .from(providerProbeState)
      .where(eq(providerProbeState.providerId, providerId))
      .get();

    const healthy = cause === "ok";
    const failures = healthy ? 0 : (prior?.consecutiveFailures ?? 0) + 1;
    const level = healthy ? 0 : Math.min((prior?.backoffLevel ?? 0) + 1, 6);
    const transient =
      cause === "timeout" ||
      cause === "network" ||
      cause === "dns" ||
      cause === "tls" ||
      cause === "server_error" ||
      cause === "bad_response" ||
      cause === "empty_results" ||
      cause === "rate_limited";

    const baseMs = transient ? Math.min(intervalMs, 60_000 * 2 ** Math.max(0, level - 1)) : intervalMs;
    // ±20% jitter. `random` is injectable so tests can be deterministic.
    const jitterMs = Math.round(baseMs * 0.2 * (this.random() * 2 - 1));
    const nextAt = new Date(now + Math.max(15_000, baseMs + jitterMs)).toISOString();
    const updatedAt = new Date(now).toISOString();

    this.db
      .insert(providerProbeState)
      .values({
        providerId,
        autoProbeEnabled: prior?.autoProbeEnabled ?? true,
        consecutiveFailures: failures,
        backoffLevel: level,
        nextProbeAt: nextAt,
        resetAt: prior?.resetAt ?? null,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: providerProbeState.providerId,
        set: { consecutiveFailures: failures, backoffLevel: level, nextProbeAt: nextAt, updatedAt },
      })
      .run();
  }

  /** Switches automatic probing for one provider. */
  setAutoProbe(providerId: string, enabled: boolean): void {
    const row = this.db
      .select({ id: providerInstances.id })
      .from(providerInstances)
      .where(eq(providerInstances.id, providerId))
      .get();
    if (!row) throw new SearchHubError("not_found", "Provider not found");
    const now = new Date(this.clock()).toISOString();
    this.db
      .insert(providerProbeState)
      .values({
        providerId,
        autoProbeEnabled: enabled,
        consecutiveFailures: 0,
        backoffLevel: 0,
        nextProbeAt: enabled ? now : null,
        resetAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providerProbeState.providerId,
        set: { autoProbeEnabled: enabled, nextProbeAt: enabled ? now : null, updatedAt: now },
      })
      .run();
  }

  /**
   * Forgets the recorded health of one provider.
   *
   * History is kept — deleting evidence of a failure is not a reset, it is a
   * cover-up. The marker makes older rows stop determining the status, so the
   * provider reads `unknown` and the next probe decides. Credentials are *not*
   * touched: re-enabling a rejected key by "resetting health" would silently
   * start spending on a key the vendor already refused.
   */
  resetProvider(providerId: string): { providerId: string; resetAt: string } {
    const row = this.db
      .select({ id: providerInstances.id })
      .from(providerInstances)
      .where(eq(providerInstances.id, providerId))
      .get();
    if (!row) throw new SearchHubError("not_found", "Provider not found");
    const now = new Date(this.clock()).toISOString();
    this.db
      .insert(providerProbeState)
      .values({
        providerId,
        autoProbeEnabled: true,
        consecutiveFailures: 0,
        backoffLevel: 0,
        nextProbeAt: now,
        resetAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: providerProbeState.providerId,
        set: {
          consecutiveFailures: 0,
          backoffLevel: 0,
          nextProbeAt: now,
          resetAt: now,
          updatedAt: now,
        },
      })
      .run();
    return { providerId, resetAt: now };
  }

  /**
   * Probes one provider unless it is already being probed.
   *
   * This is the **only** de-duplication mechanism in the health system: both
   * `checkMany` (scheduled pass, "check all") and the bulk-test runner acquire
   * their slot here, so a source can never be probed twice at once on two paid
   * paths. A second in-flight set elsewhere would drift and start paying twice
   * for one answer.
   *
   * Returns `"already_running"` instead of throwing: "someone else is on it" is
   * a normal outcome the caller records as a skip, not an error.
   */
  private async probeWithLock(
    providerId: string,
    options: {
      kind?: HealthProbeKind;
      trigger?: HealthTrigger;
      keyId?: string;
      manual?: boolean;
      signal?: AbortSignal;
      batchId?: string | null;
    },
  ): Promise<HealthCheckResult | "already_running"> {
    if (this.inFlight.has(providerId)) return "already_running";
    this.inFlight.add(providerId);
    try {
      return await this.checkOneUnlocked(providerId, options);
    } finally {
      this.inFlight.delete(providerId);
    }
  }

  get activeProbeCount(): number {
    return this.inFlight.size;
  }

  get queueDepth(): number {
    return this.queuedProbes;
  }

  /** True while a probe for this provider is in flight (used by the runner). */
  isProbing(providerId: string): boolean {
    return this.inFlight.has(providerId);
  }

  /**
   * Probes several providers with a bounded number of concurrent workers.
   *
   * Concurrency defaults to the configured `health.concurrency` (1..4). `gapMs`
   * keeps a scheduled pass from looking like a burst; a bulk run passes `0`
   * because its worker count is already the throttle and a human is watching.
   *
   * `onItem` reports every provider exactly once — a result or a skip — which is
   * what lets the bulk runner persist progress as it happens instead of waiting
   * for the whole run.
   */
  async checkMany(
    providerIds: string[] | null,
    options: {
      kind?: HealthProbeKind;
      trigger?: HealthTrigger;
      gapMs?: number;
      /** Job-level cancellation; aborted providers are reported as skipped. */
      signal?: AbortSignal;
      /** Worker count, clamped to 1..4. Defaults to `health.concurrency`. */
      concurrency?: number;
      /**
       * Retained for call-site compatibility.
       *
       * De-duplication is now unconditional: `probeWithLock` is the single gate
       * every path (scheduled pass, "check all", bulk run) goes through, so
       * passing `false` here can no longer disable it — that switch existing at
       * all is what allowed two paid paths to probe one source at once.
       */
      respectInFlight?: boolean;
      /** Called once per provider, as soon as its outcome is known. */
      onItem?: (item: {
        providerId: string;
        result?: HealthCheckResult;
        skip?: { code: string; reason: string };
      }) => void;
      /** Bulk run ledger id, forwarded to every probe row. */
      batchId?: string | null;
    } = {},
  ): Promise<{
    results: HealthCheckResult[];
    skipped: Array<{ providerId: string; reason: string; code?: string }>;
    budget: ReturnType<HealthService["budget"]>;
  }> {
    const kind = options.kind ?? "connect";
    const trigger = options.trigger ?? "manual";
    const ids =
      providerIds ??
      this.db
        .select({ id: providerInstances.id })
        .from(providerInstances)
        .where(eq(providerInstances.enabled, true))
        .all()
        .map((row) => row.id);

    const results: HealthCheckResult[] = [];
    const skipped: Array<{ providerId: string; reason: string; code?: string }> = [];
    const gap = options.gapMs ?? 400;
    // Concurrency is capped at 4; a serial default keeps a scheduled pass from
    // looking like a burst to every vendor at once.
    const workers = clampConcurrency(options.concurrency ?? this.ctx.settings.get().health.concurrency ?? 1);

    const emitSkip = (providerId: string, code: string, reason: string): void => {
      skipped.push({ providerId, reason, code });
      options.onItem?.({ providerId, skip: { code, reason } });
    };

    // The per-run cap applies to this loop, not to the daily counter: otherwise
    // a single "check all" would ignore maxRequestsPerRun entirely.
    let spentPaidThisRun = 0;
    let spentAnonymousThisRun = 0;
    const queue = [...ids];
    this.queuedProbes += queue.length;
    const worker = async (): Promise<void> => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;
        this.queuedProbes = Math.max(0, this.queuedProbes - 1);
        await probe(id);
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      }
    };
    const probe = async (id: string): Promise<void> => {
      // A cancelled job must stop *before* the next paid request. Checking here
      // (rather than only inside `checkOne`) means the remaining queue is
      // reported as cancelled without reserving any budget at all.
      if (options.signal?.aborted) {
        emitSkip(id, "SKIPPED_CANCELLED", "cancelled: the bulk run was cancelled before this probe started");
        return;
      }
      // One probe per provider at a time. Two passes (a scheduled tick and a
      // manual "check all") would otherwise hit the same vendor twice, and for
      // a paid probe that is paying twice for one answer.
      //
      // Checked before the budget so a concurrent duplicate is reported as
      // `already_running` rather than as an exhausted budget it did not cause.
      if (this.isProbing(id)) {
        emitSkip(id, "already_running", "already_running: another probe for this source is in flight");
        return;
      }
      let paidThisProbe = false;
      let anonymousThisProbe = false;
      const row = this.db.select().from(providerInstances).where(eq(providerInstances.id, id)).get();
      if (row) {
        const config = safeJson(row.configJson);
        const requiresKey = this.ctx.providers.providerRequiresKey(row.type, config);
        const credentialed = requiresKey;
        const anonymousSearch = !credentialed && (kind === "search" || row.type === "generic-http");
        const budget = this.budget();
        if (anonymousSearch) {
          if (kind === "connect" && row.type === "generic-http" &&
              (budget.connectMaxPerProbe < 1 || budget.connectRemainingToday <= 0)) {
            emitSkip(id, "SKIPPED_BUDGET", "budget_exhausted:connect_http_limit");
            return;
          }
          const remainingRun = budget.anonymousMaxPerRun - spentAnonymousThisRun;
          if (remainingRun <= 0 || budget.anonymousRemainingToday <= 0) {
            emitSkip(id, "SKIPPED_BUDGET", "budget_exhausted:anonymous_limit");
            return;
          }
          spentAnonymousThisRun += 1;
          anonymousThisProbe = true;
        } else if (kind === "search" && credentialed) {
          const remainingRun = budget.maxPerRun - spentPaidThisRun;
          if (remainingRun <= 0) {
            emitSkip(id, "SKIPPED_BUDGET", "budget_exhausted:run_limit");
            return;
          }
          const decision = decideBudget({ ...budget, maxPerRun: remainingRun }, 1);
          if (!decision.allowed) {
            emitSkip(id, "SKIPPED_BUDGET", `budget_exhausted:${decision.reason}`);
            return;
          }
          spentPaidThisRun += 1;
          paidThisProbe = true;
        }
      }
      try {
        const outcome = await this.probeWithLock(id, {
          kind,
          trigger,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          batchId: options.batchId ?? null,
        });
        if (outcome === "already_running") {
          if (paidThisProbe) spentPaidThisRun -= 1;
          if (anonymousThisProbe) spentAnonymousThisRun -= 1;
          emitSkip(id, "already_running", "already_running: another probe for this source is in flight");
          return;
        }
        // A probe that never left the machine (no credential, refused before
        // the request) must not consume the per-run allowance: otherwise
        // "check all" stops early while nothing was spent.
        if (paidThisProbe && outcome.spent === false) spentPaidThisRun -= 1;
        if (anonymousThisProbe && outcome.requests === null) spentAnonymousThisRun -= 1;
        results.push(outcome);
        options.onItem?.({ providerId: id, result: outcome });
      } catch (error) {
        // A cancellation is not a source failure: it carries its own code so
        // the runner can record `SKIPPED_CANCELLED` and leave health untouched.
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "cancelled") {
          if (paidThisProbe) spentPaidThisRun -= 1;
          if (anonymousThisProbe) spentAnonymousThisRun -= 1;
          emitSkip(id, "SKIPPED_CANCELLED", "cancelled: the bulk run was cancelled while this probe was in flight");
          return;
        }
        const details = (error as { details?: unknown } | null)?.details;
        const localBudget = typeof details === "object" && details !== null &&
          (details as { localBudget?: unknown }).localBudget === true;
        if (code === "quota_exceeded" && kind === "connect" && localBudget) {
          if (anonymousThisProbe && (details as { requests?: unknown }).requests === 0) {
            spentAnonymousThisRun -= 1;
          }
          emitSkip(id, "SKIPPED_BUDGET", "budget_exhausted:connect_http_limit");
          return;
        }
        if (paidThisProbe) spentPaidThisRun -= 1;
        if (anonymousThisProbe) spentAnonymousThisRun -= 1;
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ providerId: id, reason });
        options.onItem?.({ providerId: id, skip: { code: "unknown", reason } });
      }
    };

    try {
      const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, ids.length || 1) }, () => worker()));
      const firstFailure = settled.find((outcome) => outcome.status === "rejected");
      if (firstFailure?.status === "rejected") throw firstFailure.reason;
      return { results, skipped, budget: this.budget() };
    } finally {
      // A worker may reject from onItem while peers are still running. Only the
      // allSettled boundary can safely account for the unconsumed tail.
      this.queuedProbes = Math.max(0, this.queuedProbes - queue.length);
    }
  }

  /**
   * One scheduled pass. Returns null when scheduling is off, so a caller can
   * tell scheduling-disabled apart from ran-but-empty.
   */
  async runScheduled(): Promise<{ results: HealthCheckResult[]; skipped: unknown[] } | null> {
    const policy = this.ctx.settings.get().health;
    if (!policy.scheduledEnabled) return null;
    const now = this.clock();
    // The interval lives in each provider's `nextProbeAt`, not in a global gate.
    // A global gate would also block the *fast* retries that backoff exists for:
    // a source that failed with a timeout should be retried in a minute, not in
    // six hours, even though the schedule interval is six hours.

    // Each provider carries its own `nextProbeAt`: a source that just failed
    // backs off, and a source that just recovered must not wait a full interval
    // for the next attempt. Providers this pass does not touch stay untouched.
    const due = this.db
      .select({ providerId: providerProbeState.providerId })
      .from(providerProbeState)
      .innerJoin(providerInstances, eq(providerInstances.id, providerProbeState.providerId))
      .where(
        and(
          eq(providerInstances.enabled, true),
          eq(providerProbeState.autoProbeEnabled, true),
          or(isNull(providerProbeState.nextProbeAt), lte(providerProbeState.nextProbeAt, new Date(now).toISOString())),
        ),
      )
      .all();

    // Providers with no state row have never been probed: they are due too.
    // One query for the state table beats one query per provider.
    const known = new Set(
      this.db.select({ providerId: providerProbeState.providerId }).from(providerProbeState).all()
        .map((row) => row.providerId),
    );
    const unscheduled = this.db
      .select({ id: providerInstances.id })
      .from(providerInstances)
      .where(eq(providerInstances.enabled, true))
      .all()
      .filter((row) => !known.has(row.id));

    const ids = [...new Set([...due.map((row) => row.providerId), ...unscheduled.map((row) => row.id)])];
    // Nothing due: report "no pass ran" rather than an empty pass, so a caller
    // can tell "the schedule is idle" from "the schedule ran and found nothing".
    if (ids.length === 0) return null;

    // Scheduled runs are connectivity-only unless the operator opted into paid
    // probes: a timer must never be the reason money is spent.
    const kind: HealthProbeKind = policy.paidProbesEnabled ? "search" : "connect";
    const run = await this.checkMany(ids, { kind, trigger: "schedule", respectInFlight: true });
    return { results: run.results, skipped: run.skipped };
  }

  /**
   * Providers that should be skipped on this search, with the reason.
   *
   * Only *terminal* health states gate a search: a provider whose last probe
   * failed with an account-wide cause (quota, invalid credential) is skipped until
   * its recorded cooldown expires. A transient timeout or a single 5xx does NOT
   * gate — the scheduler's own circuit breaker handles repeated failures, and
   * permanently removing a provider because one probe timed out is exactly the
   * "one timeout kills a key" bug the brief warns about.
   */
  blockedProviders(now = Date.now()): Map<string, { code: string; message: string; until: string }> {
    const blocked = new Map<string, { code: string; message: string; until: string }>();
    const since = new Date(now - 3_600_000).toISOString();
    const rows = this.db
      .select()
      .from(providerHealthChecks)
      .where(gte(providerHealthChecks.checkedAt, since))
      .orderBy(desc(providerHealthChecks.checkedAt))
      .all();

    const latest = new Map<string, typeof providerHealthChecks.$inferSelect>();
    for (const row of rows) if (!latest.has(row.providerId)) latest.set(row.providerId, row);

    // A manual reset means "stop trusting what we recorded before this moment".
    // Old rows stay for audit but no longer gate a search.
    const resets = new Map(
      this.db
        .select({ providerId: providerProbeState.providerId, resetAt: providerProbeState.resetAt })
        .from(providerProbeState)
        .all()
        .filter((item) => item.resetAt !== null)
        .map((item) => [item.providerId, item.resetAt as string] as const),
    );

    for (const [providerId, row] of latest) {
      if (row.status !== "unhealthy" && row.status !== "degraded") continue;
      const resetAt = resets.get(providerId);
      if (resetAt && row.checkedAt <= resetAt) continue;
      const detail = safeJson(row.detailJson) as { cause?: string; cooldownUntil?: string };
      const cause = detail.cause ?? "";
      // Only account-wide / credential causes are terminal. The set lives in
      // health-classify so the rule has exactly one definition.
      if (!GATING_CAUSES.has(cause as never)) continue;
      const until = detail.cooldownUntil ?? null;
      if (!until || Date.parse(until) <= now) continue;
      blocked.set(providerId, {
        code: row.errorCode ?? "no_available_key",
        message: detail.cause === "quota_exceeded"
          ? "Source parked: account quota exhausted"
          : "Source parked: credential rejected",
        until,
      });
    }
    return blocked;
  }

  /**
   * Runs probes on a timer.
   *
   * The interval, the enable switch and the per-run cap all come from settings;
   * nothing here decides to spend money on its own. Returns a stop function.
   */
  startScheduler(intervalMs = 60_000): () => void {
    if (this.timer) return () => this.stopScheduler();
    this.stopped = false;
    this.timer = setInterval(() => {
      // Two guards, both needed:
      //  - `stopped` so a tick already queued when the process shuts down does
      //    not fire a probe during teardown;
      //  - `ticking` so a slow pass (vendor timeout plus backoff) cannot stack
      //    a second pass on top of itself and double-probe the same provider.
      if (this.stopped || this.ticking) return;
      this.ticking = true;
      void this.runScheduled()
        .catch((error: unknown) => {
          // A scheduled pass failing must never take the API down with it.
          this.ctx.appLogger.warn({ err: error }, "scheduled health pass failed");
        })
        .finally(() => {
          this.ticking = false;
        });
    }, intervalMs);
    // Do not hold the process open just for health probing: a background timer
    // is not a reason to keep the event loop alive, and on Windows a straggling
    // timer is how a service refuses to exit.
    this.timer.unref?.();
    return () => this.stopScheduler();
  }

  stopScheduler(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** True while a scheduled pass is running; used by the tests and the status API. */
  isPassRunning(): boolean {
    return this.ticking;
  }

  /**
   * Runs one scheduled pass now, ignoring the interval.
   *
   * Exists for the tests (and for an operator-triggered "check all"): the
   * interval gate is a production policy, not a correctness rule, and a test
   * that has to wait five minutes to see a schedule is not a test.
   */
  async runScheduledNow(): Promise<{ results: HealthCheckResult[]; skipped: unknown[] } | null> {
    this.lastScheduledRun = null;
    return this.runScheduled();
  }

  /** Aggregated view for the dashboard, REST and MCP. */
  overview(): HealthOverview {
    const rows = this.db.select().from(providerInstances).all();
    const since24h = new Date(this.clock() - 86_400_000).toISOString();
    const checks = this.db
      .select()
      .from(providerHealthChecks)
      .where(gte(providerHealthChecks.checkedAt, since24h))
      .orderBy(desc(providerHealthChecks.checkedAt))
      .all();
    const events = this.db
      .select()
      .from(searchEvents)
      .where(gte(searchEvents.createdAt, since24h))
      .all();
    const keys = this.db.select().from(apiKeys).all();
    const availability = this.ctx.providers.keyAvailability(rows.map((row) => row.id));
    const states = this.db.select().from(providerProbeState).all();
    const stateById = new Map(states.map((item) => [item.providerId, item]));

    const providers = rows.map((row) =>
      this.summarize(row, checks, events, keys, availability.get(row.id), stateById.get(row.id)),
    );
    const totals: Record<HealthStatus, number> = {
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      unverified: 0,
    };
    for (const item of providers) totals[item.status] += 1;

    const runtimeTotals: Record<RuntimeHealth, number> = {
      unknown: 0,
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      rate_limited: 0,
      quota_exceeded: 0,
      invalid_credentials: 0,
      permission_denied: 0,
      cooldown: 0,
      unverified: 0,
      disabled: 0,
    };
    for (const item of providers) runtimeTotals[item.runtime] += 1;

    return {
      generatedAt: new Date(this.clock()).toISOString(),
      providers,
      budget: this.budget(),
      totals,
      runtimeTotals,
    };
  }

  history(providerId: string, limit = 100): HealthCheckResult[] {
    const rows = this.db
      .select()
      .from(providerHealthChecks)
      .where(eq(providerHealthChecks.providerId, providerId))
      .orderBy(desc(providerHealthChecks.checkedAt))
      .limit(Math.min(Math.max(limit, 1), 500))
      .all();
    return rows.map((row) => {
      const detail = safeJson(row.detailJson);
      return {
        id: row.id,
        providerId: row.providerId,
        providerName: "",
        providerType: "",
        keyId: row.keyId,
        kind: row.kind as HealthProbeKind,
        status: row.status as HealthStatus,
        cause: (detail as { cause?: HealthCause }).cause ?? "ok",
        errorCode: (row.errorCode ?? null) as ProviderErrorCode | null,
        latencyMs: row.latencyMs,
        resultCount: row.resultCount,
        healthScore: row.healthScore,
        message: row.diagnosticsSanitized
          ? this.redactStoredMessage(
              row.providerId,
              row.keyId,
              String((detail as { message?: string }).message ?? ""),
            )
          : (detail as { message?: string }).message
            ? "[redacted: legacy diagnostic]"
            : "",
        checkedAt: row.checkedAt,
        trigger: row.trigger as HealthTrigger,
        cooldownUntil: ((detail as { cooldownUntil?: string }).cooldownUntil ?? null),
        // Rows written before migration 0008 have no count: `null` ("not measured"),
        // never `0`.
        requests: toRequestCount((detail as { requests?: unknown }).requests),
        billingUnit: "unknown",
        // The captured sample, capped at three. It is displayed as plain text and
        // is the only place a result title reaches the UI, so the cap is applied
        // here rather than trusting the reader.
        sample: row.diagnosticsSanitized
          ? toSamples((detail as { sample?: unknown }).sample).map((sample) => ({
              title: this.redactStoredMessage(row.providerId, row.keyId, sample.title),
              url: this.redactStoredMessage(row.providerId, row.keyId, sample.url),
            }))
          : [],
      };
    });
  }

  /** Protects clients from diagnostics persisted by releases before v0.1.12. */
  private redactStoredMessage(providerId: string, keyId: string | null, message: string): string {
    let output = redactSecrets(message);
    if (keyId) output = this.ctx.providers.redactKeyMessage?.(keyId, output) ?? output;
    return this.ctx.providers.redactProviderMessage?.(providerId, output) ?? output;
  }

  private summarize(
    row: typeof providerInstances.$inferSelect,
    checks: Array<typeof providerHealthChecks.$inferSelect>,
    events: Array<typeof searchEvents.$inferSelect>,
    keys: Array<typeof apiKeys.$inferSelect>,
    keyFacts: KeyAvailability | undefined,
    state: typeof providerProbeState.$inferSelect | undefined,
  ): ProviderHealthSummary {
    const mine = checks
      .filter((item) => item.providerId === row.id)
      .filter((item) => !state?.resetAt || item.checkedAt > state.resetAt);
    const lastCheck = mine[0] ?? null;
    const lastSuccess = mine.find((item) => item.status === "healthy") ?? null;

    // Live traffic only: probe rows must not inflate the success rate.
    // A cancelled call is not evidence about the source — the caller stopped it.
    // Counting it made one cancel look like a failed call (successRate 0,
    // consecutiveFailures 1) on a provider that had never actually failed.
    const traffic = events.filter(
      (item) => item.providerId === row.id && item.errorCode !== "cancelled",
    );
    const okCount = traffic.filter((item) => item.ok).length;
    const latencies = traffic.filter((item) => item.ok).map((item) => item.latencyMs);

    let consecutiveFailures = 0;
    for (const item of traffic.slice().reverse()) {
      if (item.ok) break;
      consecutiveFailures += 1;
    }

    const providerKeys = keys.filter((item) => item.providerId === row.id);
    // The overview must use the same strict facts as acquisition and bulk
    // eligibility. A row-level filter cannot see decryption failures or shared
    // account quota, and would report a changed master key as a healthy pool.
    const available = keyFacts?.available ?? 0;

    // Status comes from the newest probe; with no probe at all the source is
    // unverified, even if it is enabled and has keys.
    const status: HealthStatus = lastCheck ? (lastCheck.status as HealthStatus) : "unverified";
    const cause = lastCheck
      ? ((safeJson(lastCheck.detailJson) as { cause?: HealthCause }).cause ?? "ok")
      : null;
    const requiresKey = this.ctx.providers.providerRequiresKey(row.type, safeJson(row.configJson));
    const cooldownUntil = lastCheck
      ? (safeJson(lastCheck.detailJson) as { cooldownUntil?: string | null }).cooldownUntil ?? null
      : null;
    const runtime = runtimeHealthFor({
      enabled: row.enabled,
      lastCheck: lastCheck ? { status, cause: cause ?? "ok", cooldownUntil } : null,
      requiresKey,
      keyTotal: keyFacts?.total ?? providerKeys.length,
      keyAvailable: available,
      keyInvalid: keyFacts?.invalid ?? 0,
      now: this.clock(),
    });
    const entry = getCatalogEntry(row.type);
    const policy = this.ctx.settings.get().health;

    return {
      providerId: row.id,
      providerName: row.name,
      providerType: row.type,
      enabled: row.enabled,
      status,
      runtime,
      implementation: {
        verification: entry?.verification ?? "unverified",
        implementation: entry?.implementation ?? "planned",
        docsUrl: entry?.docsUrl ?? null,
      },
      autoProbeEnabled: state?.autoProbeEnabled ?? true,
      nextProbeAt: state?.nextProbeAt ?? null,
      probeMode: policy.paidProbesEnabled ? "search" : "connect",
      healthScore: lastCheck?.healthScore ?? 0,
      lastCheckedAt: lastCheck?.checkedAt ?? null,
      lastSuccessAt: lastSuccess?.checkedAt ?? null,
      lastErrorCode: lastCheck?.errorCode ?? null,
      lastErrorMessage: lastCheck
        ? lastCheck.diagnosticsSanitized
          ? this.redactStoredMessage(
              row.id,
              lastCheck.keyId,
              String((safeJson(lastCheck.detailJson) as { message?: string }).message ?? ""),
            )
          : (safeJson(lastCheck.detailJson) as { message?: string }).message
            ? "[redacted: legacy diagnostic]"
            : null
        : null,
      consecutiveFailures,
      successRate: traffic.length === 0 ? null : Number((okCount / traffic.length).toFixed(4)),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      searchCalls: traffic.length,
      keyAvailable: available,
      keyTotal: keyFacts?.total ?? providerKeys.length,
      lastProbe: lastCheck
        ? {
            kind: lastCheck.kind as HealthProbeKind,
            status: lastCheck.status as HealthStatus,
            checkedAt: lastCheck.checkedAt,
            errorCode: lastCheck.errorCode,
            resultCount: lastCheck.resultCount,
          }
        : null,
      trend: this.trend(mine),
    };
  }

  private trend(checks: Array<typeof providerHealthChecks.$inferSelect>) {
    const now = Date.now();
    const bucketMs = 86_400_000 / (TREND_BUCKETS / 24);
    const buckets = new Map<string, { healthy: number; degraded: number; unhealthy: number }>();
    for (let i = TREND_BUCKETS - 1; i >= 0; i -= 1) {
      const key = new Date(now - i * bucketMs).toISOString().slice(0, 13);
      buckets.set(key, { healthy: 0, degraded: 0, unhealthy: 0 });
    }
    for (const item of checks) {
      const key = item.checkedAt.slice(0, 13);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      if (item.status === "healthy") bucket.healthy += 1;
      else if (item.status === "degraded") bucket.degraded += 1;
      else if (item.status === "unhealthy") bucket.unhealthy += 1;
    }
    return [...buckets.entries()].map(([bucket, value]) => ({ bucket, ...value }));
  }

  private record(input: {
    providerId: string;
    providerName: string;
    providerType: string;
    keyId: string | null;
    kind: HealthProbeKind;
    status: HealthStatus;
    cause: HealthCause;
    latencyMs: number | null;
    resultCount: number | null;
    message: string;
    trigger: HealthTrigger;
    cooldownMs?: number;
    sample?: Array<{ title: string; url: string }>;
    spent?: boolean;
    /** Physical upstream requests, or `null` when none was sent. */
    requests?: number | null;
    /** Durable billing bucket and reservation day; absent when nothing was reserved. */
    billing?: { kind: LedgerKind; day: string };
    /** Whether this observation used a credential lease. */
    credentialUsed?: boolean;
    /** Bulk run ledger id this probe belongs to. */
    batchId?: string | null;
  }): HealthCheckResult {
    const id = newId("hc");
    const checkedAt = new Date(this.clock()).toISOString();
    const healthScore = scoreFor(input.cause, input.latencyMs);
    const cooldownUntil =
      input.cooldownMs && input.cooldownMs > 0
        ? new Date(this.clock() + input.cooldownMs).toISOString()
        : null;
    const errorCode = errorCodeFor(input.cause);
    const requests = input.requests ?? null;

    this.db
      .insert(providerHealthChecks)
      .values({
        id,
        providerId: input.providerId,
        keyId: input.keyId,
        kind: input.kind,
        status: input.status,
        errorCode,
        latencyMs: input.latencyMs,
        resultCount: input.resultCount,
        healthScore,
        detailJson: JSON.stringify({
          cause: input.cause,
          message: input.message,
          cooldownUntil,
          sample: input.sample ?? [],
          // Stored here rather than in a new column: the request count is a
          // property of this observation, and `detail_json` is already the
          // place per-observation facts live.
          requests,
          billingUnit: "unknown",
        }),
        trigger: input.trigger,
        checkedAt,
        batchId: input.batchId ?? null,
        diagnosticsSanitized: true,
      })
      .run();

    if (input.billing) {
      this.budgetLedger.recordBilling({
        healthCheckId: id,
        kind: input.billing.kind,
        budgetDay: input.billing.day,
        classification: "exact",
        providerType: input.providerType,
        credentialUsed: input.credentialUsed === true,
        spent: requests !== null && requests > 0,
      });
    }

    return {
      id,
      providerId: input.providerId,
      providerName: input.providerName,
      providerType: input.providerType,
      keyId: input.keyId,
      kind: input.kind,
      status: input.status,
      cause: input.cause,
      errorCode,
      latencyMs: input.latencyMs,
      resultCount: input.resultCount,
      healthScore,
      message: input.message,
      checkedAt,
      trigger: input.trigger,
      cooldownUntil,
      requests,
      billingUnit: "unknown",
      ...(input.sample ? { sample: input.sample } : {}),
      ...(input.spent === undefined ? {} : { spent: input.spent }),
    };
  }
}

function nextUtcMidnight(nowMs: number): number {
  const date = new Date(nowMs);
  date.setUTCHours(24, 0, 0, 0);
  return date.getTime();
}

function keyAcquisitionError(result: Extract<AcquireKeyResult, { ok: false }>): SearchHubError {
  if (result.reason === "account_quota") return new SearchHubError("quota_exceeded", result.message);
  if (result.reason === "queue_timeout") return new SearchHubError("queue_timeout", result.message);
  if (result.reason === "no_key") return new SearchHubError("no_available_key", result.message);
  return new SearchHubError("validation_error", result.message, { status: 400 });
}

/** Concurrency for a probe pass: an integer in 1..4, never NaN, never 0. */
function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(Math.round(value), 4));
}

/**
 * An abort reason the classifier reads as a cancellation.
 *
 * `classifyError` checks the error `code` *before* its `/aborted/i` message
 * fallback, so tagging the reason with `code: "cancelled"` is what keeps a
 * cancellation from being recorded as a timeout and parking the source.
 */
function cancelledError(): SearchHubError {
  return new SearchHubError("cancelled", "The health probe was cancelled; nothing was recorded.");
}

/** Abort reason for the probe's own deadline. Classifies as `timeout`. */
function timeoutError(): Error {
  return Object.assign(new Error("timeout"), { code: "timeout" });
}

/**
 * Combines a probe's own timeout signal with a caller's cancellation signal.
 *
 * `AbortSignal.any` exists on Node 22, but is used through a feature check rather
 * than assumed: a combination written by hand has to forward the *reason* to the
 * inner controller's `abort()`, not just the "aborted" bit, or the reason's `code`
 * is lost and a cancellation is reclassified as a timeout.
 *
 * The returned `dispose` removes the listener so a long-lived job signal does not
 * accumulate one listener per probe.
 */
function composeAbort(
  own: AbortSignal,
  outer: AbortSignal | undefined,
): { signal: AbortSignal; cancelled: () => boolean; dispose: () => void } {
  if (!outer) return { signal: own, cancelled: () => false, dispose: () => {} };

  const anySignal = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anySignal === "function") {
    const combined = anySignal.call(AbortSignal, [own, outer]);
    return {
      signal: combined,
      cancelled: () => outer.aborted && !own.aborted,
      dispose: () => {},
    };
  }

  const controller = new AbortController();
  const forward = (source: AbortSignal) => () => {
    if (controller.signal.aborted) return;
    controller.abort(source.reason);
  };
  const onOwn = forward(own);
  const onOuter = forward(outer);
  if (own.aborted) controller.abort(own.reason);
  else if (outer.aborted) controller.abort(outer.reason);
  else {
    own.addEventListener("abort", onOwn, { once: true });
    outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    cancelled: () => outer.aborted && !own.aborted,
    dispose: () => {
      own.removeEventListener("abort", onOwn);
      outer.removeEventListener("abort", onOuter);
    },
  };
}

/**
 * Reads `detail_json.requests` back into `number | null`.
 *
 * Rows written before v0.1.10 have no count at all, so they read as `null`
 * ("not measured") instead of `0` — a zero would be a claim about the wire.
 */
function toRequestCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Reads the stored sample, filtered and capped at three.
 *
 * The UI renders these as plain text, so this is the last place that can hand a
 * malformed row to it: a non-string title, a missing URL or a `javascript:` URL
 * must never reach the browser as if a vendor had supplied something valid.
 */
function toSamples(value: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ title: string; url: string }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const title = (entry as { title?: unknown }).title;
    const url = (entry as { url?: unknown }).url;
    if (typeof title !== "string" || typeof url !== "string") continue;
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 300), url: url.slice(0, 800) });
    if (out.length === 3) break;
  }
  return out;
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Query used by a probe.
 *
 * Kept short and generic: a vendor-side relevance test is not the point here,
 * and a long query would make the latency number meaningless.
 */
function probeQuery(type: string, kind: HealthProbeKind): string {
  if (kind === "connect") return "test";
  if (type === "hackernews") return "test";
  return "search engine";
}
