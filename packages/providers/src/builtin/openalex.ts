import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectArray, expectObject } from "../http.js";

const DEFAULT_BASE_URL = "https://api.openalex.org";

/**
 * OpenAlex — open scholarly catalogue.
 *
 * Contract (from the published OpenAlex API docs):
 * - `GET {baseUrl}/works?search=…&per-page=…&mailto=…&filter=from_publication_date:…`
 * - No authentication; a `mailto` identifies the caller and is recommended.
 * - Response: `results[]` with `id`, `doi`, `title`, `publication_date`,
 *   `abstract_inverted_index`, `primary_location.landing_page_url`,
 *   `best_oa_location.landing_page_url`.
 *
 * `abstract_inverted_index` is a word → positions map, not a string. It is
 * reconstructed into text here; returning the raw map as a snippet would show
 * JSON to the user.
 *
 * Verification: `documented` and **live-tested** against the public API.
 */
interface OpenAlexWork {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  display_name?: unknown;
  publication_date?: unknown;
  abstract_inverted_index?: unknown;
  primary_location?: { landing_page_url?: unknown } | null;
  best_oa_location?: { landing_page_url?: unknown } | null;
}

export const openalexAdapter: SearchProviderAdapter = {
  type: "openalex",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const perPage = Math.max(1, Math.min(200, Math.trunc(search?.targetResults ?? input.limit)));
    const mailto = (ctx.config.config["mailto"] as string | undefined) ?? "";

    const url = new URL(`${baseUrl}/works`);
    url.searchParams.set("search", input.query);
    url.searchParams.set("per-page", String(perPage));
    if (mailto.trim()) url.searchParams.set("mailto", mailto.trim());
    if (input.freshness && input.freshness !== "all") {
      const days = input.freshness === "day" ? 1 : input.freshness === "week" ? 7 : input.freshness === "month" ? 30 : 365;
      const from = new Date(Date.now() - days * 86_400_000);
      url.searchParams.set("filter", `from_publication_date:${from.toISOString().slice(0, 10)}`);
    }

    const response = await callJson(ctx, {
      url: url.toString(),
      method: "GET",
      headers: { accept: "application/json" },
    });

    const payload = expectObject(ctx, response.data, "OpenAlex response");
    const items = expectArray(ctx, payload["results"], "OpenAlex results") as OpenAlexWork[];

    const results: RawSearchResult[] = [];
    for (const item of items) {
      const title =
        (typeof item.title === "string" && item.title) ||
        (typeof item.display_name === "string" && item.display_name) ||
        "";
      const doi = typeof item.doi === "string" ? item.doi : "";
      const landing =
        (item.primary_location?.landing_page_url as string | undefined) ??
        (item.best_oa_location?.landing_page_url as string | undefined) ??
        (typeof item.id === "string" ? item.id : "");
      const url_ = landing || doi;
      if (!url_ || !/^https?:\/\//i.test(url_)) continue;
      results.push({
        title: title || url_,
        url: url_,
        snippet: reconstructAbstract(item.abstract_inverted_index).slice(0, 600),
        ...(typeof item.publication_date === "string" ? { publishedAt: item.publication_date } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url.toString(),
      warnings: ["OpenAlex indexes scholarly works, not general web pages."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await openalexAdapter.search(
        { query: "transformer attention", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `OpenAlex returned ${results.length} work(s).` : "OpenAlex returned no works.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `OpenAlex probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/**
 * Rebuilds the abstract text from OpenAlex's inverted index.
 * Positions are used as sort keys; the same word can repeat.
 */
function reconstructAbstract(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const words: Array<{ position: number; word: string }> = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number") words.push({ position, word });
    }
  }
  words.sort((a, b) => a.position - b.position);
  return words.map((entry) => entry.word).join(" ");
}
