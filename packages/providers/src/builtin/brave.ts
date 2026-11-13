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

const DEFAULT_BASE_URL = "https://api.search.brave.com";

const FRESHNESS_MAP: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const LANGUAGE_MAP: Record<string, string> = {
  "zh-cn": "zh-hans",
  zh: "zh-hans",
  "zh-tw": "zh-hant",
  "zh-hk": "zh-hant",
  ja: "jp",
};

function mapLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const key = language.toLowerCase();
  return LANGUAGE_MAP[key] ?? key.split("-")[0];
}

/**
 * Brave Web Search API adapter.
 * Endpoint + auth header follow the official Web Search documentation:
 * GET /res/v1/web/search with X-Subscription-Token.
 * Not live-tested in this repository (no subscription key available).
 */
export const braveAdapter: SearchProviderAdapter = {
  type: "brave",
  requiresKey: true,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "brave", "auth_invalid", "Brave API key is missing");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = new URL("/res/v1/web/search", baseUrl);
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(Math.min(input.limit, 20)));
    url.searchParams.set("offset", "0");
    const language = mapLanguage(input.language);
    if (language) url.searchParams.set("search_lang", language);
    if (input.freshness && input.freshness !== "all" && FRESHNESS_MAP[input.freshness]) {
      url.searchParams.set("freshness", FRESHNESS_MAP[input.freshness]!);
    }
    const country = ctx.config.config["country"];
    if (typeof country === "string" && country) url.searchParams.set("country", country);

    const response = await callJson(ctx, {
      url: url.toString(),
      method: "GET",
      headers: {
        "X-Subscription-Token": ctx.apiKey,
        Accept: "application/json",
        "Accept-Encoding": "gzip",
      },
    });

    const body = expectObject(ctx, response.data, "Brave response");
    const web = body["web"];
    const rawResults = web ? getByPath(web, "results") : undefined;
    const items = Array.isArray(rawResults) ? rawResults : [];

    const results = items
      .map((item) =>
        mapItem(item, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["description", "profile.long_name"],
          publishedPaths: ["page_age", "age"],
          languagePaths: ["language"],
        }),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: response.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    const { results } = await braveAdapter.search(
      { query: "search engine", limit: 3, signal: ctx.signal },
      ctx,
    );
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      latencyMs,
      resultCount: results.length,
      message: `Brave returned ${results.length} result(s) in ${latencyMs}ms`,
      sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
    };
  },
};
