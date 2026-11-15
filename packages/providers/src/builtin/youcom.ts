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

const DEFAULT_BASE_URL = "https://ydc-index.io";

/**
 * You.com Search API.
 *
 * Contract (from the published API reference):
 * - `GET {baseUrl}/v1/search?query=…&count=…&freshness=…&country=…`
 * - Auth header: `X-API-Key`.
 * - Response: `results.web[]` with `title`, `url`, `description`, `snippets[]`,
 *   `page_age`; `results.news[]` with `title`, `url`, `description`, `page_age`.
 *
 * Only `web[]` becomes a page result. `news[]` is a different index; mixing it
 * into the same list would misreport what was searched.
 *
 * Verification: `documented`. The endpoint answered `402 Payment Required`
 * during development, which confirms the host and path but not the payload —
 * no key exists here, so the response shape follows the reference only.
 */
interface YouWebItem {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  snippets?: unknown;
  page_age?: unknown;
}

export const youcomAdapter: SearchProviderAdapter = {
  type: "youcom",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "youcom", "auth_invalid", "You.com requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const count = Math.max(1, Math.min(100, Math.trunc(search?.targetResults ?? input.limit)));

    const url = new URL(`${baseUrl}/v1/search`);
    url.searchParams.set("query", input.query);
    url.searchParams.set("count", String(count));
    const country = search?.region ?? (ctx.config.config["country"] as string | undefined);
    if (typeof country === "string" && country.trim()) url.searchParams.set("country", country.trim().toUpperCase());
    if (input.freshness && input.freshness !== "all") url.searchParams.set("freshness", input.freshness);

    const response = await callJson(ctx, {
      url: url.toString(),
      method: "GET",
      headers: { "X-API-Key": ctx.apiKey, accept: "application/json" },
    });

    const payload = response.data as Record<string, unknown>;
    const resultsBlock = (payload["results"] ?? {}) as Record<string, unknown>;
    const web = Array.isArray(resultsBlock["web"]) ? (resultsBlock["web"] as YouWebItem[]) : [];

    const results: RawSearchResult[] = [];
    for (const item of web) {
      const link = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(link)) continue;
      const snippets = Array.isArray(item.snippets)
        ? (item.snippets as unknown[]).filter((value): value is string => typeof value === "string")
        : [];
      const description = typeof item.description === "string" ? item.description : "";
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : link,
        url: link,
        snippet: (description || snippets.join(" ")).slice(0, 600),
        ...(typeof item.page_age === "string" ? { publishedAt: item.page_age } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return { results, requestUrl: url.toString() };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await youcomAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `You.com returned ${results.length} result(s).` : "You.com returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `You.com probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as YOUCOM_DEFAULT_BASE_URL };
