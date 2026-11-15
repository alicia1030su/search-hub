import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

const DEFAULT_BASE_URL = "https://api.gdeltproject.org";

/**
 * GDELT DOC 2.0 API — global news coverage.
 *
 * Contract (from the published GDELT DOC 2.0 API docs):
 * - `GET {baseUrl}/api/v2/doc/doc?query=…&mode=ArtList&format=json&maxrecords=…&sort=DateDesc&timespan=…`
 * - No authentication.
 * - Response: `articles[]` with `url`, `title`, `seendate`, `domain`,
 *   `language`, `sourcecountry`, `socialimage`.
 *
 * GDELT indexes **news**, not web pages, and its `query` supports its own
 * operators (`domain:`, `sourcecountry:`, `sourcelang:`). The adapter passes the
 * user query through unchanged rather than rewriting it, and caps `maxrecords`
 * at 250 (the documented maximum).
 *
 * Verification: `documented`. The host answered `429` here (it rate-limits
 * aggressively), which confirms host and path.
 */
const MAX_RECORDS = 250;

interface GdeltArticle {
  url?: unknown;
  title?: unknown;
  seendate?: unknown;
  domain?: unknown;
  language?: unknown;
}

export const gdeltAdapter: SearchProviderAdapter = {
  type: "gdelt",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const maxrecords = Math.max(1, Math.min(MAX_RECORDS, Math.trunc(search?.targetResults ?? input.limit)));

    const url = new URL(`${baseUrl}/api/v2/doc/doc`);
    url.searchParams.set("query", input.query);
    url.searchParams.set("mode", "ArtList");
    url.searchParams.set("format", "json");
    url.searchParams.set("maxrecords", String(maxrecords));
    url.searchParams.set("sort", "DateDesc");
    if (input.freshness && input.freshness !== "all") {
      // GDELT's own `timespan` vocabulary: 1d/1w/1m/1y.
      const span = input.freshness === "day" ? "1d" : input.freshness === "week" ? "1w" : input.freshness === "month" ? "1m" : "1y";
      url.searchParams.set("timespan", span);
    }

    const response = await callJson(ctx, { url: url.toString(), method: "GET" });
    const payload = response.data as Record<string, unknown>;
    // GDELT returns 200 with an empty body for "no matches"; treat that as zero
    // results rather than a malformed response.
    const articles = Array.isArray(payload["articles"]) ? (payload["articles"] as GdeltArticle[]) : [];

    const results: RawSearchResult[] = [];
    for (const item of articles) {
      const link = typeof item.url === "string" ? item.url : "";
      const title = typeof item.title === "string" ? item.title : "";
      if (!link || !/^https?:\/\//i.test(link)) continue;
      results.push({
        title: title || link,
        url: link,
        snippet: typeof item.domain === "string" ? item.domain : "",
        ...(typeof item.seendate === "string" ? { publishedAt: gdeltDate(item.seendate) } : {}),
        ...(typeof item.language === "string" ? { language: item.language } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url.toString(),
      warnings: ["GDELT indexes global news coverage, not general web pages."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await gdeltAdapter.search(
        { query: "artificial intelligence", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `GDELT returned ${results.length} article(s).` : "GDELT returned no articles.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `GDELT probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/** GDELT uses `YYYYMMDDTHHMMSSZ`, not ISO 8601. */
function gdeltDate(value: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return value;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

export { DEFAULT_BASE_URL as GDELT_DEFAULT_BASE_URL };
