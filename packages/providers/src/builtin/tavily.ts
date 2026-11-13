import {
  ProviderError,
  type Freshness,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectArray, expectObject, joinApiPath, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "https://api.tavily.com";

/**
 * Tavily Search API adapter.
 *
 * Official documentation (verified 2026-11):
 * https://docs.tavily.com/documentation/api-reference/endpoint/search
 * - `POST https://api.tavily.com/search`
 * - Auth: `Authorization: Bearer <key>`. The docs also allow `api_key` in the
 *   JSON body, but the header is used here so the secret never lands in request
 *   bodies, proxy logs or captured fixtures.
 * - Body fields used: `query`, `max_results` (0-20), `search_depth`
 *   (`basic`|`advanced`|`fast`|`ultra-fast`), `topic` (`general`|`news`|`finance`),
 *   `time_range` (`day`|`week`|`month`|`year`), `language`, `include_domains`,
 *   `exclude_domains`, `include_answer`.
 *
 * Deliberate choices:
 * - `include_answer` is pinned to `false`. This adapter is a *search source*;
 *   a generated answer is the summarisation stage's job, and injecting it into
 *   `results[]` would make fusion treat prose as a web page.
 * - `days` is NOT sent. The current official request schema no longer lists it
 *   (it was replaced by `time_range`); posting an undocumented body field risks
 *   a 422 from a stricter deployment, so the internal `Freshness` enum maps to
 *   `time_range` instead.
 * - `language` is a documented body field (`ISO 639-1` code or English language
 *   name) and is passed through as a *ranking hint*: `filter_by_language` stays
 *   at its default `false`, so a hint never silently drops results.
 *
 * Verification status: `documented` only. No real API key was available in this
 * repository, so this adapter has never been exercised against the live API.
 */
const SEARCH_DEPTHS = new Set(["basic", "advanced", "fast", "ultra-fast"]);
const TOPICS = new Set(["general", "news", "finance"]);

/** Tavily `time_range` accepts the full words (and d/w/m/y aliases). */
const TIME_RANGE_MAP: Record<Exclude<Freshness, "all">, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

function readDomains(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().toLowerCase())
    .slice(0, max);
}

/**
 * The docs describe `language` as an ISO 639-1 code (`en`, `fr`, `zh-cn`) or an
 * English language name, used as a ranking boost unless `filter_by_language` is
 * true (we leave it false). Lower-cased BCP-47 tags are accepted as-is; anything
 * more exotic is reduced to its primary subtag.
 */
function mapLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const key = language.trim().toLowerCase();
  if (!key) return undefined;
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(key) ? key : key.split("-")[0];
}

export const tavilyAdapter: SearchProviderAdapter = {
  type: "tavily",
  requiresKey: true,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "tavily",
        "auth_invalid",
        "Tavily API key is missing. Add a key to this provider before searching.",
      );
    }

    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Path-preserving join so a path-mounted proxy (https://gw/tavily) keeps its prefix.
    const url = joinApiPath(baseUrl, "/search");

    const configuredDepth = ctx.config.config["searchDepth"];
    const searchDepth =
      typeof configuredDepth === "string" && SEARCH_DEPTHS.has(configuredDepth)
        ? configuredDepth
        : "basic";
    const configuredTopic = ctx.config.config["topic"];
    const topic =
      typeof configuredTopic === "string" && TOPICS.has(configuredTopic)
        ? configuredTopic
        : "general";

    const body: Record<string, unknown> = {
      query: input.query,
      // Official range: 0-20. Ask for at least one, never more than the cap.
      max_results: Math.min(Math.max(input.limit, 1), 20),
      search_depth: searchDepth,
      topic,
      // This adapter is a search source only. An LLM answer must never enter
      // `results[]`, and raw page content is the summarisation stage's job.
      include_answer: false,
      include_raw_content: false,
    };

    if (input.freshness && input.freshness !== "all") {
      body["time_range"] = TIME_RANGE_MAP[input.freshness];
    }

    const language = mapLanguage(input.language ?? ctx.config.language ?? undefined);
    if (language) body["language"] = language;

    const includeDomains = readDomains(ctx.config.config["includeDomains"], 300);
    if (includeDomains.length > 0) body["include_domains"] = includeDomains;
    const excludeDomains = readDomains(ctx.config.config["excludeDomains"], 150);
    if (excludeDomains.length > 0) body["exclude_domains"] = excludeDomains;

    const response = await callJson(ctx, {
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        Accept: "application/json",
      },
      body,
      // Tavily-specific statuses (listed in the official endpoint reference next
      // to 400/401/422/429/500). 432 is a plan/quota ceiling → quota_exceeded;
      // 433 (pay-as-you-go cap) and 434 (flex-tier capacity) are transient
      // capacity signals → rate_limited. Neither should suspend the key.
      statusOverrides: {
        432: { code: "quota_exceeded", retryable: false },
        433: { code: "rate_limited", retryable: true },
        434: { code: "rate_limited", retryable: true },
      },
    });

    const payload = expectObject(ctx, response.data, "Tavily response");
    const items = expectArray(ctx, payload["results"], "results");

    const results = items
      .map((item) =>
        mapItem(item, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["content"],
          publishedPaths: ["published_date", "publishedDate"],
          scorePaths: ["score"],
        }),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: response.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    const { results } = await tavilyAdapter.search(
      { query: "search engine", limit: 3, signal: ctx.signal },
      ctx,
    );
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      latencyMs,
      resultCount: results.length,
      message: `Tavily returned ${results.length} result(s) in ${latencyMs}ms`,
      sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
    };
  },
};
