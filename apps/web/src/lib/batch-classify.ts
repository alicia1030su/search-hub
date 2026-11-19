import type { MessageKey } from "./i18n-zh";
import type { BatchItem, BatchJobView } from "./types";

/**
 * Classification, ordering and message-key mapping for the bulk-test table.
 *
 * Pure and DOM-free on purpose: the grouping, the sort and the "retry failures"
 * set are exactly the places where a plausible-looking implementation misleads
 * the operator, so they must be testable without a browser. Locale lookup lives
 * in `batch-labels.ts`; this module only decides *which message* is meant, never
 * how it reads.
 *
 * The important decision here is `restricted`. Throttling, permissions and an
 * exhausted quota are all "did not work", but none of them is fixed by pressing
 * "retry" — a rate-limited source re-hits the same 429 and spends another
 * request. Keeping them in a separate group is what makes "retry the failures"
 * mean something.
 */

/** Codes that mean "the vendor refused or throttled us", not "something broke". */
const RESTRICTED_CODES = new Set(["forbidden", "rate_limited", "quota_exceeded"]);

export type BatchGroup = "failed" | "restricted" | "pending" | "ok" | "skipped" | "unknown";
export type BatchFilter = "all" | BatchGroup;

/** Severity order of the table. Lower sorts first. */
const GROUP_ORDER: Record<BatchGroup, number> = {
  failed: 0,
  restricted: 1,
  pending: 2,
  ok: 3,
  skipped: 4,
  unknown: 5,
};

/**
 * The group a row belongs to.
 *
 * `failed` + a restricted code becomes `restricted`; every other failed state
 * stays `failed`. `pending` (`empty_results`) is its own group because it is
 * neither a success nor a failure.
 */
export function groupOf(item: BatchItem): BatchGroup {
  switch (item.state) {
    case "failed":
      return RESTRICTED_CODES.has(item.code) ? "restricted" : "failed";
    case "pending":
      return "pending";
    case "ok":
      return "ok";
    case "skipped":
      return "skipped";
    case "unknown":
      return "unknown";
  }
}

/** Sources the "retry failures" button submits: failures only, not restrictions. */
export function failedIds(job: BatchJobView): string[] {
  return job.items.filter((item) => groupOf(item) === "failed").map((item) => item.providerId);
}

/** Sources the "retry pending" button submits (`empty_results` only). */
export function pendingIds(job: BatchJobView): string[] {
  return job.items.filter((item) => groupOf(item) === "pending").map((item) => item.providerId);
}

/**
 * Sorts by severity, then slowest first inside a group.
 *
 * The severity order is fixed rather than derived from the active filter: the
 * table must not reorder itself when the operator narrows the view, because a
 * row's position is part of what makes the list scannable.
 *
 * A `null` latency means the probe never measured one; it sorts last in its
 * group rather than as `0` (which would put an unmeasured source first among the
 * "fastest") or as infinity (which would put it first among the "slowest").
 */
export function sortItems(items: BatchItem[]): BatchItem[] {
  return [...items].sort((left, right) => {
    const byGroup = GROUP_ORDER[groupOf(left)] - GROUP_ORDER[groupOf(right)];
    if (byGroup !== 0) return byGroup;
    if (left.latencyMs === null && right.latencyMs === null) {
      return left.providerName.localeCompare(right.providerName);
    }
    if (left.latencyMs === null) return 1;
    if (right.latencyMs === null) return -1;
    if (left.latencyMs !== right.latencyMs) return right.latencyMs - left.latencyMs;
    return left.providerName.localeCompare(right.providerName);
  });
}

/**
 * `—` when the probe never issued a request.
 *
 * Never an estimate: a paginated probe's request count is measured at the fetch
 * boundary, and a source that was never contacted has no count at all.
 */
export function requestsLabel(requests: number | null): string {
  return requests === null ? "—" : String(requests);
}

/**
 * Renders `key_ab…9f` from a key **identifier**.
 *
 * There is no code path in this app that can produce the key material for
 * display, and this function is the reason: it truncates an id.
 */
export function redactKeyId(keyId: string | null): string {
  if (!keyId) return "—";
  const trimmed = keyId.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-2)}`;
}

/** Message key for a row's state, given its group (restricted overrides the state). */
export function stateKey(item: BatchItem, group: BatchGroup): MessageKey {
  return (group === "restricted" ? "providers.batch.state.restricted" : `providers.batch.state.${item.state}`) as MessageKey;
}

/** Message key for a classification, with the `.advice` suffix when asked. */
export function codeKey(code: string, variant: "label" | "advice" = "label"): MessageKey {
  return (variant === "advice" ? `providers.batch.code.${code}.advice` : `providers.batch.code.${code}`) as MessageKey;
}
