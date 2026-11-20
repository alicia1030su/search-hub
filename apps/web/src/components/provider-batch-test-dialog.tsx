import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, toApiError } from "../lib/api";
import { t } from "../lib/i18n";
import { useAsyncData } from "../lib/hooks";
import type { BatchPreview } from "../lib/types";
import { Alert, Badge, Button, EmptyState, Skeleton, Switch } from "../components/ui";

/**
 * The pre-flight confirmation dialog.
 *
 * This screen exists to answer one question before any request is sent: *what
 * will happen if I press start*. Three things it must therefore never do:
 *
 *  1. **hide a source.** The counters add up to the scope total, so nothing can
 *     simply be missing from the dialog (the "no key" row shows both halves —
 *     never set and all disabled — inside one row rather than merging them into
 *     an unexplained number);
 *  2. **claim a cost that will not happen.** `paidRisk` comes from the server and
 *     is false for connectivity runs even when paid probing is enabled;
 *  3. **let the operator discover a refusal by pressing the button.** When the
 *     server would reject the run (paid probing off, budget exhausted), the
 *     reason is shown here and the start button is disabled — a 409 after a
 *     click is a worse way to learn the same fact.
 */
export function ProviderBatchTestDialog({
  open,
  kind,
  onClose,
  onStarted,
  onKindChange,
}: {
  open: boolean;
  kind: "connect" | "search";
  onClose: () => void;
  onStarted: (jobId: string, kind: "connect" | "search") => void;
  onKindChange: (kind: "connect" | "search") => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 仅本次任务有效，不读取也不写回全局 health.includeUnverified。 */
  const [includeKeyless, setIncludeKeyless] = useState(false);

  const preview = useAsyncData<BatchPreview>(
    (signal) => api.batchTestPreview({ kind, includeKeyless }, signal),
    [kind, includeKeyless, open],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setIncludeKeyless(false);
  }, [open]);

  const counts = preview.data?.counts;
  const total = preview.data?.total ?? 0;
  const eligible = counts?.eligible ?? 0;
  const configError = counts?.configError ?? 0;
  const testable = eligible + configError;
  const budget = preview.data?.budget;

  const paidCandidates = preview.data?.estimatedPaidProbes ?? 0;
  const anonymousCandidates = preview.data?.estimatedAnonymousProbes ?? 0;
  // 只有纯付费范围才整体拒绝；混合范围会跳过付费源并继续匿名源。
  const blockedByPaidSwitch =
    kind === "search" &&
    paidCandidates > 0 &&
    anonymousCandidates === 0 &&
    budget !== undefined &&
    budget.paidProbesEnabled === false;
  const blockedByBudget =
    kind === "search" &&
    paidCandidates > 0 &&
    anonymousCandidates === 0 &&
    budget !== undefined &&
    budget.paidProbesEnabled &&
    (budget.remainingToday <= 0 || budget.maxPerRun <= 0);
  const blocked = blockedByPaidSwitch || blockedByBudget || testable === 0 || preview.loading;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const job = await api.startBatchTest({ kind, includeKeyless });
      onStarted(job.jobId, kind);
    } catch (failure) {
      setError(toApiError(failure).message);
    } finally {
      setStarting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="space-y-4" data-testid="batch-preview">
      <div className="flex flex-wrap gap-1.5">
        {(["connect", "search"] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            variant={kind === option ? "default" : "outline"}
            disabled={starting}
            data-testid={`batch-kind-${option}`}
            onClick={() => onKindChange(option)}
          >
            {option === "connect" ? t("providers.batch.entryConnect") : t("providers.batch.entrySearch")}
          </Button>
        ))}
      </div>

      {preview.error ? (
        <Alert tone="error" title={t("providers.batch.runFailed")}>
          {preview.error.message}
        </Alert>
      ) : null}

      {preview.loading && !preview.data ? (
        <Skeleton className="h-40" />
      ) : !preview.data ? (
        <EmptyState title={t("providers.batch.emptyNothing")} description={t("providers.batch.emptyNothingWhy")} />
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="batch-scope-total">
            {t("providers.batch.counts.total", { count: total })}
          </p>

          <dl className="grid gap-2 sm:grid-cols-2" data-testid="batch-counts">
            <CountRow
              testId="count-eligible"
              tone="success"
              label={t("providers.batch.counts.eligible")}
              value={counts?.eligible ?? 0}
            />
            <CountRow
              testId="count-nokey"
              tone="warning"
              label={t("providers.batch.counts.noKey")}
              value={(counts?.noKey ?? 0) + (counts?.noEnabledKey ?? 0)}
              hint={t("providers.batch.counts.noKeyDetail", {
                noKey: counts?.noKey ?? 0,
                noEnabledKey: counts?.noEnabledKey ?? 0,
              })}
            />
            <CountRow
              testId="count-config-error"
              tone="destructive"
              label={t("providers.batch.counts.configError")}
              value={counts?.configError ?? 0}
            />
            <CountRow
              testId="count-disabled"
              tone="muted"
              label={t("providers.batch.counts.disabled")}
              value={counts?.disabled ?? 0}
            />
            <CountRow
              testId="count-keyless"
              tone="muted"
              label={t("providers.batch.counts.keylessSkipped")}
              value={counts?.keylessSkipped ?? 0}
            />
            <CountRow
              testId="count-cooling"
              tone="muted"
              label={t("providers.batch.counts.coolingSkipped")}
              value={counts?.coolingSkipped ?? 0}
            />
          </dl>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("providers.batch.counts.partition")}
          </p>

          {budget ? (
            <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs" data-testid="batch-budget">
              <p className="font-medium">{t("providers.batch.budget.title")}</p>
              <p className="text-muted-foreground" data-testid="batch-budget-remaining">
                {t("providers.batch.budget.remaining", { count: budget.remainingToday })} ·{" "}
                {t("providers.batch.budget.perRun", { count: budget.maxPerRun })}
              </p>
              <p className="text-muted-foreground" data-testid="batch-anonymous-estimate">
                {t("providers.batch.budget.anonymous", {
                  count: anonymousCandidates,
                  remaining: budget.anonymousRemainingToday,
                  perRun: budget.anonymousMaxPerRun,
                })}
              </p>
              <p className="text-muted-foreground">{t("providers.batch.budget.day", { day: budget.day })}</p>
            </div>
          ) : null}

          {preview.data.paidRisk ? (
            <div data-testid="batch-paid-risk">
              <Alert tone="warning" title={t("providers.batch.paidRisk", { count: preview.data.estimatedPaidProbes })} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="batch-paid-risk-off">
              {t("providers.batch.paidRiskOff")}
            </p>
          )}

          <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium">{t("providers.batch.includeKeyless")}</p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t("providers.batch.includeKeylessHint")}
              </p>
            </div>
            <div data-testid="batch-include-keyless">
              <Switch
                checked={includeKeyless}
                disabled={starting}
                label={t("providers.batch.includeKeylessToggle")}
                onChange={setIncludeKeyless}
              />
            </div>
          </div>

          {kind === "search" && paidCandidates > 0 && anonymousCandidates > 0 && budget?.paidProbesEnabled === false ? (
            <div data-testid="batch-paid-disabled-mixed">
              <Alert
                tone="warning"
                title={t("providers.batch.paidDisabledMixed", {
                  paid: paidCandidates,
                  anonymous: anonymousCandidates,
                })}
              />
            </div>
          ) : null}

          {blockedByPaidSwitch ? (
            <div data-testid="batch-blocked-paid">
              <Alert tone="warning" title={t("providers.batch.paidDisabled")} />
            </div>
          ) : null}
          {blockedByBudget ? (
            <div data-testid="batch-blocked-budget">
              <Alert tone="warning" title={t("providers.batch.budgetExhausted")} />
            </div>
          ) : null}
          {testable === 0 ? (
            <EmptyState title={t("providers.batch.emptyNothing")} description={t("providers.batch.emptyNothingWhy")} />
          ) : null}

          {error ? (
            <Alert tone="error" title={t("providers.batch.runFailed")}>
              {error}
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground" data-testid="batch-testable">
              {t("providers.batch.progress.testable", { count: testable })}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={starting}>
                {t("providers.batch.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void start()}
                disabled={blocked || starting}
                loading={starting}
                data-testid="batch-start"
                title={
                  blockedByPaidSwitch
                    ? t("providers.batch.paidDisabled")
                    : blockedByBudget
                      ? t("providers.batch.budgetExhausted")
                      : undefined
                }
              >
                {starting ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t("providers.batch.start")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CountRow({
  label,
  value,
  tone,
  hint,
  testId,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "destructive" | "muted";
  hint?: string;
  testId: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-lg border px-3 py-2" data-testid={testId}>
      <div className="min-w-0 space-y-0.5">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        {hint ? <dd className="text-[11px] text-muted-foreground/80">{hint}</dd> : null}
      </div>
      <dd>
        <Badge tone={tone} className="text-xs">
          {value}
        </Badge>
      </dd>
    </div>
  );
}
