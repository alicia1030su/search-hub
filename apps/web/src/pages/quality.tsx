import { useState } from "react";
import {
  BarChart3,
  Database,
  Download,
  GitCompare,
  History,
  Plus,
  Snowflake,
  Upload,
} from "lucide-react";
import { api, toApiError, type ApiError } from "../lib/api";
import {
  downloadJson,
  formatDateTime,
  formatMs,
  formatPercent,
  timestampSlug,
} from "../lib/format";
import { useAsyncData, useDocumentTitle } from "../lib/hooks";
import { t } from "../lib/i18n";
import type {
  QualityComparison,
  QualityDatasetDetail,
  QualityDatasetSummary,
  QualityFusionStrategy,
  QualityMetricValue,
  QualityRunDetail,
  QualityRunSummary,
  QualitySweepResult,
  ProviderSummary,
} from "../lib/types";
import { Table, TBody, TD, TH, THead, TR } from "../components/table";
import { Tabs } from "../components/tabs";
import { useToast } from "../components/toast";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SectionHeader,
  Select,
  Skeleton,
  Textarea,
} from "../components/ui";

type Tab = "datasets" | "runs" | "compare" | "history";

const strategies: QualityFusionStrategy[] = ["rrf", "base", "single"];

/** Renders a metric, and says why it is N/A rather than printing 0. */
function MetricText({ metric, digits = 4 }: { metric: QualityMetricValue | undefined; digits?: number }) {
  if (!metric) return <span className="text-muted-foreground">—</span>;
  if (metric.status === "na") {
    const key = `quality.metric.na.${metric.reason ?? "not_applicable"}`;
    return (
      <span className="text-muted-foreground" title={t(key as never)}>
        {t("quality.metric.na")}
      </span>
    );
  }
  return <span className="font-mono tabular-nums">{metric.value?.toFixed(digits)}</span>;
}

function MetricCard({
  label,
  metric,
  digits = 4,
}: {
  label: string;
  metric: QualityMetricValue | undefined;
  digits?: number;
}) {
  const na = !metric || metric.status === "na";
  return (
    <Card>
      <CardContent className="space-y-1 p-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        {na ? (
          <p className="text-sm text-muted-foreground">
            {t(`quality.metric.na.${(metric?.reason ?? "not_applicable") as never}`)}
          </p>
        ) : (
          <p className="font-mono text-xl font-semibold tabular-nums">{metric!.value?.toFixed(digits)}</p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {metric && metric.status === "ok" ? t("quality.metric.sample", { count: metric.sampleSize }) : ""}
          {metric && metric.lowSample ? ` · ${t("quality.metric.lowSample")}` : ""}
        </p>
        {metric && metric.provisionalCount > 0 ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-500">
            {t("quality.metric.provisional", { count: metric.provisionalCount })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function originBadge(origin: QualityDatasetSummary["origin"]) {
  if (origin === "synthetic_fixture") {
    return <Badge tone="warning">{t("quality.origin.synthetic")}</Badge>;
  }
  return <Badge tone="muted">{t(origin === "imported" ? "quality.origin.imported" : "quality.origin.manual")}</Badge>;
}

function statusBadge(status: QualityRunSummary["status"]) {
  if (status === "completed") return <Badge tone="success">{t("quality.run.status.completed")}</Badge>;
  if (status === "running") return <Badge tone="info">{t("quality.run.status.running")}</Badge>;
  if (status === "cancelled") return <Badge tone="warning">{t("quality.run.status.cancelled")}</Badge>;
  return <Badge tone="destructive">{t("quality.run.status.failed")}</Badge>;
}

export function QualityPage() {
  useDocumentTitle(t("quality.title"));
  const [tab, setTab] = useState<Tab>("datasets");
  const toast = useToast();

  const datasets = useAsyncData((signal) => api.qualityDatasets(signal), []);
  const runs = useAsyncData((signal) => api.qualityRuns({ limit: 100 }, signal), []);

  const reloadAll = () => {
    datasets.reload();
    runs.reload();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("quality.title")}
        description={t("quality.subtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={reloadAll}>
            <History aria-hidden />
            {t("common.refresh")}
          </Button>
        }
      />

      <Tabs
        value={tab}
        onChange={(next) => setTab(next)}
        ariaLabel={t("quality.title")}
        items={[
          { value: "datasets", label: t("quality.tab.datasets"), count: datasets.data?.datasets.length },
          { value: "runs", label: t("quality.tab.runs"), count: runs.data?.runs.length },
          { value: "compare", label: t("quality.tab.compare") },
          { value: "history", label: t("quality.tab.history") },
        ]}
      />

      {tab === "datasets" ? (
        <DatasetsTab
          datasets={datasets.data?.datasets ?? null}
          loading={datasets.loading}
          error={datasets.error}
          onChanged={reloadAll}
        />
      ) : null}

      {tab === "runs" ? (
        <RunsTab
          runs={runs.data?.runs ?? null}
          loading={runs.loading}
          error={runs.error}
          onChanged={reloadAll}
          notify={(message) => toast.success({ title: message })}
        />
      ) : null}

      {tab === "compare" ? (
        <CompareTab runs={runs.data?.runs ?? []} />
      ) : null}

      {tab === "history" ? <HistoryTab runs={runs.data?.runs ?? []} /> : null}
    </div>
  );
}

// --------------------------------------------------------------------- datasets

function DatasetsTab({
  datasets,
  loading,
  error,
  onChanged,
}: {
  datasets: QualityDatasetSummary[] | null;
  loading: boolean;
  error: ApiError | null;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const active = selected ?? datasets?.[0]?.id ?? null;

  async function run(action: () => Promise<unknown>, okMessage: string) {
    setBusy(true);
    try {
      await action();
      onChanged();
      return okMessage;
    } catch (caught) {
      throw toApiError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>{t("quality.tab.datasets")}</CardTitle>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" onClick={() => setImportOpen((value) => !value)} title={t("quality.dataset.import")}>
              <Upload aria-hidden />
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setCreating((value) => !value)} title={t("quality.dataset.create")}>
              <Plus aria-hidden />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && !datasets ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : null}
          {error ? <Alert tone="error">{error.message}</Alert> : null}

          {creating ? (
            <div className="space-y-2 rounded-md border p-2.5">
              <Field label={t("quality.dataset.name")}>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="internal-qrels" />
              </Field>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  disabled={!name.trim() || busy}
                  onClick={() => {
                    void run(async () => {
                      const created = await api.createQualityDataset({ name: name.trim() });
                      setSelected(created.dataset.id);
                      setName("");
                      setCreating(false);
                    }, "created").catch(() => undefined);
                  }}
                >
                  {t("common.create")}
                </Button>
              </div>
            </div>
          ) : null}

          {importOpen ? (
            <div className="space-y-2 rounded-md border p-2.5">
              <p className="text-[11px] text-muted-foreground">{t("quality.dataset.importHint")}</p>
              <Textarea
                rows={6}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder='{"queries":[{"query":"...","judgments":[]}]}'
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setImportOpen(false)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  disabled={!importText.trim() || busy}
                  onClick={() => {
                    void run(async () => {
                      const parsed = JSON.parse(importText) as Record<string, unknown>;
                      const imported = await api.importQualityDataset(parsed);
                      setSelected(imported.dataset.id);
                      setImportText("");
                      setImportOpen(false);
                    }, "imported");
                  }}
                >
                  {t("common.import")}
                </Button>
              </div>
            </div>
          ) : null}

          {datasets && datasets.length === 0 ? (
            <EmptyState icon={Database} title={t("quality.dataset.empty")} />
          ) : null}

          <ul className="space-y-1">
            {(datasets ?? []).map((dataset) => (
              <li key={dataset.id}>
                <button
                  type="button"
                  onClick={() => setSelected(dataset.id)}
                  className={
                    "w-full rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-muted/60 " +
                    (active === dataset.id ? "border-primary/60 bg-muted/60" : "border-transparent")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{dataset.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">v{dataset.version}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    {originBadge(dataset.origin)}
                    <span className="text-[10px] text-muted-foreground">
                      {dataset.queryCount} / {dataset.judgmentCount}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {active ? (
        <DatasetDetail datasetId={active} onChanged={onChanged} />
      ) : (
        <Card>
          <CardContent className="p-6">
            <EmptyState icon={Database} title={t("quality.dataset.empty")} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DatasetDetail({ datasetId, onChanged }: { datasetId: string; onChanged: () => void }) {
  const detail = useAsyncData((signal) => api.qualityDataset(datasetId, signal), [datasetId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryText, setQueryText] = useState("");
  const [bulk, setBulk] = useState("");
  const [judgeQuery, setJudgeQuery] = useState("");
  const [judgeUrl, setJudgeUrl] = useState("");
  const [judgeGrade, setJudgeGrade] = useState("2");

  const data: QualityDatasetDetail | null = detail.data;
  const frozen = data?.dataset.status === "frozen";

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      detail.reload();
      onChanged();
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  if (detail.loading && !data) return <Skeleton className="h-64 w-full" />;
  if (detail.error) return <Alert tone="error">{detail.error.message}</Alert>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              {data.dataset.name}
              <Badge tone={frozen ? "info" : "muted"}>
                {t(frozen ? "quality.status.frozen" : "quality.status.draft")}
              </Badge>
              {originBadge(data.dataset.origin)}
            </CardTitle>
            <CardDescription>{data.dataset.description || "—"}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void act(() => api.exportQualityDataset(datasetId).then((payload) => downloadJson(`quality-${datasetId}-${timestampSlug()}.json`, payload)))}>
              <Download aria-hidden />
              {t("quality.dataset.export")}
            </Button>
            {frozen ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api.forkQualityDataset(datasetId))}>
                <GitCompare aria-hidden />
                {t("quality.dataset.fork")}
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void act(() => api.freezeQualityDataset(datasetId))}>
                <Snowflake aria-hidden />
                {t("quality.dataset.freeze")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.dataset.origin === "synthetic_fixture" ? (
            <Alert tone="warning">{t("quality.synthetic.warning")}</Alert>
          ) : null}
          {frozen ? <p className="text-xs text-muted-foreground">{t("quality.dataset.frozenHint")}</p> : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border p-2.5">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t("quality.dataset.version")}</p>
              <p className="font-mono text-sm">v{data.dataset.version}</p>
            </div>
            <div className="rounded-md border p-2.5">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t("quality.dataset.queries")}</p>
              <p className="font-mono text-sm">{data.coverage.queryCount}</p>
            </div>
            <div className="rounded-md border p-2.5">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t("quality.dataset.judgments")}</p>
              <p className="font-mono text-sm">{data.coverage.judgedDocuments}</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              {t("quality.dataset.coverageValue", {
                judged: String(data.coverage.judgedQueries),
                total: String(data.coverage.queryCount),
              })}
            </p>
            {data.coverage.unjudgedQueries > 0 ? (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t("quality.dataset.unjudgedQueries", { count: data.coverage.unjudgedQueries })}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {!frozen ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("quality.queries.add")}</CardTitle>
            <CardDescription>{t("quality.judgments.unjudgedNote")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-48 flex-1"
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder="typescript satisfies operator"
              />
              <Button
                size="sm"
                disabled={!queryText.trim() || busy}
                onClick={() =>
                  void act(async () => {
                    await api.addQualityQueries(datasetId, [{ query: queryText.trim() }]);
                    setQueryText("");
                  })
                }
              >
                <Plus aria-hidden />
                {t("common.add")}
              </Button>
            </div>
            <Field label={t("quality.queries.bulk")}>
              <Textarea rows={3} value={bulk} onChange={(event) => setBulk(event.target.value)} placeholder={"query one\nquery two"} />
            </Field>
            <Button
              size="sm"
              variant="outline"
              disabled={!bulk.trim() || busy}
              onClick={() =>
                void act(async () => {
                  const queries = bulk
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((query) => ({ query }));
                  await api.addQualityQueries(datasetId, queries);
                  setBulk("");
                })
              }
            >
              {t("quality.queries.add")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {data.queries.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("quality.judgments.title")}</CardTitle>
            <CardDescription>{t("quality.judgments.unjudgedNote")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!frozen ? (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_160px_auto]">
                <Select value={judgeQuery} onChange={(event) => setJudgeQuery(event.target.value)}>
                  <option value="">—</option>
                  {data.queries.map((query) => (
                    <option key={query.id} value={query.id}>
                      {query.query}
                    </option>
                  ))}
                </Select>
                <Input value={judgeUrl} onChange={(event) => setJudgeUrl(event.target.value)} placeholder="https://…" />
                <Select value={judgeGrade} onChange={(event) => setJudgeGrade(event.target.value)}>
                  {[0, 1, 2, 3].map((grade) => (
                    <option key={grade} value={String(grade)}>
                      {t(`quality.judgments.grade${grade}` as never)}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  disabled={!judgeQuery || !judgeUrl.trim() || busy}
                  onClick={() =>
                    void act(async () => {
                      await api.judgeQuality(datasetId, [
                        { queryId: judgeQuery, url: judgeUrl.trim(), relevance: Number(judgeGrade) },
                      ]);
                      setJudgeUrl("");
                    })
                  }
                >
                  {t("quality.judgments.add")}
                </Button>
              </div>
            ) : null}

            <div className="max-h-72 overflow-auto rounded-md border">
              <Table>
                <THead>
                  <TR>
                    <TH>{t("quality.dataset.queries")}</TH>
                    <TH>{t("quality.queries.category")}</TH>
                    <TH className="text-right">{t("quality.dataset.judgments")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.queries.map((query) => {
                    const count = data.judgments.filter((judgment) => judgment.queryId === query.id).length;
                    return (
                      <TR key={query.id}>
                        <TD className="max-w-96 truncate">{query.query}</TD>
                        <TD className="text-xs text-muted-foreground">{query.category}</TD>
                        <TD className="text-right font-mono text-xs">
                          {count === 0 ? (
                            <span className="text-amber-600 dark:text-amber-500">0</span>
                          ) : (
                            count
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------ runs

function RunsTab({
  runs,
  loading,
  error,
  onChanged,
  notify,
}: {
  runs: QualityRunSummary[] | null;
  loading: boolean;
  error: ApiError | null;
  onChanged: () => void;
  notify: (message: string) => void;
}) {
  const datasets = useAsyncData((signal) => api.qualityDatasets(signal), []);
  const providers = useAsyncData((signal) => api.providers(signal), []);
  const [datasetId, setDatasetId] = useState("");
  const [mode, setMode] = useState<"offline" | "live">("offline");
  const [strategy, setStrategy] = useState<QualityFusionStrategy>("rrf");
  const [k, setK] = useState("60");
  const [providerForSingle, setProviderForSingle] = useState("");
  const [limit, setLimit] = useState("10");
  const [cutoff, setCutoff] = useState("10");
  const [budget, setBudget] = useState("100");
  const [confirmPaid, setConfirmPaid] = useState(false);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [snapshotRunId, setSnapshotRunId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const effectiveDataset = datasetId || datasets.data?.datasets[0]?.id || "";
  const frozenDatasets = (datasets.data?.datasets ?? []).filter((item) => item.status === "frozen");
  const snapshotCandidates = (runs ?? []).filter(
    (run) => run.status === "completed" && run.datasetId === effectiveDataset,
  );

  async function start() {
    setBusy(true);
    setFormError(null);
    try {
      const created = await api.createQualityRun({
        datasetId: effectiveDataset,
        mode,
        name: name.trim(),
        fusion: {
          strategy,
          ...(strategy === "rrf" ? { k: Number(k) || 60 } : {}),
          ...(strategy === "single" ? { providerId: providerForSingle } : {}),
        },
        limit: Number(limit) || 10,
        cutoff: Number(cutoff) || 10,
        ...(mode === "live"
          ? {
              providerIds: selectedProviders,
              requestBudget: Number(budget) || 0,
              confirmPaid,
            }
          : {}),
        ...(snapshotRunId ? { snapshotRunId } : {}),
      });
      notify(`${t("quality.run.status.running")}: ${created.run.id}`);
      setDetailId(created.run.id);
      setName("");
      onChanged();
    } catch (caught) {
      setFormError(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("quality.run.create")}</CardTitle>
          <CardDescription>
            {mode === "offline" ? t("quality.run.mode.offlineHint") : t("quality.run.mode.liveHint")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("quality.tab.datasets")}>
              <Select value={effectiveDataset} onChange={(event) => setDatasetId(event.target.value)}>
                {frozenDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} · v{dataset.version}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("quality.run.mode")}>
              <Select
                value={mode}
                data-testid="quality-run-mode"
                onChange={(event) => setMode(event.target.value as "offline" | "live")}
              >
                <option value="offline">{t("quality.run.mode.offline")}</option>
                <option value="live">{t("quality.run.mode.live")}</option>
              </Select>
            </Field>
            <Field label={t("quality.run.fusion")}>
              <Select value={strategy} onChange={(event) => setStrategy(event.target.value as QualityFusionStrategy)}>
                {strategies.map((item) => (
                  <option key={item} value={item}>
                    {t(`quality.run.fusion.${item}` as never)}
                  </option>
                ))}
              </Select>
            </Field>
            {strategy === "rrf" ? (
              <Field label={t("quality.run.k")}>
                <Input value={k} onChange={(event) => setK(event.target.value)} inputMode="numeric" />
              </Field>
            ) : null}
            {strategy === "single" ? (
              <Field label={t("quality.run.provider")}>
                <Select value={providerForSingle} onChange={(event) => setProviderForSingle(event.target.value)}>
                  <option value="">—</option>
                  {(providers.data?.providers ?? []).map((provider: ProviderSummary) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label={t("quality.run.limit")}>
              <Input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" />
            </Field>
            <Field label={t("quality.run.cutoff")}>
              <Input value={cutoff} onChange={(event) => setCutoff(event.target.value)} inputMode="numeric" />
            </Field>
            <Field label={t("quality.run.name")}>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="rrf-k60-baseline" />
            </Field>
          </div>

          {mode === "offline" ? (
            <Field label={t("quality.run.snapshotRun")} hint={t("quality.run.snapshotRunHint")}>
              <Select value={snapshotRunId} onChange={(event) => setSnapshotRunId(event.target.value)}>
                <option value="">—</option>
                {snapshotCandidates.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.name || run.id} · {run.fusion.strategy}
                    {run.fusion.k ? `(k=${run.fusion.k})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="space-y-3 rounded-md border border-warning/30 bg-warning/5 p-3">
              <p className="text-xs text-warning">{t("quality.run.mode.liveHint")}</p>
              <Field label={t("quality.run.providers")}>
                <div className="flex flex-wrap gap-2">
                  {(providers.data?.providers ?? []).map((provider: ProviderSummary) => (
                    <label
                      key={provider.id}
                      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                    >
                      <Checkbox
                        checked={selectedProviders.includes(provider.id)}
                        onChange={(event) =>
                          setSelectedProviders((current) =>
                            event.target.checked
                              ? [...current, provider.id]
                              : current.filter((id) => id !== provider.id),
                          )
                        }
                      />
                      {provider.name}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label={t("quality.run.budget")}>
                <Input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="numeric" />
              </Field>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={confirmPaid} onChange={(event) => setConfirmPaid(event.target.checked)} />
                {t("quality.run.confirmPaid")}
              </label>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !effectiveDataset || (mode === "live" && (!confirmPaid || selectedProviders.length === 0))}
              onClick={() => void start()}
            >
              {t("quality.run.start")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? <Alert tone="error">{error.message}</Alert> : null}
      {loading && !runs ? <Skeleton className="h-40 w-full" /> : null}
      {runs && runs.length === 0 ? (
        <Card>
          <CardContent className="p-6">
            <EmptyState icon={BarChart3} title={t("quality.run.empty")} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {(runs ?? []).map((run) => (
          <Card key={run.id}>
            <CardContent className="space-y-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium">{run.name || run.id}</p>
                {statusBadge(run.status)}
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                <Badge tone="muted">{run.mode}</Badge>
                {run.datasetOrigin === "synthetic_fixture" ? (
                  <Badge tone="warning">{t("quality.origin.synthetic")}</Badge>
                ) : null}
                <Badge tone="muted">
                  {run.fusion.strategy}
                  {run.fusion.k ? ` k=${run.fusion.k}` : ""}
                </Badge>
                <span>v{run.datasetVersion}</span>
                <span>· {run.queryCount} q</span>
                <span>· {t("quality.run.requests")} {run.requestsUsed}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">{formatDateTime(run.startedAt)}</span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setDetailId((current) => (current === run.id ? null : run.id))}>
                    {t("common.view")}
                  </Button>
                  {run.status === "running" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void api
                          .cancelQualityRun(run.id)
                          .then(() => onChanged())
                          .catch((caught: unknown) => notify(toApiError(caught).message))
                      }
                    >
                      {t("quality.run.cancel")}
                    </Button>
                  ) : null}
                </div>
              </div>
              {detailId === run.id ? <RunDetailPanel runId={run.id} /> : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function RunDetailPanel({ runId }: { runId: string }) {
  const detail = useAsyncData((signal) => api.qualityRun(runId, signal), [runId]);
  const [openQuery, setOpenQuery] = useState<string | null>(null);

  if (detail.loading && !detail.data) return <Skeleton className="h-32 w-full" />;
  if (detail.error) return <Alert tone="error">{detail.error.message}</Alert>;
  const data: QualityRunDetail | null = detail.data;
  if (!data) return null;

  const k = data.run.cutoff;
  return (
    <div className="space-y-3 border-t pt-3">
      {data.run.datasetOrigin === "synthetic_fixture" ? (
        <Alert tone="warning">{t("quality.synthetic.warning")}</Alert>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <MetricCard label={t("quality.metric.ndcg", { k })} metric={data.metrics.ndcgAtK} />
        <MetricCard label={t("quality.metric.mrr", { k })} metric={data.metrics.mrrAtK} />
        <MetricCard label={t("quality.metric.precision", { k })} metric={data.metrics.precisionAtK} />
        <MetricCard label={t("quality.metric.recall", { k })} metric={data.metrics.recallAtK} />
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border p-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("quality.latency.p50")}</p>
          <p className="font-mono text-xs">{formatMs(data.latency.p50)}</p>
        </div>
        <div className="rounded-md border p-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("quality.latency.p95")}</p>
          <p className="font-mono text-xs">{formatMs(data.latency.p95)}</p>
        </div>
        <div className="rounded-md border p-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("quality.metric.duplicateRate")}</p>
          <p className="font-mono text-xs">
            {data.quality.duplicateRate?.status === "ok"
              ? formatPercent(data.quality.duplicateRate.value)
              : t("quality.metric.na")}
          </p>
        </div>
      </div>

      <div className="rounded-md border p-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("quality.cost.title")}</p>
        <p className="text-xs">
          {t("quality.cost.requests", { count: data.cost.httpRequests })}
          {data.cost.unknownCost ? ` · ${t("quality.cost.unknown")}` : ""}
        </p>
        {/* The three counts are shown separately: "2 searches" and "6 requests"
            are both true, and a single number hides which one a budget limits. */}
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {t("quality.cost.breakdown", {
            searches: String(data.cost.logicalSearches),
            attempts: String(data.cost.adapterAttempts),
            requests: String(data.cost.httpRequests),
          })}
        </p>
        {data.cost.unknownCost ? <p className="mt-0.5 text-[10px] text-muted-foreground">{t("quality.cost.unknownHint")}</p> : null}
      </div>

      <div className="space-y-1">
        <SectionHeader title={t("quality.run.perQuery")} />
        <div className="max-h-72 space-y-1 overflow-auto">
          {data.perQuery.map((row) => (
            <div key={row.queryId} className="rounded-md border">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/50"
                onClick={() => setOpenQuery((current) => (current === row.queryId ? null : row.queryId))}
              >
                <span className="truncate">{row.query}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  nDCG <MetricText metric={row.metrics.ndcgAtK} digits={3} />
                  {row.metrics.provisional ? <span className="ml-1 text-amber-600">~</span> : null}
                </span>
              </button>
              {openQuery === row.queryId ? (
                <div className="border-t px-2 py-1.5">
                  {row.ranked.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">{t("quality.run.noResults")}</p>
                  ) : (
                    <ol className="space-y-0.5 text-[11px]">
                      {row.ranked.map((document, index) => (
                        <li key={document.documentId} className="flex gap-2">
                          <span className="w-5 shrink-0 text-right font-mono text-muted-foreground">{index + 1}</span>
                          <span className="truncate">{document.title || document.url}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- compare

function CompareTab({ runs }: { runs: QualityRunSummary[] }) {
  const completed = runs.filter((run) => run.status === "completed");
  const [baseline, setBaseline] = useState("");
  const [candidate, setCandidate] = useState("");
  const [metric, setMetric] = useState("ndcgAtK");
  const [result, setResult] = useState<QualityComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState<QualitySweepResult | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);

  const datasetId = completed.find((run) => run.id === baseline)?.datasetId ?? "";

  async function compare() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.compareQualityRuns({ baseline, candidate, metric }));
    } catch (caught) {
      setError(toApiError(caught).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  async function runSweep() {
    setBusy(true);
    setSweepError(null);
    try {
      setSweep(await api.sweepQuality({ datasetId, metric }));
    } catch (caught) {
      setSweepError(toApiError(caught).message);
      setSweep(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("quality.compare.title")}</CardTitle>
          <CardDescription>{t("quality.compare.empty")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("quality.compare.baseline")}>
              <Select value={baseline} onChange={(event) => setBaseline(event.target.value)}>
                <option value="">—</option>
                {completed.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.name || run.id}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("quality.compare.candidate")}>
              <Select value={candidate} onChange={(event) => setCandidate(event.target.value)}>
                <option value="">—</option>
                {completed
                  .filter((run) => run.datasetId === datasetId)
                  .map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.name || run.id}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t("quality.compare.metric")}>
              <Select value={metric} onChange={(event) => setMetric(event.target.value)}>
                <option value="ndcgAtK">nDCG@k</option>
                <option value="mrrAtK">MRR@k</option>
                <option value="precisionAtK">P@k</option>
                <option value="recallAtK">Recall@k</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button size="sm" disabled={!baseline || !candidate || busy} onClick={() => void compare()}>
                {t("quality.compare.run")}
              </Button>
            </div>
          </div>

          {result ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge tone={result.verdict === "insufficient_evidence" ? "warning" : "info"}>
                  {t(`quality.compare.verdict.${result.verdict}` as never)}
                </Badge>
                {result.reason ? <span className="text-[11px] text-muted-foreground">{result.reason}</span> : null}
              </div>
              {result.verdict === "insufficient_evidence" ? (
                <Alert tone="warning">{t("quality.compare.insufficient")}</Alert>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-4">
                <MetricCard label={t("quality.compare.baseline")} metric={result.baseline} />
                <MetricCard label={t("quality.compare.candidate")} metric={result.candidate} />
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {t("quality.compare.absolute")}
                  </p>
                  <p className="font-mono text-xl font-semibold tabular-nums">
                    {result.absoluteDelta === null ? "—" : result.absoluteDelta.toFixed(4)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {t("quality.compare.relative")}
                  </p>
                  <p className="font-mono text-xl font-semibold tabular-nums">
                    {result.relativeDelta === null ? "—" : formatPercent(result.relativeDelta)}
                  </p>
                </div>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <QueryDeltaList title={t("quality.compare.improved")} rows={result.improved} tone="success" />
                <QueryDeltaList title={t("quality.compare.degraded")} rows={result.degraded} tone="destructive" />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("quality.sweep.title")}</CardTitle>
          <CardDescription>{t("quality.sweep.hint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {sweepError ? <Alert tone="error">{sweepError}</Alert> : null}
          <Button size="sm" variant="outline" disabled={!datasetId || busy} onClick={() => void runSweep()}>
            {t("quality.sweep.run")}
          </Button>
          {sweep ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge tone="muted">
                  {t("quality.sweep.development")} {sweep.split.development}
                </Badge>
                <Badge tone="muted">
                  {t("quality.sweep.holdout")} {sweep.split.holdout}
                </Badge>
                <Badge tone="info">
                  {t("quality.sweep.chosen")}: {sweep.chosen ?? "—"}
                </Badge>
                <Badge tone={sweep.evidence === "sufficient" ? "success" : "warning"}>
                  {t(`quality.sweep.${sweep.evidence === "sufficient" ? "sufficient" : "insufficient"}` as never)}
                </Badge>
              </div>
              <div className="overflow-auto rounded-md border">
                <Table>
                  <THead>
                    <TR>
                      <TH>k</TH>
                      <TH>{t("quality.sweep.development")}</TH>
                      <TH>{t("quality.sweep.holdout")}</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {sweep.candidates.map((candidate) => (
                      <TR key={candidate.k}>
                        <TD className="font-mono">{candidate.k}</TD>
                        <TD>
                          <MetricText metric={candidate.development[metric]} />
                        </TD>
                        <TD>
                          <MetricText metric={candidate.holdout[metric]} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function QueryDeltaList({
  title,
  rows,
  tone,
}: {
  title: string;
  rows: QualityComparison["improved"];
  tone: "success" | "destructive";
}) {
  return (
    <div className="rounded-md border p-2">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">—</p>
      ) : (
        <ul className="space-y-0.5 text-[11px]">
          {rows.slice(0, 12).map((row) => (
            <li key={row.queryId} className="flex items-center justify-between gap-2">
              <span className="truncate">{row.query}</span>
              <span className={"shrink-0 font-mono " + (tone === "success" ? "text-success" : "text-destructive")}>
                {row.delta === null ? "—" : row.delta.toFixed(4)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- history

function HistoryTab({ runs }: { runs: QualityRunSummary[] }) {
  if (runs.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyState icon={History} title={t("quality.history.empty")} />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t("quality.history.title")}</CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => downloadJson(`quality-runs-${timestampSlug()}.json`, runs)}
        >
          {t("quality.history.export")}
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto rounded-md border">
          <Table>
            <THead>
              <TR>
                <TH>{t("quality.run.name")}</TH>
                <TH>{t("quality.run.mode")}</TH>
                <TH>{t("quality.run.fusion")}</TH>
                <TH>{t("quality.run.datasetVersion")}</TH>
                <TH>{t("quality.run.requests")}</TH>
                <TH>{t("quality.run.commit")}</TH>
                <TH>{t("quality.run.engine")}</TH>
                <TH>{t("common.status")}</TH>
              </TR>
            </THead>
            <TBody>
              {runs.map((run) => (
                <TR key={run.id}>
                  <TD className="max-w-64">
                    <p className="truncate text-xs">{run.name || run.id}</p>
                    <p className="text-[10px] text-muted-foreground">{formatDateTime(run.startedAt)}</p>
                  </TD>
                  <TD className="text-xs">{run.mode}</TD>
                  <TD className="text-xs">
                    {run.fusion.strategy}
                    {run.fusion.k ? ` k=${run.fusion.k}` : ""}
                  </TD>
                  <TD className="font-mono text-xs">v{run.datasetVersion}</TD>
                  <TD className="font-mono text-xs">{run.requestsUsed}</TD>
                  <TD className="font-mono text-[10px] text-muted-foreground">
                    {run.codeCommit ? run.codeCommit.slice(0, 7) : "—"}
                  </TD>
                  <TD className="font-mono text-[10px] text-muted-foreground">{run.engineVersion}</TD>
                  <TD>{statusBadge(run.status)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
