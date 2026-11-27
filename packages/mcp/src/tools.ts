import {
  SearchHubError,
  type SearchRequest,
  type SearchResponse,
  type ProviderRuntimeSnapshot,
  type ProviderInstance,
} from "@search-hub/shared";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface McpSearchService {
  execute(request: SearchRequest, options?: { actor?: string }): Promise<SearchResponse>;
}

export interface McpProviderService {
  list(): Promise<Array<Pick<ProviderInstance, "id" | "name" | "type" | "enabled">>>;
  status(): Promise<ProviderRuntimeSnapshot[]>;
}

export interface McpWebpageService {
  read(url: string, options?: { maxContentChars?: number }): Promise<unknown>;
}

export interface McpDeps {
  search: McpSearchService;
  webpage?: McpWebpageService;
  providers: McpProviderService;
  /**
   * Read-only health snapshot, supplied by the API.
   *
   * Optional so the stdio entry keeps working against an older REST server that
   * has no `/api/admin/health`; the tool then reports "health unavailable"
   * instead of failing the whole server.
   */
  health?: () => Promise<McpHealthSnapshot | null>;
  version: string;
}

/** The subset of the admin health overview that is safe to expose to a token. */
export interface McpHealthSnapshot {
  generatedAt: string;
  totals: { healthy: number; degraded: number; unhealthy: number; unverified: number };
  providers: Array<{
    providerId: string;
    providerName: string;
    providerType: string;
    enabled: boolean;
    status: string;
    healthScore: number;
    lastCheckedAt: string | null;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
    consecutiveFailures: number;
    successRate: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    keyAvailable: number;
    keyTotal: number;
  }>;
  budget: { maxPerRun: number; maxPerDay: number; usedToday: number; paidProbesEnabled: boolean };
}

const freshness = z.enum(["day", "week", "month", "year", "all"]).optional();

type McpToolScope = "search" | "sources:read";

/** Enforce fine-grained scopes for HTTP; stdio remains authorized by REST proxy. */
function assertHttpToolScope(context: ServerContext, required: McpToolScope): void {
  if (context.http === undefined) return;
  const scopes = context.http.authInfo?.scopes ?? [];
  if (!scopes.includes("*") && !scopes.includes(required)) {
    throw new SearchHubError("forbidden", `Token is missing "${required}" scope`);
  }
}

function jsonResult(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResult({ error: { message } }, true);
}

/**
 * Every search tool calls the same SearchService used by REST. There is no MCP
 * specific search implementation, so ranking and de-dup stay identical.
 */
export function registerTools(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "search_web",
    {
      title: "Web search",
      description:
        "Search the web across the configured providers and return de-duplicated, fused results with titles, URLs, snippets and source attribution.",
      inputSchema: z.object({
        query: z.string().min(1).max(2000).describe("Search query"),
        limit: z.number().int().min(1).max(50).default(10),
        language: z.string().max(24).optional(),
        freshness,
        providers: z.array(z.string()).max(20).optional().describe("Provider instance ids"),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        const response = await deps.search.execute({
          query: args.query,
          limit: args.limit,
          mode: "rrf",
          ...(args.language ? { language: args.language } : {}),
          ...(args.freshness ? { freshness: args.freshness } : {}),
          ...(args.providers ? { providers: args.providers } : {}),
        });
        return jsonResult(
          {
          taskId: response.taskId,
          query: response.query,
          status: response.status,
          results: response.results.map(toToolResult),
          errors: response.errors,
          timing: response.stats.timing,
          // REST reports `cached`; MCP must too, otherwise an agent cannot tell
          // whether it is looking at fresh results or a replay.
          cached: response.stats.cached === true,
          // Grounded answers are kept out of `results` so a caller can never
          // mistake an AI answer for a web page.
          ...(response.answers === undefined ? {} : { answers: response.answers }),
          },
          response.status === "failed",
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_multi",
    {
      title: "Multi-query search",
      description:
        "Run up to five independent queries, merge the results by URL and return one ranked list. Useful for comparative research.",
      inputSchema: z.object({
        queries: z.array(z.string().min(1).max(500)).min(1).max(5),
        limit: z.number().int().min(1).max(50).default(10),
        language: z.string().max(24).optional(),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        const responses = await Promise.all(
          args.queries.map((query) =>
            deps.search.execute({
              query,
              limit: args.limit,
              mode: "rrf",
              ...(args.language ? { language: args.language } : {}),
            }),
          ),
        );
        const merged = new Map<string, (typeof responses)[number]["results"][number]>();
        for (const response of responses) {
          for (const result of response.results) {
            if (!merged.has(result.url)) merged.set(result.url, result);
          }
        }
        return jsonResult({
          queries: args.queries,
          results: [...merged.values()].slice(0, args.limit).map(toToolResult),
          errors: responses.flatMap((response) => response.errors),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_deep",
    {
      title: "Deep search",
      description:
        "Rewrite the query into several variants, retrieve for each variant, merge the evidence and return a cited summary when a chat model is configured.",
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(50).default(15),
        language: z.string().max(24).optional(),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        const response = await deps.search.execute({
          query: args.query,
          limit: args.limit,
          mode: "deep",
          ...(args.language ? { language: args.language } : {}),
        });
        return jsonResult({
          taskId: response.taskId,
          results: response.results.map(toToolResult),
          summary: response.summary,
          errors: response.errors,
          rewrittenQueries: response.debug?.rewrittenQueries,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "fetch_webpage",
    {
      title: "Fetch webpage",
      description:
        "Read a public HTTP(S) page as bounded Markdown. Returns stable readStatus/reasonCode for unavailable pages and never launches a browser.",
      inputSchema: z.object({
        url: z.string().min(1).max(8192).url(),
        maxContentChars: z.number().int().min(1).max(500_000).optional(),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        if (!deps.webpage) {
          return jsonResult({ available: false, reason: "This server build does not expose webpage reading over MCP." }, true);
        }
        const result = await deps.webpage.read(args.url, { maxContentChars: args.maxContentChars });
        const unavailable = result !== null && typeof result === "object" && "readStatus" in result && result.readStatus !== "ok";
        return jsonResult(result, unavailable);
      } catch {
        return jsonResult({ error: { code: "webpage_read_failed", message: "Webpage request failed" } }, true);
      }
    },
  );

  server.registerTool(
    "search_news",
    {
      title: "News search",
      description: "Search with a one-day freshness window and return dated results.",
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(50).default(10),
        language: z.string().max(24).optional(),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        const response = await deps.search.execute({
          query: args.query,
          limit: args.limit,
          mode: "rrf",
          freshness: "day",
          ...(args.language ? { language: args.language } : {}),
        });
        return jsonResult({
          taskId: response.taskId,
          results: response.results.map(toToolResult),
          errors: response.errors,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_with_sources",
    {
      title: "Search with source diagnostics",
      description:
        "Search and include per-provider timing, success/failure and de-duplication statistics for debugging.",
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(50).default(10),
        language: z.string().max(24).optional(),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        const response = await deps.search.execute({
          query: args.query,
          limit: args.limit,
          mode: "rrf",
          ...(args.language ? { language: args.language } : {}),
        });
        return jsonResult({
          taskId: response.taskId,
          status: response.status,
          results: response.results.map(toToolResult),
          sources: response.stats.providers,
          dedupe: {
            rawCount: response.stats.rawCount,
            dedupedCount: response.stats.dedupedCount,
            fusedCount: response.stats.fusedCount,
          },
          errors: response.errors,
          timing: response.stats.timing,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_and_rerank",
    {
      title: "Search with rerank",
      description:
        "Retrieve across providers, fuse with RRF, then re-order the top results with the configured rerank model.",
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(50).default(10),
        rerankModelId: z.string().optional(),
        language: z.string().max(24).optional(),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        const response = await deps.search.execute({
          query: args.query,
          limit: args.limit,
          mode: "rerank",
          ...(args.rerankModelId ? { rerankModelId: args.rerankModelId } : {}),
          ...(args.language ? { language: args.language } : {}),
        });
        return jsonResult({
          taskId: response.taskId,
          rerankApplied: response.stats.rerankApplied,
          results: response.results.map((result) => ({
            ...toToolResult(result),
            rerankScore: result.rerankScore,
          })),
          errors: response.errors,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "search_and_summarize",
    {
      title: "Search and summarize",
      description:
        "Retrieve and fuse results, then generate a summary with numbered citations. The retrieved pages are treated as untrusted data.",
      inputSchema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(50).default(10),
        language: z.string().max(24).optional(),
        chatModelId: z.string().optional(),
      }),
    },
    async (args, context) => {
      try {
        assertHttpToolScope(context, "search");
        const response = await deps.search.execute({
          query: args.query,
          limit: args.limit,
          mode: "rerank_summary",
          ...(args.chatModelId ? { chatModelId: args.chatModelId } : {}),
          ...(args.language ? { language: args.language } : {}),
        });
        return jsonResult({
          taskId: response.taskId,
          summary: response.summary,
          results: response.results.map(toToolResult),
          errors: response.errors,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_search_sources",
    {
      title: "List search sources",
      description: "List the configured provider instances and their health status.",
      inputSchema: z.object({}),
    },
    async (_args, context) => {
      try {
        assertHttpToolScope(context, "sources:read");
        const [providers, status] = await Promise.all([
          deps.providers.list(),
          deps.providers.status(),
        ]);
        return jsonResult({
          providers,
          status,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /**
   * Read-only provider health.
   *
   * Deliberately read-only: a search-scope token must not be able to spend vendor
   * quota by triggering a paid probe. Health data here is derived (status,
   * latency, error code) and contains no API keys, no base URLs and no internal
   * hostnames — the same rule the admin API follows.
   */
  server.registerTool(
    "get_provider_health",
    {
      title: "Provider health",
      description:
        "Read the health of each configured search source: status, last check, P50/P95 latency, success rate, error code and remaining key pool. Read-only; never triggers a paid probe and never returns credentials or endpoint addresses.",
      inputSchema: z.object({
        providerType: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("Only return sources of this catalog type (e.g. tavily). Omit for all."),
        status: z
          .enum(["healthy", "degraded", "unhealthy", "unverified"])
          .optional()
          .describe("Only return sources currently in this state."),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    },
    async (args, _context) => {
      try {
        if (!deps.health) {
          return jsonResult({
            available: false,
            reason: "This server build does not expose provider health over MCP.",
          });
        }
        const snapshot = await deps.health();
        if (!snapshot) {
          return jsonResult({
            available: false,
            reason: "The API did not return a health snapshot (older build or health disabled).",
          });
        }
        const filtered = snapshot.providers
          .filter((item) => (args.providerType ? item.providerType === args.providerType : true))
          .filter((item) => (args.status ? item.status === args.status : true))
          .slice(0, args.limit);
        return jsonResult({
          available: true,
          generatedAt: snapshot.generatedAt,
          totals: snapshot.totals,
          budget: snapshot.budget,
          providers: filtered,
          matchCount: filtered.length,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_search_status",
    {
      title: "Search service status",
      description:
        "Return provider health, key pool status and circuit-breaker state. Never includes API keys.",
      inputSchema: z.object({}),
    },
    async (_args, context) => {
      try {
        assertHttpToolScope(context, "sources:read");
        const status = await deps.providers.status();
        return jsonResult({          version: deps.version,
          providers: status.map((provider) => ({
            providerId: provider.providerId,
            name: provider.providerName,
            type: provider.providerType,
            enabled: provider.enabled,
            healthy: provider.healthy,
            circuitOpen: provider.circuitOpen,
            keys: provider.keys.map((key) => ({
              label: key.label,
              status: key.status,
              inFlight: key.inFlight,
              rpmUsed: key.rpmUsed,
              failureCount: key.failureCount,
              avgLatencyMs: key.avgLatencyMs,
            })),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

export function toToolResult(result: SearchResponse["results"][number]) {
  return {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    provider: result.provider,
    providerType: result.providerType,
    providerName: result.providerName,
    source: result.source,
    sources: result.sources.map((source) => ({
      providerId: source.providerId,
      providerName: source.providerName,
      rank: source.rank,
    })),
    publishedAt: result.publishedAt,
    retrievedAt: result.retrievedAt,
    score: result.score,
    language: result.language,
    // Attribution and vendor rank are distinct; neither replaces `source`.
    ...(result.upstream === undefined ? {} : { upstream: result.upstream }),
    ...(result.upstreamRank === undefined ? {} : { upstreamRank: result.upstreamRank }),
  };
}

/** Number of tools registered by `registerTools`; read by the admin status page. */
export const MCP_TOOL_COUNT = 12;
