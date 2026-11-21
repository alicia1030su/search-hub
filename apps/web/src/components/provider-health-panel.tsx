import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Field,
  Input,
  SectionHeader,
  Skeleton,
  Switch,
} from "../components/ui";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";
import { ConfirmDialog, Dialog } from "../components/overlay";
import { useToast } from "../components/toast";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { formatDateTime, formatNumber } from "../lib/format";
import { useAsyncData } from "../lib/hooks";
import type {
  HealthCheckResult,
  HealthOverview,
  ProviderHealthPolicy,
  ProviderHealthRow,
  RuntimeHealthValue,
  VerificationValue,
} from "../lib/types";

/**
 * Provider Health Management panel.
 *
 * Three things this panel must never do:
 *  - show "healthy" for a source that was never probed (that is `unverified`);
 *  - let a green probe imply a live vendor integration (`implementation` is shown
 *    separately and is never derived from a probe);
 *  - hide that a live search probe costs money — the switch and the button both
 *    say so before you press them.
 */
export function ProviderHealthPanel({
  overview,
  loading,
  error,
  onCheckAll,
  onCheckOne,
  onReload,
  busy,
}: {
  overview: HealthOverview | null;
  loading: boolean;
  error: string | null;
  onCheckAll: (kind: "connect" | "search") => void;
  onCheckOne: (providerId: string, kind: "connect" | "search") => void;
  onReload: () => void;
  busy: boolean;
}) {
  if (error) {
    return <EmptyState title={t("providers.health.error")} description={error} />;
  }
  if (loading && !overview) return <Skeleton className="h-64" />;
  if (!overview) return <EmptyState title={t("providers.health.empty")} />;

  const budget = overview.budget;
  const runtimeTotals = overview.runtimeTotals;

  return (
    <section className="space-y-4" aria-label={t("providers.health.title")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t("providers.health.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("providers.health.desc")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/*
            Two entry points into the *same* flow, differing only in `kind`.
            Both open the pre-flight dialog: testing every source is an action
            with a cost and a scope, and neither is knowable without asking
            first. Names differ so the operator is never surprised by which one
            spends quota.
          */}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onCheckAll("connect")}
            data-testid="health-test-all-connect"
            title={t("providers.batch.entryHint")}
          >
            {t("providers.batch.entryConnect")}
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={busy}
            onClick={() => onCheckAll("search")}
            data-testid="health-test-all"
            title={t("providers.batch.entryHint")}
          >
            {t("providers.batch.entry")}
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Summary label={t("providers.health.runtime.healthy")} value={runtimeTotals.healthy} tone="success" />
        <Summary
          label={t("providers.health.runtime.degraded")}
          value={
            runtimeTotals.degraded +
            runtimeTotals.cooldown +
            runtimeTotals.rate_limited +
            runtimeTotals.permission_denied
          }
          tone="warning"
        />
        <Summary
          label={t("providers.health.runtime.unhealthy")}
          value={runtimeTotals.unhealthy + runtimeTotals.quota_exceeded + runtimeTotals.invalid_credentials}
          tone="destructive"
        />
        <Summary
          label={t("providers.health.runtime.unknown")}
          value={runtimeTotals.unknown + runtimeTotals.unverified}
          tone="muted"
        />
      </div>

      <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <p>{t("providers.health.budget.day", { day: budget.day })}</p>
        <p>
          {t("providers.health.budget.split", {
            search: budget.usedToday,
            max: budget.maxPerDay,
            connect: budget.connectUsedToday,
          })}
          {" · "}
          {t("providers.health.budget.remaining", { count: budget.remainingToday })}
        </p>
        <p>
          {t("providers.health.budget", {
            used: budget.usedToday,
            max: budget.maxPerDay,
            perRun: budget.maxPerRun,
            scheduled: budget.scheduledEnabled
              ? t("providers.health.scheduledOn")
              : t("providers.health.scheduledOff"),
          })}
        </p>
      </div>

      <PolicyCard onSaved={onReload} />

      {overview.providers.length === 0 ? (
        <EmptyState title={t("providers.health.empty")} />
      ) : (
        <div className="grid gap-2">
          {overview.providers.map((row) => (
            <HealthRow
              key={row.providerId}
              row={row}
              busy={busy}
              onCheck={onCheckOne}
              onChanged={onReload}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Summary({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "destructive" | "muted";
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Badge tone={tone}>{formatNumber(value)}</Badge>
      </CardContent>
    </Card>
  );
}

/** Automatic-probing policy: schedule, interval and both budget ceilings. */
function PolicyCard({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const settings = useAsyncData((signal) => api.providerHealthSettings(signal), []);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Partial<ProviderHealthPolicy> | null>(null);

  if (settings.loading && !settings.data) return <Skeleton className="h-40" />;
  if (settings.error) {
    return <EmptyState title={t("providers.health.policy.title")} description={settings.error.message} />;
  }
  const policy = settings.data?.policy;
  if (!policy) return null;
  const current: ProviderHealthPolicy = { ...policy, ...draft };

  const patch = (value: Partial<ProviderHealthPolicy>) =>
    setDraft((previous) => ({ ...previous, ...value }));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await api.updateProviderHealthSettings(draft);
      setDraft(null);
      settings.reload();
      onSaved();
      toast.success({ title: t("providers.health.policy.saved") });
    } catch (error) {
      toast.error({
        title: t("states.errorTitle"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <SectionHeader
          title={t("providers.health.policy.title")}
          description={t("providers.health.policy.desc")}
        />
        <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
          <span className="text-xs">{t("providers.health.policy.scheduled")}</span>
          <Switch
            checked={current.scheduledEnabled}
            onChange={(value) => patch({ scheduledEnabled: value })}
            label={t("providers.health.policy.scheduled")}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
          <div className="space-y-0.5">
            <span className="text-xs">{t("providers.health.policy.paid")}</span>
            <p className="text-[11px] text-muted-foreground">{t("providers.health.paidWarning")}</p>
          </div>
          <Switch
            checked={current.paidProbesEnabled}
            onChange={(value) => patch({ paidProbesEnabled: value })}
            label={t("providers.health.policy.paid")}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("providers.health.policy.interval")} htmlFor="health-interval">
            <Input
              id="health-interval"
              type="number"
              min={5}
              max={10080}
              value={String(current.intervalMinutes)}
              onChange={(event) => patch({ intervalMinutes: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("providers.health.policy.perRun")} htmlFor="health-per-run">
            <Input
              id="health-per-run"
              type="number"
              min={1}
              max={200}
              value={String(current.maxRequestsPerRun)}
              onChange={(event) => patch({ maxRequestsPerRun: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("providers.health.policy.perDay")} htmlFor="health-per-day">
            <Input
              id="health-per-day"
              type="number"
              min={1}
              max={2000}
              value={String(current.maxRequestsPerDay)}
              onChange={(event) => patch({ maxRequestsPerDay: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("providers.health.policy.concurrency")} htmlFor="health-concurrency">
            <Input
              id="health-concurrency"
              type="number"
              min={1}
              max={4}
              value={String(current.concurrency)}
              onChange={(event) => patch({ concurrency: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("providers.health.policy.connectPerProbe")} htmlFor="health-connect-per-probe">
            <Input
              id="health-connect-per-probe"
              type="number"
              min={1}
              max={20}
              value={String(current.connectMaxRequestsPerProbe)}
              onChange={(event) => patch({ connectMaxRequestsPerProbe: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("providers.health.policy.connectPerDay")} htmlFor="health-connect-per-day">
            <Input
              id="health-connect-per-day"
              type="number"
              min={1}
              max={2000}
              value={String(current.connectMaxRequestsPerDay)}
              onChange={(event) => patch({ connectMaxRequestsPerDay: Number(event.target.value) })}
            />
          </Field>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("providers.health.connectWarning")}</p>
        <div className="flex justify-end">
          <Button size="sm" disabled={!draft || saving} loading={saving} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function HealthRow({
  row,
  busy,
  onCheck,
  onChanged,
}: {
  row: ProviderHealthRow;
  busy: boolean;
  onCheck: (providerId: string, kind: "connect" | "search") => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{row.providerName}</span>
            {/* Runtime state and implementation verification are separate axes. */}
            <Badge tone={runtimeTone(row.runtime)}>{runtimeLabel(row.runtime)}</Badge>
            <Badge tone="muted">{verificationLabel(row.implementation.verification)}</Badge>
            {row.autoProbeEnabled ? null : (
              <span className="text-[10px] text-muted-foreground">
                {t("providers.health.autoProbeOff")}
              </span>
            )}
            {row.lastProbe?.kind === "connect" ? (
              <span className="text-[10px] text-muted-foreground">{t("providers.health.connectOnly")}</span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {row.lastCheckedAt
              ? t("providers.health.lastChecked", { at: formatDateTime(row.lastCheckedAt) })
              : t("providers.health.neverChecked")}
            {" · "}
            {row.nextProbeAt
              ? t("providers.health.nextProbe", { at: formatDateTime(row.nextProbeAt) })
              : t("providers.health.noNextProbe")}
            {row.lastErrorCode ? ` · ${row.lastErrorCode}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {t("providers.health.modeLabel")}
            {" · "}
            {row.probeMode === "search"
              ? t("providers.health.mode.search")
              : t("providers.health.mode.connect")}
          </p>
        </div>

        <dl className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          <Metric label="P50" value={row.p50LatencyMs === null ? "—" : `${Math.round(row.p50LatencyMs)}ms`} />
          <Metric label="P95" value={row.p95LatencyMs === null ? "—" : `${Math.round(row.p95LatencyMs)}ms`} />
          <Metric
            label={t("providers.health.successRate")}
            value={row.successRate === null ? "—" : `${Math.round(row.successRate * 100)}%`}
          />
          <Metric label={t("providers.health.keys")} value={`${row.keyAvailable}/${row.keyTotal}`} />
        </dl>

        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheck(row.providerId, "connect")}>
            {t("providers.health.check")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title={t("providers.health.paidWarning")}
            onClick={() => onCheck(row.providerId, "search")}
          >
            {t("providers.health.mode.search")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
            {t("providers.health.history")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void api
                .setProviderAutoProbe(row.providerId, !row.autoProbeEnabled)
                .then(() => onChanged())
                .catch((error: unknown) => {
                  toast.error({
                    title: t("states.errorTitle"),
                    description: error instanceof Error ? error.message : String(error),
                  });
                });
            }}
          >
            {row.autoProbeEnabled
              ? t("providers.health.autoProbeOn")
              : t("providers.health.autoProbeOff")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setResetOpen(true)}>
            {t("providers.health.reset")}
          </Button>
        </div>
      </CardContent>

      <HistoryDialog
        open={historyOpen}
        providerId={row.providerId}
        providerName={row.providerName}
        onClose={() => setHistoryOpen(false)}
      />
      <ConfirmDialog
        open={resetOpen}
        title={t("providers.health.reset")}
        description={t("providers.health.resetConfirm")}
        confirmLabel={t("providers.health.reset")}
        onClose={() => setResetOpen(false)}
        onConfirm={async () => {
          try {
            await api.resetProviderHealth(row.providerId);
            toast.success({
              title: t("providers.health.resetDone", { name: row.providerName }),
            });
            setResetOpen(false);
            onChanged();
          } catch (error) {
            toast.error({
              title: t("states.errorTitle"),
              description: error instanceof Error ? error.message : String(error),
            });
          }
        }}
      />
    </Card>
  );
}

function HistoryDialog({
  open,
  providerId,
  providerName,
  onClose,
}: {
  open: boolean;
  providerId: string;
  providerName: string;
  onClose: () => void;
}) {
  const history = useAsyncData(
    (signal) =>
      open
        ? api.healthHistory(providerId, signal)
        : Promise.resolve({ checks: [] as HealthCheckResult[] }),
    [open, providerId],
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("providers.health.historyTitle", { name: providerName })}
      size="lg"
    >
      {history.loading && !history.data ? (
        <Skeleton className="h-48" />
      ) : history.data && history.data.checks.length > 0 ? (
        <Table minWidth="min-w-[640px]">
          <THead>
            <TR>
              <TH>{t("providers.health.historyTime")}</TH>
              <TH>{t("providers.health.historyKind")}</TH>
              <TH>{t("providers.health.historyStatus")}</TH>
              <TH>{t("providers.health.historyCause")}</TH>
              <TH>{t("providers.health.historyLatency")}</TH>
              <TH>{t("providers.health.historyResults")}</TH>
            </TR>
          </THead>
          <TBody>
            {history.data.checks.map((check) => (
              <TR key={check.id}>
                <TD className="whitespace-nowrap text-xs">{formatDateTime(check.checkedAt)}</TD>
                <TD className="text-xs">
                  {check.kind === "search"
                    ? t("providers.health.mode.search")
                    : t("providers.health.mode.connect")}
                </TD>
                <TD className="text-xs">{check.status}</TD>
                <TD className="text-xs">
                  <span className="font-mono">{check.cause}</span>
                  {check.message ? (
                    <span className="ml-1 text-muted-foreground">{check.message.slice(0, 80)}</span>
                  ) : null}
                </TD>
                <TD className="text-xs">{check.latencyMs === null ? "—" : `${check.latencyMs}ms`}</TD>
                <TD className="text-xs">{check.resultCount === null ? "—" : check.resultCount}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <EmptyState title={t("providers.health.historyEmpty")} />
      )}
    </Dialog>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[56px]">
      <dt className="text-[10px] uppercase tracking-wide opacity-70">{label}</dt>
      <dd className="font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function runtimeTone(runtime: RuntimeHealthValue): "success" | "warning" | "destructive" | "muted" {
  if (runtime === "healthy") return "success";
  if (runtime === "unhealthy" || runtime === "quota_exceeded" || runtime === "invalid_credentials") {
    return "destructive";
  }
  if (
    runtime === "degraded" ||
    runtime === "rate_limited" ||
    runtime === "permission_denied" ||
    runtime === "cooldown"
  ) {
    return "warning";
  }
  return "muted";
}

function runtimeLabel(runtime: RuntimeHealthValue): string {
  const map: Record<RuntimeHealthValue, string> = {
    unknown: t("providers.health.runtime.unknown"),
    healthy: t("providers.health.runtime.healthy"),
    degraded: t("providers.health.runtime.degraded"),
    unhealthy: t("providers.health.runtime.unhealthy"),
    rate_limited: t("providers.health.runtime.rate_limited"),
    quota_exceeded: t("providers.health.runtime.quota_exceeded"),
    invalid_credentials: t("providers.health.runtime.invalid_credentials"),
    permission_denied: t("providers.health.runtime.permission_denied"),
    cooldown: t("providers.health.runtime.cooldown"),
    unverified: t("providers.health.runtime.unverified"),
    disabled: t("providers.health.runtime.disabled"),
  };
  return map[runtime];
}

function verificationLabel(verification: VerificationValue): string {
  const map: Record<VerificationValue, string> = {
    documented: t("providers.health.verify.documented"),
    live_tested: t("providers.health.verify.live_tested"),
    mock_verified: t("providers.health.verify.mock_verified"),
    unverified: t("providers.health.verify.unverified"),
    no_official_api: t("providers.health.verify.no_official_api"),
  };
  return `${t("providers.health.implementation")}: ${map[verification]}`;
}
