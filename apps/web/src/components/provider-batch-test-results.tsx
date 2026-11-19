import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { t } from "../lib/i18n";
import type { BatchItem, BatchJobView, BatchState } from "../lib/types";
import { Badge, Button, EmptyState } from "../components/ui";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";

/**
 * Grouping, and the one place it is defined.
 *
 * `restricted` is a *subset* of "did not work", but it is not a failure the
 * operator can act on by retrying: the vendor is throttling or refusing. Keeping
 * it in its own group is what makes "retry the failures" a useful button instead
 * of a loop that fails again immediately.
 *
 *   failed     = state "failed" and code not in RESTRICTED_CODES
 *   restricted = state "failed" and code in RESTRICTED_CODES
 *   pending    = state "pending"  (200 OK, zero rows)
 *   ok         = state "ok"
 *   skipped    = state "skipped"
 *   unknown    = state "unknown"  (only while running, or after an interruption)
 */
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

/** Items that the "retry failures" button submits: failures only, not restrictions. */
export function failedIds(job: BatchJobView): string[] {
  return job.items.filter((item) => groupOf(item) === "failed").map((item) => item.providerId);
}

/** Items that the "retry pending" button submits. */
export function pendingIds(job: BatchJobView): string[] {
  return job.items.filter((item) => groupOf(item) === "pending").map((item) => item.providerId);
}

/**
 * Sorts by severity, then slowest first inside a group.
 *
 * The severity order is fixed rather than derived from the filter: the table
 * must not reorder itself when the operator narrows the view, because a row's
 * position is part of what makes the list scannable.
 */
export function sortItems(items: BatchItem[]): BatchItem[] {
  return [...items].sort((left, right) => {
    const byGroup = GROUP_ORDER[groupOf(left)] - GROUP_ORDER[groupOf(right)];
    if (byGroup !== 0) return byGroup;
    // Slowest first; a missing latency (never measured) sorts last, never as 0.
    const leftLatency = left.latencyMs ?? Number.NEGATIVE_INFINITY;
    const rightLatency = right.latencyMs ?? Number.NEGATIVE_INFINITY;
    if (leftLatency !== rightLatency) return rightLatency - leftLatency;
    return left.providerName.localeCompare(right.providerName);
  });
}

const stateTone: Record<BatchState, "success" | "destructive" | "warning" | "muted" | "info"> = {
  ok: "success",
  failed: "destructive",
  pending: "warning",
  skipped: "muted",
  unknown: "info",
};

export function stateLabel(item: BatchItem): string {
  const group = groupOf(item);
  if (group === "restricted") return t("providers.batch.state.restricted");
  return t(`providers.batch.state.${item.state}` as never);
}

/** Human label for an item's code, falling back to the raw code. */
export function codeLabel(code: string): string {
  const key = `providers.batch.code.${code}`;
  const label = t(key as never);
  // `t()` returns the key itself when it is missing, which would print
  // "providers.batch.code.…" into the table.
  return label === key ? code : label;
}

/** The actionable sentence for a classification, or an empty string. */
export function codeAdvice(code: string): string {
  const key = `providers.batch.code.${code}.advice`;
  const advice = t(key as never);
  return advice === key ? "" : advice;
}

/** `—` when the probe never issued a request. Never an estimate. */
export function requestsLabel(requests: number | null): string {
  return requests === null ? "—" : String(requests);
}

export function ProviderBatchTestResults({
  job,
  onOpenDetail,
  onRetryFailed,
  onRetryPending,
  retrying,
}: {
  job: BatchJobView;
  onOpenDetail: (item: BatchItem) => void;
  onRetryFailed: () => void;
  onRetryPending: () => void;
  retrying: boolean;
}) {
  const [filter, setFilter] = useState<BatchFilter>("all");

  const sorted = useMemo(() => sortItems(job.items), [job.items]);
  const visible = useMemo(
    () => (filter === "all" ? sorted : sorted.filter((item) => groupOf(item) === filter)),
    [sorted, filter],
  );
  const failures = failedIds(job);
  const pending = pendingIds(job);

  const filters: BatchFilter[] = ["all", "failed", "restricted", "pending", "ok", "skipped", "unknown"];

  return (
    <div className="space-y-3" data-testid="batch-results">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" data-testid="batch-filters">
          {filters.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={filter === option ? "default" : "ghost"}
              data-testid={`batch-filter-${option}`}
              onClick={() => setFilter(option)}
            >
              {t(`providers.batch.filter.${option}` as never)}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={failures.length === 0 || retrying}
            loading={retrying}
            data-testid="batch-retry-failed"
            onClick={onRetryFailed}
            title={failures.length === 0 ? t("providers.batch.retryNone") : undefined}
          >
            <RotateCcw aria-hidden />
            {t("providers.batch.retryFailed")}
            {failures.length > 0 ? ` (${failures.length})` : ""}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending.length === 0 || retrying}
            data-testid="batch-retry-pending"
            onClick={onRetryPending}
            title={pending.length === 0 ? t("providers.batch.retryNone") : undefined}
          >
            {t("providers.batch.retryPending")}
            {pending.length > 0 ? ` (${pending.length})` : ""}
          </Button>
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="batch-sort-hint">
        {t("providers.batch.sortHint")} · {t("providers.batch.retryFailedNote")}
      </p>

      {visible.length === 0 ? (
        <EmptyState title={t("providers.batch.emptyResults")} />
      ) : (
        <Table data-testid="batch-table">
          <THead>
            <TR>
              <TH>{t("providers.batch.col.provider")}</TH>
              <TH>{t("providers.batch.col.state")}</TH>
              <TH>{t("providers.batch.col.code")}</TH>
              <TH className="text-right">{t("providers.batch.col.latency")}</TH>
              <TH className="text-right">{t("providers.batch.col.results")}</TH>
              <TH className="text-right">{t("providers.batch.col.requests")}</TH>
              <TH>{null}</TH>
            </TR>
          </THead>
          <TBody>
            {visible.map((item) => {
              const group = groupOf(item);
              return (
                <TR key={item.providerId} data-state={group} data-testid={`batch-row-${item.providerId}`}>
                  <TD>
                    <button
                      type="button"
                      className="truncate text-left font-medium underline-offset-2 hover:underline"
                      onClick={() => onOpenDetail(item)}
                      data-testid={`batch-detail-${item.providerId}`}
                    >
                      {item.providerName || item.providerId}
                    </button>
                  </TD>
                  <TD>
                    <span data-testid={`batch-state-${item.providerId}`}>
                      <Badge tone={stateTone[item.state]}>{stateLabel(item)}</Badge>
                    </span>
                  </TD>
                  <TD className="text-xs text-muted-foreground">{codeLabel(item.code)}</TD>
                  <TD className="text-right text-xs tabular-nums">
                    {item.latencyMs === null ? "—" : `${item.latencyMs} ms`}
                  </TD>
                  <TD className="text-right text-xs tabular-nums">
                    {item.resultCount === null ? "—" : item.resultCount}
                  </TD>
                  <TD className="text-right text-xs tabular-nums" title={item.requests === null ? t("providers.batch.requestsUnknownHint") : undefined}>
                    <span data-testid={`batch-requests-${item.providerId}`}>{requestsLabel(item.requests)}</span>
                  </TD>
                  <TD className="text-right">
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => onOpenDetail(item)}
                    >
                      {t("providers.batch.detail.title")}
                    </button>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
