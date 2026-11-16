/**
 * Provider health: classification, scoring and budget accounting.
 *
 * The design rules this module encodes:
 *
 * 1. **A free probe and a paid search are different facts.** `connect` probes
 *    (DNS/TLS/auth) cost nothing and are allowed by default; `search` probes hit
 *    the vendor's paid endpoint and are opt-in with an explicit budget.
 * 2. **Missing credentials are `unverified`, never `healthy`.** Claiming a source
 *    works because its URL resolves would be a lie the UI then amplifies.
 * 3. **Errors are classified by cause, not by HTTP status alone.** 401 (bad key),
 *    403 (no entitlement), 429 (slow down) and quota exhaustion (stop) need
 *    different reactions: retrying a quota-exhausted key is how you fail twice.
 * 4. **A provider that answers HTTP 200 with zero results is not healthy.** The
 *    vendor may be serving an empty index or a broken upstream.
 */
import type { ProviderErrorCode } from "@search-hub/shared";

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unverified";
export type HealthProbeKind = "connect" | "search";
export type HealthTrigger = "manual" | "schedule" | "recovery" | "search";

/** Causes we can tell apart, and therefore act on differently. */
export type HealthCause =
  | "ok"
  | "config_incomplete"
  | "no_credential"
  | "network"
  | "dns"
  | "tls"
  | "timeout"
  | "auth_invalid"
  | "forbidden"
  | "rate_limited"
  | "quota_exceeded"
  | "server_error"
  | "bad_response"
  | "empty_results"
  | "cancelled";

/** Map a probe cause onto the provider error vocabulary the API already uses. */
const ERROR_CODE_BY_CAUSE: Partial<Record<HealthCause, ProviderErrorCode>> = {
  network: "network",
  dns: "network",
  tls: "network",
  timeout: "timeout",
  auth_invalid: "auth_invalid",
  forbidden: "blocked",
  rate_limited: "rate_limited",
  quota_exceeded: "quota_exceeded",
  server_error: "server_error",
  bad_response: "server_error",
  empty_results: "no_available_key",
  config_incomplete: "bad_request",
  cancelled: "cancelled",
};

export function errorCodeFor(cause: HealthCause): ProviderErrorCode | null {
  return ERROR_CODE_BY_CAUSE[cause] ?? null;
}

/**
 * Cooldown after a failed probe.
 *
 * A quota problem is NOT a short cooldown: retrying in a minute would fail again
 * and cost another request, so it parks the key until an operator or the next
 * day's reset. Getting this wrong is how a "health check" burns money.
 */
const COOLDOWN_MS_BY_CAUSE: Partial<Record<HealthCause, number>> = {
  rate_limited: 60_000,
  quota_exceeded: 6 * 60 * 60 * 1000,
  auth_invalid: 24 * 60 * 60 * 1000,
  forbidden: 30 * 60 * 1000,
  timeout: 30_000,
  network: 20_000,
  dns: 20_000,
  tls: 30 * 60 * 1000,
  server_error: 45_000,
  bad_response: 30 * 60 * 1000,
};

/** Respect the vendor's own backoff when it tells us one. */
export function cooldownFor(cause: HealthCause, retryAfterMs?: number | null): number | null {
  if (cause === "ok") return null;
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 6 * 60 * 60 * 1000);
  }
  return COOLDOWN_MS_BY_CAUSE[cause] ?? null;
}

/** True when retrying with a *different* key of the same account would help. */
export function isAccountWide(cause: HealthCause): boolean {
  // Quota is per account, not per key: rotating keys multiplies the failure.
  return cause === "quota_exceeded" || cause === "forbidden";
}

const STATUS_BY_CAUSE: Record<HealthCause, HealthStatus> = {
  ok: "healthy",
  config_incomplete: "unverified",
  no_credential: "unverified",
  network: "unhealthy",
  dns: "unhealthy",
  tls: "unhealthy",
  timeout: "degraded",
  auth_invalid: "unhealthy",
  forbidden: "degraded",
  rate_limited: "degraded",
  quota_exceeded: "unhealthy",
  server_error: "degraded",
  bad_response: "degraded",
  empty_results: "degraded",
  cancelled: "degraded",
};

export function statusFor(cause: HealthCause): HealthStatus {
  return STATUS_BY_CAUSE[cause];
}

const PENALTY_BY_CAUSE: Record<HealthCause, number> = {
  ok: 0,
  config_incomplete: 100,
  no_credential: 100,
  network: 60,
  dns: 60,
  tls: 50,
  timeout: 30,
  auth_invalid: 100,
  forbidden: 60,
  rate_limited: 25,
  quota_exceeded: 100,
  server_error: 35,
  bad_response: 45,
  empty_results: 30,
  cancelled: 0,
};

/**
 * Health score 0-100.
 *
 * Latency is a mild penalty on purpose: a source that answers in 3s with correct
 * results is still usable, while a 401 is not usable at all.
 */
export function scoreFor(cause: HealthCause, latencyMs: number | null): number {
  if (cause === "ok") {
    if (latencyMs === null) return 85;
    if (latencyMs <= 500) return 100;
    if (latencyMs <= 1500) return 95;
    if (latencyMs <= 3000) return 85;
    if (latencyMs <= 8000) return 70;
    return 55;
  }
  return Math.max(0, 100 - PENALTY_BY_CAUSE[cause]);
}

/** PERCENTILE over a sorted numeric array, linear interpolation. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const weight = rank - low;
  return Number((sorted[low]! * (1 - weight) + sorted[high]! * weight).toFixed(1));
}

/**
 * Classifies a thrown error into a cause.
 *
 * Order matters: a vendor body that says "insufficient balance" must be read as
 * quota *before* the generic 429 branch, because both can arrive as HTTP 429.
 */
export function classifyError(error: unknown): HealthCause {
  const code = (error as { code?: unknown } | null)?.code;
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "");
  const lower = message.toLowerCase();

  if (
    /insufficient|quota|余额|balance|credit|billing|exhausted|purchase/.test(lower) &&
    !/rate limit/.test(lower)
  ) {
    return "quota_exceeded";
  }
  if (typeof code === "string") {
    switch (code) {
      case "auth_invalid":
        return "auth_invalid";
      case "blocked":
        return "forbidden";
      case "rate_limited":
        return "rate_limited";
      case "quota_exceeded":
        return "quota_exceeded";
      case "timeout":
        return "timeout";
      case "network":
        return /getaddrinfo|enotfound|dns/i.test(message) ? "dns" : "network";
      case "cancelled":
        return "cancelled";
      case "server_error":
        return "server_error";
      case "bad_request":
        return "bad_response";
      default:
        break;
    }
  }
  if (/certificate|self signed|tls|ssl/i.test(message)) return "tls";
  if (/getaddrinfo|enotfound|eai_again/i.test(message)) return "dns";
  if (/etimedout|timeout|aborted/i.test(message)) return "timeout";
  if (/econnrefused|econnreset|socket hang up|network/i.test(message)) return "network";
  if (/\b401\b|unauthorized/i.test(message)) return "auth_invalid";
  if (/\b403\b|forbidden/i.test(message)) return "forbidden";
  if (/\b429\b|too many requests/i.test(message)) return "rate_limited";
  if (/\b5\d\d\b/.test(message)) return "server_error";
  return "server_error";
}

/** Reads `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Daily probe budget.
 *
 * Both limits are enforced *before* the request, so a misconfigured schedule
 * cannot spend money: `remaining` reaching zero makes the next probe `skipped`
 * rather than a failed call that still costs.
 */
export interface ProbeBudget {
  maxPerRun: number;
  maxPerDay: number;
  usedToday: number;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: "run_limit" | "day_limit";
  remainingToday: number;
}

export function decideBudget(budget: ProbeBudget, requested: number): BudgetDecision {
  const remainingToday = Math.max(0, budget.maxPerDay - budget.usedToday);
  if (requested > budget.maxPerRun) return { allowed: false, reason: "run_limit", remainingToday };
  if (remainingToday <= 0) return { allowed: false, reason: "day_limit", remainingToday };
  if (requested > remainingToday) return { allowed: false, reason: "day_limit", remainingToday };
  return { allowed: true, remainingToday };
}
