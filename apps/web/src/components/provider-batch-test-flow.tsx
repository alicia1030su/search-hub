import { useCallback, useEffect, useRef, useState } from "react";
import { api, toApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { usePolling } from "../lib/hooks";
import type { BatchItem, BatchJobView } from "../lib/types";
import { Alert, Button } from "./ui";
import { Dialog, Sheet } from "./overlay";
import { ProviderBatchTestDialog as BatchPreviewStep } from "./provider-batch-test-dialog";
import { ProviderBatchTestProgress } from "./provider-batch-test-progress";
import { ProviderBatchTestResults } from "./provider-batch-test-results";
import { failedIds, pendingIds } from "../lib/batch-classify";
import { ProviderBatchTestDetail } from "./provider-batch-test-detail";

type Step = "preview" | "progress" | "results";

/**
 * The whole flow, in **one** dialog.
 *
 * Three steps, one surface: preview → progress → results. Opening a second
 * dialog for the progress would let the operator end up with two live views of
 * one run (one of them stale), so the step is local state instead.
 *
 * The transition to `results` is driven by the *server's* status, never by a
 * timer: a run that is still `running` keeps showing progress, and a run that
 * stopped — completed, cancelled, interrupted or partial — shows the table. That
 * is also why "partial" is rendered as a partial label and never as "completed".
 */
export function ProviderBatchTestFlow({
  open,
  initialKind,
  onClose,
  onFinished,
}: {
  open: boolean;
  initialKind: "connect" | "search";
  onClose: () => void;
  onFinished: () => void;
}) {
  const [step, setStep] = useState<Step>("preview");
  const [kind, setKind] = useState<"connect" | "search">(initialKind);
  const [jobId, setJobId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchItem | null>(null);
  const finishedRef = useRef(false);

  // Reset on every open so a previous run's rows never appear as this run's.
  useEffect(() => {
    if (!open) return;
    setStep("preview");
    setKind(initialKind);
    setJobId(null);
    setPolling(false);
    setCancelling(false);
    setRetrying(false);
    setError(null);
    setDetail(null);
    finishedRef.current = false;
  }, [open, initialKind]);

  const job = usePolling<BatchJobView | null>(
    (signal) => (jobId === null ? Promise.resolve(null) : api.batchTestJob(jobId, signal)),
    polling && jobId !== null ? 1000 : null,
    [jobId],
  );

  const view = job.data;

  // A server-reported terminal status is the only thing that stops the polling
  // and advances the step.
  useEffect(() => {
    if (!view) return;
    if (view.status === "running") return;
    setPolling(false);
    setStep("results");
    if (!finishedRef.current) {
      finishedRef.current = true;
      // Let the page refresh the health overview: the run wrote real probe rows.
      onFinished();
    }
  }, [view, onFinished]);

  const startWith = useCallback(
    async (request: { kind: "connect" | "search"; providerIds?: string[] }) => {
      setRetrying(true);
      setError(null);
      try {
        const started = await api.startBatchTest(request);
        setJobId(started.jobId);
        setKind(request.kind);
        setStep("progress");
        setPolling(true);
        finishedRef.current = false;
      } catch (failure) {
        setError(toApiError(failure).message);
      } finally {
        setRetrying(false);
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    if (!jobId) return;
    setCancelling(true);
    setError(null);
    try {
      await api.cancelBatchTest(jobId);
      // Keep polling: the runner still has to record the cancelled items, and
      // the table must show them.
      setPolling(true);
      job.refresh();
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      setCancelling(false);
    }
  }, [job, jobId]);

  const retryOne = useCallback(
    async (providerId: string) => {
      setRetrying(true);
      setError(null);
      try {
        const result = await api.testProvider(providerId);
        onFinished();
        setDetail((current) =>
          current && current.providerId === providerId
            ? { ...current, state: result.cause === "ok" ? "ok" : current.state, code: result.cause ?? current.code }
            : current,
        );
      } catch (failure) {
        setError(toApiError(failure).message);
      } finally {
        setRetrying(false);
      }
    },
    [onFinished],
  );

  const title =
    step === "preview"
      ? t("providers.batch.title")
      : step === "progress"
        ? t("providers.batch.step.progress")
        : t("providers.batch.step.results");

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={title}
        description={step === "preview" ? t("providers.batch.entryHint") : t("providers.batch.desc")}
        size="xl"
        footer={
          step === "results" ? (
            <Button size="sm" variant="outline" onClick={onClose}>
              {t("providers.batch.close")}
            </Button>
          ) : undefined
        }
      >
        {step === "preview" ? (
          <BatchPreviewStep
            open={open}
            kind={kind}
            onKindChange={setKind}
            onClose={onClose}
            onStarted={(startedId, startedKind) => {
              setJobId(startedId);
              setKind(startedKind);
              setStep("progress");
              setPolling(true);
              finishedRef.current = false;
            }}
          />
        ) : step === "progress" ? (
          <div className="space-y-3">
            <ProviderBatchTestProgress
              job={view}
              onCancel={() => void cancel()}
              cancelling={cancelling}
              error={error ?? job.error?.message ?? null}
            />
            {view && view.status !== "running" ? (
              // A finished run leaves this step through the effect above; this
              // button is the manual fallback if that transition was missed.
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setStep("results")}>
                  {t("providers.batch.step.results")}
                </Button>
              </div>
            ) : null}
          </div>
        ) : view ? (
          <div className="space-y-3">
            {/*
              The run's own verdict, above the table. A cancelled or interrupted
              run must be described as *partially* complete here: the table alone
              cannot say whether the rows are everything that was asked for.
            */}
            <div className="flex flex-wrap items-center gap-2" data-testid="batch-result-status">
              <p className="text-sm font-medium">
                {view.status === "completed"
                  ? t("providers.batch.progress.completed")
                  : view.status === "running"
                    ? t("providers.batch.progress.running")
                    : t("providers.batch.progress.partial", {
                        done: view.counts.done + view.counts.skipped,
                        total: view.counts.total,
                      })}
              </p>
              <p className="text-xs text-muted-foreground" data-testid="batch-result-counts">
                {t("providers.batch.progress.counts", {
                  ok: view.counts.ok,
                  failed: view.counts.failed,
                  pending: view.counts.pending,
                  skipped: view.counts.skipped,
                })}
              </p>
            </div>
            {view.status === "interrupted" ? (
              <Alert tone="warning" title={t("providers.batch.progress.interrupted")} />
            ) : null}
            {view.status === "cancelled" ? (
              <Alert
                tone="warning"
                title={t("providers.batch.progress.cancelled", { count: view.counts.remaining })}
              />
            ) : null}
            {error ? (
              <Alert tone="error" title={t("providers.batch.runFailed")}>
                {error}
              </Alert>
            ) : null}
            <ProviderBatchTestResults
              job={view}
              retrying={retrying}
              onOpenDetail={(item) => setDetail(item)}
              onRetryFailed={() => void startWith({ kind: view.kind, providerIds: failedIds(view) })}
              onRetryPending={() => void startWith({ kind: view.kind, providerIds: pendingIds(view) })}
            />
          </div>
        ) : (
          <p className="py-6 text-sm text-muted-foreground">{t("providers.batch.emptyResults")}</p>
        )}
      </Dialog>

      <Sheet
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={t("providers.batch.detail.title")}
        description={detail ? detail.providerName : undefined}
        size="sm"
      >
        <ProviderBatchTestDetail
          item={detail}
          providerType={undefined}
          onRetry={(providerId) => void retryOne(providerId)}
          retrying={retrying}
        />
      </Sheet>
    </>
  );
}
