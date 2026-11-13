import {
  type SearchRequest,
  type SearchResponse,
  type ProviderRuntimeSnapshot,
  type ProviderInstance,
} from "@search-hub/shared";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface McpSearchService {
  execute(request: SearchRequest, options?: { actor?: string }): Promise<SearchResponse>;
}

export interface McpProviderService {
  list(): Promise<Array<Pick<ProviderInstance, "id" | "name" | "type" | "enabled">>>;
  status(): Promise<ProviderRuntimeSnapshot[]>;
}

export interface McpDeps {
  search: McpSearchService;
  providers: McpProviderService;
  version: string;
}

const freshness = z.enum(["day", "week", "month", "year", "all"]).optional();

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
 * All nine tools call the same SearchService used by REST. There is no MCP
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
    async (args) => {
      try {
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
    async (args) => {
      try {
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
    async (args) => {
      try {
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
    async (args) => {
      try {
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
    async (args) => {
      try {
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
    async (args) => {
      try {
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
    async (args) => {
      try {
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
    async () => {
      try {
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

  server.registerTool(
    "get_search_status",
    {
      title: "Search service status",
      description:
        "Return provider health, key pool status and circuit-breaker state. Never includes API keys.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
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

function toToolResult(result: SearchResponse["results"][number]) {
  return {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    sources: result.sources.map((source) => ({
      providerId: source.providerId,
      providerName: source.providerName,
      rank: source.rank,
    })),
    publishedAt: result.publishedAt,
    retrievedAt: result.retrievedAt,
    score: result.score,
    language: result.language,
  };
}
