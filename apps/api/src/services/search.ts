import { and, eq, lt } from "drizzle-orm";
import {
  SearchHubError,
  type Freshness,
  type ProviderErrorCode,
  type SearchErrorSummary,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
  type SafeFetch,
  type Logger,
} from "@search-hub/shared";
import { executeSearch, type ProviderRuntime } from "@search-hub/core";
import { rerankWithEmbeddings, rewriteQuery, summarizeResults } from "@search-hub/models";
import type { SearchHubDb } from "@search-hub/db";
import { auditLogs, searchEvents, searchGroups, searchTasks } from "@search-hub/db";
import type { ProviderService } from "./providers.js";
import type { ModelService } from "./models.js";
import type { SettingsService } from "./settings.js";

export interface SearchServiceDeps {
  db: SearchHubDb;
  providers: ProviderService;
  models: ModelService;
  settings: SettingsService;
  fetch: SafeFetch;
  logger: Logger;
}

const MAX_STORED_RESPONSE_BYTES = 512 * 1024;

function modeIncludesRerank(mode: SearchRequest["mode"]): boolean {
  return mode === "rerank" || mode === "embedding_rerank" || mode === "rerank_summary";
}

function modeIncludesEmbedding(mode: SearchRequest["mode"]): boolean {
  return mode === "embedding" || mode === "embedding_rerank";
}

function modeIncludesSummary(mode: SearchRequest["mode"]): boolean {
  return mode === "rerank_summary";
}

export class SearchService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cache = new Map<string, { expiresAt: number; response: SearchResponse }>();

  constructor(private readonly deps: SearchServiceDeps) {}

  async execute(
    request: SearchRequest,
    options: { actor?: string; signal?: AbortSignal } = {},
  ): Promise<SearchResponse> {
    const settings = this.deps.settings.get();
    const taskId = `task_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(options.signal?.reason ?? new Error("cancelled"));
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const providerIds = this.resolveProviderIds(request);
    const runtimes = this.deps.providers.runtimesFor(providerIds);
    if (runtimes.length === 0) {
      throw new SearchHubError(
        "validation_error",
        "No enabled search provider matched this request. Check provider selection or enable a provider.",
      );
    }

    const mode = request.mode ?? settings.defaults.mode;
    const wantsRerank = request.rerank ?? modeIncludesRerank(mode);
    const wantsEmbedding = request.embedding ?? modeIncludesEmbedding(mode);
    const wantsSummary = request.summarize ?? modeIncludesSummary(mode);

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
    if ((wantsSummary || mode === "deep") && !this.deps.models.findDefault("chat")) {
      throw new SearchHubError(
        "validation_error",
        "AI summarization/deep search requires a chat model. Add one in AI Models or use basic mode.",
      );
    }

    const startedAt = Date.now();
    const cacheConfig = settings.cache;
    const cacheKey = JSON.stringify({
      query: request.query,
      mode,
      providers: runtimes.map((runtime) => runtime.config.id).sort(),
      limit: request.limit ?? settings.defaults.limit,
      language: request.language ?? null,
      freshness: request.freshness ?? null,
      rerank: wantsRerank,
      embedding: wantsEmbedding,
      summarize: wantsSummary,
      rerankModelId: request.rerankModelId ?? null,
      embeddingModelId: request.embeddingModelId ?? null,
      chatModelId: request.chatModelId ?? null,
    });

    if (cacheConfig.enabled && cacheConfig.ttlSeconds > 0) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        const cached: SearchResponse = {
          ...structuredClone(hit.response),
          taskId,
          stats: {
            ...hit.response.stats,
            cached: true,
            timing: { ...hit.response.stats.timing, totalMs: 0 },
          },
        };
        this.deps.db
          .insert(searchTasks)
          .values({
            id: taskId,
            query: request.query,
            mode,
            status: "completed",
            providersJson: JSON.stringify(runtimes.map((runtime) => runtime.config.id)),
            resultCount: cached.results.length,
            rawCount: cached.stats.rawCount,
            durationMs: 0,
            requestJson: JSON.stringify(request),
            responseJson: JSON.stringify(cached),
            actor: options.actor ?? null,
            createdAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          })
          .run();
        return cached;
      }
      if (hit) this.cache.delete(cacheKey);
    }

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
    this.controllers.set(taskId, controller);

    try {
      let response =
        mode === "deep"
          ? await this.runDeep(request, runtimes, controller.signal, taskId)
          : await this.runStandard(request, runtimes, controller.signal, taskId);

      if (wantsEmbedding && mode !== "deep") {
        response = await this.applyEmbedding(response, request, controller.signal);
      }
      if (wantsRerank && mode !== "deep") {
        response = await this.applyRerank(response, request, controller.signal);
      }
      if (wantsSummary || mode === "deep") {
        response = await this.applySummary(response, request, controller.signal);
      }

      response.stats.timing.totalMs = Date.now() - startedAt;
      const cancelled = controller.signal.aborted && options.signal?.aborted === true;

      this.persistTask(taskId, response, cancelled ? "cancelled" : null);
      if (cacheConfig.enabled && cacheConfig.ttlSeconds > 0 && response.status !== "failed") {
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + cacheConfig.ttlSeconds * 1000,
          response: structuredClone(response),
        });
        if (this.cache.size > 100) {
          const oldest = this.cache.keys().next().value;
          if (oldest) this.cache.delete(oldest);
        }
      }
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = controller.signal.aborted ? "cancelled" : "failed";
      this.deps.db
        .update(searchTasks)
        .set({
          status,
          durationMs: Date.now() - startedAt,
          errorsJson: JSON.stringify([{ providerId: "engine", code: "unknown", message }]),
          finishedAt: new Date().toISOString(),
        })
        .where(eq(searchTasks.id, taskId))
        .run();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      this.controllers.delete(taskId);
    }
  }

  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort(new Error("cancelled by user"));
    return true;
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
  } | null {
    const row = this.deps.db.select().from(searchTasks).where(eq(searchTasks.id, taskId)).get();
    if (!row) return null;
    let response: SearchResponse | null = null;
    if (row.responseJson) {
      try {
        response = JSON.parse(row.responseJson) as SearchResponse;
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
    };
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
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      } catch {
        return [];
      }
    }
    return request.providers ?? [];
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

  private async runStandard(
    request: SearchRequest,
    runtimes: ProviderRuntime[],
    signal: AbortSignal,
    taskId: string,
  ): Promise<SearchResponse> {
    const deps = this.engineDeps();
    deps.runtimes = runtimes;
    const response = await executeSearch(deps, request, { signal, taskId });
    if (signal.aborted) {
      response.status = "failed";
      response.errors.push({
        providerId: "engine",
        providerName: "Search Hub",
        code: "cancelled",
        message: "Search cancelled by caller",
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
  ): Promise<SearchResponse> {
    const chat = this.deps.models.chatModel(request.chatModelId);
    const rewritten = await rewriteQuery(chat, request.query, 3, signal);
    const queries = rewritten.slice(0, 3);
    const deps = this.engineDeps();
    deps.runtimes = runtimes;

    const outcomes = await Promise.all(
      queries.map(async (query) => {
        try {
          return await executeSearch(
            deps,
            { ...request, query, mode: "rrf", summarize: false, timeoutMs: request.timeoutMs },
            { signal, taskId },
          );
        } catch {
          return null;
        }
      }),
    );

    const valid = outcomes.filter((item): item is SearchResponse => item !== null);
    if (valid.length === 0) {
      throw new SearchHubError("server_error", "Deep search failed for every rewritten query");
    }

    const merged = new Map<string, SearchResult>();
    for (const response of valid) {
      for (const result of response.results) {
        const existing = merged.get(result.url);
        if (!existing) {
          merged.set(result.url, { ...result, sources: [...result.sources] });
          continue;
        }
        const sources = [...existing.sources];
        for (const source of result.sources) {
          if (!sources.some((item) => item.providerId === source.providerId && item.rank === source.rank)) {
            sources.push(source);
          }
        }
        merged.set(result.url, {
          ...existing,
          score: existing.score + result.score,
          sources,
        });
      }
    }

    const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, request.limit ?? 20);
    const maxScore = Math.max(0.000001, ...results.map((item) => item.score));
    for (const result of results) result.score = Number((result.score / maxScore).toFixed(6));

    const base = valid[0]!;
    const providerStats = new Map<string, SearchResponse["stats"]["providers"][number]>();
    for (const response of valid) {
      for (const stat of response.stats.providers) {
        const existing = providerStats.get(stat.providerId);
        if (!existing) {
          providerStats.set(stat.providerId, { ...stat });
        } else {
          existing.resultCount += stat.resultCount;
          existing.attempts += stat.attempts;
          existing.latencyMs = Math.max(existing.latencyMs, stat.latencyMs);
          existing.ok = existing.ok || stat.ok;
        }
      }
    }

    const errors = valid.flatMap((response) => response.errors);
    return {
      ...base,
      query: request.query,
      mode: "deep",
      status: valid.some((response) => response.status === "partial") ? "partial" : "completed",
      results,
      stats: {
        ...base.stats,
        rawCount: valid.reduce((sum, response) => sum + response.stats.rawCount, 0),
        dedupedCount: results.length,
        fusedCount: results.length,
        providers: [...providerStats.values()],
        timing: { ...base.stats.timing, totalMs: 0 },
      },
      errors,
      debug: {
        ...base.debug,
        rewrittenQueries: queries,
        perProviderResults: base.debug?.perProviderResults,
      },
    };
  }

  private async applyEmbedding(
    response: SearchResponse,
    request: SearchRequest,
    _signal: AbortSignal,
  ): Promise<SearchResponse> {
    const started = Date.now();
    try {
      const embedding = this.deps.models.embeddingModel(request.embeddingModelId);
      const reranked = await rerankWithEmbeddings(
        embedding,
        request.query,
        response.results,
        request.limit ?? 20,
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
      return this.withWarning(response, "embedding", error, "embeddingMs");
    }
  }

  private async applyRerank(
    response: SearchResponse,
    request: SearchRequest,
    _signal: AbortSignal,
  ): Promise<SearchResponse> {
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
      const ranked = await rerank.rerank(request.query, documents, request.limit ?? 20);
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
        stats: {
          ...response.stats,
          rerankApplied: true,
          timing: { ...response.stats.timing, rerankMs: Date.now() - started },
        },
      };
    } catch (error) {
      return this.withWarning(response, "rerank", error, "rerankMs");
    }
  }

  private async applySummary(
    response: SearchResponse,
    request: SearchRequest,
    signal: AbortSignal,
  ): Promise<SearchResponse> {
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
      return this.withWarning(response, "summary", error, "summaryMs");
    }
  }

  private withWarning(
    response: SearchResponse,
    stage: "rerank" | "embedding" | "summary",
    error: unknown,
    timingKey: "rerankMs" | "embeddingMs" | "summaryMs",
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
        [timingKey]: response.stats.timing[timingKey] ?? 0,
      },
      errors: [...response.errors, warning],
    };
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
