import { Activity, Clock3, Database, RefreshCw, Server } from "lucide-react";
import { api } from "../lib/api";
import { formatBytes, formatDateTime, formatNumber, formatUptime } from "../lib/format";
import { useAsyncData } from "../lib/hooks";
import { t } from "../lib/i18n";
import type { RuntimeResourceSnapshot } from "../lib/types";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "./ui";

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-muted/20 p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function reasonFor(data: RuntimeResourceSnapshot, field: string, fallback: string | null = null): string | null {
  return data.unavailable.find((item) => item.field === field)?.reason ?? fallback;
}

function nullable(value: number | null, formatter: (value: number) => string, reason: string | null): { value: string; hint?: string } {
  return value === null ? { value: "—", hint: reason ?? t("resources.unavailable") } : { value: formatter(value) };
}

export function ResourceMonitorPanel() {
  const { data, error, loading, reload } = useAsyncData((signal) => api.resources(signal), []);

  return (
    <Card aria-labelledby="resources-title">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle><span id="resources-title">{t("resources.title")}</span></CardTitle>
          <CardDescription>{t("resources.description")}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && error ? <Badge tone="warning">{t("resources.stale")}</Badge> : null}
          <Button variant="outline" size="sm" onClick={reload} disabled={loading} aria-label={t("resources.refresh")}>
            <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden />
            {t("common.refresh")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert tone="error" title={t("resources.errorTitle")}>
            <p>{error.message}</p>
          </Alert>
        ) : null}
        {!data && loading ? <Skeleton className="h-48" /> : null}
        {data ? (
          <div className="space-y-4" aria-busy={loading}>
            <section aria-labelledby="resources-process">
              <h3 id="resources-process" className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Server className="size-4 text-muted-foreground" aria-hidden /> {t("resources.process")}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <Metric label={t("resources.rss")} {...nullable(data.process.memory.rssBytes, formatBytes, reasonFor(data, "process.memory.rssBytes"))} />
                <Metric
                  label={t("resources.heap")}
                  {...nullable(data.process.memory.heapUsedBytes, formatBytes, reasonFor(data, "process.memory.heapUsedBytes"))}
                  hint={data.process.memory.heapTotalBytes === null ? (reasonFor(data, "process.memory.heapTotalBytes") ?? undefined) : `${t("resources.total")} ${formatBytes(data.process.memory.heapTotalBytes)}`}
                />
                <Metric label={t("resources.external")} {...nullable(data.process.memory.externalBytes, formatBytes, reasonFor(data, "process.memory.externalBytes"))} />
                <Metric label={t("resources.arrayBuffers")} {...nullable(data.process.memory.arrayBuffersBytes, formatBytes, reasonFor(data, "process.memory.arrayBuffersBytes"))} />
                <Metric label={t("resources.uptime")} value={formatUptime(data.process.uptimeSeconds)} hint={`${data.process.platform} · ${data.process.nodeVersion}`} />
                <Metric label={t("resources.sampledAt")} value={formatDateTime(data.sampledAt)} />
              </div>
            </section>

            <section aria-labelledby="resources-activity">
              <h3 id="resources-activity" className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Activity className="size-4 text-muted-foreground" aria-hidden /> {t("resources.activity")}
              </h3>
              <div className="grid gap-2 sm:grid-cols-3">
                <Metric label={t("resources.activeSearches")} value={formatNumber(data.activity.activeSearches)} />
                <Metric label={t("resources.activeProbes")} value={formatNumber(data.activity.activeProbes)} />
                <Metric
                  label={t("resources.queue")}
                  value={formatNumber(data.activity.queue.total)}
                  hint={`${t("resources.providerKey")} ${data.activity.queue.providerKey} · ${t("resources.health")} ${data.activity.queue.health} · ${t("resources.followers")} ${data.activity.queue.singleflightFollowers}`}
                />
              </div>
            </section>

            <section aria-labelledby="resources-cache">
              <h3 id="resources-cache" className="mb-2 flex items-center gap-2 text-sm font-medium">
                <Database className="size-4 text-muted-foreground" aria-hidden /> {t("resources.cache")}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <Metric label={t("resources.entries")} {...nullable(data.cache.entries, formatNumber, reasonFor(data, "cache.totals", data.cache.totalsReason))} />
                <Metric label={t("resources.logicalBytes")} {...nullable(data.cache.bytes, formatBytes, reasonFor(data, "cache.totals", data.cache.totalsReason))} />
                <Metric label={t("resources.dbFile")} {...nullable(data.cache.dbFileBytes, formatBytes, reasonFor(data, "cache.dbFileBytes"))} hint={data.cache.diskScope} />
                <Metric label={t("resources.walFile")} {...nullable(data.cache.walFileBytes, formatBytes, reasonFor(data, "cache.walFileBytes"))} hint={data.cache.diskScope} />
                <Metric label={t("resources.totalsUpdatedAt")} value={data.cache.totalsUpdatedAt ? formatDateTime(data.cache.totalsUpdatedAt) : "—"} hint={data.cache.totalsReason ?? data.cache.totalsSource} />
                <Metric label={t("resources.diskScope")} value={t("resources.wholeDatabase")} hint={`${data.cache.dbFileSource} · ${data.cache.walFileSource}`} />
              </div>
            </section>
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock3 className="size-3" aria-hidden /> {t("resources.manualOnly")}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
