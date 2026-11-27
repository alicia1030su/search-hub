import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectArray, expectObject } from "../http.js";
import { providerRateLimitKey, withProviderRateLimit } from "../rate-limit.js";

/**
 * Wikipedia / Wikimedia search (MediaWiki Action API).
 *
 * Contract (from the published MediaWiki API help):
 * - `GET https://{lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=…&format=json&srlimit=…`
 * - No authentication for reads; a descriptive `User-Agent` is required by the
 *   Wikimedia Foundation's user-agent policy.
 * - Response: `query.search[]` with `title`, `snippet` (HTML with `<span
 *   class="searchmatch">`), `timestamp`, `pageid`, `size`, `wordcount`.
 * - Article URL: `https://{lang}.wikipedia.org/?curid={pageid}`.
 *
 * This is an encyclopaedia index: it returns articles, not ranked web pages.
 * The adapter says so in a warning so a caller cannot mistake it for the web.
 *
 * Verification: `documented`. `en.wikipedia.org` was unreachable from this
 * network; `api.wikimedia.org` answered 200 for its OpenAPI description.
 */
interface WikiSearchItem {
  title?: unknown;
  snippet?: unknown;
  timestamp?: unknown;
  pageid?: unknown;
}

const DEFAULT_LANG = "en";

export const wikipediaAdapter: SearchProviderAdapter = {
  type: "wikipedia",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const langRaw = (ctx.config.config["language"] as string | undefined) ?? input.language ?? DEFAULT_LANG;
    const lang = /^[a-z-]{2,12}$/i.test(langRaw) ? langRaw.toLowerCase() : DEFAULT_LANG;
    const baseUrl = (ctx.config.baseUrl ?? `https://${lang}.wikipedia.org`).replace(/\/+$/, "");
    const search = ctx.config.search;
    const limit = Math.max(1, Math.min(50, Math.trunc(search?.targetResults ?? input.limit)));

    const url = new URL(`${baseUrl}/w/api.php`);
    url.searchParams.set("action", "query");
    url.searchParams.set("list", "search");
    url.searchParams.set("srsearch", input.query);
    url.searchParams.set("srlimit", String(limit));
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");

    const userAgent = typeof ctx.config.config["userAgent"] === "string" && ctx.config.config["userAgent"].trim()
      ? ctx.config.config["userAgent"].trim()
      : "SearchHub (https://github.com/alicia1030su/search-hub; self-hosted search aggregator)";
    const response = await withProviderRateLimit(
      providerRateLimitKey("wikipedia", baseUrl),
      { maxPerMinute: 60, maxInFlight: 2 },
      () => callJson(ctx, {
        url: url.toString(),
        method: "GET",
        headers: {
          accept: "application/json",
          // Wikimedia requires a descriptive agent with a way to contact the
          // operator; a generic or versionless agent is rate-limited aggressively.
          "user-agent": userAgent,
        },
      }),
    );

    const payload = expectObject(ctx, response.data, "Wikipedia response");
    if (payload["error"] !== undefined) {
      const detail = payload["error"];
      const message = typeof detail === "object" && detail !== null
        ? String((detail as Record<string, unknown>)["info"] ?? (detail as Record<string, unknown>)["code"] ?? "unknown error")
        : String(detail);
      throw new ProviderError(ctx.config.id, "wikipedia", "bad_request", `Wikipedia returned a business error: ${message.slice(0, 200)}`);
    }
    const query = expectObject(ctx, payload["query"], "Wikipedia query");
    const items = expectArray(ctx, query["search"], "Wikipedia search results");

    const results: RawSearchResult[] = [];
    for (const raw of items) {
      const item = raw as WikiSearchItem;
      const pageId = typeof item.pageid === "number" ? item.pageid : undefined;
      const title = typeof item.title === "string" ? item.title : "";
      if (!title || pageId === undefined) continue;
      results.push({
        title,
        url: `${baseUrl}/?curid=${pageId}`,
        snippet: stripTags(item.snippet).slice(0, 600),
        ...(typeof item.timestamp === "string" ? { publishedAt: item.timestamp } : {}),
        language: lang,
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url.toString(),
      warnings: ["Wikipedia returns encyclopaedia articles, not general web pages."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await wikipediaAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Wikipedia returned ${results.length} article(s).` : "Wikipedia returned no articles.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Wikipedia probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function stripTags(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}
