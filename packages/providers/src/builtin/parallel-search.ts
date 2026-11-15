import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

const DEFAULT_BASE_URL = "https://api.parallel.ai";

/**
 * Parallel Search API.
 *
 * Contract (from the published Parallel Web Systems reference):
 * - `POST {baseUrl}/v1beta/search`, auth `x-api-key`.
 * - Body: `objective` and/or `search_queries[]`, `max_results`,
 *   `max_chars_per_result`, `source_policy` with `include_domains`.
 * - Response: `results[]` with `title`, `url`, `excerpts[]` (and `publish_date`
 *   when available).
 *
 * Parallel is built around an "objective" rather than a keyword query, so the
 * user query is sent as both `objective` and a single `search_queries` entry:
 * sending only a keyword would under-use the API, sending only an objective
 * would drop the exact phrasing the user typed.
 *
 * Verification: `documented`. The endpoint answered `401` here, which confirms
 * host and path; no key exists, so the body follows the reference.
 */
interface ParallelResult {
  title?: unknown;
  url?: unknown;
  excerpts?: unknown;
  publish_date?: unknown;
  snippet?: unknown;
}

export const parallelSearchAdapter: SearchProviderAdapter = {
  type: "parallel-search",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "parallel-search", "auth_invalid", "Parallel requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const maxResults = Math.max(1, Math.min(50, Math.trunc(search?.targetResults ?? input.limit)));

    const body: Record<string, unknown> = {
      objective: input.query,
      search_queries: [input.query],
      max_results: maxResults,
      max_chars_per_result: 2000,
    };
    if (search?.includeDomains && search.includeDomains.length > 0) {
      body["source_policy"] = { include_domains: search.includeDomains.slice(0, 10) };
    }

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1beta/search`,
      method: "POST",
      headers: { "x-api-key": ctx.apiKey, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const raw = Array.isArray(payload["results"]) ? (payload["results"] as ParallelResult[]) : [];
    const results: RawSearchResult[] = [];
    for (const item of raw) {
      const link = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(link)) continue;
      const excerpts = Array.isArray(item.excerpts)
        ? (item.excerpts as unknown[]).filter((value): value is string => typeof value === "string")
        : [];
      const snippet = typeof item.snippet === "string" ? item.snippet : excerpts.join(" ");
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : link,
        url: link,
        snippet: snippet.slice(0, 600),
        ...(typeof item.publish_date === "string" ? { publishedAt: item.publish_date } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return { results, requestUrl: `${baseUrl}/v1beta/search` };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await parallelSearchAdapter.search(
        { query: "search engine architecture", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Parallel returned ${results.length} result(s).` : "Parallel returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Parallel probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as PARALLEL_DEFAULT_BASE_URL };
