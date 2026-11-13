import {
  ProviderError,
  getByPath,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectObject, mapItem } from "../http.js";

const TIME_RANGE_MAP: Record<string, string> = {
  day: "day",
  week: "month", // SearXNG only supports day/month/year
  month: "month",
  year: "year",
};

/**
 * SearXNG JSON adapter.
 * Requires the instance to enable the `json` output format; public instances
 * usually disable it, so this adapter is intended for a self-hosted instance.
 * If a key is configured it is forwarded as a Bearer token for instances
 * behind an authenticating reverse proxy.
 */
export const searxngAdapter: SearchProviderAdapter = {
  type: "searxng",
  requiresKey: false,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    if (!ctx.config.baseUrl) {
      throw new ProviderError(
        ctx.config.id,
        "searxng",
        "bad_request",
        "SearXNG requires a base URL (for example http://searxng:8080)",
      );
    }
    const base = ctx.config.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", "1");
    const language = input.language ?? ctx.config.language;
    if (language) url.searchParams.set("language", language);
    if (input.freshness && input.freshness !== "all") {
      const range = TIME_RANGE_MAP[input.freshness];
      if (range) url.searchParams.set("time_range", range);
    }
    const categories = ctx.config.config["categories"];
    if (typeof categories === "string" && categories) url.searchParams.set("categories", categories);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (ctx.apiKey) headers["Authorization"] = `Bearer ${ctx.apiKey}`;

    let response;
    try {
      response = await callJson(ctx, { url: url.toString(), method: "GET", headers });
    } catch (error) {
      if (
        error instanceof ProviderError &&
        (error.statusCode === 403 || error.message.includes("HTTP 403"))
      ) {
        throw new ProviderError(
          ctx.config.id,
          "searxng",
          "blocked",
          "SearXNG rejected the JSON format. Enable `search.formats: [json]` in the instance settings.",
          { statusCode: 403, cause: error },
        );
      }
      throw error;
    }

    const body = expectObject(ctx, response.data, "SearXNG response");
    const raw = body["results"];
    if (!Array.isArray(raw)) {
      throw new ProviderError(
        ctx.config.id,
        "searxng",
        "bad_request",
        "SearXNG response did not contain a results array (is JSON output enabled?)",
      );
    }

    const results = raw
      .map((item) =>
        mapItem(item, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["content", "snippet", "description"],
          publishedPaths: ["publishedDate", "published_date"],
          scorePaths: ["score"],
          languagePaths: ["language"],
        }),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: response.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    const { results } = await searxngAdapter.search(
      { query: "searxng", limit: 3, signal: ctx.signal },
      ctx,
    );
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      latencyMs,
      resultCount: results.length,
      message: `SearXNG returned ${results.length} result(s) in ${latencyMs}ms`,
      sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
    };
  },
};

export function searxngResultsCount(data: unknown): number {
  const results = getByPath(data, "results");
  return Array.isArray(results) ? results.length : 0;
}
