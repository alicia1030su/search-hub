import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { t } from "../lib/i18n";
import {
  failedIds,
  groupOf,
  pendingIds,
  requestsLabel,
  sortItems,
  type BatchFilter,
} from "../lib/batch-classify";
import { codeLabel, STATE_TONE, stateLabel } from "../lib/batch-labels";
import type { BatchItem, BatchJobView } from "../lib/types";
import { Badge, Button, EmptyState } from "../components/ui";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";

/**
 * The result table.
 *
 * Columns are the six facts an operator actually uses to decide what to fix:
 * which source, what happened, which classification, how slow, how many rows,
 * how many requests. Sorting and grouping come from `lib/batch-classify`, so the
 * table, the drawer and the retry buttons cannot disagree about what "failed"
 * means.
 */
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
              {t(`providers.batch.filter.${option}` as const)}
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
                      className="max-w-[16rem] truncate text-left font-medium underline-offset-2 hover:underline"
                      onClick={() => onOpenDetail(item)}
                      data-testid={`batch-detail-${item.providerId}`}
                    >
                      {item.providerName || item.providerId}
                    </button>
                  </TD>
                  <TD>
                    <span data-testid={`batch-state-${item.providerId}`}>
                      <Badge tone={STATE_TONE[item.state]}>{stateLabel(item)}</Badge>
                    </span>
                  </TD>
                  <TD className="text-xs text-muted-foreground">{codeLabel(item.code)}</TD>
                  <TD className="text-right text-xs tabular-nums">
                    {item.latencyMs === null ? "—" : `${item.latencyMs} ms`}
                  </TD>
                  <TD className="text-right text-xs tabular-nums">
                    {item.resultCount === null ? "—" : item.resultCount}
                  </TD>
                  <TD
                    className="text-right text-xs tabular-nums"
                    title={item.requests === null ? t("providers.batch.requestsUnknownHint") : undefined}
                  >
                    <span data-testid={`batch-requests-${item.providerId}`}>{requestsLabel(item.requests)}</span>
                  </TD>
                  <TD className="text-right">
                    <button
                      type="button"
                      className="whitespace-nowrap text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
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
