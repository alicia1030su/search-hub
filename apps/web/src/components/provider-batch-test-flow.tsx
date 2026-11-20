import { useCallback, useEffect, useRef, useState } from "react";
import { api, toApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { usePolling } from "../lib/hooks";
import { rememberBatchJob } from "../lib/batch-job-store";
import type { BatchItem, BatchJobView, ProviderTestResult } from "../lib/types";
import { Alert, Button } from "./ui";
import { Dialog, Sheet } from "./overlay";
import { ProviderBatchTestDialog as BatchPreviewStep } from "./provider-batch-test-dialog";
import { ProviderBatchTestProgress } from "./provider-batch-test-progress";
import { ProviderBatchTestResults } from "./provider-batch-test-results";
import { failedIds, pendingIds } from "../lib/batch-classify";
import { ProviderBatchTestDetail } from "./provider-batch-test-detail";
import { TestResultDialog } from "../pages/providers/keys-panel";

type Step = "preview" | "progress" | "results";

/**
 * The whole flow, in **one** dialog.
 *
 * Three steps, one surface: preview → progress → results. Opening a second
 * dialog for the progress would let the operator end up with two live views of
 * one run (one of them stale), so the step is local state instead.
 *
 * 只有在服务端状态已停止且 `remaining === 0` 时才进入结果页；取消后的陈旧
 * 快照仍继续轮询，不会提前展示尚在结算的行。"partial" 也始终按部分完成展示。
 *
 * `initialJobId` is the reload path: the page stores the last job id, and after a
 * refresh it can reopen the very same run. The step is *not* assumed — the flow
 * always starts on `progress` and lets the first poll decide, because a run that
 * finished while the page was closed must land on the table and a run that is
 * still going must keep polling.
 *
 * `results` is reachable **while the run is still going**, on purpose: §6 lets the
 * operator read what has already finished. Getting there is a user action (the
 * "view finished results" button), never an automatic transition, and the polling
 * keeps running so the table grows underneath the reader.
 */
export function ProviderBatchTestFlow({
  open,
  initialKind,
  initialJobId = null,
  onClose,
  onFinished,
}: {
  open: boolean;
  initialKind: "connect" | "search";
  /** Resume an existing run instead of starting from the preview. */
  initialJobId?: string | null;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [step, setStep] = useState<Step>("preview");
  const [kind, setKind] = useState<"connect" | "search">(initialKind);
  const [jobId, setJobId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** The source currently being retested on its own (drives the row buttons). */
  const [singleTestingId, setSingleTestingId] = useState<string | null>(null);
  /**
   * The single-source probe's own conclusion.
   *
   * A retest is a *new* probe, not a correction of the run: the batch table is
   * the record of what that run saw, so its rows are never rewritten by a later
   * test. The result is presented on its own surface instead — the same
   * `TestResultDialog` the providers page uses — which is both honest about the
   * outcome and visible without opening the drawer.
   */
  const [singleResult, setSingleResult] = useState<{ title: string; result: ProviderTestResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchItem | null>(null);
  const finishedRef = useRef(false);

  // Reset on every open so a previous run's rows never appear as this run's.
  // A resumed job skips the preview: the run already exists, and re-previewing it
  // would let the operator start a *second* run over the same sources.
  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setCancelling(false);
    setRetrying(false);
    setSingleTestingId(null);
    setSingleResult(null);
    setError(null);
    setDetail(null);
    finishedRef.current = false;
    if (initialJobId) {
      setJobId(initialJobId);
      setStep("progress");
      setPolling(true);
      return;
    }
    setStep("preview");
    setJobId(null);
    setPolling(false);
  }, [open, initialKind, initialJobId]);

  const job = usePolling<{ jobId: string; view: BatchJobView } | null>(
    (signal) =>
      jobId === null
        ? Promise.resolve(null)
        : api.batchTestJob(jobId, signal).then((view) => ({ jobId, view })),
    polling && jobId !== null ? 1000 : null,
    [jobId],
  );

  // 切任务时忽略上一个任务的缓存快照，避免旧终态提前把新任务带入结果页。
  const view = job.data?.jobId === jobId ? job.data.view : null;
  const settled = view !== null && view.status !== "running" && view.counts.remaining === 0;

  // 终态且 remaining=0 才停止轮询；取消后的陈旧快照仍会继续 poll 到 settled。
  useEffect(() => {
    if (!view || !settled) return;
    setPolling(false);
    setStep("results");
    if (!finishedRef.current) {
      finishedRef.current = true;
      // Let the page refresh the health overview: the run wrote real probe rows.
      onFinished();
    }
  }, [view, settled, onFinished]);

  const startWith = useCallback(
    async (request: { kind: "connect" | "search"; providerIds?: string[]; includeKeyless?: boolean }) => {
      setRetrying(true);
      setError(null);
      try {
        const started = await api.startBatchTest(request);
        setJobId(started.jobId);
        setKind(request.kind);
        setStep("progress");
        setPolling(true);
        finishedRef.current = false;
        rememberBatchJob({ jobId: started.jobId, kind: request.kind, startedAt: new Date().toISOString() });
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

  /**
   * Retests **one** source, outside the run.
   *
   * Three rules, and the second is the one that used to be wrong:
   *
   *  1. the probe is the real single-source path (`api.testProvider`), so the
   *     answer is the vendor's, measured the same way the batch measured it;
   *  2. the batch row is **not** rewritten. A batch row says "this is what run X
   *     saw at time T"; folding a later probe into it would turn the ledger into a
   *     mixture of two runs and could keep an `ok` that no longer holds;
   *  3. the conclusion is shown on its own dialog, so pressing the button has a
   *     visible effect even when no drawer is open — and a failed retest is
   *     reported as a failure.
   */
  const retryOne = useCallback(
    async (providerId: string) => {
      setSingleTestingId(providerId);
      setError(null);
      try {
        const result = await api.testProvider(providerId);
        // The probe wrote a real health row; the overview should show it.
        onFinished();
        const providerName =
          view?.items.find((item) => item.providerId === providerId)?.providerName ?? providerId;
        setSingleResult({ title: t("providers.test.title", { name: providerName }), result });
      } catch (failure) {
        setError(toApiError(failure).message);
      } finally {
        setSingleTestingId(null);
      }
    },
    [onFinished, view],
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
              rememberBatchJob({ jobId: startedId, kind: startedKind, startedAt: new Date().toISOString() });
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
            {view && view.status === "running" && view.counts.done > 0 ? (
              // §6: the finished rows are readable while the run is still going.
              // This only switches the view — `polling` stays on, so the table
              // keeps growing and a restart of the step is not needed.
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="batch-view-results"
                  onClick={() => setStep("results")}
                >
                  {t("providers.batch.viewDone", { count: view.counts.done })}
                </Button>
              </div>
            ) : null}
            {view && view.status !== "running" && view.counts.remaining === 0 ? (
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
            {/* The way back: from the table the operator cannot see the progress
                bar or the cancel button, so a run still in flight needs a door. */}
            {view.status === "running" ? (
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="batch-back-progress"
                  onClick={() => setStep("progress")}
                >
                  {t("providers.batch.backToProgress")}
                </Button>
              </div>
            ) : null}
            {/*
              The run's own verdict, above the table. A cancelled or interrupted
              run must be described as *partially* complete here: the table alone
              cannot say whether the rows are everything that was asked for.
            */}
            <div className="flex flex-wrap items-center gap-2" data-testid="batch-result-status">
              <p className="text-sm font-medium">
                {view.status === "running"
                  ? // Never "completed" while the run is still going: the table is
                    // a snapshot of the finished rows, not the whole answer.
                    `${t("providers.batch.progress.running")} · ${t("providers.batch.progress.done", {
                      done: view.counts.done,
                      total: view.counts.total,
                    })}`
                  : view.status === "completed"
                    ? t("providers.batch.progress.completed")
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
              retrying={retrying || singleTestingId !== null}
              onOpenDetail={(item) => setDetail(item)}
              onRetryFailed={() =>
                void startWith({
                  kind: view.kind,
                  providerIds: failedIds(view),
                  includeKeyless: view.includeKeyless,
                })
              }
              onRetryPending={() =>
                void startWith({
                  kind: view.kind,
                  providerIds: pendingIds(view),
                  includeKeyless: view.includeKeyless,
                })
              }
              onRetryOne={(providerId) => void retryOne(providerId)}
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
          providerType={detail?.providerType ?? undefined}
          onRetry={(providerId) => void retryOne(providerId)}
          retrying={singleTestingId !== null}
        />
      </Sheet>

      {/*
        One surface for the single-source probe result, shared by the table row and
        the drawer: the same dialog the providers page already uses, so a retest
        reads identically wherever it was started from.
      */}
      <TestResultDialog
        open={singleResult !== null}
        onClose={() => setSingleResult(null)}
        title={singleResult?.title ?? ""}
        result={singleResult?.result ?? null}
      />
    </>
  );
}
