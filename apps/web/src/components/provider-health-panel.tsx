import { Badge, Button, Card, CardContent, EmptyState, Skeleton } from "../components/ui";
import { t } from "../lib/i18n";
import { formatDateTime, formatNumber } from "../lib/format";
import type { HealthOverview, HealthStatusValue, ProviderHealthRow } from "../lib/types";

/**
 * Provider health panel.
 *
 * Two things this panel must never do:
 * - show "healthy" for a source that was never probed (that is `unverified`)
 * - hide that a paid probe costs money: the button says so before you press it
 */
export function ProviderHealthPanel({
  overview,
  loading,
  error,
  onCheckAll,
  onCheckOne,
  busy,
}: {
  overview: HealthOverview | null;
  loading: boolean;
  error: string | null;
  onCheckAll: (kind: "connect" | "search") => void;
  onCheckOne: (providerId: string, kind: "connect" | "search") => void;
  busy: boolean;
}) {
  if (error) {
    return <EmptyState title={t("providers.health.error")} description={error} />;
  }
  if (loading && !overview) return <Skeleton className="h-64" />;
  if (!overview) return <EmptyState title={t("providers.health.empty")} />;

  const budget = overview.budget;
  const totals = overview.totals;

  return (
    <section className="space-y-4" aria-label={t("providers.health.title")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t("providers.health.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("providers.health.desc")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheckAll("connect")}>
            {t("providers.health.checkConnect")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !budget.paidProbesEnabled || budget.remainingToday <= 0}
            onClick={() => onCheckAll("search")}
            title={
              budget.paidProbesEnabled
                ? t("providers.health.paidHint", {
                    used: budget.usedToday,
                    max: budget.maxPerDay,
                  })
                : t("providers.health.paidDisabled")
            }
          >
            {t("providers.health.checkSearch")}
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Summary label={t("providers.health.totalHealthy")} value={totals.healthy} tone="success" />
        <Summary label={t("providers.health.totalDegraded")} value={totals.degraded} tone="warning" />
        <Summary label={t("providers.health.totalUnhealthy")} value={totals.unhealthy} tone="destructive" />
        {/* Unverified is a first-class state: no probe means no claim. */}
        <Summary label={t("providers.health.totalUnverified")} value={totals.unverified} tone="muted" />
      </div>

      <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t("providers.health.budget", {
          used: budget.usedToday,
          max: budget.maxPerDay,
          perRun: budget.maxPerRun,
          scheduled: budget.scheduledEnabled
            ? t("providers.health.scheduledOn")
            : t("providers.health.scheduledOff"),
        })}
      </div>

      {overview.providers.length === 0 ? (
        <EmptyState title={t("providers.health.empty")} />
      ) : (
        <div className="grid gap-2">
          {overview.providers.map((row) => (
            <HealthRow key={row.providerId} row={row} busy={busy} onCheck={onCheckOne} />
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

function HealthRow({
  row,
  busy,
  onCheck,
}: {
  row: ProviderHealthRow;
  busy: boolean;
  onCheck: (providerId: string, kind: "connect" | "search") => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{row.providerName}</span>
            <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
            {row.enabled ? null : <Badge tone="muted">{t("providers.health.disabled")}</Badge>}
            {row.lastProbe?.kind === "connect" ? (
              <span className="text-[10px] text-muted-foreground">{t("providers.health.connectOnly")}</span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {row.lastCheckedAt
              ? t("providers.health.lastChecked", { at: formatDateTime(row.lastCheckedAt) })
              : t("providers.health.neverChecked")}
            {row.lastErrorCode ? ` · ${row.lastErrorCode}` : ""}
          </p>
        </div>

        <dl className="flex flex-wrap gap-4 text-[11px] text-muted-foreground">
          <Metric label="P50" value={row.p50LatencyMs === null ? "—" : `${Math.round(row.p50LatencyMs)}ms`} />
          <Metric label="P95" value={row.p95LatencyMs === null ? "—" : `${Math.round(row.p95LatencyMs)}ms`} />
          <Metric
            label={t("providers.health.successRate")}
            value={row.successRate === null ? "—" : `${Math.round(row.successRate * 100)}%`}
          />
          <Metric
            label={t("providers.health.keys")}
            value={`${row.keyAvailable}/${row.keyTotal}`}
          />
        </dl>

        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onCheck(row.providerId, "connect")}>
            {t("providers.health.check")}
          </Button>
        </div>
      </CardContent>
    </Card>
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

function statusTone(status: HealthStatusValue): "success" | "warning" | "destructive" | "muted" {
  if (status === "healthy") return "success";
  if (status === "degraded") return "warning";
  if (status === "unhealthy") return "destructive";
  return "muted";
}

function statusLabel(status: HealthStatusValue): string {
  const map: Record<HealthStatusValue, string> = {
    healthy: t("providers.health.status.healthy"),
    degraded: t("providers.health.status.degraded"),
    unhealthy: t("providers.health.status.unhealthy"),
    unverified: t("providers.health.status.unverified"),
  };
  return map[status];
}
