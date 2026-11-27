import {
  ProviderError,
  redactSecrets,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";
import { paginate, type PaginatedPage } from "../pagination.js";

const DEFAULT_BASE_URL = "https://www.searchapi.io";

/**
 * SearchAPI.io — Google SERP JSON.
 *
 * Contract (from the published SearchAPI.io docs):
 * - `GET {baseUrl}/api/v1/search?engine=google&q=…&api_key=…&num=…&page=…`
 * - Auth: `api_key` query parameter.
 * - Response: `organic_results[]` with `title`, `link`, `snippet`, `position`,
 *   `date`; plus `answer_box`, `knowledge_graph`.
 *
 * `page` is **1-based** here while our planner is 0-based, so the adapter adds
 * one. `num` max is 100.
 *
 * Verification: `documented`. The host answered `401` without a key, which
 * confirms the path; the payload follows the reference only.
 */
const MAX_NUM = 100;

interface OrganicResult {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  position?: unknown;
  date?: unknown;
}

export const searchapiAdapter: SearchProviderAdapter = {
  type: "searchapi",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "searchapi", "auth_invalid", "SearchAPI.io requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const engine = (ctx.config.config["engine"] as string | undefined) ?? "google";
    const region = search?.region ?? (ctx.config.config["gl"] as string | undefined);
    const language = input.language ?? ctx.config.language ?? undefined;

    const fetchPage = async (index: number, pageSize: number): Promise<PaginatedPage> => {
      const url = new URL(`${baseUrl}/api/v1/search`);
      url.searchParams.set("engine", engine);
      url.searchParams.set("q", input.query);
      url.searchParams.set("api_key", ctx.apiKey!);
      url.searchParams.set("num", String(Math.max(1, Math.min(MAX_NUM, Math.trunc(pageSize || input.limit)))));
      url.searchParams.set("page", String(index + 1));
      if (typeof region === "string" && region) url.searchParams.set("gl", region);
      if (language) url.searchParams.set("hl", language);

      const response = await callJson(ctx, { url: url.toString(), method: "GET" });
      const payload = response.data as Record<string, unknown>;
      if (typeof payload["error"] === "string") {
        throw new ProviderError(ctx.config.id, "searchapi", "bad_request", redactSecrets(payload["error"], [ctx.apiKey]));
      }
      const organic = Array.isArray(payload["organic_results"])
        ? (payload["organic_results"] as OrganicResult[])
        : [];
      const rows: RawSearchResult[] = [];
      for (const item of organic) {
        const link = typeof item.link === "string" ? item.link : "";
        if (!/^https?:\/\//i.test(link)) continue;
        rows.push({
          title: typeof item.title === "string" && item.title ? item.title : link,
          url: link,
          snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 600) : "",
          ...(typeof item.date === "string" ? { publishedAt: item.date } : {}),
          ...(typeof item.position === "number" ? { upstreamRank: item.position } : {}),
        });
      }
      return { items: rows, rawCount: organic.length };
    };

    const requestUrl = `${baseUrl}/api/v1/search`;

    if (!search) {
      const single = await fetchPage(0, Math.min(input.limit, MAX_NUM));
      return { results: single.items.slice(0, input.limit), requestUrl };
    }

    const paged = await paginate({ search, fetchPage, maxPages: 10, signal: input.signal });
    const warnings: string[] = [];
    if (paged.exhausted && paged.results.length < search.targetResults) {
      warnings.push(
        `SearchAPI.io returned ${paged.results.length} of ${search.targetResults} requested rows in ${paged.requests} request(s).`,
      );
    }
    return {
      results: paged.results.slice(0, input.limit),
      requestUrl,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await searchapiAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `SearchAPI.io returned ${results.length} organic result(s).` : "SearchAPI.io returned no organic results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `SearchAPI.io probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as SEARCHAPI_DEFAULT_BASE_URL };
