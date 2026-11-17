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
import { SearchHubError } from "@search-hub/shared";
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
import { ProbeBudget } from "./health-budget.js";

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
    resolveKey(keyId: string): string | undefined;
    reload(): void;
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
    /** Paid searches reserved today. */
    usedToday: number;
    /** Free connectivity probes reserved today. */
    connectUsedToday: number;
    remainingToday: number;
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
    });
    return {
      day: snapshot.day,
      maxPerRun: snapshot.maxPerRun,
      maxPerDay: snapshot.maxPerDay,
      usedToday: snapshot.searchUsedToday,
      connectUsedToday: snapshot.connectUsedToday,
      anonymousSearchUsedToday: snapshot.anonymousSearchUsedToday,
      remainingToday: snapshot.remainingToday,
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
   */
  async checkOne(
    providerId: string,
    options: { kind?: HealthProbeKind; keyId?: string; trigger?: HealthTrigger } = {},
  ): Promise<HealthCheckResult> {
    const row = this.db.select().from(providerInstances).where(eq(providerInstances.id, providerId)).get();
    if (!row) throw new SearchHubError("not_found", "Provider not found");
    const adapter = getAdapter(row.type);
    if (!adapter) throw new SearchHubError("unsupported", `Provider type "${row.type}" is not implemented`);

    const kind = options.kind ?? "connect";
    const trigger = options.trigger ?? "manual";
    const policy = this.ctx.settings.get().health;
    const catalogEntry = getCatalogEntry(row.type);

    // Resolve the credential, but do not treat its absence as "unhealthy":
    // without a key we simply cannot tell, and saying so is the honest answer.
    // Resolved *before* reserving budget so an impossible probe never spends.
    const keys = this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.providerId, providerId), eq(apiKeys.enabled, true)))
      .all();
    const targetKeyId = options.keyId ?? keys[0]?.id ?? null;
    let apiKey: string | undefined;
    if (targetKeyId) {
      const resolved = this.ctx.providers.resolveKey(targetKeyId);
      apiKey = resolved ?? undefined;
    }

    if (adapter.requiresKey && !apiKey) {
      return this.record({
        providerId,
        providerName: row.name,
        providerType: row.type,
        keyId: targetKeyId,
        kind,
        status: "unverified",
        cause: targetKeyId ? "config_incomplete" : "no_credential",
        latencyMs: null,
        resultCount: null,
        message: targetKeyId
          ? "The stored key could not be decrypted (master key changed?)"
          : "No enabled API key. This provider is unverified, not healthy.",
        trigger,
        // Nothing was requested, so nothing was spent: the caller refunds its
        // per-run allowance from this.
        spent: false,
      });
    }

    // Reserve *before* the request. The reservation is a durable ledger write:
    // if it cannot be recorded we refuse rather than spend money the budget has
    // no record of. Connectivity probes are counted too (separately) but are
    // not capped — capping them would leave the page unable to explain itself.
    //
    // A real search against a *keyless* source sends no credential, so it cannot
    // consume the operator's account quota and must not require the paid switch:
    // blocking it would make every public source permanently unverifiable. It is
    // still counted in its own bucket — this code cannot know whether the vendor
    // meters by IP, so it is counted, not assumed free.
    const ledgerKind = kind === "search" && !adapter.requiresKey ? "search_anonymous" : kind;
    const reservation = this.budgetLedger.reserve({
      kind: ledgerKind,
      paidProbesEnabled: policy.paidProbesEnabled,
      maxPerRun: policy.maxRequestsPerRun,
      maxPerDay: policy.maxRequestsPerDay,
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
      // A connectivity probe is free; a broken ledger should not make the
      // page unusable, but the miss is logged so it is not silent.
      this.ctx.appLogger.warn(
        { providerId, reason: reservation.reason },
        "connect probe ran without a budget reservation",
      );
    }

    const started = this.clock();
    const controller = new AbortController();
    const timeoutMs = Math.min(row.timeoutMs, kind === "connect" ? 12_000 : 20_000);
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

    try {
      const result = await adapter.search(
        { query: probeQuery(row.type, kind), limit: kind === "connect" ? 1 : 3, signal: controller.signal },
        {
          fetch: this.ctx.fetch,
          ...(apiKey === undefined ? {} : { apiKey }),
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
          signal: controller.signal,
          logger: this.ctx.appLogger,
        },
      );
      const latencyMs = this.clock() - started;
      const count = result.results.length;

      // HTTP 200 with no rows is a degraded answer, not a healthy one: the
      // vendor answered, but the source is not usable for searching right now.
      const cause: HealthCause = count > 0 ? "ok" : "empty_results";
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
        sample: result.results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
        spent: kind === "search" && ledgerKind === "search" && reservation.ok,
      });
      this.advanceSchedule(providerId, cause);
      return recorded;
    } catch (error) {
      const latencyMs = this.clock() - started;
      const cause = classifyError(error);
      // A cancelled probe is not evidence about the source: it says the caller
      // (or shutdown) stopped it. Recording it would degrade a provider for a
      // reason it had no part in, so it is dropped and its budget returned.
      if (cause === "cancelled") {
        if (reservation.ok) this.budgetLedger.release(ledgerKind);
        throw new SearchHubError("cancelled", "The health probe was cancelled; nothing was recorded.");
      }
      const retryAfterMs = parseRetryAfterMs(
        (error as { retryAfterMs?: number } | null)?.retryAfterMs != null
          ? String((error as { retryAfterMs?: number }).retryAfterMs! / 1000)
          : null,
      );
      const cooldown = cooldownFor(cause, retryAfterMs);
      // Account-wide problems must not be "fixed" by rotating keys; the record
      // step parks the key and the scheduler stops offering it.
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
        message: error instanceof Error ? error.message : String(error),
        trigger,
        cooldownMs: cooldown ?? undefined,
        spent: kind === "search" && ledgerKind === "search" && reservation.ok,
      });
      this.advanceSchedule(providerId, cause);
      return recorded;
    } finally {
      clearTimeout(timer);
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
   * Probes several providers in order with a small gap.
   *
   * Serial on purpose: firing probes at every vendor at once is the fastest way
   * to trip rate limits on all of them and learn nothing.
   */
  async checkMany(
    providerIds: string[] | null,
    options: { kind?: HealthProbeKind; trigger?: HealthTrigger; gapMs?: number; respectInFlight?: boolean } = {},
  ): Promise<{
    results: HealthCheckResult[];
    skipped: Array<{ providerId: string; reason: string }>;
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
    const skipped: Array<{ providerId: string; reason: string }> = [];
    const gap = options.gapMs ?? 400;
    // Concurrency is capped at 4 by the settings schema; a serial default keeps
    // a scheduled pass from looking like a burst to every vendor at once.
    const workers = Math.max(1, Math.min(this.ctx.settings.get().health.concurrency ?? 1, 4));

    // The per-run cap applies to this loop, not to the daily counter: otherwise
    // a single "check all" would ignore maxRequestsPerRun entirely.
    let spentThisRun = 0;
    const queue = [...ids];
    const worker = async (): Promise<void> => {
      for (;;) {
        const id = queue.shift();
        if (id === undefined) return;
        await probe(id);
        if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      }
    };
    const probe = async (id: string): Promise<void> => {
      // One probe per provider at a time. Two passes (a scheduled tick and a
      // manual "check all") would otherwise hit the same vendor twice, and for
      // a paid probe that is paying twice for one answer.
      if (options.respectInFlight === true && this.inFlight.has(id)) {
        skipped.push({ providerId: id, reason: "already_running" });
        return;
      }
      if (kind === "search") {
        const remainingRun = this.budget().maxPerRun - spentThisRun;
        if (remainingRun <= 0) {
          skipped.push({ providerId: id, reason: "budget_exhausted:run_limit" });
          return;
        }
        const decision = decideBudget({ ...this.budget(), maxPerRun: remainingRun }, 1);
        if (!decision.allowed) {
          skipped.push({ providerId: id, reason: `budget_exhausted:${decision.reason}` });
          return;
        }
        spentThisRun += 1;
      }
      this.inFlight.add(id);
      try {
        const recorded = await this.checkOne(id, { kind, trigger });
        // A probe that never left the machine (no credential, refused before
        // the request) must not consume the per-run allowance: otherwise
        // "check all" stops early while nothing was spent.
        if (kind === "search" && recorded.spent === false) spentThisRun -= 1;
        results.push(recorded);
      } catch (error) {
        skipped.push({
          providerId: id,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.inFlight.delete(id);
      }
    };

    await Promise.all(Array.from({ length: Math.min(workers, ids.length || 1) }, () => worker()));
    return { results, skipped, budget: this.budget() };
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
    const states = this.db.select().from(providerProbeState).all();
    const stateById = new Map(states.map((item) => [item.providerId, item]));

    const providers = rows.map((row) => this.summarize(row, checks, events, keys, stateById.get(row.id)));
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
    return rows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      providerName: "",
      providerType: "",
      keyId: row.keyId,
      kind: row.kind as HealthProbeKind,
      status: row.status as HealthStatus,
      cause: (safeJson(row.detailJson) as { cause?: HealthCause }).cause ?? "ok",
      errorCode: (row.errorCode ?? null) as ProviderErrorCode | null,
      latencyMs: row.latencyMs,
      resultCount: row.resultCount,
      healthScore: row.healthScore,
      message: String((safeJson(row.detailJson) as { message?: string }).message ?? ""),
      checkedAt: row.checkedAt,
      trigger: row.trigger as HealthTrigger,
      cooldownUntil: ((safeJson(row.detailJson) as { cooldownUntil?: string }).cooldownUntil ?? null),
    }));
  }

  private summarize(
    row: typeof providerInstances.$inferSelect,
    checks: Array<typeof providerHealthChecks.$inferSelect>,
    events: Array<typeof searchEvents.$inferSelect>,
    keys: Array<typeof apiKeys.$inferSelect>,
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
    const available = providerKeys.filter(
      (item) =>
        item.enabled &&
        item.status !== "invalid" &&
        (!item.cooldownUntil || Date.parse(item.cooldownUntil) <= Date.now()),
    ).length;

    // Status comes from the newest probe; with no probe at all the source is
    // unverified, even if it is enabled and has keys.
    const status: HealthStatus = lastCheck ? (lastCheck.status as HealthStatus) : "unverified";
    const cause = lastCheck
      ? ((safeJson(lastCheck.detailJson) as { cause?: HealthCause }).cause ?? "ok")
      : null;
    const adapter = getAdapter(row.type);
    const requiresKey = adapter?.requiresKey ?? true;
    const cooldownUntil = lastCheck
      ? (safeJson(lastCheck.detailJson) as { cooldownUntil?: string | null }).cooldownUntil ?? null
      : null;
    const runtime = runtimeHealthFor({
      enabled: row.enabled,
      lastCheck: lastCheck ? { status, cause: cause ?? "ok", cooldownUntil } : null,
      requiresKey,
      keyTotal: providerKeys.length,
      keyAvailable: available,
      keyInvalid: providerKeys.filter((item) => item.status === "invalid").length,
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
        ? String((safeJson(lastCheck.detailJson) as { message?: string }).message ?? "")
        : null,
      consecutiveFailures,
      successRate: traffic.length === 0 ? null : Number((okCount / traffic.length).toFixed(4)),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      searchCalls: traffic.length,
      keyAvailable: available,
      keyTotal: providerKeys.length,
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
  }): HealthCheckResult {
    const id = newId("hc");
    const checkedAt = new Date(this.clock()).toISOString();
    const healthScore = scoreFor(input.cause, input.latencyMs);
    const cooldownUntil =
      input.cooldownMs && input.cooldownMs > 0
        ? new Date(this.clock() + input.cooldownMs).toISOString()
        : null;
    const errorCode = errorCodeFor(input.cause);

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
        }),
        trigger: input.trigger,
        checkedAt,
      })
      .run();

    // A failing credential changes how the scheduler treats that key; anything
    // else is provider-level and leaves the key pool alone.
    if (input.keyId && input.cause !== "ok") {
      this.applyKeyOutcome(input.keyId, input.cause, cooldownUntil);
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
      ...(input.sample ? { sample: input.sample } : {}),
      ...(input.spent === undefined ? {} : { spent: input.spent }),
    };
  }

  private applyKeyOutcome(keyId: string, cause: HealthCause, cooldownUntil: string | null): void {
    const patch: Record<string, unknown> = { lastErrorCode: errorCodeFor(cause) };
    if (cause === "auth_invalid") {
      patch["status"] = "invalid";
    } else if (cause === "quota_exceeded") {
      patch["status"] = "quota_exhausted";
      // Always park until at least the next UTC midnight: a quota-exhausted key
      // without a cooldown would be retried on the next search and fail again.
      patch["cooldownUntil"] =
        cooldownUntil ?? new Date(nextUtcMidnight(this.clock())).toISOString();
    } else if (cooldownUntil) {
      patch["cooldownUntil"] = cooldownUntil;
    }
    try {
      this.db.update(apiKeys).set(patch).where(eq(apiKeys.id, keyId)).run();
      this.ctx.providers.reload();
    } catch {
      // A health probe must never fail the request that triggered it because a
      // best-effort key annotation did not apply.
    }
  }
}

function nextUtcMidnight(nowMs: number): number {
  const date = new Date(nowMs);
  date.setUTCHours(24, 0, 0, 0);
  return date.getTime();
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
