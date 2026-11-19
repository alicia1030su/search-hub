import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { t } from "../lib/i18n";
import { formatDateTime, formatShortDateTime } from "../lib/format";
import { errorReasonOf, failedIds, groupOf, pendingIds, sortItems, type BatchFilter } from "../lib/batch-classify";
import { STATE_TONE, stateLabel } from "../lib/batch-labels";
import type { BatchItem, BatchJobView } from "../lib/types";
import { Badge, Button, EmptyState } from "../components/ui";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";

/**
 * The result table — exactly the eight columns §7 asks for:
 * source (name + type), state, API key count, latency, result count, error
 * reason, last checked, and the two per-row actions.
 *
 * **Two facts are deliberately *not* columns here.** The canonical error
 * classification and the upstream request count live in the detail drawer (§4),
 * which already displays them. Keeping them in the table too pushed the action
 * column out of the dialog's visible width, hiding the very buttons the row
 * exists to offer; a table whose last column is unreachable is worse than a
 * narrower one.
 *
 * Two rendering rules matter here:
 *
 *  - **`null` is an em dash, never a zero.** A probe that never sent a request
 *    has no latency, no result count and no check time; printing `0` would turn
 *    "not measured" into a measurement.
 *  - **The key column is a count, never key material.** `keyCount` is the size of
 *    the credential pool, so the column can say "2 configured" without this
 *    component ever touching a secret or an identifier.
 *
 * Sorting and grouping come from `lib/batch-classify`, so the table, the drawer
 * and the retry buttons cannot disagree about what "failed" means.
 */
export function ProviderBatchTestResults({
  job,
  onOpenDetail,
  onRetryFailed,
  onRetryPending,
  onRetryOne,
  retrying,
}: {
  job: BatchJobView;
  onOpenDetail: (item: BatchItem) => void;
  onRetryFailed: () => void;
  onRetryPending: () => void;
  /** Retest exactly one source, without starting a new run. */
  onRetryOne: (providerId: string) => void;
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
        // Eight columns, sized to sit inside the `xl` dialog so the action column
        // stays on screen. The wrapper still scrolls rather than clipping at a
        // narrow viewport, but at the dialog's own width nothing is out of reach.
        <Table data-testid="batch-table" minWidth="min-w-[860px]">
          <THead>
            <TR>
              <TH className="w-[16%]">{t("providers.batch.col.provider")}</TH>
              <TH className="w-[9%]">{t("providers.batch.col.state")}</TH>
              <TH className="w-[11%]">{t("providers.batch.col.keys")}</TH>
              <TH className="w-[9%] text-right">{t("providers.batch.col.latency")}</TH>
              <TH className="w-[8%] text-right">{t("providers.batch.col.results")}</TH>
              <TH className="w-[21%]">{t("providers.batch.col.reason")}</TH>
              <TH className="w-[12%]">{t("providers.batch.col.checkedAt")}</TH>
              <TH className="w-[14%] text-right">{t("common.actions")}</TH>
            </TR>
          </THead>
          <TBody>
            {visible.map((item) => {
              const group = groupOf(item);
              return (
                <TR key={item.providerId} data-state={group} data-testid={`batch-row-${item.providerId}`}>
                  <TD>
                    {/* Name and type in one cell: the type is what tells the
                        operator *which* integration this row is about. */}
                    <button
                      type="button"
                      className="block max-w-[11rem] truncate text-left font-medium underline-offset-2 hover:underline"
                      title={item.providerName || item.providerId}
                      onClick={() => onOpenDetail(item)}
                      data-testid={`batch-detail-${item.providerId}`}
                    >
                      {item.providerName || item.providerId}
                    </button>
                    {item.providerType ? (
                      <p className="truncate font-mono text-[10px] text-muted-foreground">{item.providerType}</p>
                    ) : null}
                  </TD>
                  <TD>
                    <span data-testid={`batch-state-${item.providerId}`}>
                      <Badge tone={STATE_TONE[item.state]}>{stateLabel(item)}</Badge>
                    </span>
                  </TD>
                  <TD className="text-xs tabular-nums" data-testid={`batch-keys-${item.providerId}`}>
                    {item.keyCount === null ? "—" : t("providers.batch.keysConfigured", { count: item.keyCount })}
                  </TD>
                  <TD className="text-right text-xs tabular-nums">
                    {item.latencyMs === null ? "—" : `${item.latencyMs} ms`}
                  </TD>
                  <TD className="text-right text-xs tabular-nums">
                    {item.resultCount === null ? "—" : item.resultCount}
                  </TD>
                  <TD className="max-w-[12rem]">
                    {errorReasonOf(item) ? (
                      <p
                        className="truncate text-[11px] leading-relaxed text-muted-foreground"
                        // The full message lives in the tooltip and the drawer;
                        // a vendor error can be long and must not widen the table.
                        title={errorReasonOf(item) ?? undefined}
                        data-testid={`batch-reason-${item.providerId}`}
                      >
                        {errorReasonOf(item)}
                      </p>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">—</span>
                    )}
                  </TD>
                  <TD
                    className="whitespace-nowrap text-[11px] text-muted-foreground tabular-nums"
                    data-testid={`batch-checked-${item.providerId}`}
                    // The compact form fits the column; the full timestamp is one
                    // hover (or one drawer) away.
                    title={formatDateTime(item.checkedAt)}
                  >
                    {formatShortDateTime(item.checkedAt)}
                  </TD>
                  <TD className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="whitespace-nowrap px-2 text-xs"
                        data-testid={`batch-open-detail-${item.providerId}`}
                        onClick={() => onOpenDetail(item)}
                      >
                        {t("providers.batch.action.detail")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="whitespace-nowrap px-2 text-xs"
                        disabled={retrying || item.state === "unknown"}
                        data-testid={`batch-retry-one-${item.providerId}`}
                        onClick={() => onRetryOne(item.providerId)}
                        title={item.state === "unknown" ? t("providers.batch.state.unknown") : undefined}
                      >
                        {t("providers.batch.retryOne")}
                      </Button>
                    </div>
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
