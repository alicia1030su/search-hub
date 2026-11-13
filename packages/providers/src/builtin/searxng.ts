import {
  ProviderError,
  getByPath,
  type Freshness,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectObject, mapItem } from "../http.js";

/**
 * SearXNG only accepts `day`, `month`, `year` for `time_range`
 * (https://docs.searxng.org/dev/search_api.html — documented as
 * `time_range optional [ day, month, year ]`).
 *
 * There is no `week` bucket upstream. `week` is therefore widened to `month`:
 * a one-month window is a superset of a one-week window, so no result is
 * dropped, only older pages may appear. Callers that need an exact week window
 * should not map it here; the alternative (omitting `time_range` for `week`)
 * would silently return results of any age, which hides the widening entirely.
 */
const TIME_RANGE_MAP: Record<Exclude<Freshness, "all">, string> = {
  day: "day",
  week: "month",
  month: "month",
  year: "year",
};

/**
 * SearXNG's `language` param takes its own codes (e.g. `zh-CN`, `zh-TW`, `en`,
 * `ja`), upper-casing the region subtag. Lower-cased BCP-47 tags from the API
 * are normalized here; unknown values are passed through unchanged so a
 * self-hosted instance with extra engines is not blocked by this table.
 */
const LANGUAGE_MAP: Record<string, string> = {
  "zh-cn": "zh-CN",
  zh: "zh-CN",
  "zh-sg": "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "zh-mo": "zh-TW",
  "pt-br": "pt-BR",
  "en-us": "en",
  "en-gb": "en",
};

function mapLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const key = language.trim().toLowerCase();
  if (!key) return undefined;
  return LANGUAGE_MAP[key] ?? language.trim();
}

/**
 * SearXNG JSON adapter.
 * Requires the instance to enable the `json` output format; public instances
 * usually disable it, so this adapter is intended for a self-hosted instance.
 * If a key is configured it is forwarded as a Bearer token for instances
 * behind an authenticating reverse proxy.
 *
 * Verification status: `documented` only. No SearXNG instance was available in
 * this repository, so this adapter has never been exercised live.
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
    const language = mapLanguage(input.language ?? ctx.config.language ?? undefined);
    if (language) url.searchParams.set("language", language);
    if (input.freshness && input.freshness !== "all") {
      url.searchParams.set("time_range", TIME_RANGE_MAP[input.freshness]);
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
