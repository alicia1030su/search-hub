import { and, eq, lt } from "drizzle-orm";
import {
  SearchHubError,
  normalizeUrl,
  redactSecrets,
  type Freshness,
  type ProviderErrorCode,
  type SearchErrorSummary,
  type SearchExecutionEvent,
  type SearchRequest,
  type SearchResponse,
  type SearchRouteExplanation,
  type SearchDegradation,
  type SearchResult,
  type SearchFunnel,
  type SearchQueryOrigin,
  type SearchTruncationReason,
  type SafeFetch,
  type Logger,
} from "@search-hub/shared";
import {
  dedupeResults,
  executeSearch,
  expandQuery,
  fuseLayeredRrf,
  resolveSearchIntent,
  routeProviders,
  routeSearchStrategy,
  type CandidateResult,
  type ProviderRuntime,
} from "@search-hub/core";
import { rerankWithEmbeddings, rewriteQuery, summarizeResults } from "@search-hub/models";
import type { SearchHubDb } from "@search-hub/db";
import { auditLogs, searchEvents, searchGroups, searchTasks } from "@search-hub/db";
import type { ProviderService } from "./providers.js";
import type { ModelService } from "./models.js";
import type { SettingsService } from "./settings.js";
import { CacheService } from "./cache.js";
import { SearchFlightService } from "./singleflight.js";
import type { ResourceSlotLimiter } from "./resource-budget.js";
import {
  buildSearchFingerprintV1,
  buildSearchFingerprintV2,
  canReadV1,
  type SearchCacheV1Input,
  type SearchCacheV2Input,
} from "./search-cache-key.js";

export interface SearchServiceDeps {
  db: SearchHubDb;
  providers: ProviderService;
  models: ModelService;
  settings: SettingsService;
  fetch: SafeFetch;
  logger: Logger;
  /**
   * Health gate: providers parked for an account-wide failure are skipped.
   * Only `blockedProviders` is used, so the search path has no way to trigger a
   * probe and therefore cannot spend money.
   */
  health: { blockedProviders(now?: number): Map<string, { code: string; message: string; until: string }> };
  /** Persistent response cache. Shared by REST, MCP and Skills. */
  cache: CacheService;
  /** Optional shared concurrency gate for provider fanout and webpage reads. */
  resourceSlots?: ResourceSlotLimiter;
}

const MAX_STORED_RESPONSE_BYTES = 512 * 1024;

function abortMessage(signal?: AbortSignal): string {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : String(reason ?? "");
}

function isDeadlineAbort(signal?: AbortSignal): boolean {
  return signal?.aborted === true && /deadline|timeout/i.test(abortMessage(signal));
}

function isCancellationAbort(signal?: AbortSignal): boolean {
  return signal?.aborted === true && !isDeadlineAbort(signal);
}

function emptyFunnel(): SearchFunnel {
  return {
    rawReceived: 0,
    invalidDropped: 0,
    eligible: 0,
    exactDuplicateDropped: 0,
    nearDuplicateDropped: 0,
    dedupedCount: 0,
    candidateTruncatedCount: 0,
    candidateSelectedCount: 0,
    rankingInputCount: 0,
    rerankInputCount: 0,
    returnedCount: 0,
  };
}

/**
 * Maps a user-facing preset onto the provider capability it implies.
 * `basic` / `rrf` / model modes keep their existing meaning and are not
 * restricted, so older callers see no behaviour change.
 */
function capabilityForMode(
  mode: SearchRequest["mode"],
): "raw_search" | "grounded_answer" | null {
  if (mode === "web") return "raw_search";
  if (mode === "grounded") return "grounded_answer";
  return null;
}

function modeIncludesRerank(mode: SearchRequest["mode"]): boolean {
  return mode === "rerank" || mode === "embedding_rerank" || mode === "rerank_summary";
}

function modeIncludesEmbedding(mode: SearchRequest["mode"]): boolean {
  return mode === "embedding" || mode === "embedding_rerank";
}

function modeIncludesSummary(mode: SearchRequest["mode"]): boolean {
  return mode === "rerank_summary";
}

function modeUsesRrfForResponse(mode: SearchRequest["mode"]): boolean {
  return mode !== "basic";
}

/**
 * Stable identity of one provider *as configured right now*.
 *
 * The cache key must change when the endpoint, the vendor options or the
 * platform search parameters change: reusing a cached response from an old
 * configuration is indistinguishable from a stale result for the user.
 *
 * `credentialVersion` covers the key pool. It is a hash of key ids, their
 * enabled flag and the encryption version — never a key, a hint or a secret.
 */
function providerFingerprint(runtime: ProviderRuntime, credentialVersion: string): string {
  const config = runtime.config;
  return [
    config.id,
    config.type,
    config.baseUrl ?? "",
    config.maxResults ?? "",
    config.language ?? "",
    config.freshness ?? "",
    JSON.stringify(config.config ?? {}),
    JSON.stringify(config.search ?? {}),
    credentialVersion,
  ].join("|");
}

/**
 * Identity of a model configuration, for the cache key.
 *
 * Includes what changes the *output* (model id, endpoint, parameters) plus the
 * row's `updatedAt`, so editing a model invalidates responses produced by the
 * previous one. The ciphertext and the hint are deliberately absent: they are
 * credential material and have no business in a cache key.
 */
function modelFingerprint(
  config: { id: string; modelId: string; baseUrl: string; params: Record<string, unknown>; updatedAt: string } | null,
): string | null {
  if (!config) return null;
  return [config.id, config.modelId, config.baseUrl, JSON.stringify(config.params), config.updatedAt].join("|");
}

export class SearchService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly flights = new SearchFlightService();

  constructor(private readonly deps: SearchServiceDeps) {}

  async execute(
    request: SearchRequest,
    options: {
      actor?: string;
      signal?: AbortSignal;
      /**
       * Run as a quality-evaluation capture.
       *
       * Three things change, all of them about not contaminating the instance:
       *  - the shared response cache is neither read nor written, so an
       *    experiment cannot be served a stale result and cannot seed one;
       *  - no `search_tasks` row is written, so the dashboard's success rate
       *    stays a measure of user traffic;
       *  - nothing is counted in search statistics for the same reason.
       */
      evaluate?: boolean;
      /**
       * Gate called before every physical upstream request this search makes,
       * including each page of a paginated adapter and each redirect hop.
       *
       * It throws to refuse the request. A caller that wants a hard ceiling on
       * vendor spend passes this instead of counting "attempts" after the fact.
       */
      beforeRequest?: (providerId: string, url: string) => void;
      /** Optional incremental observer used by streaming transports. */
      onEvent?: (event: SearchExecutionEvent) => void;
    } = {},
  ): Promise<SearchResponse> {
    const settings = this.deps.settings.get();
    const requestedMode = request.mode;
    const requestedStrategy = request.strategy;
    const autoRoute = requestedStrategy === "auto" ? routeSearchStrategy(request) : null;
    const intent = resolveSearchIntent(
      autoRoute && requestedMode === undefined ? { ...request, strategy: autoRoute.selected } : request,
      settings.defaults.mode,
    );
    if (autoRoute) intent.effectiveStrategy = autoRoute.selected;
    request = { ...request, mode: intent.mode };
    const taskId = `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error("cancelled"));
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }



    const providerIds = this.resolveProviderIds(request);
    let runtimes = this.deps.providers.runtimesFor(providerIds);
    if (providerIds.length > 0) {
      const byId = new Map(runtimes.map((runtime) => [runtime.config.id, runtime] as const));
      runtimes = providerIds.map((id) => byId.get(id)).filter((runtime): runtime is ProviderRuntime => runtime !== undefined);
    } else {
      runtimes = [...runtimes].sort((left, right) => left.config.id.localeCompare(right.config.id));
    }

    // Capability presets: "web" must never return an AI answer, "grounded" must
    // never return a web page list. Filtering here (not in the UI) keeps REST,
    // MCP and Skills on the same rule.
    const capability = capabilityForMode(request.mode) ?? request.capability;
    if (capability) {
      runtimes = runtimes.filter(
        (runtime) => (runtime.adapter.capability ?? "raw_search") === capability,
      );
    }
    if (runtimes.length === 0) {
      throw new SearchHubError(
        "validation_error",
        "No enabled search provider matched this request. Check provider selection or enable a provider.",
      );
    }

    const mode = intent.mode;

    // Health-based isolation: a source parked for an account-wide failure (quota
    // exhausted, credential rejected) is skipped until its cooldown expires.
    // Transient failures are NOT considered here — the scheduler's circuit
    // breaker already handles those, and one timeout must never remove a source.
    // Per-request, never instance state: two overlapping searches used to
    // overwrite each other's skip list, so one could report the other's parked
    // sources — or none at all. It is threaded explicitly from here.
    const blocked = this.deps.health.blockedProviders();
    let routeExplanation: SearchRouteExplanation | undefined;
    if (request.strategy) {
      const observations = Object.fromEntries([...blocked.keys()].map((id) => [id, { blocked: true, successRate: 0 }]));
      routeExplanation = routeProviders({
        query: request.query,
        runtimes,
        capability,
        explicitProviderIds: providerIds,
        observations,
      });
      if (autoRoute) {
        routeExplanation = {
          ...routeExplanation,
          selectedStrategy: autoRoute.selected,
          ruleId: autoRoute.ruleId,
          matchedSignals: autoRoute.matchedSignals,
          considered: autoRoute.considered,
        };
      }
      const selected = new Set(routeExplanation.selectedProviderIds);
      runtimes = runtimes.filter((runtime) => selected.has(runtime.config.id));
      if (providerIds.length > 0) {
        const byId = new Map(runtimes.map((runtime) => [runtime.config.id, runtime] as const));
        runtimes = providerIds.map((id) => byId.get(id)).filter((runtime): runtime is ProviderRuntime => runtime !== undefined);
      } else {
        runtimes = [...runtimes].sort((left, right) => left.config.id.localeCompare(right.config.id));
      }
    }
    let skippedByHealth: SearchErrorSummary[] = [];
    if (blocked.size > 0) {
      const skipped: SearchErrorSummary[] = [];
      runtimes = runtimes.filter((runtime) => {
        const reason = blocked.get(runtime.config.id);
        if (!reason) return true;
        skipped.push({
          providerId: runtime.config.id,
          providerName: runtime.config.name,
          code: reason.code as SearchErrorSummary["code"],
          message: `${reason.message} until ${reason.until}`,
        });
        return false;
      });
      skippedByHealth = skipped;
      if (runtimes.length === 0) {
        // Structured failure, never an empty "success". It is persisted first:
        // the caller is holding a taskId, so `getTask` must be able to find it.
        const response = this.failedResponse(
          request,
          mode,
          taskId,
          skipped,
          "Every selected source is parked by the health gate",
        );
        options.onEvent?.({
          type: "meta",
          data: {
            taskId,
            query: request.query,
            mode,
            strategy: request.strategy,
            route: routeExplanation,
            selectedProviderIds: [],
            requestedProviderCount: routeExplanation?.requestedProviderCount ?? 0,
            selectedProviderCount: 0,
          },
        });
        options.onEvent?.({ type: "search_failed", data: { status: response.status, errors: response.errors, failedSources: response.failedSources } });
        if (options.evaluate !== true) {
          this.persistTaskRow(taskId, request, mode, runtimes, response, options.actor);
        }
        return response;
      }
    }
    if (routeExplanation) {
      routeExplanation = {
        ...routeExplanation,
        selectedProviderIds: runtimes.map((runtime) => runtime.config.id),
        selectedProviderCount: runtimes.length,
      };
    }

    const wantsRerank = request.rerank ?? modeIncludesRerank(mode);
    const wantsEmbedding = request.embedding ?? modeIncludesEmbedding(mode);
    const wantsSummary = request.summarize ?? modeIncludesSummary(mode);

    // An explicit model id must be validated up front: otherwise a disabled or
    // mismatched id would only surface mid-search as a degraded response, and
    // the caller would pay for provider calls that cannot use it.
    if (request.rerankModelId) this.deps.models.getEnabled(request.rerankModelId, "rerank");
    if (request.embeddingModelId) this.deps.models.getEnabled(request.embeddingModelId, "embedding");
    if (request.chatModelId) this.deps.models.getEnabled(request.chatModelId, "chat");

    // Fail fast before spending provider quota when an optional model is missing.
    if (wantsRerank && !this.deps.models.findDefault("rerank")) {
      throw new SearchHubError("validation_error", "Rerank was requested but no rerank model is configured.");
    }
    if (wantsEmbedding && !this.deps.models.findDefault("embedding")) {
      throw new SearchHubError(
        "validation_error",
        "Semantic scoring was requested but no embedding model is configured.",
      );
    }
    if (wantsSummary && !this.deps.models.findDefault("chat")) {
      throw new SearchHubError(
        "validation_error",
        "AI summarization requires a chat model. Add one in AI Models or disable summarize.",
      );
    }

    const startedAt = Date.now();
    const cacheConfig = settings.cache;
    // `includeRaw` responses carry the upstream payload verbatim. Persisting
    // them would write provider-internal debug data into the database and hand
    // it to the next caller, so such requests bypass the persistent cache
    // entirely — they neither read nor write it. (They still run normally.)
    const rawBypass = request.includeRaw === true;
    const cacheUsable =
      cacheConfig.enabled &&
      cacheConfig.ttlSeconds > 0 &&
      request.skipCache !== true &&
      !rawBypass &&
      options.evaluate !== true;

    const providerIdentities = runtimes.map((runtime) => ({
      id: runtime.config.id,
      capability: runtime.adapter.capability ?? "raw_search",
      configFingerprint: providerFingerprint(runtime, this.deps.providers.credentialVersion(runtime.config.id)),
      credentialVersion: this.deps.providers.credentialVersion(runtime.config.id),
    }));
    const modelIdentities: NonNullable<SearchCacheV2Input["models"]> = {};
    if (wantsRerank) {
      const fingerprint = modelFingerprint(this.deps.models.resolveConfig(request.rerankModelId, "rerank"));
      if (fingerprint) modelIdentities.rerank = { fingerprint, stageVersion: "rerank-v1" };
    }
    if (wantsEmbedding) {
      const fingerprint = modelFingerprint(this.deps.models.resolveConfig(request.embeddingModelId, "embedding"));
      if (fingerprint) modelIdentities.embedding = { fingerprint, stageVersion: "embedding-v1" };
    }
    if ((wantsSummary || mode === "deep") && this.deps.models.findDefault?.("chat")) {
      const fingerprint = modelFingerprint(this.deps.models.resolveConfig(request.chatModelId, "chat"));
      if (fingerprint) modelIdentities.chat = { fingerprint, stageVersion: "chat-v1" };
    }
    const legacyInput: SearchCacheV1Input = {
      query: request.query,
      mode,
      capability: capability ?? null,
      providers: providerIdentities.map((provider) => provider.configFingerprint).sort(),
      limit: request.limit ?? settings.defaults.limit,
      perProviderLimit: request.perProviderLimit ?? null,
      timeoutMs: request.timeoutMs ?? null,
      language: request.language ?? null,
      freshness: request.freshness ?? null,
      rerank: wantsRerank,
      embedding: wantsEmbedding,
      summarize: wantsSummary,
      models: {
        rerank: wantsRerank ? modelIdentities.rerank?.fingerprint ?? null : null,
        embedding: wantsEmbedding ? modelIdentities.embedding?.fingerprint ?? null : null,
        chat: wantsSummary || mode === "deep" ? modelIdentities.chat?.fingerprint ?? null : null,
      },
      parked: [...blocked.keys()].sort(),
    };
    const legacyFingerprint = buildSearchFingerprintV1(legacyInput);
    const v2Fingerprint = buildSearchFingerprintV2({
      query: request.query,
      mode: requestedMode,
      strategy: requestedStrategy,
      capability: capability ?? null,
      effectiveMode: mode,
      effectiveStrategy: intent.effectiveStrategy,
      limit: request.limit ?? settings.defaults.limit,
      perProviderLimit: request.perProviderLimit ?? null,
      providers: providerIdentities,
      routeVersion: intent.routeVersion,
      queryExpansion: request.queryExpansion === true,
      queryPlan: [{ queryId: "q1", query: request.query, kind: "original", round: 1, weight: 1 }],
      models: modelIdentities,
      parked: [...blocked.keys()].sort(),
    });
    const cacheKey = cacheUsable ? CacheService.buildKey(v2Fingerprint) : null;
    const legacyCacheKey = cacheUsable && canReadV1(legacyInput, legacyFingerprint)
      ? CacheService.buildKey(legacyFingerprint)
      : null;

    if (cacheUsable && cacheKey) {
      // A cache read is an optimisation. If it fails — corrupted row, locked
      // database, full disk — the search must still run and answer; turning a
      // cache fault into a 500 would make the cache a dependency.
      let hit: ReturnType<typeof this.deps.cache.get> = null;
      try {
        hit = this.deps.cache.get(cacheKey);
        if (!hit && legacyCacheKey) hit = this.deps.cache.get(legacyCacheKey);
      } catch (error) {
        this.deps.logger.warn({ err: error }, "cache lookup failed; continuing without a hit");
      }
      if (hit) {
        const cached: SearchResponse = {
          ...structuredClone(hit.response),
          taskId,
          stats: {
            ...hit.response.stats,
            cached: true,
            timing: { ...hit.response.stats.timing, totalMs: 0 },
          },
        };
        // The cache is a snapshot of provider results, not of provider health.
        // Re-apply the current gate so a parked source is still reported as
        // skipped instead of silently looking healthy because it once worked.
        if (skippedByHealth.length > 0) {
          cached.errors.push(...skippedByHealth);
          const known = new Set(cached.failedSources.map((item) => item.id));
          for (const skipped of skippedByHealth) {
            if (!known.has(skipped.providerId)) {
              cached.failedSources.push({ id: skipped.providerId, code: skipped.code });
            }
          }
          cached.stats.partial = true;
          if (cached.status === "completed") cached.status = "partial";
        }
        options.onEvent?.({
          type: "meta",
          data: {
            taskId,
            query: request.query,
            mode,
            selectedProviderIds: runtimes.map((runtime) => runtime.config.id),
            requestedProviderCount: runtimes.length,
            selectedProviderCount: runtimes.length,
            cached: true,
          },
        });
        options.onEvent?.({ type: "search_completed", data: { ...cached, cached: true } as unknown as Record<string, unknown> });
        this.deps.db
          .insert(searchTasks)
          .values({
            id: taskId,
            query: request.query,
            mode,
            // A cached partial must stay partial: recording it as completed would
            // inflate the dashboard success rate.
            status: cached.status,
            providersJson: JSON.stringify(runtimes.map((runtime) => runtime.config.id)),
            resultCount: cached.results.length,
            rawCount: cached.stats.rawCount,
            durationMs: 0,
            requestJson: JSON.stringify(request),
            responseJson: JSON.stringify(this.redactStoredResponse(cached)),
            diagnosticsSanitized: true,
            actor: options.actor ?? null,
            createdAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          })
          .run();
        return cached;
      }
    }

    // Measured so the AC-05 breakdown can separate SQLite cost from fan-out,
    // fusion and HTTP overhead. Cheap enough to keep on in production.
    let dbWriteMs = 0;
    const insertStarted = performance.now();
    if (options.evaluate !== true) {
      this.deps.db
        .insert(searchTasks)
        .values({
          id: taskId,
          query: request.query,
          mode,
          status: "running",
          providersJson: JSON.stringify(runtimes.map((runtime) => runtime.config.id)),
          requestJson: JSON.stringify(request),
          actor: options.actor ?? null,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
    dbWriteMs += performance.now() - insertStarted;
    this.controllers.set(taskId, controller);

    try {
      options.onEvent?.({
        type: "meta",
        data: {
          taskId,
          query: request.query,
          mode,
          strategy: request.strategy,
          route: routeExplanation,
          selectedProviderIds: runtimes.map((runtime) => runtime.config.id),
          requestedProviderCount: routeExplanation?.requestedProviderCount ?? runtimes.length,
          selectedProviderCount: runtimes.length,
        },
      });
      options.onEvent?.({ type: "status", data: { status: "running", terminal: false } });
      const beforeRequest = options.beforeRequest;
      const performPhysical = async (sharedSignal: AbortSignal, leaderTaskId: string): Promise<SearchResponse> => {
        const useMultiQueryPipeline = mode === "deep" || request.queryExpansion === true;
        let response = useMultiQueryPipeline
          ? await this.runDeep(request, runtimes, sharedSignal, leaderTaskId, skippedByHealth, beforeRequest, options.onEvent)
          : await this.runStandard(request, runtimes, sharedSignal, leaderTaskId, skippedByHealth, beforeRequest, options.onEvent);
        if (useMultiQueryPipeline && mode !== "deep") response.mode = mode;

        if (wantsEmbedding && mode !== "deep") {
          response = await this.applyEmbedding(response, request, sharedSignal);
        }
        if (wantsRerank && mode !== "deep") {
          options.onEvent?.({ type: "rerank_started", data: { taskId: leaderTaskId, candidateCount: response.results.length } });
          response = await this.applyRerank(response, request, sharedSignal);
        }
        // A failed response has no results to summarize; calling the model would
        // add a second, misleading error on top of the real provider failure.
        if ((wantsSummary || mode === "deep") && response.status !== "failed" && !sharedSignal.aborted && this.deps.models.findDefault?.("chat")) {
          response = await this.applySummary(response, request, sharedSignal);
        } else if (mode === "deep" && !this.deps.models.findDefault?.("chat")) {
          response.degradations = [
            ...(response.degradations ?? []),
            { stage: "summary", reason: "model_not_configured" },
          ];
        }

        response.results = response.results.slice(0, request.limit ?? 20);
        if (response.stats.funnel) response.stats.funnel.returnedCount = response.results.length;
        if (request.strategy) {
          response.strategy = request.strategy;
          if (routeExplanation) response.route = routeExplanation;
          response.appliedStages = [
            "fanout",
            modeUsesRrfForResponse(mode) ? "rrf" : "basic",
            ...(response.queryExpansion ? ["query_expansion"] : []),
            ...(response.stats.embeddingApplied ? ["embedding"] : []),
            ...(response.stats.rerankApplied ? ["rerank"] : []),
            ...(response.stats.summaryApplied ? ["summary"] : []),
          ];
          const degradations: SearchDegradation[] = [...(response.degradations ?? [])];
          if (request.strategy === "quality" && !this.deps.models.findDefault("rerank")) {
            degradations.push({ stage: "rerank", reason: "model_not_configured" });
          }
          if (degradations.length > 0) response.degradations = degradations;
        }
        options.onEvent?.({
          type: "results_updated",
          data: { results: response.results, stats: response.stats, errors: response.errors, failedSources: response.failedSources },
        });
        response.stats.timing.totalMs = Date.now() - startedAt;
        response.stats.timing.dbWriteMs = Math.round(dbWriteMs * 100) / 100;
        const cancelled = isCancellationAbort(sharedSignal);
        options.onEvent?.({ type: "status", data: { status: response.status, terminal: false } });
        if (cancelled || response.status === "cancelled") {
          options.onEvent?.({ type: "status", data: { status: "cancelled", terminal: true } });
        } else if (response.status === "failed") {
          options.onEvent?.({ type: "search_failed", data: { status: response.status, errors: response.errors, failedSources: response.failedSources } });
        } else {
          options.onEvent?.({ type: "search_completed", data: { ...response } as unknown as Record<string, unknown> });
        }
        if (cacheUsable && cacheKey && this.isCacheable(response, cancelled)) {
          try {
            this.deps.cache.put(cacheKey, response, cacheConfig.ttlSeconds, mode);
          } catch (error) {
            // A cache write must never fail the search that produced it.
            this.deps.logger.warn({ err: error }, "could not persist the search response cache");
          }
        }
        return response;
      };

      const canShare = cacheUsable && cacheKey !== null && beforeRequest === undefined;
      const deadlineMs = request.timeoutMs ?? settings.defaults.timeoutMs;
      let ledPhysical = false;
      const physical = (sharedSignal: AbortSignal): Promise<SearchResponse> => {
        ledPhysical = true;
        return performPhysical(sharedSignal, taskId);
      };
      const shared = canShare
        ? await this.flights.run(cacheKey, controller.signal, physical, { deadlineAtMs: startedAt + deadlineMs })
        : await performPhysical(controller.signal, taskId);
      if (canShare && !ledPhysical) {
        options.onEvent?.({ type: "results_updated", data: { results: shared.results, stats: shared.stats, errors: shared.errors, failedSources: shared.failedSources } });
        options.onEvent?.({ type: "status", data: { status: shared.status, terminal: false } });
        if (shared.status === "failed") {
          options.onEvent?.({ type: "search_failed", data: { status: shared.status, errors: shared.errors, failedSources: shared.failedSources } });
        } else if (shared.status === "cancelled") {
          options.onEvent?.({ type: "status", data: { status: "cancelled", terminal: true } });
        } else {
          options.onEvent?.({ type: "search_completed", data: { ...shared } as unknown as Record<string, unknown> });
        }
      }
      const response: SearchResponse = {
        ...structuredClone(shared),
        taskId,
        stats: {
          ...shared.stats,
          timing: { ...shared.stats.timing, totalMs: Date.now() - startedAt },
        },
      };

      const persistStarted = performance.now();
      if (options.evaluate !== true) this.persistTask(taskId, response, controller.signal.aborted ? "cancelled" : null);
      dbWriteMs += performance.now() - persistStarted;
      response.stats.timing.dbWriteMs = Math.round(dbWriteMs * 100) / 100;
      return response;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = runtimes.reduce(
        (output, runtime) => this.redactForProvider(runtime.config.id, output),
        redactSecrets(rawMessage),
      );
      const externalCancelled = isCancellationAbort(controller.signal);
      const deadline = isDeadlineAbort(controller.signal) || /deadline|timeout/i.test(message);
      const status = externalCancelled ? "cancelled" : "failed";
      const errorCode = externalCancelled ? "cancelled" : deadline ? "timeout" : "unknown";
      if (options.evaluate !== true) {
        this.deps.db
          .update(searchTasks)
          .set({
            status,
            durationMs: Date.now() - startedAt,
            errorsJson: JSON.stringify([{ providerId: "engine", code: errorCode, message }]),
            diagnosticsSanitized: true,
            finishedAt: new Date().toISOString(),
          })
          .where(eq(searchTasks.id, taskId))
          .run();
      }
      if (externalCancelled) {
        return this.failedResponse(request, mode, taskId, [], "Search cancelled by caller", "cancelled");
      }
      if (deadline) {
        return this.failedResponse(request, mode, taskId, [], "Search deadline exceeded", "failed");
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      this.controllers.delete(taskId);
    }
  }

  /** Abort shared physical searches and callers before the database is closed. */
  shutdown(): void {
    this.flights.shutdown();
    for (const controller of this.controllers.values()) controller.abort(new Error("service shutdown"));
  }

  get flightWaitingCount(): number {
    return this.flights.waitingCount;
  }

  get queuedFollowerCount(): number {
    return this.flights.queuedFollowerCount;
  }

  get activeSearchCount(): number {
    return this.controllers.size;
  }

  /**
   * Cancels a running task. `actor` is optional only for internal callers; the
   * HTTP route always passes it so one token cannot abort another's search.
   */
  cancel(
    taskId: string,
    actor?: string,
    options: { allowUnowned?: boolean } = {},
  ): boolean {
    return this.cancelDetailed(taskId, actor, options).ok;
  }

  cancelDetailed(
    taskId: string,
    actor?: string,
    options: { allowUnowned?: boolean } = {},
  ): { ok: boolean; status: "cancelling" | "already_terminal" | "not_found" | "forbidden"; taskStatus?: string } {
    const task = this.getTask(taskId);
    if (actor !== undefined && (!task || (task.actor !== actor && !(task.actor === null && options.allowUnowned)))) {
      return { ok: false, status: "forbidden" };
    }
    if (task && task.status !== "running") {
      return { ok: false, status: "already_terminal", taskStatus: task.status };
    }
    const controller = this.controllers.get(taskId);
    if (!controller) return { ok: false, status: "not_found" };
    if (!controller.signal.aborted) controller.abort(new Error("cancelled by user"));
    return { ok: true, status: "cancelling" };
  }

  getTask(taskId: string): {
    id: string;
    query: string;
    mode: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    response: SearchResponse | null;
    /** Who ran it. Routes compare this with the caller before returning data. */
    actor: string | null;
  } | null {
    const row = this.deps.db.select().from(searchTasks).where(eq(searchTasks.id, taskId)).get();
    if (!row) return null;
    let response: SearchResponse | null = null;
    if (row.responseJson) {
      try {
        response = this.redactStoredResponse(
          JSON.parse(row.responseJson) as SearchResponse,
          !row.diagnosticsSanitized,
        );
      } catch {
        response = null;
      }
    }
    return {
      id: row.id,
      query: row.query,
      mode: row.mode,
      status: row.status,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      response,
      actor: row.actor,
    };
  }

  /** Protects task reads from diagnostics persisted before v0.1.12. */
  private redactStoredResponse(response: SearchResponse, legacy = false): SearchResponse {
    const message = (providerId: string, value: string): string => legacy
      ? "[redacted: legacy diagnostic]"
      : this.redactForProvider(providerId, value);
    return {
      ...response,
      errors: response.errors.map((error) => ({
        ...error,
        message: message(error.providerId, error.message),
      })),
      stats: {
        ...response.stats,
        providers: response.stats.providers.map((stat) => ({
          ...stat,
          ...(stat.errorMessage === undefined
            ? {}
            : {
                errorMessage: this.redactForProvider(
                  stat.providerId,
                  legacy
                    ? "[redacted: legacy diagnostic]"
                    : stat.keyId
                      ? this.deps.providers.redactKeyMessage(stat.keyId, stat.errorMessage) ?? stat.errorMessage
                      : stat.errorMessage,
                ),
              }),
          ...(stat.warning === undefined
            ? {}
            : { warning: message(stat.providerId, stat.warning) }),
        })),
      },
    };
  }

  private redactForProvider(providerId: string, message: string): string {
    return this.deps.providers.redactProviderMessage(providerId, message) ?? redactSecrets(message);
  }

  /** Applies the configured retention window to tasks, events and audit logs. */
  runRetention(): { tasks: number; events: number; auditLogs: number } {
    const retention = this.deps.settings.get().retention;
    const taskCutoff = new Date(Date.now() - retention.taskRetentionDays * 86_400_000).toISOString();
    const logCutoff = new Date(Date.now() - retention.logRetentionDays * 86_400_000).toISOString();
    const tasks = this.deps.db.delete(searchTasks).where(lt(searchTasks.createdAt, taskCutoff)).run();
    const events = this.deps.db.delete(searchEvents).where(lt(searchEvents.createdAt, taskCutoff)).run();
    const logs = this.deps.db.delete(auditLogs).where(lt(auditLogs.createdAt, logCutoff)).run();
    return {
      tasks: Number(tasks.changes ?? 0),
      events: Number(events.changes ?? 0),
      auditLogs: Number(logs.changes ?? 0),
    };
  }

  cleanupOldTasks(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    this.deps.db.delete(searchTasks).where(lt(searchTasks.createdAt, cutoff)).run();
    this.deps.db.delete(searchEvents).where(lt(searchEvents.createdAt, cutoff)).run();
  }

  /**
   * Whether this response may be persisted.
   *
   * Only a **fully successful** search is cached:
   *  - `failed` (every source failed, or the engine threw) — no;
   *  - `partial` (some sources failed or were skipped) — no, because replaying a
   *    degraded answer for 24 hours would hide a source that recovered minutes
   *    later;
   *  - cancelled — no;
   *  - anything still carrying an error entry — no, for the same reason;
   *  - a structured response that violates the contract — no, because writing it
   *    would poison every later caller.
   *
   * A completed search with **zero results** *is* cached: "the internet has
   * nothing on this" is a legitimate, repeatable answer, and re-querying it
   * costs money for the same silence.
   */
  private isCacheable(response: SearchResponse, cancelled: boolean): boolean {
    if (cancelled) return false;
    if (response.status !== "completed") return false;
    if (response.errors.length > 0) return false;
    if (response.stats.partial) return false;
    if (!Array.isArray(response.results) || !Array.isArray(response.failedSources)) return false;
    if (response.failedSources.length > 0) return false;
    if (typeof response.taskId !== "string" || typeof response.query !== "string") return false;
    if (response.stats === undefined || typeof response.stats.rawCount !== "number") return false;
    // Guard against a malformed entry that would break every later deserialise.
    try {
      JSON.stringify(response);
    } catch {
      return false;
    }
    return true;
  }

  /** Structured failure with an explicit reason list; results stay empty. */
  private failedResponse(
    request: SearchRequest,
    mode: SearchRequest["mode"] & string,
    taskId: string,
    errors: SearchErrorSummary[],
    reason: string,
    status: "failed" | "cancelled" = "failed",
  ): SearchResponse {
    return {
      taskId,
      query: request.query,
      mode,
      status,
      results: [],
      stats: {
        rawCount: 0,
        dedupedCount: 0,
        fusedCount: 0,
        providers: [],
        rerankApplied: false,
        embeddingApplied: false,
        summaryApplied: false,
        partial: true,
        timing: { totalMs: 0, fanoutMs: 0, fusionMs: 0 },
        funnel: emptyFunnel(),
        truncationReasons: [],
      },
      errors: [...errors, {
        providerId: "engine",
        providerName: "Search Hub",
        code: status === "cancelled" ? "cancelled" : status === "failed" && /timeout|deadline/i.test(reason) ? "timeout" : "no_available_key",
        message: reason,
      }],
      failedSources: status === "cancelled" ? [] : errors.map((item) => ({ id: item.providerId, code: item.code })),
      debug: { rewrittenQueries: [] },
    };
  }

  private resolveProviderIds(request: SearchRequest): string[] {
    if (request.group) {
      const group = this.deps.db
        .select()
        .from(searchGroups)
        .where(eq(searchGroups.name, request.group))
        .get();
      if (!group) throw new SearchHubError("not_found", `Search group "${request.group}" not found`);
      try {
        const ids = JSON.parse(group.providerIdsJson) as unknown;
        return Array.isArray(ids)
          ? [...new Set(ids.filter((id): id is string => typeof id === "string"))].sort()
          : [];
      } catch {
        return [];
      }
    }
    return [...new Set(request.providers ?? [])];
  }

  private engineDeps() {
    return {
      runtimes: [] as ProviderRuntime[],
      fetch: this.deps.fetch,
      credentials: {
        getKeyValue: async (keyId: string) => this.deps.providers.resolveKey(keyId),
      },
      logger: this.deps.logger,
      defaultTimeoutMs: this.deps.settings.get().defaults.timeoutMs,
    };
  }

  /**
   * Adds the sources the health gate parked to a response.
   *
   * Without this the caller sees a smaller fan-out and no reason for it —
   * indistinguishable from a source that simply returned nothing. The list is a
   * parameter: it belongs to one request, not to the service.
   */
  private applyHealthSkips(response: SearchResponse, skipped: readonly SearchErrorSummary[]): void {
    if (skipped.length === 0) return;
    const alreadyReported = new Set(response.errors.map((item) => item.providerId));
    for (const item of skipped) {
      if (!alreadyReported.has(item.providerId)) response.errors.push(item);
    }
    const known = new Set(response.failedSources.map((item) => item.id));
    for (const item of skipped) {
      if (!known.has(item.providerId)) response.failedSources.push({ id: item.providerId, code: item.code });
    }
    response.stats.partial = true;
    if (response.status === "completed") response.status = "partial";
  }

  private async runStandard(
    request: SearchRequest,
    runtimes: ProviderRuntime[],
    signal: AbortSignal,
    taskId: string,
    skippedByHealth: readonly SearchErrorSummary[] = [],
    beforeRequest?: (providerId: string, url: string) => void,
    onEvent?: (event: SearchExecutionEvent) => void,
  ): Promise<SearchResponse> {
    const deps = this.engineDeps();
    deps.runtimes = runtimes;
    const response = await executeSearch(deps, request, {
      signal,
      taskId,
      ...(beforeRequest === undefined ? {} : { beforeRequest }),
      ...(this.deps.resourceSlots === undefined ? {} : { providerSlot: this.deps.resourceSlots }),
      ...(onEvent === undefined ? {} : {
        onEvent: (event) => {
          if (event.type !== "meta") onEvent(event);
        },
      }),
    });
    this.applyHealthSkips(response, skippedByHealth);
    if (signal.aborted) {
      const deadline = isDeadlineAbort(signal);
      response.status = deadline ? "failed" : "cancelled";
      response.errors.push({
        providerId: "engine",
        providerName: "Search Hub",
        code: deadline ? "timeout" : "cancelled",
        message: deadline ? "Search deadline exceeded" : "Search cancelled by caller",
      });
    }
    return response;
  }

  /**
   * Deep mode: rewrite the query, run up to 3 retrievals and merge by URL.
   * Model rewriting is best-effort; a failure falls back to the original query.
   */
  private async runDeep(
    request: SearchRequest,
    runtimes: ProviderRuntime[],
    signal: AbortSignal,
    taskId: string,
    skippedByHealth: readonly SearchErrorSummary[] = [],
    beforeRequest?: (providerId: string, url: string) => void,
    onEvent?: (event: SearchExecutionEvent) => void,
  ): Promise<SearchResponse> {
    let expansionMetadata: SearchResponse["queryExpansion"];
    const deepDegradations: SearchDegradation[] = [];
    let modelCalls = 0;
    const maxQueries = Math.min(4, Math.max(1, request.maxSubqueries ?? (request.strategy || request.queryExpansion ? 4 : 3)));
    const maxRounds = Math.min(2, Math.max(1, request.maxRounds ?? 2));
    let queries: Array<{
      query: string;
      id: string;
      kind: "original" | "rewrite";
      weight: number;
      queryIndex: number;
      round: number;
    }>;
    const modelService = this.deps.models as Partial<ModelService>;
    const chatAvailable = Boolean(
      request.chatModelId ||
      (typeof modelService.findDefault === "function" ? modelService.findDefault("chat") : typeof modelService.chatModel === "function"),
    );
    if (request.queryExpansion === true || !chatAvailable) {
      const chat = chatAvailable ? this.deps.models.chatModel(request.chatModelId) : null;
      if (!chat) deepDegradations.push({ stage: "query_expansion", reason: "model_not_configured" });
      const expansion = await expandQuery(
        { query: request.query, queryExpansion: true, strategy: request.strategy ?? "deep" },
        {
          maxQueries,
          signal,
          ...(chat === null ? {} : {
            modelExpander: async (query, expansionSignal) => {
              modelCalls += 1;
              const completion = await chat.complete([
                { role: "system", content: "Rewrite the search query conservatively. Return strict JSON {\"queries\":[\"...\"]}." },
                { role: "user", content: query },
              ], { signal: expansionSignal, maxTokens: 300, json: true });
              return completion.text;
            },
          }),
        },
      );
      expansionMetadata = {
        language: expansion.language,
        queries: expansion.queries.map((query) => ({
          query: query.query,
          kind: query.kind,
          weight: query.weight,
          source: query.source,
        })),
        skippedReasons: expansion.skippedReasons,
      };
      queries = expansion.queries.map((query, index) => ({
        query: query.query,
        id: `q${index + 1}`,
        kind: index === 0 ? "original" : "rewrite",
        weight: query.weight,
        queryIndex: index + 1,
        round: 1,
      }));
    } else {
      const chat = this.deps.models.chatModel(request.chatModelId);
      modelCalls += 1;
      const rewritten = await rewriteQuery(chat, request.query, maxQueries, signal);
      queries = rewritten.slice(0, maxQueries).map((rawQuery, index) => {
        const queryIndex = index + 1;
        return {
          query: rawQuery.trim(),
          id: `q${queryIndex}`,
          kind: queryIndex === 1 ? "original" as const : "rewrite" as const,
          weight: queryIndex === 1 ? 1 : 0.8,
          queryIndex,
          round: 1,
        };
      });
    }
    const roundsPlanned = maxRounds > 1 && queries.length > 1 ? 2 : 1;
    const plannedQueries = queries.map((query, index) => ({
      ...query,
      round: roundsPlanned === 1 ? 1 : index === 0 ? 1 : 2,
    }));
    const deps = this.engineDeps();
    deps.runtimes = runtimes;

    // Each rewrite is its own search. A sub-search that comes back with
    // `status: "failed"` is NOT a usable result: it means every provider for
    // that query failed. Treating it as valid is how a deep search used to
    // report `completed` with zero results.
    const maxProviderQueryCalls = 32;
    const maxHttpRequests = 64;
    const deadline = Date.now() + (request.timeoutMs ?? this.deps.settings.get().defaults.timeoutMs);
    let providerQueryCalls = 0;
    let httpRequests = 0;
    let budgetExhausted = false;
    const outcomes: Array<{
      query: (typeof plannedQueries)[number];
      index: number;
      response: SearchResponse | null;
      error?: unknown;
    }> = [];
    const gatedBeforeRequest = (providerId: string, url: string): void => {
      beforeRequest?.(providerId, url);
      if (httpRequests >= maxHttpRequests) {
        budgetExhausted = true;
        throw new SearchHubError("rate_limited", "Deep search HTTP request budget exhausted");
      }
      httpRequests += 1;
    };

    for (let round = 1; round <= roundsPlanned; round += 1) {
      if (signal.aborted || Date.now() >= deadline) {
        budgetExhausted = true;
        break;
      }
      const roundQueries = plannedQueries.filter((query) => query.round === round);
      const allocations: Array<{ query: (typeof plannedQueries)[number]; runtimes: ProviderRuntime[] }> = [];
      for (const queryInfo of roundQueries) {
        const remaining = maxProviderQueryCalls - providerQueryCalls;
        if (remaining <= 0) {
          budgetExhausted = true;
          break;
        }
        const queryRuntimes = runtimes.slice(0, Math.min(runtimes.length, remaining, 8));
        providerQueryCalls += queryRuntimes.length;
        allocations.push({ query: queryInfo, runtimes: queryRuntimes });
      }
      const roundOutcomes = await Promise.all(allocations.map(async ({ query: queryInfo, runtimes: queryRuntimes }) => {
        try {
          const response = await executeSearch(
            { ...deps, runtimes: queryRuntimes },
            {
              ...request,
              query: queryInfo.query,
              mode: "rrf",
              summarize: false,
              timeoutMs: Math.max(1, deadline - Date.now()),
            },
            {
              signal,
              taskId,
              beforeRequest: gatedBeforeRequest,
              ...(this.deps.resourceSlots === undefined ? {} : { providerSlot: this.deps.resourceSlots }),
              ...(onEvent === undefined ? {} : {
                onEvent: (event) => {
                  if (event.type !== "meta") onEvent(event);
                },
              }),
            },
          );
          return { query: queryInfo, index: queryInfo.queryIndex - 1, response };
        } catch (error) {
          return { query: queryInfo, index: queryInfo.queryIndex - 1, response: null, error };
        }
      }));
      outcomes.push(...roundOutcomes);
    }
    const deepBudget: NonNullable<SearchResponse["deepBudget"]> = {
      maxQueries,
      maxRounds,
      maxProviderQueryCalls,
      maxHttpRequests,
      queriesPlanned: plannedQueries.length,
      roundsPlanned,
      providerQueryCalls,
      httpRequests,
      modelCalls,
      budgetExhausted,
    };

    // Indexed rather than matched by query text: two rewrites can be identical,
    // and matching by string would then mark both as succeeded together.
    const succeeded = outcomes.filter(
      (outcome): outcome is { query: (typeof queries)[number]; index: number; response: SearchResponse } =>
        outcome.response !== null && outcome.response.status !== "failed",
    );
    const succeededIndexes = new Set(succeeded.map((outcome) => outcome.index));
    const failed = outcomes.filter((outcome) => !succeededIndexes.has(outcome.index));

    /** Failure entries for rewrites that produced no usable response. */
    const queryFailures = (): SearchErrorSummary[] =>
      failed.map((outcome) => {
        const detail = outcome.response
          ? outcome.response.errors.map((item) => item.message).join("; ") || "all providers failed"
          : outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error);
        const code = outcome.response?.errors[0]?.code ?? "unknown";
        return {
          providerId: outcome.response?.errors[0]?.providerId ?? "deep-query",
          providerName: "Deep search",
          code,
          message: `Query "${outcome.query.query}" failed: ${detail}`,
          query: outcome.query.query,
        };
      });

    const providerStats = new Map<string, SearchResponse["stats"]["providers"][number]>();
    for (const outcome of outcomes) {
      if (outcome.response === null) continue;
      for (const stat of outcome.response.stats.providers) {
        const existing = providerStats.get(stat.providerId);
        if (!existing) {
          providerStats.set(stat.providerId, { ...stat, httpRequests: stat.httpRequests ?? 0 });
        } else {
          existing.resultCount += stat.resultCount;
          existing.attempts += stat.attempts;
          existing.httpRequests = (existing.httpRequests ?? 0) + (stat.httpRequests ?? 0);
          existing.latencyMs = Math.max(existing.latencyMs, stat.latencyMs);
          existing.ok = existing.ok || stat.ok;
        }
      }
    }

    if (succeeded.length === 0) {
      // Return a *failed* response instead of throwing: the caller then gets the
      // per-query failure list, REST answers 503, and the task row records
      // `failed` with the same errors. Throwing would lose that structure.
      // A parked source is a reason the rewrites failed, and the caller is
      // entitled to see it here rather than only in REST's generic error.
      const failures = [...queryFailures(), ...skippedByHealth];
      if (isDeadlineAbort(signal)) {
        failures.push({ providerId: "engine", providerName: "Search Hub", code: "timeout", message: "Search deadline exceeded" });
      }
      return {
        taskId,
        query: request.query,
        mode: "deep",
        status: isCancellationAbort(signal) ? "cancelled" : "failed",
        results: [],
        stats: {
          rawCount: 0,
          dedupedCount: 0,
          fusedCount: 0,
          providers: [...providerStats.values()],
          rerankApplied: false,
          embeddingApplied: false,
          summaryApplied: false,
        partial: true,
        degraded: false,
        timing: { totalMs: 0, fanoutMs: 0, fusionMs: 0 },
        funnel: emptyFunnel(),
        truncationReasons: budgetExhausted ? [{ reason: "deep_budget", count: 1 }] : [],
      },
        errors: failures,
        failedSources: failures.map((item) => ({ id: item.providerId, code: item.code })),
        ...(expansionMetadata ? { queryExpansion: expansionMetadata } : {}),
        deepBudget,
        ...(deepDegradations.length > 0 ? { degradations: deepDegradations } : {}),
        debug: { rewrittenQueries: queries.map((query) => query.query) },
      };
    }

    const valid = succeeded.map((outcome) => outcome.response);
    const deepCandidates: CandidateResult[] = [];
    let invalidDropped = 0;
    let rawPoolTruncated = 0;
    for (const outcome of succeeded) {
      invalidDropped += outcome.response.stats.funnel?.invalidDropped ?? 0;
      const providerResults = outcome.response.debug?.perProviderResults?.length
        ? outcome.response.debug.perProviderResults
        : [{ providerId: outcome.response.results[0]?.provider ?? "unknown", providerName: outcome.response.results[0]?.providerName ?? "unknown", results: outcome.response.results }];
      const providerCandidates: CandidateResult[][] = providerResults.map((provider) => provider.results.map((result) => {
        const bestByProvider = new Map<string, (typeof result.sources)[number]>();
        for (const source of result.sources) {
          const previous = bestByProvider.get(source.providerId);
          if (!previous || source.rank < previous.rank) bestByProvider.set(source.providerId, source);
        }
        const bestSources = [...bestByProvider.values()];
        const fallbackSource = result.sources[0] ?? {
          providerId: result.provider,
          providerName: result.providerName,
          providerType: result.providerType,
          rank: 1,
          url: result.url,
        };
        const primary = bestSources[0] ?? fallbackSource;
        const queryOrigins: SearchQueryOrigin[] = bestSources.map((source) => ({
          queryId: outcome.query.id,
          query: outcome.query.query,
          queryIndex: outcome.query.queryIndex,
          kind: outcome.query.kind,
          round: outcome.query.round,
          weight: outcome.query.weight,
          providerId: source.providerId,
          rank: source.rank,
          score: 1 / (60 + Math.max(1, source.rank)),
        }));
        return {
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          ...(result.publishedAt === undefined ? {} : { publishedAt: result.publishedAt }),
          ...(result.language === undefined ? {} : { language: result.language }),
          ...(result.upstream === undefined ? {} : { upstream: result.upstream }),
          ...(result.upstreamRank === undefined ? {} : { upstreamRank: result.upstreamRank }),
          providerId: primary.providerId,
          providerName: primary.providerName,
          providerType: primary.providerType,
          rank: primary.rank,
          retrievedAt: result.retrievedAt,
          sources: result.sources.map((source) => ({ ...source })),
          queryOrigins,
        } satisfies CandidateResult;
      }));
      for (const list of providerCandidates) {
        list.sort((left, right) => {
          if (left.rank !== right.rank) return left.rank - right.rank;
          const leftUrl = normalizeUrl(left.url) ?? left.url;
          const rightUrl = normalizeUrl(right.url) ?? right.url;
          return leftUrl < rightUrl ? -1 : leftUrl > rightUrl ? 1 : 0;
        });
      }
      const queryPool: CandidateResult[] = [];
      for (let index = 0; queryPool.length < 400; index += 1) {
        let appended = false;
        for (const list of providerCandidates) {
          const candidate = list[index];
          if (!candidate) continue;
          queryPool.push(candidate);
          appended = true;
          if (queryPool.length === 400) break;
        }
        if (!appended) break;
      }
      rawPoolTruncated += providerCandidates.reduce((sum, list) => sum + list.length, 0) - queryPool.length;
      deepCandidates.push(...queryPool);
    }
    const deduped = dedupeResults(deepCandidates);
    const fused = fuseLayeredRrf(
      deduped.results,
      queries.map((query) => ({ id: query.id, weight: query.weight })),
    );
    const candidateSelected = fused.slice(0, 200);
    const candidateTruncatedCount = deduped.results.length - candidateSelected.length;
    const results: SearchResult[] = candidateSelected.slice(0, request.limit ?? 20).map((item) => ({
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
      retrievedAt: item.retrievedAt,
      score: Number(item.deepScore.toFixed(6)),
      fusionScore: Number(item.deepScore.toFixed(6)),
      ...(item.language === undefined ? {} : { language: item.language }),
      ...(item.upstream === undefined ? {} : { upstream: item.upstream }),
      ...(item.upstreamRank === undefined ? {} : { upstreamRank: item.upstreamRank }),
      sources: item.sources,
      queryOrigins: item.queryOrigins,
    }));

    const base = valid[0]!;

    // Errors from every rewrite, plus one entry per rewrite that failed
    // outright. Without the second group a deep search over 3 queries where 1
    // failed would look like a clean `completed`.
    const seenErrors = new Set<string>();
    const errors: SearchErrorSummary[] = [];
    for (const item of [...valid.flatMap((response) => response.errors), ...queryFailures(), ...skippedByHealth]) {
      // Deep merges up to three rewrites; the same parked source is reported by
      // each of them, and the caller needs it once.
      const key = `${item.providerId}|${item.code}|${item.message}`;
      if (seenErrors.has(key)) continue;
      seenErrors.add(key);
      errors.push(item);
    }
    if (isDeadlineAbort(signal)) {
      errors.push({ providerId: "engine", providerName: "Search Hub", code: "timeout", message: "Search deadline exceeded" });
    }
    // A parked source is a failure of this search even when every rewrite
    // succeeded: the caller asked for N sources and got N-1.
    const anyFailure =
      failed.length > 0 ||
      skippedByHealth.length > 0 ||
      valid.some((response) => response.status === "partial");
    const exactDuplicateDropped = deduped.dropped.filter((item) => item.reason === "exact_url").length;
    const nearDuplicateDropped = deduped.dropped.filter((item) => item.reason === "near_title").length;
    const funnel: SearchFunnel = {
      rawReceived: invalidDropped + deepCandidates.length,
      invalidDropped,
      eligible: deepCandidates.length,
      exactDuplicateDropped,
      nearDuplicateDropped,
      dedupedCount: deduped.results.length,
      candidateTruncatedCount,
      candidateSelectedCount: candidateSelected.length,
      rankingInputCount: candidateSelected.length,
      rerankInputCount: 0,
      returnedCount: results.length,
    };
    const truncationReasons: SearchTruncationReason[] = [];
    if (rawPoolTruncated > 0) truncationReasons.push({ reason: "raw_pool_limit", count: rawPoolTruncated });
    if (candidateTruncatedCount > 0) truncationReasons.push({ reason: "candidate_pool_limit", count: candidateTruncatedCount });
    if (budgetExhausted) truncationReasons.push({ reason: "deep_budget", count: 1 });
    const perProviderResults = new Map<string, { providerId: string; providerName: string; results: SearchResult[] }>();
    for (const response of valid) {
      for (const providerResults of response.debug?.perProviderResults ?? []) {
        const target = perProviderResults.get(providerResults.providerId) ?? {
          providerId: providerResults.providerId,
          providerName: providerResults.providerName,
          results: [],
        };
        const seen = new Set(target.results.map((result) => result.id));
        for (const result of providerResults.results) {
          if (seen.has(result.id)) continue;
          seen.add(result.id);
          target.results.push(result);
        }
        perProviderResults.set(providerResults.providerId, target);
      }
    }
    return {
      ...base,
      query: request.query,
      mode: "deep",
      status: isCancellationAbort(signal) ? "cancelled" : isDeadlineAbort(signal) ? "failed" : anyFailure ? "partial" : "completed",
      results,
      stats: {
        ...base.stats,
        rawCount: funnel.rawReceived,
        dedupedCount: funnel.dedupedCount,
        fusedCount: candidateSelected.length,
        providers: [...providerStats.values()],
        partial: errors.length > 0,
        timing: { ...base.stats.timing, totalMs: 0 },
        funnel,
        truncationReasons,
      },
      failedSources: errors.map((item) => ({ id: item.providerId, code: item.code })),
      errors,
      ...(expansionMetadata ? { queryExpansion: expansionMetadata } : {}),
      deepBudget,
      ...(deepDegradations.length > 0 ? { degradations: deepDegradations } : {}),
      debug: {
        ...base.debug,
        rewrittenQueries: queries.map((query) => query.query),
        perProviderResults: [...perProviderResults.values()],
      },
    };
  }

  private async applyEmbedding(
    response: SearchResponse,
    request: SearchRequest,
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    if (signal.aborted) return response;
    const started = Date.now();
    try {
      const embedding = this.deps.models.embeddingModel(request.embeddingModelId);
      const reranked = await rerankWithEmbeddings(
        embedding,
        request.query,
        response.results,
        response.results.length,
        signal,
      );
      return {
        ...response,
        results: reranked,
        stats: {
          ...response.stats,
          embeddingApplied: true,
          timing: { ...response.stats.timing, embeddingMs: Date.now() - started },
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return this.withWarning(response, "embedding", error, "embeddingMs", started);
    }
  }

  private async applyRerank(
    response: SearchResponse,
    request: SearchRequest,
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    if (signal.aborted) return response;
    const started = Date.now();
    try {
      const rerank = this.deps.models.rerankModel(request.rerankModelId);
      const documents = response.results.map((result) => ({
        id: result.url,
        text: `${result.title}\n${result.snippet}`,
      }));
      if (documents.length === 0) {
        return { ...response, stats: { ...response.stats, rerankApplied: true } };
      }
      const before = response.results.slice(0, 100);
      const ranked = await rerank.rerank(request.query, documents, documents.length, signal);
      const index = new Map(response.results.map((result) => [result.url, result] as const));
      const reordered = ranked.results
        .map((item) => {
          const result = index.get(item.id);
          if (!result) return null;
          return { ...result, rerankScore: item.score };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      return {
        ...response,
        results: reordered,
        debug: {
          ...response.debug,
          rerankComparison: { before, after: reordered.slice(0, 100) },
        },
        stats: {
          ...response.stats,
          rerankApplied: true,
          funnel: response.stats.funnel
            ? { ...response.stats.funnel, rerankInputCount: response.stats.funnel.candidateSelectedCount }
            : undefined,
          timing: { ...response.stats.timing, rerankMs: Date.now() - started },
        },
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return this.withWarning(response, "rerank", error, "rerankMs", started);
    }
  }

  private async applySummary(
    response: SearchResponse,
    request: SearchRequest,
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    if (response.deepBudget) response.deepBudget.modelCalls += 1;
    const started = Date.now();
    try {
      const chat = this.deps.models.chatModel(request.chatModelId);
      const summary = await summarizeResults(chat, request.query, response.results, {
        maxDocs: 8,
        signal,
      });
      if (summary.degraded) {
        return this.withWarning(
          response,
          "summary",
          new Error("The chat model did not return a usable summary"),
          "summaryMs",
          started,
        );
      }
      return {
        ...response,
        summary,
        stats: {
          ...response.stats,
          summaryApplied: true,
          timing: { ...response.stats.timing, summaryMs: Date.now() - started },
        },
      };
    } catch (error) {
      return this.withWarning(response, "summary", error, "summaryMs", started);
    }
  }

  private withWarning(
    response: SearchResponse,
    stage: "rerank" | "embedding" | "summary",
    error: unknown,
    timingKey: "rerankMs" | "embeddingMs" | "summaryMs",
    startedAt: number,
  ): SearchResponse {
    const message = error instanceof Error ? error.message : String(error);
    const code: ProviderErrorCode = "server_error";
    const warning: SearchErrorSummary = {
      providerId: `${stage}-model`,
      providerName: `${stage} model`,
      code,
      message: `${stage} failed; returning the fused results without it: ${message}`,
    };
    return {
      ...response,
      stats: {
        ...response.stats,
        degraded: true,
        // The failed stage still cost time; record it inside `timing` (where the
        // type, the UI and the dashboards read it) instead of on `stats`.
        timing: { ...response.stats.timing, [timingKey]: Date.now() - startedAt },
      },
      errors: [...response.errors, warning],
    };
  }

  /**
   * Writes a whole `search_tasks` row for a request that never reached the
   * normal insert.
   *
   * The health gate can reject a search before the task row exists; the caller
   * still receives a taskId, so `getTask` has to be able to find it and the
   * failure has to appear in history. Written once, already finished.
   */
  private persistTaskRow(
    taskId: string,
    request: SearchRequest,
    mode: string,
    runtimes: readonly ProviderRuntime[],
    response: SearchResponse,
    actor: string | undefined,
  ): void {
    const now = new Date().toISOString();
    let serialized = JSON.stringify(response);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORED_RESPONSE_BYTES) {
      serialized = JSON.stringify({
        ...response,
        results: response.results.map(({ metadata: _metadata, ...rest }) => rest),
        debug: { ...response.debug, perProviderResults: undefined },
      });
    }
    try {
      this.deps.db
        .insert(searchTasks)
        .values({
          id: taskId,
          query: request.query,
          mode,
          // Never "completed": this row exists only because the request failed.
          status: response.status,
          providersJson: JSON.stringify(runtimes.map((runtime) => runtime.config.id)),
          resultCount: response.results.length,
          rawCount: response.stats.rawCount,
          durationMs: response.stats.timing.totalMs,
          requestJson: JSON.stringify(request),
          responseJson: serialized,
          diagnosticsSanitized: true,
          actor: actor ?? null,
          createdAt: now,
          finishedAt: now,
        })
        .run();
    } catch (error) {
      // A history write must not turn a structured failure into a 500.
      this.deps.logger.warn({ err: error, taskId }, "could not record a pre-fan-out failure");
    }
  }

  private persistTask(taskId: string, response: SearchResponse, forcedStatus: string | null): void {
    const now = new Date().toISOString();
    let serialized = JSON.stringify(response);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORED_RESPONSE_BYTES) {
      const trimmed: SearchResponse = {
        ...response,
        results: response.results.map(({ metadata: _metadata, ...rest }) => rest),
        debug: { ...response.debug, perProviderResults: undefined },
      };
      serialized = JSON.stringify(trimmed);
    }

    this.deps.db
      .update(searchTasks)
      .set({
        status: forcedStatus ?? response.status,
        resultCount: response.results.length,
        rawCount: response.stats.rawCount,
        durationMs: response.stats.timing.totalMs,
        errorsJson: JSON.stringify(response.errors),
        responseJson: serialized,
        diagnosticsSanitized: true,
        finishedAt: now,
      })
      .where(eq(searchTasks.id, taskId))
      .run();

    if (response.stats.providers.length > 0) {
      this.deps.db
        .insert(searchEvents)
        .values(
          response.stats.providers.map((stat) => ({
            taskId,
            providerId: stat.providerId,
            providerName: stat.providerName,
            providerType: stat.providerType,
            keyId: stat.keyId ?? null,
            ok: stat.ok,
            statusCode: stat.statusCode ?? null,
            latencyMs: Math.max(0, Math.round(stat.latencyMs)),
            resultCount: stat.resultCount,
            errorCode: stat.errorCode ?? null,
            errorMessage: stat.errorMessage?.slice(0, 500) ?? null,
            diagnosticsSanitized: true,
            createdAt: now,
          })),
        )
        .run();
    }
  }
}

export function groupProviderIds(db: SearchHubDb, groupId: string): string[] {
  const row = db
    .select()
    .from(searchGroups)
    .where(and(eq(searchGroups.id, groupId)))
    .get();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.providerIdsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export const SEARCH_MODES = [
  "basic",
  "rrf",
  "rerank",
  "embedding",
  "embedding_rerank",
  "rerank_summary",
  "deep",
] as const;

export type { Freshness };
