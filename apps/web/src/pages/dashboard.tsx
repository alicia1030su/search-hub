import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Clock3,
  Cpu,
  Gauge,
  KeyRound,
  RefreshCw,
  Search,
  Server,
  TrendingUp,
} from "lucide-react";
import { api } from "../lib/api";
import { formatDateTime, formatMs, formatNumber, formatPercent, formatRange } from "../lib/format";
import { useAsyncData, useDocumentTitle } from "../lib/hooks";
import { keyStatusLabel, t } from "../lib/i18n";
import { dashboardKeySegments } from "../lib/dashboard-key-segments";
import type { HealthOverview } from "../lib/types";
import { StackedBar, TimelineChart } from "../components/charts";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";
import { Segmented } from "../components/tabs";
import { ResourceMonitorPanel } from "../components/resource-monitor";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Skeleton,
} from "../components/ui";

type Range = "1h" | "24h" | "7d" | "30d";

const ranges: Array<{ value: Range; label: string }> = [
  { value: "1h", label: t("range.1h") },
  { value: "24h", label: t("range.24h") },
  { value: "7d", label: t("range.7d") },
  { value: "30d", label: t("range.30d") },
];

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Activity;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-3.5" aria-hidden />
          </span>
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
        {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  useDocumentTitle(t("dashboard.title"));
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>("24h");
  const { data, error, loading, reload } = useAsyncData(
    (signal) => api.dashboard(range, signal),
    [range],
  );
  // The dashboard is where a fresh install lands, so it must say "you have no
  // search source yet" instead of showing empty charts with no next step.
  const providers = useAsyncData((signal) => api.providers(signal), []);
  // Source health is its own resource: it changes on the probe schedule, not on
  // the dashboard range, so reloading the range must not refetch it.
  const health = useAsyncData((signal) => api.healthOverview(signal), []);

  const hasSearches = (data?.totals.searches ?? 0) > 0;
  const keySegments = data ? dashboardKeySegments(data.keys, keyStatusLabel) : [];

  const providerList = providers.data?.providers ?? [];
  const enabledCount = providerList.filter((item) => item.ready).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.subtitle")}
        meta={
          data ? (
            <span>
              {formatRange(data.range.from, data.range.to)} · {t("dashboard.metric.resultCount")}{" "}
              {formatNumber(data.totals.resultCount)}
            </span>
          ) : null
        }
        actions={
          <>
            <Segmented items={ranges} value={range} onChange={setRange} ariaLabel={t("dashboard.title")} />
            <Button variant="outline" size="sm" onClick={reload} disabled={loading}>
              <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden />
              {t("common.refresh")}
            </Button>
          </>
        }
      />

      {error ? (
        <Alert
          tone="error"
          title={t("states.errorTitle")}
          action={
            <Button size="sm" variant="outline" onClick={reload}>
              {t("common.retry")}
            </Button>
          }
        >
          <p className="font-mono">{error.code}</p>
          <p>{error.message}</p>
        </Alert>
      ) : null}

      {providers.data && enabledCount === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {providerList.length === 0 ? t("dashboard.onboard.empty") : t("dashboard.onboard.notEnabled")}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {providerList.length === 0
                  ? t("dashboard.onboard.emptyHint")
                  : t("dashboard.onboard.notEnabledHint", { count: providerList.length })}
              </p>
            </div>
            <Button size="sm" onClick={() => navigate(providerList.length === 0 ? "/providers" : "/providers")}>
              {providerList.length === 0 ? t("dashboard.onboard.cta") : t("dashboard.onboard.manage")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {!data && loading ? (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-[104px]" />
            ))}
          </div>
          <Skeleton className="h-72" />
          <Skeleton className="h-64" />
        </div>
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label={t("dashboard.metric.searches")}
              value={formatNumber(data.totals.searches)}
              hint={t("dashboard.metric.resultCount") + " " + formatNumber(data.totals.resultCount)}
              icon={Search}
            />
            <MetricCard
              label={t("dashboard.metric.successRate")}
              value={formatPercent(data.totals.successRate)}
              hint={t("dashboard.metric.successHint", {
                partial: formatNumber(data.totals.partial ?? 0),
                failed: formatNumber(data.totals.failed ?? 0),
                cancelled: formatNumber(data.totals.cancelled ?? 0),
              })}
              icon={TrendingUp}
            />
            <MetricCard
              label={t("dashboard.metric.avgLatency")}
              value={formatMs(data.totals.avgLatencyMs)}
              icon={Gauge}
            />
            <MetricCard
              label={t("dashboard.metric.concurrency")}
              value={formatNumber(data.currentConcurrency)}
              hint={t("dashboard.metric.concurrencyHint")}
              icon={Activity}
            />
          </div>

          <ResourceMonitorPanel />

          <HealthSummary data={health.data} loading={health.loading} />

          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t("dashboard.timeline.title")}</CardTitle>
                <CardDescription>{t("dashboard.timeline.desc")}</CardDescription>
              </div>
              <Badge tone="outline">{formatRange(data.range.from, data.range.to)}</Badge>
            </CardHeader>
            <CardContent>
              {hasSearches ? (
                <TimelineChart
                  points={data.timeline}
                  labels={{
                    searches: t("dashboard.timeline.searches"),
                    errors: t("dashboard.timeline.errors"),
                    latency: t("dashboard.timeline.latency"),
                  }}
                />
              ) : (
                <EmptyState
                  icon={Clock3}
                  title={t("dashboard.timeline.empty")}
                  description={t("states.emptyDesc")}
                  className="py-8"
                />
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader>
                <div>
                  <CardTitle>{t("dashboard.providers.title")}</CardTitle>
                  <CardDescription>{t("dashboard.providers.desc")}</CardDescription>
                </div>
                <Button variant="ghost" size="sm" onClick={() => navigate("/providers")}>
                  {t("dashboard.viewProviders")}
                  <ArrowRight aria-hidden />
                </Button>
              </CardHeader>
              <CardContent className="p-0 sm:p-0">
                {data.providers.length === 0 ? (
                  <div className="p-4">
                    <EmptyState
                      icon={Server}
                      title={t("dashboard.providers.empty")}
                      action={
                        <Button size="sm" onClick={() => navigate("/providers")}>
                          {t("providers.add")}
                        </Button>
                      }
                    />
                  </div>
                ) : (
                  <Table minWidth="min-w-[640px]" className="rounded-none border-0 sm:table">
                    <THead>
                      <tr>
                        <TH>{t("lab.result.provider")}</TH>
                        <TH className="text-right">{t("dashboard.providers.calls")}</TH>
                        <TH className="text-right">{t("common.errors")}</TH>
                        <TH className="text-right">{t("dashboard.providers.errorRate")}</TH>
                        <TH className="text-right">{t("common.latency")}</TH>
                        <TH />
                      </tr>
                    </THead>
                    <TBody>
                      {data.providers.map((provider) => (
                        <TR
                          key={provider.providerId}
                          onClick={() => navigate(`/providers?focus=${encodeURIComponent(provider.providerId)}`)}
                        >
                          <TD>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{provider.providerName}</span>
                              <Badge tone={provider.enabled ? "outline" : "muted"}>
                                {provider.enabled ? t("common.enabled") : t("common.disabled")}
                              </Badge>
                            </div>
                            <p className="text-[11px] text-muted-foreground">{provider.providerType}</p>
                          </TD>
                          <TD className="text-right font-mono tabular-nums">{formatNumber(provider.calls)}</TD>
                          <TD className="text-right font-mono tabular-nums">{formatNumber(provider.errors)}</TD>
                          <TD className="text-right font-mono tabular-nums">
                            {provider.calls === 0 ? (
                              <span className="text-muted-foreground">{t("dashboard.providers.emptyError")}</span>
                            ) : (
                              <span className={provider.errorRate > 0.2 ? "text-destructive" : undefined}>
                                {formatPercent(provider.errorRate)}
                              </span>
                            )}
                          </TD>
                          <TD className="text-right font-mono tabular-nums">{formatMs(provider.avgLatencyMs)}</TD>
                          <TD className="w-6 text-right text-muted-foreground">
                            <ArrowRight className="ml-auto size-3.5" aria-hidden />
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>{t("dashboard.keys.title")}</CardTitle>
                    <CardDescription>{t("dashboard.keys.desc")}</CardDescription>
                  </div>
                  <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                </CardHeader>
                <CardContent className="space-y-3">
                  {data.keys.total === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("dashboard.keys.empty")}</p>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs text-muted-foreground">{t("dashboard.keys.total")}</span>
                        <span className="text-lg font-semibold tabular-nums">{formatNumber(data.keys.total)}</span>
                      </div>
                      <StackedBar segments={keySegments} />
                      <ul className="grid grid-cols-2 gap-1.5 text-[11px]">
                        {keySegments.map((segment) => (
                          <li key={segment.label} className="flex items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                              <span className={`size-1.5 rounded-full ${segment.className}`} aria-hidden />
                              {segment.label}
                            </span>
                            <span className="font-mono tabular-nums">{segment.value}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <Button variant="outline" size="sm" className="w-full" onClick={() => navigate("/providers")}>
                    {t("providers.list.keys")}
                    <ArrowRight aria-hidden />
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>{t("dashboard.models.title")}</CardTitle>
                    <CardDescription>{t("dashboard.models.desc")}</CardDescription>
                  </div>
                  <Cpu className="size-4 text-muted-foreground" aria-hidden />
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-muted-foreground">{t("dashboard.models.total")}</span>
                    <span className="text-lg font-semibold tabular-nums">{formatNumber(data.models.total)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {(
                      [
                        ["dashboard.models.chat", data.models.chat],
                        ["dashboard.models.embedding", data.models.embedding],
                        ["dashboard.models.rerank", data.models.rerank],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="rounded-md border bg-muted/25 px-2 py-1.5">
                        <p className="text-[10px] text-muted-foreground">{t(label)}</p>
                        <p className="font-mono text-sm tabular-nums">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{t("dashboard.models.enabled")}</span>
                    <span className="font-mono">{data.models.enabled}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{t("dashboard.models.calls")}</span>
                    <span className="font-mono">{formatNumber(data.models.calls)}</span>
                  </div>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => navigate("/models")}>
                    {t("dashboard.viewModels")}
                    <ArrowRight aria-hidden />
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Live source health, on the dashboard.
 *
 * Shows the aggregate counts plus one row per source with the last check time,
 * P50 latency, success rate and error code — the same data the 健康监控 tab and
 * the MCP tool expose, so an operator never sees two different answers.
 */
function HealthSummary({
  data,
  loading,
}: {
  data: HealthOverview | null;
  loading: boolean;
}) {
  if (loading && !data) return <Skeleton className="h-40" />;
  if (!data) return null;
  const totals = data.totals;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("dashboard.health.title")}</CardTitle>
          <CardDescription>{t("dashboard.health.desc")}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="success">{t("providers.health.status.healthy")} {totals.healthy}</Badge>
          <Badge tone="warning">{t("providers.health.status.degraded")} {totals.degraded}</Badge>
          <Badge tone="destructive">{t("providers.health.status.unhealthy")} {totals.unhealthy}</Badge>
          <Badge tone="muted">{t("providers.health.status.unverified")} {totals.unverified}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {data.providers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard.health.empty")}</p>
        ) : (
          <div className="space-y-1.5">
            {data.providers.slice(0, 8).map((provider) => (
              <div
                key={provider.providerId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{provider.providerName}</span>
                <Badge
                  tone={
                    provider.status === "healthy"
                      ? "success"
                      : provider.status === "degraded"
                        ? "warning"
                        : provider.status === "unhealthy"
                          ? "destructive"
                          : "muted"
                  }
                >
                  {provider.status}
                </Badge>
                <span className="text-muted-foreground">
                  {provider.lastCheckedAt ? formatDateTime(provider.lastCheckedAt) : t("dashboard.health.never")}
                </span>
                <span className="font-mono text-muted-foreground">
                  {provider.p50LatencyMs === null ? "—" : `${Math.round(provider.p50LatencyMs)}ms`}
                </span>
                <span className="font-mono text-muted-foreground">
                  {provider.successRate === null ? "—" : `${Math.round(provider.successRate * 100)}%`}
                </span>
                {provider.lastErrorCode ? (
                  <span className="font-mono text-destructive">{provider.lastErrorCode}</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
