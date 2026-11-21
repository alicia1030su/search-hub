import {
  ProviderError,
  redactSecrets,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";
import { normalizeDomains } from "../pagination.js";

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";

/**
 * Firecrawl Search.
 *
 * Docs (verified 2026-11-15): https://docs.firecrawl.dev/features/search
 * - `POST {baseUrl}/v2/search`, `Authorization: Bearer fc-…`.
 * - Body: `query`, `limit`, `sources` (`web` | `news` | `images`),
 *   `includeDomains` / `excludeDomains`, `categories`
 *   (`research` | `pdf` | `developer` | `gov`), `scrapeOptions`, `tbs`.
 * - Response: `{ success, data: { web: [{ url, title, description, position }],
 *   news: [{ title, url, snippet, date, position }], images: [...] } }`.
 * - The `github` category was removed and now returns 400; `developer` replaced it.
 *
 * Firecrawl has no offset/page parameter, so pagination is not available and the
 * manifest declares `pagination: none`. The per-request `limit` cap is enforced
 * locally instead of being silently ignored.
 */
const MAX_LIMIT = 100;

const CATEGORIES = new Set(["research", "pdf", "developer", "gov"]);

interface FirecrawlWebItem {
  url?: unknown;
  title?: unknown;
  description?: unknown;
  position?: unknown;
  date?: unknown;
}

export const firecrawlAdapter: SearchProviderAdapter = {
  type: "firecrawl",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "firecrawl", "auth_invalid", "Firecrawl requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const target = search?.targetResults ?? input.limit;

    const body: Record<string, unknown> = {
      query: input.query,
      limit: Math.max(1, Math.min(MAX_LIMIT, Math.trunc(target))),
      sources: ["web"],
    };
    const include = normalizeDomains(search?.includeDomains);
    const exclude = normalizeDomains(search?.excludeDomains);
    if (include.length > 0) body["includeDomains"] = include;
    if (exclude.length > 0) body["excludeDomains"] = exclude;
    const category = ctx.config.config["category"];
    if (typeof category === "string" && CATEGORIES.has(category)) body["categories"] = [category];
    if (input.freshness && input.freshness !== "all") {
      body["tbs"] = freshnessToTbs(input.freshness);
    }

    const response = await callJson(ctx, {
      url: `${baseUrl}/v2/search`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    if (payload["success"] === false) {
      throw new ProviderError(
        ctx.config.id,
        "firecrawl",
        "bad_request",
        redactSecrets(String(payload["error"] ?? "Firecrawl reported success=false"), [ctx.apiKey]),
      );
    }
    const data = (payload["data"] ?? {}) as Record<string, unknown>;
    const items = Array.isArray(data["web"]) ? (data["web"] as FirecrawlWebItem[]) : [];

    const results = items
      .map((item) => {
        const mapped = mapItem(item, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["description"],
          publishedPaths: ["date"],
        });
        if (!mapped) return null;
        const position = typeof item.position === "number" ? item.position : undefined;
        return {
          ...mapped,
          ...(position === undefined ? {} : { upstreamRank: position }),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    const warnings: string[] = [];
    if (search && target > MAX_LIMIT) {
      warnings.push(`Firecrawl returns at most ${MAX_LIMIT} results per request; the target was clamped.`);
    }

    return {
      results,
      requestUrl: `${baseUrl}/v2/search`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await firecrawlAdapter.search(
        { query: "web scraping", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `Firecrawl returned ${results.length} result(s).`
            : "Firecrawl responded but returned no web results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Firecrawl probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function freshnessToTbs(freshness: string): string {
  return freshness === "day" ? "qdr:d" : freshness === "week" ? "qdr:w" : freshness === "month" ? "qdr:m" : "qdr:y";
}

export { DEFAULT_BASE_URL as FIRECRAWL_DEFAULT_BASE_URL };
