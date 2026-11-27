import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Clock3, Copy, Download, ExternalLink, FlaskConical, Play, Search, Square, Timer } from "lucide-react";
import { api, ApiError, isAbortError, SearchStreamUnsupportedError, toApiError } from "../lib/api";
import { downloadJson, formatMs, formatNumber, orDash, prettyJson } from "../lib/format";
import { useAsyncData, useCopy, useDocumentTitle, useElapsed, useLocale } from "../lib/hooks";
import {
  expansionQueries, funnelConsistent, funnelValues, mergeProvisionalResults, queryOriginsForResult, rankingComparison,
  resultsFromStreamEvent, sourceContributions, withoutRawPayloads, type ComparisonRow,
} from "../lib/search-response";
import { freshnessLabel, searchModeLabel, t, type MessageKey } from "../lib/i18n";
import type {
  Freshness, GroundedAnswer, ModelConfig, QueryOrigin, SearchMode, SearchRequest,
  SearchResponse, SearchResult, SearchStatus, SearchStrategy, SearchStreamEvent, SearchTaskRecord, StreamProviderState, WebReadResponse,
} from "../lib/types";
import { useToast } from "../components/toast";
import {
  Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Collapsible,
  Drawer, EmptyState, Field, InlineCode, Input, JsonPreview, PageHeader, Progress, SearchStatusBadge,
  Select, Skeleton, Switch, Textarea,
} from "../components/ui";

const modes: SearchMode[] = ["web", "grounded", "research", "basic", "rrf", "rerank", "embedding", "embedding_rerank", "rerank_summary", "deep"];
const strategies: SearchStrategy[] = ["auto", "fast", "balanced", "quality", "deep"];
const freshnessOptions: Array<Freshness | ""> = ["", "day", "week", "month", "year", "all"];
const stages = ["routing", "fanout", "dedupe", "rerank", "embedding", "finalizing", "done"];
const legacyModels: Partial<Record<SearchMode, Array<"chat" | "embedding" | "rerank">>> = {
  rerank: ["rerank"], embedding: ["embedding"], embedding_rerank: ["embedding", "rerank"], rerank_summary: ["rerank", "chat"],
};

type PickerValue = `strategy:${SearchStrategy}` | `mode:${SearchMode}`;
export type LabRunStatus = "idle" | "running" | SearchStatus;
export interface LabViewState {
  status: LabRunStatus;
  request: SearchRequest | null;
  response: SearchResponse | null;
  provisional: SearchResult[];
  stage: string | null;
  completed: number | null;
  total: number | null;
  providerStates: StreamProviderState[];
  selectedProviderIds: string[] | null;
  excludedProviders: SearchResponse["excludedProviders"];
  route: SearchResponse["route"];
  expansions: QueryOrigin[];
  error: ApiError | null;
  clientDuration: number | null;
  startedAt: number | null;
  fallback: boolean;
  taskId: string | null;
}
export const initialLabState: LabViewState = {
  status: "idle", request: null, response: null, provisional: [], stage: null, completed: null, total: null,
  providerStates: [], selectedProviderIds: null, excludedProviders: undefined, route: undefined,
  expansions: [], error: null, clientDuration: null, startedAt: null, fallback: false, taskId: null,
};
export type LabAction =
  | { type: "start"; request: SearchRequest; startedAt: number }
  | { type: "event"; event: SearchStreamEvent }
  | { type: "complete"; response: SearchResponse; clientDuration: number; fallback?: boolean }
  | { type: "error"; error: ApiError; cancelled?: boolean }
  | { type: "cancel" }
  | { type: "reset" };

export function labReducer(state: LabViewState, action: LabAction): LabViewState {
  switch (action.type) {
    case "start":
      return { ...initialLabState, status: "running", request: action.request, startedAt: action.startedAt };
    case "event": {
      if (state.status !== "running") return state;
      const event = action.event;
      if (event.type === "results") {
        if (!Array.isArray(event.data) && event.data.stats && typeof event.data.stats === "object" && "cached" in event.data.stats && event.data.stats.cached === true) return state;
        return { ...state, provisional: mergeProvisionalResults(state.provisional, resultsFromStreamEvent(event)) };
      }
      if (event.type === "meta") return {
        ...state, taskId: event.data.taskId ?? state.taskId,
        selectedProviderIds: event.data.selectedProviderIds ?? null,
        route: event.data.route ?? state.route,
      };
      if (event.type === "status") return {
        ...state, stage: event.data.stage ?? event.data.status ?? state.stage,
        completed: event.data.completed ?? null, total: event.data.total ?? null,
        providerStates: event.data.providers ?? state.providerStates,
      };
      if (event.type === "done") {
        const finalResponse = event.data;
        return {
          ...state, status: finalResponse.status, response: finalResponse, provisional: [],
          selectedProviderIds: finalResponse.selectedProviderIds ?? state.selectedProviderIds,
          route: finalResponse.route ?? state.route,
          expansions: expansionQueries(finalResponse),
          stage: "done",
        };
      }
      return state;
    }
    case "complete":
      return {
        ...state, status: action.response.status, response: action.response, provisional: [],
        clientDuration: action.clientDuration, startedAt: null, taskId: action.response.taskId,
        selectedProviderIds: action.response.selectedProviderIds ?? state.selectedProviderIds,
        route: action.response.route ?? state.route,
        expansions: expansionQueries(action.response),
        fallback: action.fallback ?? false,
      };
    case "error":
      return { ...state, status: action.cancelled ? "cancelled" : "failed", error: action.error, startedAt: null };
    case "cancel":
      return state.status === "running" ? { ...state, status: "cancelled", startedAt: null } : state;
    case "reset": return initialLabState;
  }
}

export function buildLabRequest(input: {
  query: string; picker: PickerValue; limit: number; selected: string[];
  providerMode: "auto" | "manual"; includeRaw: boolean; skipCache: boolean; queryExpansion: boolean;
  timeoutMs?: number; language?: string; freshness?: string; rerankModelId?: string; chatModelId?: string; embeddingModelId?: string;
}): SearchRequest {
  const base: SearchRequest = {
    query: input.query.trim(), limit: input.limit, includeRaw: input.includeRaw, skipCache: input.skipCache,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(input.freshness ? { freshness: input.freshness as Freshness } : {}),
    ...(input.rerankModelId ? { rerankModelId: input.rerankModelId } : {}),
    ...(input.chatModelId ? { chatModelId: input.chatModelId } : {}),
    ...(input.embeddingModelId ? { embeddingModelId: input.embeddingModelId } : {}),
  };
  if (input.picker.startsWith("mode:")) {
    return { ...base, mode: input.picker.slice(5) as SearchMode, ...(input.providerMode === "manual" ? { providers: input.selected } : {}) };
  }
  const strategy = input.picker.slice(9) as SearchStrategy;
  return {
    ...base, strategy, stream: "sse",
    ...(input.providerMode === "manual" ? { providers: input.selected } : {}),
    ...(strategy !== "fast" && ["balanced", "quality", "deep", "auto"].includes(strategy) ? { queryExpansion: input.queryExpansion } : {}),
  };
}

export function LabPage() {
  useLocale();
  useDocumentTitle(t("lab.title"));
  const toast = useToast();
  const providersResource = useAsyncData((signal) => api.providers(signal), []);
  const modelsResource = useAsyncData((signal) => api.models(signal), []);
  const providers = providersResource.data?.providers ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState<PickerValue>("mode:rrf");
  const [providerMode, setProviderMode] = useState<"auto" | "manual">("manual");
  const [limit, setLimit] = useState("20");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [language, setLanguage] = useState("");
  const [freshness, setFreshness] = useState("");
  const [rerankModelId, setRerankModelId] = useState("");
  const [chatModelId, setChatModelId] = useState("");
  const [embeddingModelId, setEmbeddingModelId] = useState("");
  const [includeRaw, setIncludeRaw] = useState(false);
  const [skipCache, setSkipCache] = useState(true);
  const [queryExpansion, setQueryExpansion] = useState(false);
  const [queryError, setQueryError] = useState(false);
  const [state, dispatch] = useReducer(labReducer, initialLabState);
  const [taskIdInput, setTaskIdInput] = useState("");
  const [taskRecord, setTaskRecord] = useState<SearchTaskRecord | null>(null);
  const [taskError, setTaskError] = useState<ApiError | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [cancellingTask, setCancellingTask] = useState(false);
  const [readerResult, setReaderResult] = useState<SearchResult | null>(null);
  const [routePreview, setRoutePreview] = useState<SearchResponse["route"]>();
  const readerCache = useRef(new Map<string, WebReadResponse>());
  const abortRef = useRef<AbortController | null>(null);
  const queryRef = useRef<HTMLTextAreaElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);
  const cancelGuard = useRef(false);
  const taskIdRef = useRef<string | null>(null);
  const elapsed = useElapsed(state.startedAt);
  const copy = useCopy();

  const strategy = picker.startsWith("strategy:") ? picker.slice(9) as SearchStrategy : null;
  const legacyMode = picker.startsWith("mode:") ? picker.slice(5) as SearchMode : null;
  const expansionAvailable = strategy !== null && strategy !== "fast";
  const modelsByKind = useMemo(() => {
    const groups: Record<"chat" | "embedding" | "rerank", ModelConfig[]> = { chat: [], embedding: [], rerank: [] };
    for (const model of modelsResource.data ?? []) if (model.enabled) groups[model.kind].push(model);
    return groups;
  }, [modelsResource.data]);
  const eligible = useMemo(() => providers.filter((provider) => provider.enabled && provider.ready !== false), [providers]);
  const missingLegacyModels = legacyMode ? (legacyModels[legacyMode] ?? []).filter((kind) => modelsByKind[kind].length === 0) : [];
  const noModelsKnown = modelsResource.data !== undefined;
  const legacyBlocked = noModelsKnown && missingLegacyModels.length > 0;
  const missingOptionalModel = strategy === "quality" ? modelsByKind.rerank.length === 0 : strategy && queryExpansion ? modelsByKind.chat.length === 0 : false;
  const providersBlocked = providerMode === "manual" ? eligible.length === 0 : eligible.length === 0;
  const running = state.status === "running";

  useEffect(() => {
    if (selectionInitialized || providers.length === 0) return;
    setSelected(providers.filter((provider) => provider.enabled && provider.ready !== false).map((provider) => provider.id));
    setSelectionInitialized(true);
  }, [providers, selectionInitialized]);

  useEffect(() => {
    if (!strategy || !query.trim() || running) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api.previewSearchRoute({ query: query.trim(), strategy }, controller.signal)
        .then((preview) => setRoutePreview(preview.route ?? (preview.selected ? { selected: preview.selected, ruleId: "preview" } : undefined)))
        .catch(() => undefined);
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, strategy, running]);

  const setSelection = (value: PickerValue) => {
    setPicker(value);
    if (value.startsWith("strategy:")) setProviderMode("auto");
    if (value === "strategy:fast") setQueryExpansion(false);
  };

  const run = async () => {
    if (running || cancelGuard.current) return;
    setQueryError(false);
    if (!query.trim()) {
      setQueryError(true);
      queryRef.current?.focus();
      toast.error({ title: t("lab.queryRequired") });
      return;
    }
    if (providerMode === "manual" && selected.length === 0) {
      providerRef.current?.focus();
      toast.error({ title: t("lab.providers"), description: t("lab.providersHint") });
      return;
    }
    if (providersBlocked) {
      providerRef.current?.focus();
      toast.error({ title: t("lab.provider.none") });
      return;
    }
    if (legacyBlocked) {
      toast.error({ title: t("lab.strategy.legacyBlocked") });
      return;
    }
    const numericLimit = Number(limit);
    if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 100) {
      toast.error({ title: t("providers.form.rangeError", { label: t("lab.limit"), min: 1, max: 100 }) });
      return;
    }
    const numericTimeout = timeoutMs.trim() ? Number(timeoutMs) : undefined;
    if (numericTimeout !== undefined && (!Number.isInteger(numericTimeout) || numericTimeout < 1000 || numericTimeout > 120000)) {
      toast.error({ title: t("providers.form.rangeError", { label: t("lab.timeout"), min: 1000, max: 120000 }) });
      return;
    }
    const request = buildLabRequest({ query, picker, limit: numericLimit, selected, providerMode, includeRaw, skipCache, queryExpansion, timeoutMs: numericTimeout, language, freshness, rerankModelId, chatModelId, embeddingModelId });
    const controller = new AbortController();
    abortRef.current = controller;
    taskIdRef.current = null;
    cancelGuard.current = false;
    const startedAt = Date.now();
    dispatch({ type: "start", request, startedAt });
    try {
      if (strategy) {
        try {
          const finalResponse = await api.searchStream(request, {
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "meta" && event.data.taskId) {
                taskIdRef.current = event.data.taskId;
                setTaskIdInput(event.data.taskId);
              }
              dispatch({ type: "event", event });
            },
          });
          if (controller.signal.aborted) dispatch({ type: "cancel" });
          else dispatch({ type: "complete", response: finalResponse, clientDuration: Date.now() - startedAt });
        } catch (caught) {
          if (!(caught instanceof SearchStreamUnsupportedError)) throw caught;
          dispatch({ type: "event", event: { type: "status", data: { status: "finalizing" } } });
          const fallbackRequest = { ...request };
          delete fallbackRequest.stream;
          const finalResponse = await api.search(fallbackRequest, controller.signal);
          dispatch({ type: "complete", response: finalResponse, clientDuration: Date.now() - startedAt, fallback: true });
        }
      } else {
        const finalResponse = await api.search(request, controller.signal);
        dispatch({ type: "complete", response: finalResponse, clientDuration: Date.now() - startedAt });
      }
    } catch (caught) {
      const cancelled = isAbortError(caught) || controller.signal.aborted || (caught instanceof ApiError && caught.code === "cancelled");
      dispatch({ type: "error", error: toApiError(caught), cancelled });
    } finally {
      abortRef.current = null;
      cancelGuard.current = false;
    }
  };

  const cancel = async () => {
    if (!running || cancelGuard.current) return;
    cancelGuard.current = true;
    dispatch({ type: "cancel" });
    const knownTaskId = taskIdRef.current;
    try {
      if (knownTaskId) await api.cancelSearchTask(knownTaskId);
    } catch (caught) {
      toast.error({ title: toApiError(caught).message });
    } finally {
      abortRef.current?.abort();
    }
  };

  const loadTask = async () => {
    const id = taskIdInput.trim();
    if (!id) return toast.error({ title: t("lab.task.idRequired") });
    setTaskLoading(true); setTaskError(null); setTaskRecord(null);
    try {
      const record = await api.searchTask(id);
      setTaskRecord(record);
      if (record.response) dispatch({ type: "complete", response: record.response, clientDuration: record.durationMs ?? 0 });
      toast.success({ title: t("lab.task.loaded") });
    } catch (caught) { setTaskError(toApiError(caught)); }
    finally { setTaskLoading(false); }
  };
  const cancelTask = async () => {
    const id = taskIdInput.trim();
    if (!id) return toast.error({ title: t("lab.task.idRequired") });
    setCancellingTask(true);
    try {
      const result = await api.cancelSearchTask(id);
      if (result.ok) toast.success({ title: t("lab.task.cancelled") });
      else toast.info({ title: t("lab.task.notCancelled") });
    } catch (caught) { const error = toApiError(caught); toast.error({ title: error.message, description: error.code }); }
    finally { setCancellingTask(false); }
  };

  const response = state.response;
  const visibleResults = state.provisional.length > 0 ? state.provisional : response?.results ?? [];
  const provisional = !response && visibleResults.length > 0;

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader title={t("lab.title")} description={t("lab.subtitle")}
        meta={<span className="inline-flex items-center gap-1"><FlaskConical className="size-3.5" aria-hidden />{t("lab.strategyHint")}</span>} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <Card>
            <CardHeader><div><CardTitle>{t("lab.query")}</CardTitle><CardDescription>{t("lab.strategyHint")}</CardDescription></div></CardHeader>
            <CardContent className="space-y-3">
              <Field label={t("lab.query")} htmlFor="lab-query" required error={queryError ? t("lab.queryRequired") : undefined}>
                <Textarea ref={queryRef} id="lab-query" rows={3} maxLength={2000} value={query}
                  onChange={(event) => { setQuery(event.target.value); setQueryError(false); }} placeholder={t("lab.queryPlaceholder")}
                  onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void run(); } }} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("lab.strategy")} htmlFor="lab-mode" hint={strategy ? t(`lab.strategy.${strategy}`) : t("lab.strategy.legacy")}>
                  <Select id="lab-mode" value={picker} onChange={(event) => setSelection(event.target.value as PickerValue)}>
                    <optgroup label={t("lab.strategy.presets")}>
                      {strategies.map((item) => <option key={item} value={`strategy:${item}`}>{t(`lab.strategy.${item}`)}</option>)}
                    </optgroup>
                    <optgroup label={t("lab.strategy.legacy")}>
                      {modes.map((item) => <option key={item} value={`mode:${item}`}>{searchModeLabel(item)}</option>)}
                    </optgroup>
                  </Select>
                </Field>
                <Field label={t("lab.limit")} htmlFor="lab-limit"><Input id="lab-limit" type="number" min={1} max={100} value={limit} onChange={(event) => setLimit(event.target.value)} /></Field>
              </div>
              {legacyBlocked ? <Alert tone="error" title={t("lab.strategy.legacyBlocked")} /> : null}
              {missingOptionalModel && noModelsKnown ? <Alert tone="warning" title={strategy === "quality" ? t("lab.strategy.modelWarning") : t("lab.expansion.noModel")} /> : null}

              <div ref={providerRef} tabIndex={-1} className="space-y-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="text-xs font-medium">{t("lab.providers")}</span>
                  <div className="flex rounded-md border p-0.5" role="group" aria-label={t("lab.providers")}>
                    {(["auto", "manual"] as const).map((item) => <button key={item} type="button" aria-pressed={providerMode === item}
                      className={`min-h-9 rounded px-2 text-[11px] ${providerMode === item ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
                      onClick={() => setProviderMode(item)}>{t(`lab.provider.${item}`)}</button>)}
                  </div>
                </div>
                {providerMode === "auto" ? <p className="text-[11px] text-muted-foreground">{t("lab.provider.autoHint")}</p> : null}
                {providersResource.loading && !providersResource.data ? <Skeleton className="h-20" /> : null}
                {providersResource.error ? <Alert tone="error" title={`${providersResource.error.code}: ${providersResource.error.message}`} /> : null}
                {!providersResource.loading && providers.length === 0 ? <Alert tone="warning" title={t("lab.provider.none")} /> : null}
                {providersBlocked && providers.length > 0 ? <Alert tone="warning" title={t("lab.provider.allExcluded")} /> : null}
                <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border p-1.5">
                  {providers.map((provider) => {
                    const ready = provider.enabled && provider.ready !== false;
                    const autoCandidate = eligible.slice(0, 8).some((item) => item.id === provider.id);
                    const reason = !provider.enabled ? t("common.disabled") : !ready ? provider.notReadyReason ?? t("lab.provider.unavailable") : !autoCandidate ? t("lab.provider.candidateLimit") : t("lab.provider.ready");
                    return <label key={provider.id} className={`flex min-h-11 items-center gap-2 rounded px-1.5 py-1 text-sm ${providerMode === "manual" && ready ? "cursor-pointer hover:bg-accent/50" : "opacity-70"}`}>
                      <input type="checkbox" className="size-4 accent-primary" disabled={providerMode === "auto" || !ready}
                        checked={providerMode === "auto" ? autoCandidate : selected.includes(provider.id)}
                        onChange={() => setSelected((current) => current.includes(provider.id) ? current.filter((id) => id !== provider.id) : [...current, provider.id])} />
                      <span className="min-w-0 flex-1"><span className="block truncate">{provider.name}</span><span className="block text-[10px] text-muted-foreground">{reason}</span></span>
                      <span className="font-mono text-[10px] text-muted-foreground">{provider.type}</span>
                    </label>;
                  })}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
                  <span>{t("lab.selectedCount", { count: providerMode === "auto" ? Math.min(8, eligible.length) : selected.length, total: providers.length })}</span>
                  {providerMode === "manual" ? <div className="flex gap-2">
                    <button type="button" className="min-h-9 underline" onClick={() => setSelected(eligible.map((provider) => provider.id))}>{t("lab.selectAll")}</button>
                    <button type="button" className="min-h-9 underline" onClick={() => setSelected([])}>{t("lab.clearAll")}</button>
                  </div> : null}
                </div>
                {state.selectedProviderIds ? <p className="text-[11px]">{t("lab.provider.requestedSelected", { requested: providerMode === "auto" ? "—" : selected.length, selected: state.selectedProviderIds.length })}</p> : null}
                {state.excludedProviders?.length ? <ul className="space-y-1 text-[11px] text-warning">{state.excludedProviders.map((item) => <li key={item.providerId}>{item.providerName ?? item.providerId}: {item.reason}</li>)}</ul> : null}
              </div>

              <Collapsible summary={t("lab.advanced")}>
                <div className="space-y-3">
                  {expansionAvailable ? <div className="flex items-start justify-between gap-3 rounded-md border p-2.5">
                    <div><p className="text-xs font-medium">{t("lab.expansion.enabled")}</p><p className="text-[10px] text-muted-foreground">{t("lab.expansion.hint")}</p></div>
                    <Switch checked={queryExpansion} onChange={setQueryExpansion} label={t("lab.expansion.enabled")} />
                  </div> : null}
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t("lab.timeout")} htmlFor="lab-timeout" hint={t("lab.timeoutHint")}><Input id="lab-timeout" type="number" min={1000} max={120000} value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} placeholder="15000" /></Field>
                    <Field label={t("lab.freshness")} htmlFor="lab-freshness"><Select id="lab-freshness" value={freshness} onChange={(event) => setFreshness(event.target.value)}>{freshnessOptions.map((option) => <option key={option || "none"} value={option}>{option === "" ? t("providers.freshness.null") : freshnessLabel(option)}</option>)}</Select></Field>
                  </div>
                  <Field label={t("lab.language")} htmlFor="lab-language"><Input id="lab-language" value={language} maxLength={24} onChange={(event) => setLanguage(event.target.value)} placeholder={t("lab.languagePlaceholder")} /></Field>
                  <Field label={t("lab.rerankModel")} htmlFor="lab-rerank-model"><Select id="lab-rerank-model" value={rerankModelId} onChange={(event) => setRerankModelId(event.target.value)}><option value="">{t("lab.modelDefault")}</option>{modelsByKind.rerank.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.modelId})</option>)}</Select></Field>
                  <Field label={t("lab.chatModel")} htmlFor="lab-chat-model"><Select id="lab-chat-model" value={chatModelId} onChange={(event) => setChatModelId(event.target.value)}><option value="">{t("lab.modelDefault")}</option>{modelsByKind.chat.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.modelId})</option>)}</Select></Field>
                  <Field label={t("lab.embeddingModel")} htmlFor="lab-embedding-model"><Select id="lab-embedding-model" value={embeddingModelId} onChange={(event) => setEmbeddingModelId(event.target.value)}><option value="">{t("lab.modelDefault")}</option>{modelsByKind.embedding.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.modelId})</option>)}</Select></Field>
                  <Field label={t("lab.cache.title")} htmlFor="lab-cache"><Select id="lab-cache" value={skipCache ? "bypass" : "allow"} onChange={(event) => setSkipCache(event.target.value === "bypass")}><option value="bypass">{t("lab.cache.bypass")}</option><option value="allow">{t("lab.cache.allow")}</option></Select></Field>
                  <label className="flex min-h-11 items-start gap-2 rounded-md border bg-muted/20 px-2.5 py-2"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={includeRaw} onChange={(event) => setIncludeRaw(event.target.checked)} /><span><span className="block text-xs font-medium">{t("lab.includeRaw")}</span><span className="block text-[10px] text-muted-foreground">{t("lab.includeRawHint")}</span></span></label>
                  {modelsResource.error ? <p className="text-[11px] text-warning">{t("models.title")}: {modelsResource.error.message}</p> : null}
                </div>
              </Collapsible>
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-11 flex-1" loading={running} disabled={providersBlocked || legacyBlocked} onClick={() => void run()}>{running ? <><Clock3 aria-hidden />{t("lab.running")} {formatMs(elapsed)}</> : <><Play aria-hidden />{t("lab.run")}</>}</Button>
                {running ? <Button variant="outline" className="min-h-11 min-w-11" onClick={() => void cancel()}><Square aria-hidden />{t("lab.cancel")}</Button> : null}
              </div>
              <p className="text-[10px] text-muted-foreground">{t("common.keyShortcut")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>{t("lab.task.title")}</CardTitle><CardDescription>{t("lab.task.desc")}</CardDescription></div></CardHeader>
            <CardContent className="space-y-2.5">
              <div className="flex gap-1.5"><Input value={taskIdInput} onChange={(event) => setTaskIdInput(event.target.value)} placeholder={t("lab.task.idPlaceholder")} aria-label={t("lab.result.taskId")} className="font-mono text-xs" /><Button variant="outline" size="sm" loading={taskLoading} onClick={() => void loadTask()}>{t("lab.task.load")}</Button></div>
              <div className="flex flex-wrap gap-1.5"><Button variant="outline" size="sm" loading={cancellingTask} onClick={() => void cancelTask()}>{t("lab.task.cancel")}</Button>{taskIdInput ? <Button variant="ghost" size="sm" onClick={() => void copy.copy(taskIdInput)}><Copy aria-hidden />{copy.copied ? t("common.copied") : t("common.copy")}</Button> : null}</div>
              {taskError ? <Alert tone="error" title={`${taskError.code}: ${taskError.message}`} /> : null}
              {taskRecord ? <div className="space-y-1 rounded-md border bg-muted/20 p-2.5 text-[11px]">
                <p>{t("lab.result.taskId")}: <InlineCode>{taskRecord.id}</InlineCode></p><p>{t("lab.task.status")}: <SearchStatusBadge status={taskRecord.status} /></p>
                <p>{t("lab.result.duration")}: {formatMs(taskRecord.durationMs)}</p>{!taskRecord.response ? <p>{t("lab.task.noResponse")}</p> : null}
              </div> : null}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4" aria-live="polite" aria-busy={running}>
          {state.error && state.status !== "cancelled" ? <Alert tone="error" title={`${state.error.code}: ${state.error.message}`}>{state.error.details ? <JsonPreview value={state.error.details} /> : null}</Alert> : null}
          {state.fallback ? <Alert tone="info" title={t("lab.stream.fallback")} /> : null}
          {state.status === "cancelled" ? <Alert tone="warning" title={t("searchStatus.cancelled")}>{t("lab.stream.cancelledHint")}</Alert> : null}
          {running ? <RunProgress state={state} elapsed={elapsed} onCancel={() => void cancel()} /> : null}
          {strategy ? <RouteSummary route={state.route ?? routePreview} /> : null}
          {(state.expansions.length > 0 || response?.queryExpansion || response?.debug?.queryOrigins) && response ? <QueryExpansionPanel response={response} /> : null}
          {response ? <SearchResultPanel response={response} clientDuration={state.clientDuration} request={state.request} skipCache={state.request?.skipCache ?? skipCache} onRead={setReaderResult} /> : null}
          {!response && visibleResults.length > 0 ? <ResultsCard results={visibleResults} provisional={provisional} cancelled={state.status === "cancelled"} onRead={setReaderResult} /> : null}
          {!response && !running && visibleResults.length === 0 ? <EmptyState icon={Search} title={t("lab.empty")} description={t("lab.emptyDesc")} className="py-16" /> : null}
        </div>
      </div>
      {readerResult ? <ReaderDrawer key={`${readerResult.id}-${readerResult.url}`} result={readerResult} cache={readerCache.current} onClose={() => setReaderResult(null)} /> : null}
    </div>
  );
}

function RunProgress({ state, elapsed, onCancel }: { state: LabViewState; elapsed: number; onCancel: () => void }) {
  const percent = state.completed !== null && state.total !== null && state.total > 0 ? state.completed / state.total * 100 : null;
  return <Card>
    <CardHeader><div><CardTitle>{t("lab.status.running")}</CardTitle><CardDescription>{t("lab.result.duration")} {formatMs(elapsed)} · {state.stage ? `${t("lab.stream.stage")}: ${state.stage}` : t("lab.stream.indeterminate")}</CardDescription></div><Button variant="outline" className="min-h-11" onClick={onCancel}><Square aria-hidden />{t("lab.cancel")}</Button></CardHeader>
    <CardContent className="space-y-3">
      <Progress value={percent} label={percent === null ? t("lab.stream.indeterminate") : t("lab.stream.progress", { completed: state.completed ?? 0, total: state.total ?? 0 })} />
      {percent === null ? <p className="text-[11px] text-muted-foreground">{t("lab.stream.indeterminate")}</p> : null}
      <ol className="flex flex-wrap gap-1 text-[10px]">{stages.map((stage) => <li key={stage}><Badge tone={state.stage === stage ? "info" : "muted"}>{stage}</Badge></li>)}</ol>
      {state.providerStates.length > 0 ? <div className="overflow-x-auto"><table className="w-full min-w-[420px] text-xs"><thead><tr><th className="text-left">{t("lab.stream.providers")}</th><th>{t("common.status")}</th><th>{t("lab.result.latency")}</th><th>{t("lab.result.results")}</th></tr></thead><tbody>{state.providerStates.map((provider) => <tr key={provider.providerId} className="border-t"><td className="py-2">{provider.providerName ?? provider.providerId}{provider.reason ? <span className="block text-[10px] text-muted-foreground">{provider.reason}</span> : null}</td><td><Badge tone={provider.state === "success" ? "success" : provider.state === "failed" ? "destructive" : "muted"}>{provider.state ?? "unknown"}</Badge></td><td className="text-right font-mono">{formatMs(provider.latencyMs)}</td><td className="text-right font-mono">{provider.resultCount ?? "—"}</td></tr>)}</tbody></table></div> : null}
    </CardContent>
  </Card>;
}

function RouteSummary({ route }: { route?: SearchResponse["route"] }) {
  return <Card><CardHeader><div><CardTitle>{t("lab.route.title")}</CardTitle><CardDescription>{route?.reason}</CardDescription></div>{route ? <Badge tone="info">{route.selected}</Badge> : null}</CardHeader>
    {route ? <CardContent className="space-y-2 text-xs">
      {route.selected ? <Badge tone="info">{route.selected}</Badge> : null}
      {route.ruleId ? <p>{t("lab.route.rule")}: <InlineCode>{route.ruleId}</InlineCode></p> : null}
      {(route.matchedSignals?.length || route.matchedRules?.length) ? <p>{t("lab.route.signals")}: {(route.matchedSignals ?? route.matchedRules)?.join(", ")}</p> : null}
      {route.considered?.length ? <p>{t("lab.route.considered")}: {route.considered.join(", ")}</p> : null}
      {(route.selectedProviderCount !== undefined || route.requestedProviderCount !== undefined) ? <p>{t("lab.provider.requestedSelected", { requested: route.requestedProviderCount ?? "—", selected: route.selectedProviderCount ?? "—" })}</p> : null}
      {route.decisions?.length ? <ul className="space-y-1">{route.decisions.map((decision) => <li key={decision.providerId} className="break-words rounded border p-1.5"><span className="font-mono">{decision.providerId}</span> · {decision.reasons.join("; ")}</li>)}</ul> : null}
      {!route.selected && !route.ruleId && !route.decisions?.length ? <p className="text-muted-foreground">{t("lab.route.empty")}</p> : null}
    </CardContent> : <CardContent><p className="text-xs text-muted-foreground">{t("lab.route.empty")}</p></CardContent>}
  </Card>;
}

function QueryExpansionPanel({ response }: { response: SearchResponse }) {
  const origins = expansionQueries(response);
  const original = response.query.trim();
  const seen = new Set<string>();
  const queries = origins.filter((origin) => {
    const text = origin.query?.trim();
    if (!text || seen.has(text)) return false;
    seen.add(text); return true;
  }).slice(0, 4);
  if (!queries.some((query) => query.query === original)) queries.unshift({ query: original, original: true, round: 1 });
  const rounds = queries.reduce((max, query) => Math.max(max, query.round ?? 0), 0);
  const providerQueries = response.results.reduce((sum, item) => sum + (item.queryOrigins?.length ?? 0), 0);
  const httpCounts = response.stats.providers.map((provider) => provider.httpRequests);
  const httpRequests = httpCounts.length > 0 && httpCounts.every((count) => count !== undefined) ? httpCounts.reduce((sum, count) => sum + (count ?? 0), 0) : undefined;
  const budget = {
    subqueries: response.deepBudget?.subqueries ?? (queries.length || undefined),
    rounds: response.deepBudget?.rounds ?? (rounds || undefined),
    providerQueries: response.deepBudget?.providerQueries ?? (providerQueries || undefined),
    httpRequests: response.deepBudget?.httpRequests ?? httpRequests,
    exhausted: response.deepBudget?.exhausted ?? ((queries.length >= 4 || rounds >= 2 || providerQueries >= 32 || (httpRequests ?? 0) >= 64)),
  };
  return <Card><CardHeader><CardTitle>{t("lab.expansion.title")}</CardTitle></CardHeader><CardContent className="space-y-3">
    <ul className="flex flex-wrap gap-1.5">{queries.map((query, index) => <li key={`${query.query}-${index}`} className="rounded-md border px-2 py-1 text-xs"><Badge tone={index === 0 ? "info" : "outline"}>{index === 0 ? t("lab.expansion.original") : t("lab.strategy.deep")}</Badge> {query.query} {query.round ? <span className="text-muted-foreground">{t("lab.expansion.round", { round: query.round })}</span> : null}{query.weight !== undefined ? ` · ${query.weight}` : ""}{query.language ? ` · ${query.language}` : ""}</li>)}</ul>
    {origins.length > queries.length ? <p className="text-[11px] text-muted-foreground">{t("lab.expansion.deduped")}</p> : null}
    {response.strategy === "deep" || response.mode === "deep" ? <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[["subqueries", 4], ["rounds", 2], ["providerQueries", 32], ["httpRequests", 64]].map(([key]) => <div key={key} className="rounded-md border p-2"><p className="text-[10px] text-muted-foreground">{t(`lab.budget.${key}` as MessageKey)}</p><p className="font-mono text-sm">{budget?.[key as keyof typeof budget] ?? "—"}</p></div>)}</div> : null}
    {budget?.exhausted ? <Alert tone="warning" title={t("lab.budget.exhausted")} /> : null}
  </CardContent></Card>;
}

function FunnelPanel({ response }: { response: SearchResponse }) {
  if (!response.stats.funnel) return null;
  const values = funnelValues(response.stats.funnel);
  const consistent = funnelConsistent(response.stats.funnel);
  const rows = [["raw", values.raw], ["invalid", values.invalid], ["duplicates", values.duplicates ?? (values.exact !== undefined || values.nearTitle !== undefined ? (values.exact ?? 0) + (values.nearTitle ?? 0) : undefined)], ["truncated", values.truncated], ["rerankInput", values.rerankInput], ["final", values.final]] as const;
  return <Card><CardHeader><CardTitle>{t("lab.funnel.title")}</CardTitle></CardHeader><CardContent className="space-y-2">
    {consistent === false ? <Alert tone="warning" title={t("lab.funnel.mismatch")} /> : null}
    {consistent === null ? <p className="text-xs text-muted-foreground">{t("lab.funnel.unknown")}</p> : null}
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{rows.map(([key, value]) => <div key={key} className="rounded-md border p-2"><p className="text-[10px] text-muted-foreground">{t(`lab.funnel.${key}` as MessageKey)}</p><p className="font-mono text-sm">{value === undefined ? "—" : formatNumber(value)}</p></div>)}</div>
  </CardContent></Card>;
}

function ContributionPanel({ response }: { response: SearchResponse }) {
  const rows = sourceContributions(response);
  const total = response.results.length;
  return <Card><CardHeader><div><CardTitle>{t("lab.contribution.title")}</CardTitle><CardDescription>{t("lab.contribution.hint")}</CardDescription></div></CardHeader><CardContent>
    <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[620px] text-xs"><thead className="bg-muted/40"><tr>{["Provider", "raw", "dropped", "final", "topK", "failure"].map((key, index) => <th key={key} className="px-2 py-2 text-left font-medium">{index === 0 ? key : t(`lab.contribution.${key}` as MessageKey)}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.providerId} className="border-t align-top"><td className="sticky left-0 bg-card px-2 py-2"><p>{row.providerName}</p><div className="mt-1 h-1.5 w-24 rounded bg-muted" aria-label={`${row.providerName}: ${row.finalCount}/${total}`}><div className="h-full rounded bg-info" style={{ width: `${total ? row.finalCount / total * 100 : 0}%` }} /></div></td><td className="px-2 py-2 font-mono">{row.rawCount ?? "—"}</td><td className="px-2 py-2 font-mono">{row.duplicatesDropped ?? "—"}</td><td className="px-2 py-2 font-mono">{row.finalCount}</td><td className="px-2 py-2 font-mono">{row.topKCount}</td><td className="max-w-[220px] px-2 py-2">{row.failed || row.skipped || row.reason ? <><Badge tone={row.failed ? "destructive" : "warning"}>{row.failed ? t("common.failed") : row.skipped ? t("lab.contribution.failure") : t("common.status")}</Badge>{row.reason ? <p className="mt-1 text-[10px] text-muted-foreground">{row.reason}</p> : null}</> : "—"}</td></tr>)}</tbody></table></div>
  </CardContent></Card>;
}

function movementBadge(row: ComparisonRow) {
  if (row.movement === "up") return <Badge tone="success">{t("lab.compare.up", { count: row.delta ?? 0 })}</Badge>;
  if (row.movement === "down") return <Badge tone="warning">{t("lab.compare.down", { count: Math.abs(row.delta ?? 0) })}</Badge>;
  return <Badge tone="muted">{t(`lab.compare.${row.movement === "same" ? "same" : row.movement === "entered" ? "entered" : "exited"}`)}</Badge>;
}

function RankingComparison({ response }: { response: SearchResponse }) {
  const comparison = response.debug?.rerankComparison;
  const [filter, setFilter] = useState("all");
  if (!response.stats.rerankApplied) return <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">{t("lab.compare.notApplied")}</p></CardContent></Card>;
  if (!comparison) return <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">{t("lab.compare.noData")}</p></CardContent></Card>;
  const all = rankingComparison(comparison.before, comparison.after);
  const filtered = all.filter((row) => filter === "all" || (filter === "changed" ? row.movement !== "same" : row.movement === "entered" || row.movement === "exited"));
  const rows = filtered.slice(0, 20);
  return <Card><CardHeader><div><CardTitle>{t("lab.compare.title")}</CardTitle><CardDescription>{t("lab.compare.note")}</CardDescription></div><Select aria-label={t("lab.compare.title")} className="w-36" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">{t("lab.compare.all")}</option><option value="changed">{t("lab.compare.changed")}</option><option value="enterExit">{t("lab.compare.enterExit")}</option></Select></CardHeader><CardContent>
    {rows.length === 0 ? <p className="text-xs text-muted-foreground">{t("lab.compare.noData")}</p> : <ol className="space-y-2">{rows.map((row) => <li key={row.key} className="grid gap-2 rounded-md border p-2 sm:grid-cols-2"><div><p className="text-[10px] text-muted-foreground">{t("lab.compare.before")} · {row.before ?? "—"}</p><a href={row.url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 text-xs hover:underline">{row.title}</a></div><div><div className="flex items-center justify-between gap-2"><p className="text-[10px] text-muted-foreground">{t("lab.compare.after")} · {row.after ?? "—"}</p>{movementBadge(row)}</div><p className="line-clamp-2 break-all text-xs sm:hidden">{row.title}</p></div></li>)}</ol>}
    {filtered.length > 20 ? <p className="mt-2 text-[11px] text-muted-foreground">{t("lab.compare.more", { count: filtered.length - 20 })}</p> : null}
  </CardContent></Card>;
}

function CacheBadge({ response, skipCache }: { response: SearchResponse; skipCache: boolean }) {
  const label = skipCache ? t("lab.cache.bypassed") : response.stats.cached === true ? t("lab.cache.hit") : response.stats.cached === false ? t("lab.cache.miss") : t("lab.cache.unknown");
  return <Badge tone={skipCache ? "muted" : response.stats.cached === true ? "success" : response.stats.cached === false ? "info" : "outline"}>{t("lab.cache.title")}: {label}</Badge>;
}

function SearchResultPanel({ response, clientDuration, request, skipCache, onRead }: { response: SearchResponse; clientDuration: number | null; request: SearchRequest | null; skipCache: boolean; onRead: (result: SearchResult) => void }) {
  const toast = useToast(); const copy = useCopy();
  const copyJson = async () => { const ok = await copy.copy(prettyJson(withoutRawPayloads(response))); if (ok) toast.success({ title: t("common.copied") }); else toast.error({ title: t("common.copyFailed") }); };
  const timing = response.stats.timing;
  const allFailed = response.status === "failed" || (response.results.length === 0 && response.failedSources.length > 0);
  const timingItems = [["totalMs", timing.totalMs], ["fanoutMs", timing.fanoutMs], ["fusionMs", timing.fusionMs], ["rerankMs", timing.rerankMs], ["embeddingMs", timing.embeddingMs], ["summaryMs", timing.summaryMs]] as const;
  return <div className="space-y-4">
    <Card><CardHeader><div className="min-w-0"><div className="flex flex-wrap gap-1.5"><SearchStatusBadge status={response.status} /><Badge tone="outline">{response.strategy ?? (response.mode ? searchModeLabel(response.mode) : "—")}</Badge><Badge tone="success">{t("lab.stream.final")}</Badge>{response.stats.partial ? <Badge tone="warning">{t("states.partial")}</Badge> : null}<CacheBadge response={response} skipCache={skipCache} /></div><CardTitle className="mt-2 break-words text-base">{response.query}</CardTitle><CardDescription>{t("lab.result.statusLine", { status: t(`searchStatus.${response.status}`), duration: formatMs(timing.totalMs), count: response.results.length })} · {t("lab.result.duration")} {formatMs(clientDuration)}</CardDescription><p className="mt-1 text-[10px] text-muted-foreground">{t("lab.result.taskId")}: <InlineCode>{response.taskId}</InlineCode></p></div><div className="flex shrink-0 flex-wrap gap-1.5"><Button size="sm" variant="outline" className="min-h-11" onClick={() => void copyJson()}><Copy aria-hidden />{t("lab.result.copyJson")}</Button><Button size="sm" variant="outline" className="min-h-11" onClick={() => downloadJson(`search-${response.taskId}.json`, withoutRawPayloads(response))}><Download aria-hidden />{t("lab.result.downloadJson")}</Button></div></CardHeader><CardContent className="space-y-3">
      {allFailed ? <Alert tone="error" title={t("lab.status.allFailed")} /> : null}
      {response.status === "completed" && response.results.length === 0 ? <Alert tone="info" title={t("lab.status.emptySuccess")} /> : null}
      {response.degradations?.length ? <Alert tone="warning" title={t("states.partial")}><ul>{response.degradations.map((item, index) => <li key={index}>{item.stage}: {item.reason} {item.fallback ? `→ ${item.fallback}` : ""}</li>)}</ul></Alert> : null}
      <div className="flex flex-wrap gap-1.5 text-[11px]"><Timer className="size-3" aria-hidden />{timingItems.map(([key, value]) => value !== undefined ? <Badge key={key} tone="outline">{t(`lab.result.${key}` as MessageKey)} {formatMs(value)}</Badge> : null)}</div>
      {response.errors.length ? <Alert tone="warning" title={t("lab.result.errors")}><ul>{response.errors.map((error, index) => <li key={index}><span className="font-medium">{error.providerName}</span> [{error.code}] {error.message}</li>)}</ul></Alert> : null}
    </CardContent></Card>
    <FunnelPanel response={response} /><ContributionPanel response={response} /><RankingComparison response={response} />
    <ResultsCard results={response.results} provisional={false} onRead={onRead} origins={response.debug?.queryOrigins} />
    {response.answers?.[0] ? <AnswerPanel answer={response.answers[0]} /> : null}
    {response.summary ? <Card><CardHeader><CardTitle>{t("lab.result.summary")}</CardTitle>{response.summary.degraded ? <Badge tone="warning">{t("lab.result.summaryDegraded")}</Badge> : null}</CardHeader><CardContent><p className="whitespace-pre-wrap text-sm">{response.summary.text}</p></CardContent></Card> : null}
    <Card><CardHeader><CardTitle>{t("lab.result.providerStats")}</CardTitle></CardHeader><CardContent><div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[720px] text-xs"><thead className="bg-muted/40"><tr>{[t("lab.result.provider"), t("common.status"), t("lab.result.latency"), t("lab.result.results"), t("lab.result.attempts"), t("lab.result.error")].map((label) => <th key={label} className="px-2 py-2 text-left font-medium">{label}</th>)}</tr></thead><tbody>{response.stats.providers.map((stat) => <tr key={stat.providerId} className="border-t"><td className="px-2 py-2">{stat.providerName}</td><td><Badge tone={stat.ok ? "success" : "destructive"}>{stat.ok ? t("common.success") : t("common.failed")}</Badge></td><td className="font-mono">{formatMs(stat.latencyMs)}</td><td className="font-mono">{stat.resultCount}</td><td className="font-mono">{stat.attempts}</td><td>{stat.errorCode ?? stat.warning ?? "—"}</td></tr>)}</tbody></table></div></CardContent></Card>
    <Collapsible summary={t("lab.result.debug")}><div className="space-y-3"><JsonPreview value={request ?? withoutRawPayloads(response)} />{response.debug?.providerQueries?.length ? <JsonPreview value={response.debug.providerQueries} /> : null}{response.debug?.droppedDuplicates?.length ? <JsonPreview value={response.debug.droppedDuplicates} /> : null}<JsonPreview value={timing} /></div></Collapsible>
  </div>;
}

function AnswerPanel({ answer }: { answer: GroundedAnswer }) {
  const signals: Array<[string, boolean | "unknown"]> = [["toolProvided", answer.status.toolProvided], ["toolInvoked", answer.status.toolInvoked], ["retrievalSucceeded", answer.status.retrievalSucceeded], ["hasVerifiableSources", answer.status.hasVerifiableSources], ["answerSupported", answer.status.answerSupported]];
  return <Card><CardHeader><div><CardTitle>{t("lab.answers")}</CardTitle><CardDescription>{answer.provider}{answer.model ? ` · ${answer.model}` : ""}</CardDescription></div>{answer.status.toolInvoked === "unknown" ? <Badge tone="muted">{t("lab.answers.stateUnknown")}</Badge> : null}</CardHeader><CardContent className="space-y-3"><div className="grid gap-2 sm:grid-cols-2">{signals.map(([key, value]) => <div key={key} className="flex justify-between rounded border p-2 text-xs"><span>{t(`lab.answers.grid.${key}` as MessageKey)}</span><Badge tone={value === true ? "success" : value === "unknown" ? "muted" : "warning"}>{value === true ? t("lab.answers.value.yes") : value === "unknown" ? t("lab.answers.value.unknown") : t("lab.answers.value.no")}</Badge></div>)}</div><p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.text}</p>{answer.citations.map((citation, index) => <a key={index} href={citation.url} target="_blank" rel="noreferrer noopener" className="block truncate text-xs text-info hover:underline">[{index + 1}] {citation.title}</a>)}</CardContent></Card>;
}

function ResultsCard({ results, provisional, cancelled, onRead, origins }: { results: SearchResult[]; provisional: boolean; cancelled?: boolean; onRead: (result: SearchResult) => void; origins?: QueryOrigin[] }) {
  return <Card className={provisional ? "border-dashed bg-muted/20" : ""} data-testid={provisional ? "provisional-results" : "final-results"}>
    <CardHeader><div><div className="flex flex-wrap items-center gap-1.5"><CardTitle>{t(provisional ? "lab.stream.provisional" : "lab.stream.final")}</CardTitle><Badge tone={provisional ? "warning" : "success"}>{t(provisional ? "lab.stream.provisional" : "lab.stream.final")} · {results.length}</Badge>{provisional ? <Badge tone="warning">{t(cancelled ? "searchStatus.cancelled" : "searchStatus.running")}</Badge> : null}</div><CardDescription>{t(provisional ? cancelled ? "lab.stream.cancelledHint" : "lab.stream.provisionalHint" : "lab.result.count", { count: results.length })}</CardDescription></div></CardHeader>
    <CardContent className="space-y-2">{results.length === 0 ? <EmptyState title={t("lab.status.emptySuccess")} /> : results.map((result, index) => <ResultRow key={`${result.id}-${index}`} result={result} rank={index + 1} provisional={provisional} onRead={onRead} origins={origins} />)}</CardContent>
  </Card>;
}

function ResultRow({ result, rank, provisional, onRead, origins }: { result: SearchResult; rank: number; provisional: boolean; onRead: (result: SearchResult) => void; origins?: QueryOrigin[] }) {
  const resultOrigins = queryOriginsForResult(result, origins);
  return <article className={`rounded-lg border p-3 ${provisional ? "border-dashed bg-background/50" : ""}`}>
    <div className="flex gap-2.5"><span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[11px]">{rank}</span><div className="min-w-0 flex-1">
      <a href={result.url} target="_blank" rel="noreferrer noopener" className="line-clamp-2 break-words font-medium hover:underline">{result.title || result.url}</a>
      <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground" title={result.url}>{result.url}</p>
      {result.snippet ? <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{result.snippet}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1"><Badge tone="outline">{result.providerName}</Badge>{result.fusionScore !== undefined ? <Badge tone="info">fusion {result.fusionScore.toFixed(4)}</Badge> : null}{result.rerankScore !== undefined ? <Badge tone="success">rerank {result.rerankScore.toFixed(4)}</Badge> : null}<Button variant="outline" size="sm" className="min-h-11" onClick={() => onRead(result)}><Search aria-hidden />{t("lab.reader.open")}</Button></div>
      {result.sources.length ? <details className="mt-2"><summary className="min-h-9 cursor-pointer text-[11px] text-muted-foreground">{t("lab.result.sources")} ({result.sources.length})</summary><ul className="mt-1 space-y-1">{result.sources.map((source, index) => <li key={index} className="text-[10px]">#{source.rank} {source.providerName} · <span className="break-all">{source.url}</span></li>)}</ul></details> : null}
      {resultOrigins.length ? <details className="mt-1"><summary className="min-h-9 cursor-pointer text-[11px] text-muted-foreground">queryOrigins ({resultOrigins.length})</summary><ul className="mt-1 space-y-1 text-[10px]">{resultOrigins.map((origin, index) => <li key={index}>{origin.query ?? "—"} · {origin.providerName ?? origin.providerId ?? "—"} · #{origin.rank ?? "—"}{origin.round ? ` · ${t("lab.expansion.round", { round: origin.round })}` : ""}</li>)}</ul></details> : null}
    </div></div>
  </article>;
}

const readerStatusKeys: Record<string, MessageKey> = {
  login_required: "lab.reader.login_required", soft404: "lab.reader.not_found", captcha: "lab.reader.captcha",
  maintenance: "lab.reader.maintenance", not_found: "lab.reader.not_found", unsupported: "lab.reader.unsupported",
  timeout: "lab.reader.timeout", ssrf_blocked: "lab.reader.ssrf_blocked", network_error: "lab.reader.network_error",
};
function readerMessage(response: WebReadResponse): string {
  return t(readerStatusKeys[response.readStatus] ?? readerStatusKeys[response.code ?? ""] ?? "lab.reader.failed");
}

function ReaderDrawer({ result, cache, onClose }: { result: SearchResult; cache: Map<string, WebReadResponse>; onClose: () => void }) {
  const [response, setResponse] = useState<WebReadResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const copy = useCopy(); const toast = useToast();
  const load = async () => {
    abortRef.current?.abort();
    const cached = cache.get(result.url);
    if (cached) { setResponse(cached); setError(null); setLoading(false); return; }
    const controller = new AbortController(); abortRef.current = controller; setLoading(true); setError(null);
    try { const value = await api.readWebpage({ url: result.url, render: false }, controller.signal); cache.set(result.url, value); setResponse(value); }
    catch (caught) { if (!isAbortError(caught)) setError(toApiError(caught)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [result.url]);
  const copyText = async () => { if (!response?.text) return; if (await copy.copy(response.text)) toast.success({ title: t("common.copied") }); else toast.error({ title: t("common.copyFailed") }); };
  const statusKey = response ? readerStatusKeys[response.readStatus] ?? readerStatusKeys[response.code ?? ""] : undefined;
  const success = response && (response.ok ?? ["ok", "success", "completed"].includes(response.readStatus));
  return <Drawer open onClose={onClose} title={t("lab.reader.title")} closeLabel={t("common.close")}>
    <div className="space-y-3"><div><h3 className="break-words text-base font-semibold">{result.title || response?.title || result.url}</h3><a href={result.url} target="_blank" rel="noreferrer noopener" className="break-all text-xs text-info hover:underline">{result.url}</a></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" onClick={() => void copyText()} disabled={!response?.text}><Copy aria-hidden />{t("lab.reader.copy")}</Button><Button variant="outline" className="min-h-11" onClick={() => void load()} disabled={loading}>{t("lab.reader.retry")}</Button><a href={result.url} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 text-xs underline"><ExternalLink className="size-3" />{t("lab.reader.original")}</a></div>
      <p className="text-[11px] text-muted-foreground">{t("lab.reader.renderHint")}</p>
      {loading ? <div role="status" className="space-y-2"><p className="text-sm">{t("lab.reader.loading")}</p><Skeleton className="h-5" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : null}
      {error ? <Alert tone="error" title={`${error.code}: ${error.message}`}>{t(readerStatusKeys[error.code] ?? "lab.reader.network_error")}</Alert> : null}
      {!loading && response ? <div className="space-y-3">
        {!success ? <Alert tone="warning" title={response.message ?? response.code ?? response.readStatus}>{response.suggestion ?? readerMessage(response)}</Alert> : null}
        {response.truncated ? <Alert tone="warning" title={t("lab.reader.truncated")} /> : null}
        <dl className="grid grid-cols-2 gap-2 text-xs"><div><dt className="text-muted-foreground">{t("lab.reader.extractor")}</dt><dd>{orDash(response.extractor)}</dd></div><div><dt className="text-muted-foreground">{t("lab.reader.duration")}</dt><dd>{formatMs(response.fetchMs ?? response.latencyMs)}</dd></div><div><dt className="text-muted-foreground">{t("lab.reader.cache")}</dt><dd>{response.cached === true ? t("lab.reader.cached") : response.cached === false ? t("lab.reader.notCached") : t("lab.reader.cacheUnknown")}</dd></div><div><dt className="text-muted-foreground">{t("common.status")}</dt><dd>{statusKey ? t(statusKey) : response.readStatus}</dd></div></dl>
        {success && !response.text ? <p className="text-sm text-muted-foreground">{t("lab.reader.empty")}</p> : null}
        {response.text ? <pre className="max-h-[60vh] whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 font-sans text-sm leading-relaxed">{response.text}</pre> : null}
      </div> : null}
    </div>
  </Drawer>;
}
