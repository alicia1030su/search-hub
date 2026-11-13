import { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FlaskConical,
  Play,
  Search,
  Sparkles,
  Square,
  Timer,
} from "lucide-react";
import { api, isAbortError, toApiError, type ApiError } from "../lib/api";
import {
  downloadJson,
  formatDateTime,
  formatMs,
  formatNumber,
  orDash,
  prettyJson,
} from "../lib/format";
import { useAsyncData, useCopy, useDocumentTitle, useElapsed } from "../lib/hooks";
import {
  droppedReasonLabel,
  freshnessLabels,
  searchModeLabels,
  t,
} from "../lib/i18n";
import type {
  Freshness,
  ModelConfig,
  SearchMode,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchTaskRecord,
} from "../lib/types";
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
  Collapsible,
  EmptyState,
  Field,
  InlineCode,
  Input,
  JsonPreview,
  PageHeader,
  SearchStatusBadge,
  Select,
  Skeleton,
  Textarea,
} from "../components/ui";

const modes: SearchMode[] = [
  "basic",
  "rrf",
  "rerank",
  "embedding",
  "embedding_rerank",
  "rerank_summary",
  "deep",
];

const freshnessOptions: Array<Freshness | ""> = ["", "day", "week", "month", "year", "all"];

interface RunState {
  request: SearchRequest;
  startedAt: number;
}

export function LabPage() {
  useDocumentTitle(t("lab.title"));
  const toast = useToast();
  const providersResource = useAsyncData((signal) => api.providers(signal), []);
  const modelsResource = useAsyncData((signal) => api.models(signal), []);
  const providers = useMemo(
    () => (providersResource.data?.providers ?? []).filter((provider) => provider.enabled),
    [providersResource.data],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("rrf");
  const [limit, setLimit] = useState("20");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [language, setLanguage] = useState("");
  const [freshness, setFreshness] = useState<string>("");
  const [rerankModelId, setRerankModelId] = useState("");
  const [chatModelId, setChatModelId] = useState("");
  const [embeddingModelId, setEmbeddingModelId] = useState("");
  const [includeDebug, setIncludeDebug] = useState(true);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [lastRequest, setLastRequest] = useState<SearchRequest | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [runError, setRunError] = useState<ApiError | null>(null);
  const [clientDuration, setClientDuration] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const elapsed = useElapsed(runState?.startedAt ?? null);
  const copy = useCopy();

  const [taskIdInput, setTaskIdInput] = useState("");
  const [taskRecord, setTaskRecord] = useState<SearchTaskRecord | null>(null);
  const [taskError, setTaskError] = useState<ApiError | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [cancellingTask, setCancellingTask] = useState(false);

  useEffect(() => {
    if (selectionInitialized || providers.length === 0) return;
    setSelected(providers.map((provider) => provider.id));
    setSelectionInitialized(true);
  }, [providers, selectionInitialized]);

  const modelsByKind = useMemo(() => {
    const groups: Record<"chat" | "embedding" | "rerank", ModelConfig[]> = {
      chat: [],
      embedding: [],
      rerank: [],
    };
    for (const model of modelsResource.data ?? []) {
      if (model.enabled) groups[model.kind].push(model);
    }
    return groups;
  }, [modelsResource.data]);

  const running = runState !== null;

  const toggleProvider = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const run = async () => {
    if (running) return;
    if (!query.trim()) {
      toast.error({ title: t("lab.queryRequired") });
      return;
    }
    if (selected.length === 0) {
      toast.error({ title: t("lab.providers"), description: t("lab.providersHint") });
      return;
    }
    const numericLimit = Number(limit);
    if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 100) {
      toast.error({
        title: t("providers.form.rangeError", { label: t("lab.limit"), min: 1, max: 100 }),
      });
      return;
    }
    const numericTimeout = timeoutMs.trim() ? Number(timeoutMs) : null;
    if (numericTimeout !== null && (!Number.isInteger(numericTimeout) || numericTimeout < 1000 || numericTimeout > 120000)) {
      toast.error({
        title: t("providers.form.rangeError", { label: t("lab.timeout"), min: 1000, max: 120000 }),
      });
      return;
    }

    const request: SearchRequest = {
      query: query.trim(),
      mode,
      limit: numericLimit,
      providers: selected.length === providers.length ? undefined : selected,
      includeRaw: includeDebug,
      ...(numericTimeout === null ? {} : { timeoutMs: numericTimeout }),
      ...(language.trim() ? { language: language.trim() } : {}),
      ...(freshness ? { freshness: freshness as Freshness } : {}),
      ...(rerankModelId ? { rerankModelId } : {}),
      ...(chatModelId ? { chatModelId } : {}),
      ...(embeddingModelId ? { embeddingModelId } : {}),
    };

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    setRunState({ request, startedAt });
    setLastRequest(request);
    setRunError(null);
    setResponse(null);
    setClientDuration(null);

    try {
      const result = await api.search(request, controller.signal);
      setResponse(result);
      setClientDuration(Date.now() - startedAt);
      setTaskIdInput(result.taskId);
    } catch (caught) {
      if (isAbortError(caught) || controller.signal.aborted) {
        toast.info({ title: t("lab.cancelled") });
      } else {
        setRunError(toApiError(caught));
      }
    } finally {
      setRunState(null);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const loadTask = async () => {
    const id = taskIdInput.trim();
    if (!id) {
      toast.error({ title: t("lab.task.idRequired") });
      return;
    }
    setTaskLoading(true);
    setTaskError(null);
    setTaskRecord(null);
    setLastRequest(null);
    try {
      const record = await api.searchTask(id);
      setTaskRecord(record);
      if (record.response) {
        setResponse(record.response);
        setClientDuration(null);
      }
      toast.success({ title: t("lab.task.loaded") });
    } catch (caught) {
      setTaskError(toApiError(caught));
    } finally {
      setTaskLoading(false);
    }
  };

  const cancelTask = async () => {
    const id = taskIdInput.trim();
    if (!id) {
      toast.error({ title: t("lab.task.idRequired") });
      return;
    }
    setCancellingTask(true);
    try {
      const result = await api.cancelSearchTask(id);
      if (result.ok) {
        toast.success({ title: t("lab.task.cancelled") });
      } else {
        toast.info({ title: t("lab.task.notCancelled") });
      }
    } catch (caught) {
      const apiError = toApiError(caught);
      toast.error({ title: apiError.message, description: apiError.code });
    } finally {
      setCancellingTask(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("lab.title")}
        description={t("lab.subtitle")}
        meta={
          <span className="inline-flex items-center gap-1">
            <FlaskConical className="size-3.5" aria-hidden />
            {t("lab.abortNotCancelable")}
          </span>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t("lab.query")}</CardTitle>
                <CardDescription>{t("lab.modeHint")}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label={t("lab.query")} htmlFor="lab-query" required>
                <Textarea
                  id="lab-query"
                  rows={3}
                  maxLength={2000}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("lab.queryPlaceholder")}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      void run();
                    }
                  }}
                />
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label={t("lab.mode")} htmlFor="lab-mode">
                  <Select
                    id="lab-mode"
                    value={mode}
                    onChange={(event) => setMode(event.target.value as SearchMode)}
                  >
                    {modes.map((item) => (
                      <option key={item} value={item}>
                        {searchModeLabels[item]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("lab.limit")} htmlFor="lab-limit">
                  <Input
                    id="lab-limit"
                    type="number"
                    min={1}
                    max={100}
                    value={limit}
                    onChange={(event) => setLimit(event.target.value)}
                  />
                </Field>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{t("lab.providers")}</span>
                  <div className="flex items-center gap-2 text-[11px]">
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => setSelected(providers.map((provider) => provider.id))}
                    >
                      {t("lab.selectAll")}
                    </button>
                    <span className="text-border">|</span>
                    <button
                      type="button"
                      className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      onClick={() => setSelected([])}
                    >
                      {t("lab.clearAll")}
                    </button>
                  </div>
                </div>
                <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border p-1.5">
                  {providersResource.loading && !providersResource.data ? (
                    <Skeleton className="h-16" />
                  ) : providers.length === 0 ? (
                    <p className="p-2 text-xs text-muted-foreground">{t("providers.list.empty")}</p>
                  ) : (
                    providers.map((provider) => (
                      <label
                        key={provider.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent/50"
                      >
                        <input
                          type="checkbox"
                          className="size-4 rounded border-input accent-primary"
                          checked={selected.includes(provider.id)}
                          onChange={() => toggleProvider(provider.id)}
                        />
                        <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{provider.type}</span>
                      </label>
                    ))
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("lab.selectedCount", { count: selected.length, total: providers.length })} ·{" "}
                  {t("lab.providersHint")}
                </p>
              </div>

              {providersResource.error ? (
                <Alert tone="warning" title={`${providersResource.error.code}: ${providersResource.error.message}`} />
              ) : null}

              <Collapsible summary={t("lab.advanced")}>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t("lab.timeout")} htmlFor="lab-timeout" hint={t("lab.timeoutHint")}>
                      <Input
                        id="lab-timeout"
                        type="number"
                        min={1000}
                        max={120000}
                        value={timeoutMs}
                        onChange={(event) => setTimeoutMs(event.target.value)}
                        placeholder="15000"
                      />
                    </Field>
                    <Field label={t("lab.freshness")} htmlFor="lab-freshness">
                      <Select
                        id="lab-freshness"
                        value={freshness}
                        onChange={(event) => setFreshness(event.target.value)}
                      >
                        {freshnessOptions.map((option) => (
                          <option key={option || "none"} value={option}>
                            {option === "" ? t("providers.freshness.null") : freshnessLabels[option]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <Field label={t("lab.language")} htmlFor="lab-language">
                    <Input
                      id="lab-language"
                      value={language}
                      maxLength={24}
                      onChange={(event) => setLanguage(event.target.value)}
                      placeholder={t("lab.languagePlaceholder")}
                    />
                  </Field>

                  <Field label={t("lab.rerankModel")} htmlFor="lab-rerank-model">
                    <Select
                      id="lab-rerank-model"
                      value={rerankModelId}
                      onChange={(event) => setRerankModelId(event.target.value)}
                    >
                      <option value="">{t("lab.modelDefault")}</option>
                      {modelsByKind.rerank.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} ({model.modelId})
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field label={t("lab.chatModel")} htmlFor="lab-chat-model">
                    <Select
                      id="lab-chat-model"
                      value={chatModelId}
                      onChange={(event) => setChatModelId(event.target.value)}
                    >
                      <option value="">{t("lab.modelDefault")}</option>
                      {modelsByKind.chat.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} ({model.modelId})
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field label={t("lab.embeddingModel")} htmlFor="lab-embedding-model">
                    <Select
                      id="lab-embedding-model"
                      value={embeddingModelId}
                      onChange={(event) => setEmbeddingModelId(event.target.value)}
                    >
                      <option value="">{t("lab.modelDefault")}</option>
                      {modelsByKind.embedding.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} ({model.modelId})
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <label className="flex items-start gap-2 rounded-md border bg-muted/20 px-2.5 py-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 rounded border-input accent-primary"
                      checked={includeDebug}
                      onChange={(event) => setIncludeDebug(event.target.checked)}
                    />
                    <span>
                      <span className="block text-xs font-medium">{t("lab.includeRaw")}</span>
                      <span className="block text-[10px] leading-relaxed text-muted-foreground">
                        {t("lab.includeRawHint")}
                      </span>
                    </span>
                  </label>

                  {modelsResource.error ? (
                    <p className="text-[11px] text-warning">
                      {t("models.title")}: {modelsResource.error.message}
                    </p>
                  ) : null}
                </div>
              </Collapsible>

              <div className="flex items-center gap-2">
                <Button className="flex-1" loading={running} onClick={() => void run()}>
                  {running ? (
                    <>
                      <Clock3 className="animate-pulse" aria-hidden />
                      {t("lab.running")} {formatMs(elapsed)}
                    </>
                  ) : (
                    <>
                      <Play aria-hidden />
                      {t("lab.run")}
                    </>
                  )}
                </Button>
                {running ? (
                  <Button variant="outline" onClick={cancel}>
                    <Square aria-hidden />
                    {t("lab.cancel")}
                  </Button>
                ) : null}
              </div>
              <p className="text-[10px] text-muted-foreground">{t("common.keyShortcut")}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>{t("lab.task.title")}</CardTitle>
                <CardDescription>{t("lab.task.desc")}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2.5">
              <div className="flex gap-1.5">
                <Input
                  value={taskIdInput}
                  onChange={(event) => setTaskIdInput(event.target.value)}
                  placeholder={t("lab.task.idPlaceholder")}
                  aria-label={t("lab.result.taskId")}
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="sm" loading={taskLoading} onClick={() => void loadTask()}>
                  {t("lab.task.load")}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  loading={cancellingTask}
                  onClick={() => void cancelTask()}
                >
                  {t("lab.task.cancel")}
                </Button>
                {taskIdInput ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copy.copy(taskIdInput)}
                    title={t("common.copy")}
                  >
                    <Copy aria-hidden />
                    {copy.copied ? t("common.copied") : t("common.copy")}
                  </Button>
                ) : null}
              </div>
              {taskError ? <Alert tone="error" title={`${taskError.code}: ${taskError.message}`} /> : null}
              {taskRecord ? (
                <div className="space-y-1 rounded-md border bg-muted/20 p-2.5 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t("lab.result.taskId")}</span>
                    <span className="truncate font-mono">{taskRecord.id}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t("lab.task.status")}</span>
                    <SearchStatusBadge status={taskRecord.status} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t("lab.task.finishedAt")}</span>
                    <span>{formatDateTime(taskRecord.finishedAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">{t("lab.result.duration")}</span>
                    <span className="font-mono">{formatMs(taskRecord.durationMs)}</span>
                  </div>
                  {!taskRecord.response ? (
                    <p className="pt-1 text-muted-foreground">{t("lab.task.noResponse")}</p>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          {runError ? (
            <Alert tone="error" title={`${runError.code}: ${runError.message}`}>
              {runError.details ? <JsonPreview value={runError.details} /> : null}
            </Alert>
          ) : null}

          {running && !response ? (
            <Card>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center gap-2 text-sm">
                  <Clock3 className="size-4 animate-pulse text-muted-foreground" aria-hidden />
                  <span>
                    {t("lab.running")} {formatMs(elapsed)}
                  </span>
                </div>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </CardContent>
            </Card>
          ) : response ? (
            <SearchResultPanel
              response={response}
              clientDuration={clientDuration}
              request={lastRequest}
            />
          ) : (
            <EmptyState
              icon={Search}
              title={t("lab.empty")}
              description={t("lab.emptyDesc")}
              className="py-16"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SearchResultPanel({
  response,
  clientDuration,
  request,
}: {
  response: SearchResponse;
  clientDuration: number | null;
  request: SearchRequest | null;
}) {
  const toast = useToast();
  const copy = useCopy();

  const copyJson = async () => {
    const ok = await copy.copy(prettyJson(response));
    if (ok) toast.success({ title: t("common.copied") });
    else toast.error({ title: t("common.copyFailed") });
  };

  const timing = response.stats.timing;
  const timingItems: Array<{ label: string; value: number }> = [
    { label: t("lab.result.totalMs"), value: timing.totalMs },
    { label: t("lab.result.fanoutMs"), value: timing.fanoutMs },
    { label: t("lab.result.fusionMs"), value: timing.fusionMs },
    ...(timing.rerankMs === undefined ? [] : [{ label: t("lab.result.rerankMs"), value: timing.rerankMs }]),
    ...(timing.embeddingMs === undefined ? [] : [{ label: t("lab.result.embeddingMs"), value: timing.embeddingMs }]),
    ...(timing.summaryMs === undefined ? [] : [{ label: t("lab.result.summaryMs"), value: timing.summaryMs }]),
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <SearchStatusBadge status={response.status} />
              <Badge tone="outline">{searchModeLabels[response.mode]}</Badge>
              {response.stats.partial ? <Badge tone="warning">{t("states.partial")}</Badge> : null}
              {response.stats.rerankApplied ? <Badge tone="info">rerank</Badge> : null}
              {response.stats.embeddingApplied ? <Badge tone="info">embedding</Badge> : null}
              {response.stats.summaryApplied ? <Badge tone="info">summary</Badge> : null}
            </div>
            <CardTitle className="mt-1.5 text-base">{response.query}</CardTitle>
            <CardDescription>
              {t("lab.result.statusLine", {
                status: t(`searchStatus.${response.status}`),
                duration: formatMs(timing.totalMs),
                count: response.results.length,
              })}
              {clientDuration !== null ? ` · ${t("lab.result.duration")} ${formatMs(clientDuration)}` : ""}
            </CardDescription>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span>{t("lab.result.taskId")}:</span>
              <InlineCode>{response.taskId}</InlineCode>
              <button
                type="button"
                onClick={() => void copy.copy(response.taskId)}
                className="inline-flex items-center gap-0.5 hover:text-foreground"
              >
                <Copy className="size-3" aria-hidden />
                {t("common.copy")}
              </button>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void copyJson()}>
              <Copy aria-hidden />
              {t("lab.result.copyJson")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadJson(`search-${response.taskId}.json`, response)}
            >
              <Download aria-hidden />
              {t("lab.result.downloadJson")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: t("lab.result.rawCount"), value: response.stats.rawCount },
              { label: t("lab.result.dedupedCount"), value: response.stats.dedupedCount },
              { label: t("lab.result.fusedCount"), value: response.stats.fusedCount },
            ].map((stat) => (
              <div key={stat.label} className="rounded-md border bg-muted/20 p-2.5">
                <p className="text-[10px] text-muted-foreground">{stat.label}</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatNumber(stat.value)}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Timer className="size-3" aria-hidden />
              {t("lab.result.timing")}
            </span>
            {timingItems.map((item) => (
              <Badge key={item.label} tone="outline">
                {item.label} {formatMs(item.value)}
              </Badge>
            ))}
          </div>

          {response.errors.length > 0 ? (
            <Alert tone="warning" title={t("lab.result.errors")}>
              <ul className="space-y-1">
                {response.errors.map((error) => (
                  <li key={`${error.providerId}-${error.code}`}>
                    <span className="font-medium text-foreground">{error.providerName}</span>{" "}
                    <span className="font-mono">[{error.code}]</span> {error.message}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : (
            <p className="text-[11px] text-success">{t("lab.result.noErrors")}</p>
          )}
        </CardContent>
      </Card>

      {response.summary ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5">
                <Sparkles className="size-4" aria-hidden />
                {t("lab.result.summary")}
              </CardTitle>
              {response.summary.modelId ? (
                <CardDescription>{t("lab.result.summaryModel", { model: response.summary.modelId })}</CardDescription>
              ) : null}
            </div>
            {response.summary.degraded ? <Badge tone="warning">{t("lab.result.summaryDegraded")}</Badge> : null}
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{response.summary.text}</p>
            {response.summary.citations.length > 0 ? (
              <div>
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t("lab.result.citations")}</p>
                <ol className="space-y-1">
                  {response.summary.citations.map((citation) => (
                    <li key={`${citation.index}-${citation.url}`} className="flex gap-2 text-xs">
                      <span className="font-mono text-muted-foreground">[{citation.index}]</span>
                      <a
                        href={citation.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="min-w-0 truncate hover:underline"
                      >
                        {citation.title || citation.url}
                      </a>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("lab.result.providerStats")}</CardTitle>
            <CardDescription>
              {response.errors.length > 0 ? t("lab.result.partialNote") : t("lab.result.noErrors")}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/45">
                <tr className="text-[11px] text-muted-foreground">
                  <th className="px-3 py-2 text-left font-medium">{t("lab.result.provider")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("common.status")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("lab.result.latency")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("lab.result.results")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("lab.result.attempts")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("lab.result.key")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("lab.result.error")}</th>
                </tr>
              </thead>
              <tbody>
                {response.stats.providers.map((stat) => (
                  <tr key={stat.providerId} className="border-t">
                    <td className="px-3 py-2">
                      <p className="font-medium">{stat.providerName}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{stat.providerType}</p>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={stat.ok ? "success" : "destructive"}>
                        {stat.ok ? t("common.success") : t("common.failed")}
                      </Badge>
                      {stat.statusCode ? (
                        <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{stat.statusCode}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{formatMs(stat.latencyMs)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{stat.resultCount}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{stat.attempts}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{orDash(stat.keyId)}</td>
                    <td className="max-w-[240px] px-3 py-2">
                      {stat.errorCode ? (
                        <div>
                          <Badge tone="destructive">{stat.errorCode}</Badge>
                          {stat.errorMessage ? (
                            <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                              {stat.errorMessage}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t("lab.result.finalRanking")}</CardTitle>
              <CardDescription>{t("lab.result.statusLine", {
                status: t(`searchStatus.${response.status}`),
                duration: formatMs(timing.totalMs),
                count: response.results.length,
              })}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {response.results.length === 0 ? (
              <EmptyState title={t("lab.result.finalEmpty")} />
            ) : (
              response.results.map((result, index) => (
                <ResultRow key={result.id} result={result} rank={index + 1} />
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t("lab.result.perProvider")}</CardTitle>
              <CardDescription>{t("lab.result.includeRaw")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {response.debug?.perProviderResults && response.debug.perProviderResults.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {response.debug.perProviderResults.map((entry) => (
                  <div key={entry.providerId} className="rounded-md border">
                    <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2.5 py-1.5">
                      <p className="truncate text-xs font-medium">{entry.providerName}</p>
                      <Badge tone="outline">{entry.results.length}</Badge>
                    </div>
                    {entry.results.length === 0 ? (
                      <p className="p-2.5 text-[11px] text-muted-foreground">{t("lab.result.providerEmpty")}</p>
                    ) : (
                      <ol className="max-h-64 space-y-1 overflow-y-auto p-2">
                        {entry.results.map((result, index) => (
                          <li key={`${entry.providerId}-${result.id}-${index}`} className="flex gap-1.5 text-[11px]">
                            <span className="w-4 shrink-0 text-right font-mono text-muted-foreground">
                              {index + 1}
                            </span>
                            <a
                              href={result.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="line-clamp-2 min-w-0 hover:underline"
                              title={result.url}
                            >
                              {result.title || result.url}
                            </a>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("lab.result.debugUnavailable")}</p>
            )}
          </CardContent>
        </Card>

        <Collapsible summary={t("lab.result.debug")}>
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium">
                <Braces className="size-3.5" aria-hidden />
                {t("lab.result.request")}
              </p>
              <JsonPreview value={request ?? response} />
            </div>

            {response.debug?.providerQueries && response.debug.providerQueries.length > 0 ? (
              <div>
                <p className="mb-1.5 text-xs font-medium">{t("lab.result.providerQueries")}</p>
                <ul className="space-y-1 text-[11px]">
                  {response.debug.providerQueries.map((entry) => (
                    <li key={entry.providerId} className="flex gap-2">
                      <span className="font-mono text-muted-foreground">{entry.providerId}</span>
                      <span>{entry.query}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {response.debug?.rewrittenQueries && response.debug.rewrittenQueries.length > 0 ? (
              <div>
                <p className="mb-1.5 text-xs font-medium">{t("lab.result.rewrittenQueries")}</p>
                <div className="flex flex-wrap gap-1">
                  {response.debug.rewrittenQueries.map((query) => (
                    <Badge key={query} tone="outline">
                      {query}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {response.debug?.droppedDuplicates && response.debug.droppedDuplicates.length > 0 ? (
              <div>
                <p className="mb-1.5 text-xs font-medium">{t("lab.result.droppedDuplicates")}</p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[520px] text-[11px]">
                    <thead className="bg-muted/40 text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1.5 text-left font-medium">URL</th>
                        <th className="px-2 py-1.5 text-left font-medium">Kept</th>
                        <th className="px-2 py-1.5 text-left font-medium">{t("common.details")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {response.debug.droppedDuplicates.map((entry, index) => (
                        <tr key={`${entry.url}-${index}`} className="border-t">
                          <td className="max-w-[240px] truncate px-2 py-1.5 font-mono">{entry.url}</td>
                          <td className="max-w-[240px] truncate px-2 py-1.5 font-mono text-muted-foreground">
                            {entry.keptUrl}
                          </td>
                          <td className="px-2 py-1.5">{droppedReasonLabel(entry.reason)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <div>
              <p className="mb-1.5 text-xs font-medium">{t("lab.result.timing")}</p>
              <JsonPreview value={timing} />
            </div>
          </div>
        </Collapsible>
      </div>
    </div>
  );
}

function ResultRow({ result, rank }: { result: SearchResult; rank: number }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex gap-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[11px] text-muted-foreground">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <a
            href={result.url}
            target="_blank"
            rel="noreferrer noopener"
            className="group inline-flex items-start gap-1 font-medium hover:underline"
          >
            <span className="line-clamp-2">{result.title || result.url}</span>
            <ExternalLink className="mt-1 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
          </a>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{result.url}</p>
          {result.snippet ? (
            <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{result.snippet}</p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Badge tone="outline">{result.providerName}</Badge>
            <Badge tone="muted">{result.providerType}</Badge>
            {result.score ? <Badge tone="muted">{t("lab.result.score")} {result.score.toFixed(3)}</Badge> : null}
            {result.fusionScore !== undefined ? (
              <Badge tone="info">
                {t("lab.result.fusionScore")} {result.fusionScore.toFixed(4)}
              </Badge>
            ) : null}
            {result.rerankScore !== undefined ? (
              <Badge tone="success">
                {t("lab.result.rerankScore")} {result.rerankScore.toFixed(4)}
              </Badge>
            ) : null}
            {result.publishedAt ? (
              <span className="text-[10px] text-muted-foreground">
                {t("lab.result.publishedAt")} {formatDateTime(result.publishedAt)}
              </span>
            ) : null}
          </div>
          {result.sources.length > 0 ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                {t("lab.result.sources")} ({result.sources.length})
              </summary>
              <ul className="mt-1 space-y-0.5">
                {result.sources.map((source) => (
                  <li key={`${source.providerId}-${source.rank}`} className="flex items-center gap-1.5 text-[10px]">
                    <span className="font-mono text-muted-foreground">#{source.rank}</span>
                    <span>{source.providerName}</span>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="truncate text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {source.url}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

