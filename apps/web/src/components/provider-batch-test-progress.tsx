import { AlertTriangle, Loader2, XCircle } from "lucide-react";
import { t } from "../lib/i18n";
import type { BatchJobView } from "../lib/types";
import { Alert, Badge, Button, Spinner } from "../components/ui";

/**
 * Live progress for a bulk run.
 *
 * The label is the point of this component. A run that is still going must say
 * "running"; a run that stopped early must say "partially complete (7/12)" and
 * never "all done" — the two are one boolean apart in the data and a world apart
 * for the operator, who would otherwise trust a half-finished table.
 *
 * `testable = total - skipped` is the denominator: dividing by the scope would
 * show a source that was deliberately skipped as a missing result.
 */
export function ProviderBatchTestProgress({
  job,
  onCancel,
  cancelling,
  error,
}: {
  job: BatchJobView | null;
  onCancel: () => void;
  cancelling: boolean;
  error: string | null;
}) {
  if (!job) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner /> …
      </div>
    );
  }

  const { counts, status } = job;
  const testable = Math.max(0, counts.total - counts.skipped);
  const finished = counts.done + counts.skipped;
  const percent = counts.total === 0 ? 0 : Math.min(100, Math.round((finished / counts.total) * 100));
  const running = status === "running";

  // The source being probed right now: the first item still `unknown`. When the
  // run is finishing, no such item may remain visible for a moment, hence the
  // explicit fallback rather than an empty line.
  const current = job.items.find((item) => item.state === "unknown");
  // Three labels, deliberately distinct: still going, genuinely complete, and
  // stopped-early. The middle one is only reachable when every non-skipped
  // source received a conclusion.
  const label = running
    ? t("providers.batch.progress.running")
    : status === "completed"
      ? t("providers.batch.progress.completed")
      : t("providers.batch.progress.partial", { done: finished, total: counts.total });

  return (
    <div className="space-y-4" data-testid="batch-progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {running ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : null}
          <p className="text-sm font-medium" data-testid="batch-progress-status">
            {label}
          </p>
          <span data-testid="batch-status-badge">
            <Badge tone={running ? "info" : status === "completed" ? "success" : "warning"}>{status}</Badge>
          </span>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="batch-progress-fraction">
          {t("providers.batch.progress.done", { done: counts.done, total: Math.max(testable, counts.done) })}
        </p>
      </div>

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={counts.total}
        aria-valuenow={finished}
        data-testid="batch-progress-bar"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span data-testid="batch-progress-percent">
          {t("providers.batch.progress.percent", { percent })}
        </span>
        <span data-testid="batch-progress-current">
          {current?.providerName
            ? t("providers.batch.progress.current", { name: current.providerName })
            : running
              ? t("providers.batch.progress.finishing")
              : ""}
        </span>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="batch-progress-counts">
        {t("providers.batch.progress.counts", {
          ok: counts.ok,
          failed: counts.failed,
          pending: counts.pending,
          skipped: counts.skipped,
        })}
      </p>

      {status === "cancelled" ? (
        <div data-testid="batch-progress-cancelled">
          <Alert tone="warning" title={t("providers.batch.progress.cancelled", { count: counts.remaining })} />
        </div>
      ) : null}
      {status === "interrupted" ? (
        <div data-testid="batch-progress-interrupted">
          <Alert tone="warning" title={t("providers.batch.progress.interrupted")} />
        </div>
      ) : null}
      {error ? (
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 text-destructive" aria-hidden />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : null}

      <div className="flex justify-end gap-2 border-t pt-3">
        {running ? (
          <Button size="sm" variant="outline" onClick={onCancel} loading={cancelling} data-testid="batch-cancel">
            <XCircle aria-hidden />
            {t("providers.batch.progress.cancel")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
