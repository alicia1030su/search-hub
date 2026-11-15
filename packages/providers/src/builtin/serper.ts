import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";
import { paginate } from "../pagination.js";

const DEFAULT_BASE_URL = "https://google.serper.dev";

/**
 * Serper.dev — Google SERP via API.
 *
 * Docs: https://serper.dev/ (dashboard) and https://serper.dev/playground
 * - `POST https://google.serper.dev/search`, auth `X-API-KEY`.
 * - Body: `q`, `num` (rows per page; Serper caps at 100), `page` (1-based),
 *   `gl` (country), `hl` (language), `tbs` (time filter), `autocorrect`.
 * - Response: `organic[]` with `title`, `link`, `snippet`, `position`, `date`;
 *   optional `answerBox`, `knowledgeGraph`, `peopleAlsoAsk`, `relatedSearches`.
 *
 * `page` is 1-based while the platform's page index is 0-based, so the adapter
 * adds one. Only `organic[]` becomes a search result: an `answerBox` is a SERP
 * feature, not a web page, and turning it into a result would fabricate a URL.
 */
const MAX_NUM = 100;

export const serperAdapter: SearchProviderAdapter = {
  type: "serper",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "serper", "auth_invalid", "Serper requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const region = search?.region ?? (ctx.config.config["gl"] as string | undefined);
    const language = input.language ?? ctx.config.language ?? undefined;

    const fetchPage = async (index: number, pageSize: number): Promise<RawSearchResult[]> => {
      const body: Record<string, unknown> = {
        q: input.query,
        num: Math.max(1, Math.min(MAX_NUM, Math.trunc(pageSize || input.limit))),
        // Serper's `page` is 1-based.
        page: index + 1,
      };
      if (typeof region === "string" && region) body["gl"] = region;
      if (language) body["hl"] = language;
      if (input.freshness && input.freshness !== "all") body["tbs"] = freshnessToTbs(input.freshness);

      const response = await callJson(ctx, {
        url: `${baseUrl}/search`,
        method: "POST",
        headers: { "X-API-KEY": ctx.apiKey!, "content-type": "application/json" },
        body,
      });
      const payload = response.data as Record<string, unknown>;
      const organic = Array.isArray(payload["organic"]) ? payload["organic"] : [];
      return organic
        .map((item) => {
          const mapped = mapItem(item, {
            titlePaths: ["title"],
            urlPaths: ["link"],
            snippetPaths: ["snippet"],
            publishedPaths: ["date"],
          });
          if (!mapped) return null;
          const position = (item as Record<string, unknown>)["position"];
          return typeof position === "number" ? { ...mapped, upstreamRank: position } : mapped;
        })
        .filter((item): item is RawSearchResult => item !== null);
    };

    if (!search) {
      const single = await fetchPage(0, input.limit);
      return { results: single.slice(0, input.limit), requestUrl: `${baseUrl}/search` };
    }

    const paged = await paginate({ search, fetchPage, signal: input.signal });
    return {
      results: paged.results.slice(0, input.limit),
      requestUrl: `${baseUrl}/search`,
      ...(paged.exhausted && paged.results.length < search.targetResults
        ? {
            warnings: [
              `Serper returned ${paged.results.length} of ${search.targetResults} requested rows after ${paged.requests} request(s).`,
            ],
          }
        : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await serperAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `Serper returned ${results.length} organic result(s).`
            : "Serper responded without organic results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Serper probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function freshnessToTbs(freshness: string): string {
  return freshness === "day" ? "qdr:d" : freshness === "week" ? "qdr:w" : freshness === "month" ? "qdr:m" : "qdr:y";
}
