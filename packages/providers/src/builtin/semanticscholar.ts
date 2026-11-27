import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectArray, expectObject } from "../http.js";

const DEFAULT_BASE_URL = "https://api.semanticscholar.org";

/**
 * Semantic Scholar Graph API — paper search.
 *
 * Contract (from the published Semantic Scholar API docs):
 * - `GET {baseUrl}/graph/v1/paper/search?query=…&limit=…&fields=…`
 * - Auth optional: `x-api-key` raises the shared rate limit. Without a key the
 *   public pool is aggressive (HTTP 429), which the adapter reports as
 *   `rate_limited` instead of pretending the provider is broken.
 * - Response: `data[]` with `paperId`, `title`, `abstract`, `url`, `year`,
 *   `venue`, `authors[]`.
 *
 * `limit` caps at 100 and the endpoint is offset-paged via `offset`.
 *
 * Verification: `documented`. The host answered `429` here (shared pool), which
 * confirms host and path.
 */
interface S2Paper {
  paperId?: unknown;
  title?: unknown;
  abstract?: unknown;
  url?: unknown;
  year?: unknown;
  venue?: unknown;
}

export const semanticscholarAdapter: SearchProviderAdapter = {
  type: "semanticscholar",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const limit = Math.max(1, Math.min(100, Math.trunc(search?.targetResults ?? input.limit)));

    const url = new URL(`${baseUrl}/graph/v1/paper/search`);
    url.searchParams.set("query", input.query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fields", "title,abstract,url,year,venue,authors,externalIds");

    const headers: Record<string, string> = { accept: "application/json" };
    if (ctx.apiKey) headers["x-api-key"] = ctx.apiKey;

    const response = await callJson(ctx, { url: url.toString(), method: "GET", headers });
    const payload = expectObject(ctx, response.data, "Semantic Scholar response");
    const items = expectArray(ctx, payload["data"], "Semantic Scholar data") as S2Paper[];

    const results: RawSearchResult[] = [];
    for (const item of items) {
      const link = typeof item.url === "string" && item.url
        ? item.url
        : typeof item.paperId === "string"
          ? `https://www.semanticscholar.org/paper/${item.paperId}`
          : "";
      const title = typeof item.title === "string" ? item.title : "";
      if (!link || !title) continue;
      const venue = typeof item.venue === "string" ? item.venue : "";
      const abstract = typeof item.abstract === "string" ? item.abstract : "";
      results.push({
        title,
        url: link,
        snippet: (abstract || venue).slice(0, 600),
        ...(typeof item.year === "number" ? { publishedAt: String(item.year) } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url.toString(),
      warnings: ["Semantic Scholar indexes research papers, not general web pages."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await semanticscholarAdapter.search(
        { query: "transformer attention", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Semantic Scholar returned ${results.length} paper(s).` : "Semantic Scholar returned no papers.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Semantic Scholar probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as SEMANTICSCHOLAR_DEFAULT_BASE_URL };
