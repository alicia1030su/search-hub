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
import { and, desc, gte, eq } from "drizzle-orm";
import type { ProviderErrorCode } from "@search-hub/shared";
import { SearchHubError } from "@search-hub/shared";
import {
  apiKeys,
  providerHealthChecks,
  providerInstances,
  searchEvents,
  type SearchHubDb,
} from "@search-hub/db";
import { getAdapter } from "@search-hub/providers";
import { newId } from "../security/crypto.js";
import type { Logger, SafeFetch } from "@search-hub/shared";
import {
  classifyError,
  cooldownFor,
  decideBudget,
  errorCodeFor,
  parseRetryAfterMs,
  percentile,
  scoreFor,
  statusFor,
  type HealthCause,
  type HealthProbeKind,
  type HealthStatus,
  type HealthTrigger,
} from "./health-classify.js";

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
}

export interface ProviderHealthSummary {
  providerId: string;
  providerName: string;
  providerType: string;
  enabled: boolean;
  status: HealthStatus;
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
    maxPerRun: number;
    maxPerDay: number;
    usedToday: number;
    remainingToday: number;
    paidProbesEnabled: boolean;
    scheduledEnabled: boolean;
  };
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

  constructor(private readonly ctx: HealthDependencies) {}

  private get db(): SearchHubDb {
    return this.ctx.db;
  }

  /** Number of *paid* probes started today, read from the probe log itself. */
  usedToday(): number {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const rows = this.db
      .select({ id: providerHealthChecks.id })
      .from(providerHealthChecks)
      .where(
        and(
          eq(providerHealthChecks.kind, "search"),
          gte(providerHealthChecks.checkedAt, since.toISOString()),
        ),
      )
      .all();
    return rows.length;
  }

  budget() {
    const policy = this.ctx.settings.get().health;
    const used = this.usedToday();
    return {
      maxPerRun: policy.maxRequestsPerRun,
      maxPerDay: policy.maxRequestsPerDay,
      usedToday: used,
      remainingToday: Math.max(0, policy.maxRequestsPerDay - used),
      paidProbesEnabled: policy.paidProbesEnabled,
      scheduledEnabled: policy.scheduledEnabled,
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

    if (kind === "search") {
      const policy = this.ctx.settings.get().health;
      if (!policy.paidProbesEnabled) {
        throw new SearchHubError(
          "validation_error",
          "Paid search probes are disabled. Enable them in Settings → Provider health, or run a connectivity probe instead.",
        );
      }
      const decision = decideBudget(this.budget(), 1);
      if (!decision.allowed) {
        throw new SearchHubError(
          "quota_exceeded",
          `Health probe budget exhausted (${decision.reason}). Probes used today: ${this.budget().usedToday}/${policy.maxRequestsPerDay}.`,
        );
      }
    }

    // Resolve the credential, but do not treat its absence as "unhealthy":
    // without a key we simply cannot tell, and saying so is the honest answer.
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
      });
    }

    const started = Date.now();
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
            search: safeJson(row.searchConfigJson) as never,
          },
          signal: controller.signal,
          logger: this.ctx.appLogger,
        },
      );
      const latencyMs = Date.now() - started;
      const count = result.results.length;

      // HTTP 200 with no rows is a degraded answer, not a healthy one: the
      // vendor answered, but the source is not usable for searching right now.
      const cause: HealthCause = count > 0 ? "ok" : "empty_results";
      return this.record({
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
      });
    } catch (error) {
      const latencyMs = Date.now() - started;
      const cause = classifyError(error);
      const retryAfterMs = parseRetryAfterMs(
        (error as { retryAfterMs?: number } | null)?.retryAfterMs != null
          ? String((error as { retryAfterMs?: number }).retryAfterMs! / 1000)
          : null,
      );
      const cooldown = cooldownFor(cause, retryAfterMs);
      // Account-wide problems must not be "fixed" by rotating keys; the record
      // step parks the key and the scheduler stops offering it.
      return this.record({
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
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probes several providers in order with a small gap.
   *
   * Serial on purpose: firing probes at every vendor at once is the fastest way
   * to trip rate limits on all of them and learn nothing.
   */
  async checkMany(
    providerIds: string[] | null,
    options: { kind?: HealthProbeKind; trigger?: HealthTrigger; gapMs?: number } = {},
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
      try {
        results.push(await this.checkOne(id, { kind, trigger }));
      } catch (error) {
        skipped.push({
          providerId: id,
          reason: error instanceof Error ? error.message : String(error),
        });
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
    const last = this.lastScheduledRun ? Date.parse(this.lastScheduledRun) : 0;
    if (Date.now() - last < policy.intervalMinutes * 60_000) return null;
    this.lastScheduledRun = new Date().toISOString();

    // Scheduled runs are connectivity-only unless the operator opted into paid
    // probes: a timer must never be the reason money is spent.
    const kind: HealthProbeKind = policy.paidProbesEnabled ? "search" : "connect";
    const run = await this.checkMany(null, { kind, trigger: "schedule" });
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

    for (const [providerId, row] of latest) {
      if (row.status !== "unhealthy" && row.status !== "degraded") continue;
      const detail = safeJson(row.detailJson) as { cause?: string; cooldownUntil?: string };
      const cause = detail.cause ?? "";
      // Only account-wide / credential causes are terminal.
      if (cause !== "quota_exceeded" && cause !== "auth_invalid") continue;
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
    const timer = setInterval(() => {
      void this.runScheduled().catch(() => undefined);
    }, intervalMs);
    // Do not hold the process open just for health probing.
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Aggregated view for the dashboard, REST and MCP. */
  overview(): HealthOverview {
    const rows = this.db.select().from(providerInstances).all();
    const since24h = new Date(Date.now() - 86_400_000).toISOString();
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

    const providers = rows.map((row) => this.summarize(row, checks, events, keys));
    const totals: Record<HealthStatus, number> = {
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      unverified: 0,
    };
    for (const item of providers) totals[item.status] += 1;

    return {
      generatedAt: new Date().toISOString(),
      providers,
      budget: this.budget(),
      totals,
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
  ): ProviderHealthSummary {
    const mine = checks.filter((item) => item.providerId === row.id);
    const lastCheck = mine[0] ?? null;
    const lastSuccess = mine.find((item) => item.status === "healthy") ?? null;

    // Live traffic only: probe rows must not inflate the success rate.
    const traffic = events.filter((item) => item.providerId === row.id);
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

    return {
      providerId: row.id,
      providerName: row.name,
      providerType: row.type,
      enabled: row.enabled,
      status,
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
  }): HealthCheckResult {
    const id = newId("hc");
    const checkedAt = new Date().toISOString();
    const healthScore = scoreFor(input.cause, input.latencyMs);
    const cooldownUntil =
      input.cooldownMs && input.cooldownMs > 0
        ? new Date(Date.now() + input.cooldownMs).toISOString()
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
        cooldownUntil ?? new Date(nextUtcMidnight(Date.now())).toISOString();
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
