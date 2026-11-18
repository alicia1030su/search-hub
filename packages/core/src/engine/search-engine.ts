import {
  SearchHubError,
  type ProviderAttemptStat,
  type ProviderRuntimeConfig,
  type SearchErrorSummary,
  type SearchMode,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type Logger,
  type SafeFetch,
} from "@search-hub/shared";
import { fanoutProviders, type CredentialResolver, type FanoutResult, type ProviderRuntime } from "./fanout.js";
import { RetryBudget, classifyError } from "../errors/classify.js";
import { baseScore, dedupeResults, fuseWithRrf, orderByBaseRanking, type CandidateResult, type DedupDrop } from "../fusion/fuse.js";
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

function modeUsesRrf(mode: SearchMode): boolean {
  return mode !== "basic";
}

/**
 * Provider-agnostic search pipeline. REST, MCP and Skills all call this
 * function; there is no second search implementation anywhere in the repo.
 */
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

  const perProviderLimit = Math.min(
    request.perProviderLimit ?? Math.max(5, Math.ceil((request.limit ?? 20) / Math.max(1, deps.runtimes.length)) + 3),
    50,
  );

  const retryBudget = new RetryBudget(Math.max(4, deps.runtimes.length * 2 + 2));
  const mode: SearchMode = request.mode ?? "basic";

  try {
    const fanoutStarted = Date.now();
    const outcomes = await fanoutProviders(deps.runtimes, {
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
}

function buildResponse(input: BuildResponseInput): SearchResponse {
  const { request, outcomes, mode } = input;
  const retrievedAt = new Date().toISOString();

  const candidates: CandidateResult[] = [];
  const perProviderResults: Array<{ providerId: string; providerName: string; results: SearchResult[] }> = [];

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      perProviderResults.push({
        providerId: outcome.providerId,
        providerName: outcome.providerName,
        results: [],
      });
      continue;
    }
    const providerResults: SearchResult[] = [];
    outcome.results.forEach((raw, index) => {
      const normalized = normalizeRawResult(raw, outcome, index + 1, retrievedAt);
      if (!normalized) return;
      candidates.push({
        ...normalized.candidate,
        providerId: outcome.providerId,
        providerName: outcome.providerName,
        providerType: outcome.providerType,
        rank: index + 1,
        retrievedAt,
      });
      providerResults.push(normalized.result);
    });
    perProviderResults.push({
      providerId: outcome.providerId,
      providerName: outcome.providerName,
      results: providerResults,
    });
  }

  const deduped = dedupeResults(candidates);
  const dropped: DedupDrop[] = deduped.dropped;

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

  const maxScore = Math.max(0.000001, ...fused.map((item) => scores.get(item.normalizedUrl) ?? 0));
  const limit = Math.min(request.limit ?? 20, MAX_RESULTS);

  const results: SearchResult[] = fused.slice(0, limit).map((item) => {
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
      fusionScore: Number(rawScore.toFixed(8)),
      ...(item.language === undefined ? {} : { language: item.language }),
      ...(item.upstream === undefined ? {} : { upstream: item.upstream }),
      sources: item.sources,
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

  // A gateway can report "partial" while still returning rows. Treat that as
  // partial, not completed: the caller must be able to tell that some upstream
  // sources failed even though the request itself succeeded.
  const degradedCount = outcomes.filter((outcome) => outcome.ok && outcome.stat.warning).length;
  const status: SearchResponse["status"] =
    input.cancelled
      ? "failed"
      : okCount === 0
        ? "failed"
        : errorSummaries.length > 0 || degradedCount > 0
          ? "partial"
          : "completed";

  const providers: ProviderAttemptStat[] = outcomes.map((outcome) => outcome.stat);

  return {
    taskId: input.taskId,
    query: request.query,
    mode,
    status,
    results,
    stats: {
      rawCount: candidates.length,
      dedupedCount: deduped.results.length,
      fusedCount: fused.length,
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
    },
    errors: errorSummaries,
    ...(answers.length > 0 ? { answers } : {}),
    failedSources: errorSummaries.map((item) => ({ id: item.providerId, code: item.code })),
    debug: {
      providerQueries: outcomes.map((outcome) => ({
        providerId: outcome.providerId,
        query: request.query,
      })),
      droppedDuplicates: dropped.slice(0, 200),
      perProviderResults,
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
  if (!title || !url) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  const snippet = (raw.snippet ?? "").trim();
  const providerLabel = outcome.providerName;

  const result: SearchResult = {
    id: url,
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
    // Gateway adapters report which upstream provider actually produced this
    // row. It is copied as-is and never inferred from the URL or domain.
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
