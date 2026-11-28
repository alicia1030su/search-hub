import type { ApiError } from "./api";
import { expansionQueries, mergeProvisionalResults, resultsFromStreamEvent } from "./search-response";
import type {
  Freshness, QueryOrigin, SearchMode, SearchRequest, SearchResponse, SearchResult,
  SearchStatus, SearchStrategy, SearchStreamEvent, StreamProviderState,
} from "./types";

export const searchModes: SearchMode[] = ["web", "grounded", "research", "basic", "rrf", "rerank", "embedding", "embedding_rerank", "rerank_summary", "deep"];
export const searchStrategies: SearchStrategy[] = ["auto", "fast", "balanced", "quality", "deep"];

export type PickerValue = `strategy:${SearchStrategy}` | `mode:${SearchMode}`;
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
