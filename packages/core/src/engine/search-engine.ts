import {
  SearchHubError,
  normalizeUrl,
  type ProviderAttemptStat,
  type ProviderRuntimeConfig,
  type SearchErrorSummary,
  type SearchFunnel,
  type SearchMode,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type SearchTruncationReason,
  type Logger,
  type SafeFetch,
} from "@search-hub/shared";
import { fanoutProviders, type CredentialResolver, type FanoutResult, type ProviderRuntime } from "./fanout.js";
import { RetryBudget, classifyError } from "../errors/classify.js";
import {
  baseScore,
  dedupeResults,
  fuseWithRrf,
  orderByBaseRanking,
  type CandidateResult,
  type DedupDrop,
} from "../fusion/fuse.js";
import type { RawSearchResult } from "@search-hub/shared";

export interface SearchEngineDeps {
  runtimes: ProviderRuntime[];
  fetch: SafeFetch;
  credentials: CredentialResolver;
  logger: Logger;
  defaultTimeoutMs?: number;
}

export interface ExecuteSearchOptions {
  signal?: AbortSignal;
  taskId: string;
  /** Called before each physical upstream request; throw to refuse it. */
  beforeRequest?: (providerId: string, url: string) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 100;
const MAX_PROVIDERS = 8;
const MAX_RAW_CANDIDATES = 400;
const MAX_RANKING_CANDIDATES = 200;

function modeUsesRrf(mode: SearchMode): boolean {
  return mode !== "basic";
}

/** Provider-agnostic search pipeline shared by REST, MCP and Skills. */
export async function executeSearch(
  deps: SearchEngineDeps,
  request: SearchRequest,
  options: ExecuteSearchOptions,
): Promise<SearchResponse> {
  if (deps.runtimes.length === 0) {
    throw new SearchHubError(
      "validation_error",
      "No search providers are enabled. Add and enable at least one provider in Search Sources.",
    );
  }

  const startedAt = Date.now();
  const totalTimeout = request.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = startedAt + totalTimeout;

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("cancelled"));
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  const deadlineTimer = setTimeout(() => controller.abort(new Error("search deadline exceeded")), totalTimeout);

  const requestedProviderCount = deps.runtimes.length;
  const selectedRuntimes = deps.runtimes.slice(0, MAX_PROVIDERS);
  const perProviderLimit = Math.min(
    request.perProviderLimit ?? Math.max(5, Math.ceil((request.limit ?? 20) / Math.max(1, selectedRuntimes.length)) + 3),
    MAX_RESULTS,
  );

  const retryBudget = new RetryBudget(Math.max(4, selectedRuntimes.length * 2 + 2));
  const mode: SearchMode = request.mode ?? "basic";

  try {
    const fanoutStarted = Date.now();
    const outcomes = await fanoutProviders(selectedRuntimes, {
      query: request.query,
      limitPerProvider: perProviderLimit,
      ...(request.language === undefined ? {} : { language: request.language }),
      ...(request.freshness === undefined ? {} : { freshness: request.freshness }),
      deadlineMs: Math.max(500, deadline - fanoutStarted),
      retryBudget,
      signal: controller.signal,
      logger: deps.logger,
      fetch: deps.fetch,
      credentials: deps.credentials,
      ...(options.beforeRequest === undefined ? {} : { beforeRequest: options.beforeRequest }),
    });
    const fanoutMs = Date.now() - fanoutStarted;
    const cancelled = controller.signal.aborted && options.signal?.aborted === true;

    const fusionStarted = Date.now();
    const response = buildResponse({
      taskId: options.taskId,
      request,
      mode,
      outcomes,
      startedAt,
      fanoutMs,
      fusionMs: 0,
      cancelled,
      requestedProviderCount,
      selectedProviderIds: selectedRuntimes.map((runtime) => runtime.config.id),
    });
    response.stats.timing.fusionMs = Date.now() - fusionStarted;
    response.stats.timing.totalMs = Date.now() - startedAt;
    return response;
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

interface BuildResponseInput {
  taskId: string;
  request: SearchRequest;
  mode: SearchMode;
  outcomes: FanoutResult[];
  startedAt: number;
  fanoutMs: number;
  fusionMs: number;
  cancelled: boolean;
  requestedProviderCount: number;
  selectedProviderIds: string[];
}

function buildResponse(input: BuildResponseInput): SearchResponse {
  const { request, outcomes, mode } = input;
  const retrievedAt = new Date().toISOString();

  const allCandidates: CandidateResult[] = [];
  const candidatesByProvider = new Map<string, CandidateResult[]>();
  const perProviderResults: Array<{ providerId: string; providerName: string; results: SearchResult[] }> = [];
  let invalidDropped = 0;

  for (const outcome of outcomes) {
    const providerCandidates: CandidateResult[] = [];
    const providerResults: SearchResult[] = [];
    if (!outcome.ok) {
      perProviderResults.push({ providerId: outcome.providerId, providerName: outcome.providerName, results: [] });
      candidatesByProvider.set(outcome.providerId, providerCandidates);
      continue;
    }
    outcome.results.forEach((raw, index) => {
      const normalized = normalizeRawResult(raw, outcome, index + 1, retrievedAt);
      if (!normalized) {
        invalidDropped += 1;
        return;
      }
      const candidate: CandidateResult = {
        ...normalized.candidate,
        providerId: outcome.providerId,
        providerName: outcome.providerName,
        providerType: outcome.providerType,
        rank: index + 1,
        retrievedAt,
      };
      providerCandidates.push(candidate);
      allCandidates.push(candidate);
      providerResults.push(normalized.result);
    });
    providerCandidates.sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      const leftUrl = normalizeUrl(left.url) ?? left.url;
      const rightUrl = normalizeUrl(right.url) ?? right.url;
      return leftUrl < rightUrl ? -1 : leftUrl > rightUrl ? 1 : 0;
    });
    candidatesByProvider.set(outcome.providerId, providerCandidates);
    perProviderResults.push({ providerId: outcome.providerId, providerName: outcome.providerName, results: providerResults });
  }

  // Stable round-robin over each provider's rank-ordered list. No de-duplication
  // happens here, so candidate truncation has one deterministic meaning.
  const rawPool: CandidateResult[] = [];
  const providerLists = input.selectedProviderIds.map((id) => candidatesByProvider.get(id) ?? []);
  for (let index = 0; rawPool.length < MAX_RAW_CANDIDATES; index += 1) {
    let appended = false;
    for (const list of providerLists) {
      const candidate = list[index];
      if (!candidate) continue;
      rawPool.push(candidate);
      appended = true;
      if (rawPool.length === MAX_RAW_CANDIDATES) break;
    }
    if (!appended) break;
  }
  const rawPoolTruncated = allCandidates.length - rawPool.length;

  const deduped = dedupeResults(rawPool);
  const dropped: DedupDrop[] = deduped.dropped;
  const exactDuplicateDropped = dropped.filter((item) => item.reason === "exact_url").length;
  const nearDuplicateDropped = dropped.filter((item) => item.reason === "near_title").length;

  let fused = deduped.results;
  let scores = new Map<string, number>();
  if (modeUsesRrf(mode) && deduped.results.length > 0) {
    const rrf = fuseWithRrf(deduped.results);
    fused = rrf.results;
    scores = new Map(rrf.results.map((item) => [item.normalizedUrl, item.fusionScore]));
  } else {
    fused = orderByBaseRanking(deduped.results);
    scores = new Map(fused.map((item) => [item.normalizedUrl, baseScore(item)]));
  }

  const candidateSelected = fused.slice(0, MAX_RANKING_CANDIDATES);
  const candidateTruncatedCount = deduped.results.length - candidateSelected.length;
  const maxScore = Math.max(0.000001, ...candidateSelected.map((item) => scores.get(item.normalizedUrl) ?? 0));
  const limit = Math.min(request.limit ?? 20, MAX_RESULTS);

  // The engine returns the bounded ranking pool. The service applies the final
  // user limit only after optional embedding/rerank stages have seen every candidate.
  const results: SearchResult[] = candidateSelected.map((item) => {
    const rawScore = scores.get(item.normalizedUrl) ?? 0;
    return {
      id: item.normalizedUrl,
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      source: item.sources
        .map((source) => source.providerName)
        .filter((value, index, array) => array.indexOf(value) === index)
        .join(" · "),
      provider: item.providerId,
      providerType: item.providerType,
      providerName: item.providerName,
      ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
      retrievedAt,
      score: Number((rawScore / maxScore).toFixed(6)),
      fusionScore: Number(rawScore.toFixed(6)),
      ...(item.language === undefined ? {} : { language: item.language }),
      ...(item.upstream === undefined ? {} : { upstream: item.upstream }),
      ...(item.upstreamRank === undefined ? {} : { upstreamRank: item.upstreamRank }),
      sources: item.sources,
      ...(item.queryOrigins?.length ? { queryOrigins: item.queryOrigins } : {}),
      ...(request.includeRaw && item.raw !== undefined ? { metadata: { raw: item.raw } } : {}),
    };
  });

  const okCount = outcomes.filter((outcome) => outcome.ok).length;
  const answers = outcomes
    .map((outcome) => outcome.answer)
    .filter((answer): answer is NonNullable<typeof answer> => answer !== undefined);

  const errorSummaries: SearchErrorSummary[] = outcomes
    .filter((outcome) => !outcome.ok && outcome.error)
    .map((outcome) => outcome.error!);

  const degradedCount = outcomes.filter((outcome) => outcome.ok && outcome.stat.warning).length;
  const status: SearchResponse["status"] =
    input.cancelled
      ? "cancelled"
      : okCount === 0
        ? "failed"
        : errorSummaries.length > 0 || degradedCount > 0
          ? "partial"
          : "completed";

  const providers: ProviderAttemptStat[] = outcomes.map((outcome) => outcome.stat);
  const eligible = rawPool.length;
  const dedupedCount = deduped.results.length;
  const funnel: SearchFunnel = {
    rawReceived: invalidDropped + eligible,
    invalidDropped,
    eligible,
    exactDuplicateDropped,
    nearDuplicateDropped,
    dedupedCount,
    candidateTruncatedCount,
    candidateSelectedCount: candidateSelected.length,
    rankingInputCount: candidateSelected.length,
    rerankInputCount: 0,
    returnedCount: Math.min(limit, candidateSelected.length),
  };
  const truncationReasons: SearchTruncationReason[] = [];
  if (input.requestedProviderCount > input.selectedProviderIds.length) {
    truncationReasons.push({ reason: "provider_limit", count: input.requestedProviderCount - input.selectedProviderIds.length });
  }
  if (rawPoolTruncated > 0) truncationReasons.push({ reason: "raw_pool_limit", count: rawPoolTruncated });
  if (candidateTruncatedCount > 0) truncationReasons.push({ reason: "candidate_pool_limit", count: candidateTruncatedCount });

  return {
    taskId: input.taskId,
    query: request.query,
    mode,
    status,
    results,
    stats: {
      rawCount: funnel.rawReceived,
      dedupedCount,
      fusedCount: candidateSelected.length,
      providers,
      timing: {
        totalMs: 0,
        fanoutMs: input.fanoutMs,
        fusionMs: input.fusionMs,
      },
      rerankApplied: false,
      embeddingApplied: false,
      summaryApplied: false,
      partial: errorSummaries.length > 0,
      requestedProviderCount: input.requestedProviderCount,
      selectedProviderCount: input.selectedProviderIds.length,
      funnel,
      truncationReasons,
    },
    errors: errorSummaries,
    ...(answers.length > 0 ? { answers } : {}),
    failedSources: errorSummaries.map((item) => ({ id: item.providerId, code: item.code })),
    debug: {
      providerQueries: outcomes.map((outcome) => ({ providerId: outcome.providerId, query: request.query })),
      droppedDuplicates: dropped.slice(0, 200),
      perProviderResults,
      selectedProviderIds: input.selectedProviderIds,
    },
  };
}

function normalizeRawResult(
  raw: Pick<RawSearchResult, "title" | "url" | "snippet" | "publishedAt" | "score" | "language" | "raw" | "upstream" | "upstreamRank">,
  outcome: FanoutResult,
  rank: number,
  retrievedAt: string,
): { result: SearchResult; candidate: Omit<CandidateResult, "providerId" | "providerName" | "providerType" | "rank" | "retrievedAt"> } | null {
  const title = (raw.title ?? "").trim();
  const url = (raw.url ?? "").trim();
  if (!title || !url || !normalizeUrl(url)) return null;

  const snippet = (raw.snippet ?? "").trim();
  const providerLabel = outcome.providerName;

  const result: SearchResult = {
    id: normalizeUrl(url)!,
    title,
    url,
    snippet,
    source: providerLabel,
    provider: outcome.providerId,
    providerType: outcome.providerType,
    providerName: providerLabel,
    ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
    retrievedAt,
    score: 0,
    ...(raw.language ? { language: raw.language } : {}),
    sources: [
      {
        providerId: outcome.providerId,
        providerName: providerLabel,
        providerType: outcome.providerType,
        rank,
        ...(raw.score === undefined ? {} : { score: raw.score }),
        url,
        ...(raw.upstream === undefined ? {} : { upstream: raw.upstream }),
      },
    ],
    ...(raw.upstream === undefined ? {} : { upstream: raw.upstream }),
    ...(raw.upstreamRank === undefined ? {} : { upstreamRank: raw.upstreamRank }),
  };

  return {
    result,
    candidate: {
      title,
      url,
      snippet,
      ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
      ...(raw.language ? { language: raw.language } : {}),
      ...(raw.score === undefined ? {} : { score: raw.score }),
      ...(raw.upstream === undefined ? {} : { upstream: raw.upstream }),
      ...(raw.upstreamRank === undefined ? {} : { upstreamRank: raw.upstreamRank }),
      ...(raw.raw === undefined ? {} : { raw: raw.raw }),
    },
  };
}

export function summarizeProviderConfig(config: ProviderRuntimeConfig): string {
  return `${config.name} (${config.type})`;
}

export function describeEngineError(error: unknown): SearchErrorSummary {
  const classified = classifyError(error);
  return {
    providerId: "engine",
    providerName: "Search Hub",
    code: classified.code,
    message: classified.message,
  };
}

export type { DedupDrop };
