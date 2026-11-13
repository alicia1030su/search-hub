import {
  ProviderError,
  getByPath,
  isPlainObject,
  type Freshness,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectObject, joinApiPath, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "https://api.search.brave.com";

/**
 * Brave Web Search API adapter.
 *
 * Official documentation:
 * https://api-dashboard.search.brave.com/app/documentation/web-search
 * - `GET https://api.search.brave.com/res/v1/web/search`
 * - Auth header: `X-Subscription-Token: <key>` (not `Authorization`).
 * - Query params used: `q`, `count` (1-20), `offset` (0-9), `search_lang`,
 *   `freshness` (`pd`/`pw`/`pm`/`py`), `country`, optional `extra_snippets=true`.
 * - Response: `web.results[]` with `title`, `url`, `description`, `page_age`,
 *   `language` and, when requested, `extra_snippets[]`.
 *
 * `freshness` uses Brave's own bucket codes, which are **not** the SearXNG or
 * Bocha names — mapping it here is the only place the two vocabularies meet.
 * `search_lang` wants Brave's language codes (`zh-hans`, `zh-hant`, `jp`), not
 * BCP-47 tags, hence the lookup table below.
 *
 * Verification status: `documented` only. `api.search.brave.com` was not
 * reachable from the development network in this environment and no
 * subscription token exists, so this adapter has never been exercised live.
 */
const FRESHNESS_MAP: Record<Exclude<Freshness, "all">, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const LANGUAGE_MAP: Record<string, string> = {
  "zh-cn": "zh-hans",
  zh: "zh-hans",
  "zh-sg": "zh-hans",
  "zh-tw": "zh-hant",
  "zh-hk": "zh-hant",
  "zh-mo": "zh-hant",
  ja: "jp",
};

function mapLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const key = language.toLowerCase();
  return LANGUAGE_MAP[key] ?? key.split("-")[0];
}

export const braveAdapter: SearchProviderAdapter = {
  type: "brave",
  requiresKey: true,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "brave",
        "auth_invalid",
        "Brave API key is missing. Add a subscription token to this provider before searching.",
      );
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Path-preserving join: a base like https://gw.example/brave keeps its prefix.
    const url = new URL(joinApiPath(baseUrl, "/res/v1/web/search"));
    url.searchParams.set("q", input.query);
    // Official range: count 1-20, offset 0-9.
    url.searchParams.set("count", String(Math.min(Math.max(input.limit, 1), 20)));
    url.searchParams.set("offset", "0");
    const language = mapLanguage(input.language ?? ctx.config.language ?? undefined);
    if (language) url.searchParams.set("search_lang", language);
    if (input.freshness && input.freshness !== "all") {
      url.searchParams.set("freshness", FRESHNESS_MAP[input.freshness]);
    }
    const country = ctx.config.config["country"];
    if (typeof country === "string" && country) url.searchParams.set("country", country);
    // Extra snippets are plan-gated on the vendor side; opt in only when asked.
    if (ctx.config.config["extraSnippets"] === true) {
      url.searchParams.set("extra_snippets", "true");
    }

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
    if (web !== undefined && rawResults !== undefined && !Array.isArray(rawResults)) {
      throw new ProviderError(
        ctx.config.id,
        "brave",
        "bad_request",
        "Brave response contained a non-array web.results value",
      );
    }
    const items: unknown[] = Array.isArray(rawResults) ? rawResults : [];

    const results = items
      .map((item) => {
        // `description` is the primary snippet; Brave's `extra_snippets[]` holds
        // up to 5 alternative excerpts the caller opted into. Keep one excerpt as
        // fallback so a result without `description` is still usable.
        const extra = getByPath(item, "extra_snippets");
        const extraText =
          Array.isArray(extra) && typeof extra[0] === "string" ? extra[0] : "";
        const source =
          extraText && typeof getByPath(item, "description") !== "string" && isPlainObject(item)
            ? { ...item, description: extraText }
            : item;
        return mapItem(source, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["description", "profile.long_name"],
          publishedPaths: ["page_age", "age"],
          languagePaths: ["language"],
        });
      })
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
