import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";
import { normalizeDomains } from "../pagination.js";

const DEFAULT_BASE_URL = "https://api.exa.ai";

/**
 * Exa Search.
 *
 * Docs (verified 2026-11-15): https://docs.exa.ai/reference/search
 * - `POST {baseUrl}/search`, auth `x-api-key` (Bearer also accepted).
 * - Body: `query`, `numResults` (1–100), `type` (`auto` | `lite` | `deep` | …),
 *   `includeDomains` / `excludeDomains` (≤1200 each), `startPublishedDate`,
 *   `endPublishedDate`, `category`, `contents`.
 * - Response: `results[]` with `title`, `url`, `publishedDate`, `author`, `text`,
 *   `score`; plus `requestId`, `costDollars`, `warnings`.
 * - `numResults` max is 100, so a target above that needs the budget check in
 *   the manifest rather than a second page: Exa's `/search` has no offset.
 *
 * `costDollars` is surfaced in a warning so the operator sees paid usage; the
 * platform never bills silently.
 */
interface ExaResult {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  author?: unknown;
  text?: unknown;
  summary?: unknown;
  score?: unknown;
}

const TYPES = new Set(["auto", "lite", "deep-lite", "deep", "instant", "fast", "deep-reasoning"]);

export const exaAdapter: SearchProviderAdapter = {
  type: "exa",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "exa", "auth_invalid", "Exa requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const target = search?.targetResults ?? input.limit;

    const typeRaw = ctx.config.config["searchType"];
    const type = typeof typeRaw === "string" && TYPES.has(typeRaw) ? typeRaw : "auto";
    const category = ctx.config.config["category"];

    const body: Record<string, unknown> = {
      query: input.query,
      numResults: Math.max(1, Math.min(100, Math.trunc(target))),
      type,
    };
    const include = normalizeDomains(search?.includeDomains);
    const exclude = normalizeDomains(search?.excludeDomains);
    if (include.length > 0) body["includeDomains"] = include;
    if (exclude.length > 0) body["excludeDomains"] = exclude;
    if (typeof category === "string" && category.trim()) body["category"] = category.trim();
    // Freshness is expressed as a published-date window, per the API reference.
    if (input.freshness && input.freshness !== "all") {
      body["startPublishedDate"] = isoDaysAgo(input.freshness);
    }

    const response = await callJson(ctx, {
      url: `${baseUrl}/search`,
      method: "POST",
      headers: { "x-api-key": ctx.apiKey, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const results =
      Array.isArray(payload["results"]) && payload["results"].length > 0
        ? (payload["results"] as ExaResult[])
            .map((item) =>
              mapItem(item, {
                titlePaths: ["title"],
                urlPaths: ["url"],
                // `text` is the page body; `summary` is a shorter related excerpt.
                snippetPaths: ["summary", "text"],
                publishedPaths: ["publishedDate"],
                scorePaths: ["score"],
              }),
            )
            .filter((item): item is NonNullable<typeof item> => item !== null)
            .slice(0, input.limit)
        : [];

    const warnings: string[] = [];
    const costRaw = payload["costDollars"];
    const cost =
      typeof costRaw === "object" && costRaw !== null
        ? (costRaw as Record<string, unknown>)["total"]
        : undefined;
    if (typeof cost === "number") warnings.push(`Exa billed $${cost.toFixed(4)} for this search.`);
    if (Array.isArray(payload["warnings"]) && payload["warnings"].length > 0) {
      warnings.push(`Exa returned ${payload["warnings"].length} warning(s); some parameters had no effect.`);
    }
    if (search && target > 100) {
      warnings.push("Exa returns at most 100 results per request; the target above 100 was clamped.");
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
      const { results } = await exaAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `Exa returned ${results.length} result(s).`
            : "Exa responded but returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Exa probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function isoDaysAgo(freshness: string): string {
  const days = freshness === "day" ? 1 : freshness === "week" ? 7 : freshness === "month" ? 30 : 365;
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

export { DEFAULT_BASE_URL as EXA_DEFAULT_BASE_URL };
