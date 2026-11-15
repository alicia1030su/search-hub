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
import { normalizeDomains } from "../pagination.js";

const DEFAULT_BASE_URL = "https://api.perplexity.ai";

/**
 * Perplexity Search API — the retrieval endpoint, not the chat models.
 *
 * Contract (from the published Search API reference):
 * - `POST {baseUrl}/search`, `Authorization: Bearer`.
 * - Body: `query`, `max_results`, `search_recency_filter`
 *   (`day` | `week` | `month` | `year`), `country`, optional `search_domain_filter`.
 * - Response: `results[]` with `title`, `url`, `date`, `last_updated`, `snippet`.
 *
 * This returns **raw pages**, so it is `raw_search`. Perplexity's Sonar models
 * are a different product and live in `perplexity-sonar.ts` as a grounded
 * answer provider; conflating them would let an AI answer masquerade as a page.
 *
 * Verification: `documented`. `api.perplexity.ai` was unreachable from the
 * development network, so the adapter has never been exercised against the
 * vendor. `max_results` is capped at 20 conservatively.
 */
const MAX_RESULTS = 20;

interface PerplexityResult {
  title?: unknown;
  url?: unknown;
  date?: unknown;
  last_updated?: unknown;
  snippet?: unknown;
}

const RECENCY = new Set(["day", "week", "month", "year"]);

export const perplexitySearchAdapter: SearchProviderAdapter = {
  type: "perplexity-search",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "perplexity-search", "auth_invalid", "Perplexity requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const target = search?.targetResults ?? input.limit;

    const body: Record<string, unknown> = {
      query: input.query,
      max_results: Math.max(1, Math.min(MAX_RESULTS, Math.trunc(target))),
    };
    if (input.freshness && input.freshness !== "all") body["search_recency_filter"] = input.freshness;
    const country = search?.region ?? (ctx.config.config["country"] as string | undefined);
    if (typeof country === "string" && country.trim()) body["country"] = country.trim().toUpperCase();
    const include = normalizeDomains(search?.includeDomains);
    if (include.length > 0) body["search_domain_filter"] = include;

    const response = await callJson(ctx, {
      url: `${baseUrl}/search`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const raw = Array.isArray(payload["results"]) ? (payload["results"] as PerplexityResult[]) : [];
    const results: RawSearchResult[] = [];
    for (const item of raw) {
      const url = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(url)) continue;
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : url,
        url,
        snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 600) : "",
        ...(typeof item.date === "string" ? { publishedAt: item.date } : {}),
      });
      if (results.length >= input.limit) break;
    }

    const warnings: string[] = [];
    if (search && target > MAX_RESULTS) {
      warnings.push(`Perplexity Search returns at most ${MAX_RESULTS} results per request; the target was clamped.`);
    }

    return {
      results,
      requestUrl: `${baseUrl}/search`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await perplexitySearchAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Perplexity returned ${results.length} result(s).` : "Perplexity returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Perplexity probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as PERPLEXITY_DEFAULT_BASE_URL, RECENCY as PERPLEXITY_RECENCY };
