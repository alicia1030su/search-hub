import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

const DEFAULT_BASE_URL = "https://s.jina.ai";

/**
 * Jina AI Search (`s.jina.ai`).
 *
 * Contract (from the published Jina Reader/Search docs):
 * - `GET {baseUrl}/{query}` returns **Markdown**, or JSON when
 *   `Accept: application/json` (or `X-Respond-With: no-content`).
 * - Auth: `Authorization: Bearer <JINA_API_KEY>` (optional but rate-limited).
 * - JSON shape: `data[]` with `title`, `url`, `description`, `content`.
 *
 * The response is a document, not a SERP: Jina returns page contents rather
 * than ranked snippets. This adapter therefore maps `description` first and
 * falls back to the first paragraph of `content`, and it never claims a rank.
 *
 * Verification: `documented`. `s.jina.ai` was unreachable from this network, so
 * the shape follows the reference only.
 */
interface JinaItem {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  content?: unknown;
}

export const jinaSearchAdapter: SearchProviderAdapter = {
  type: "jina-search",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    // The path carries the query; every path segment must be encoded so a query
    // containing "/" or "?" cannot change the endpoint.
    const url = `${baseUrl}/${encodeURIComponent(input.query)}`;

    const headers: Record<string, string> = {
      accept: "application/json",
      "X-Respond-With": "no-content",
    };
    if (ctx.apiKey) headers["authorization"] = `Bearer ${ctx.apiKey}`;

    const response = await callJson(ctx, { url, method: "GET", headers });
    const payload = response.data as Record<string, unknown>;
    const raw = Array.isArray(payload["data"]) ? (payload["data"] as JinaItem[]) : [];

    const target = search?.targetResults ?? input.limit;
    const results: RawSearchResult[] = [];
    for (const item of raw) {
      const link = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(link)) continue;
      const description = typeof item.description === "string" ? item.description : "";
      const content = typeof item.content === "string" ? item.content : "";
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : link,
        url: link,
        snippet: (description || firstParagraph(content)).slice(0, 600),
      });
      if (results.length >= target || results.length >= input.limit) break;
    }

    return { results, requestUrl: url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await jinaSearchAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Jina returned ${results.length} document(s).` : "Jina returned no documents.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Jina probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function firstParagraph(content: string): string {
  const block = content.split(/\n{2,}/).find((part) => part.trim().length > 40);
  return (block ?? content).replace(/\s+/g, " ").trim();
}

export { DEFAULT_BASE_URL as JINA_DEFAULT_BASE_URL };
