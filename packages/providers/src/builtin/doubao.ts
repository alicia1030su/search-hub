import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "https://open.feedcoopapi.com";
const DEFAULT_PATH = "/search_api/web_search";

/**
 * Doubao (Volcengine) networked web search — Custom edition.
 *
 * Official doc: https://docs.volcengine.com/docs/networked-search/networked-search?lang=zh
 * - `POST https://open.feedcoopapi.com/search_api/web_search`
 * - `Authorization: Bearer <API_KEY>`
 * - **All body fields are PascalCase** (`Query`, `SearchType`, `Count`, ...) and
 *   every item field too (`Title`, `Url`, `Summary`, `SiteName`, `PublishTime`).
 * - `Result` is `null` on failure; the error lives in `ResponseMetadata.Error`.
 * - `Summary` (500–1000 chars) is the vendor-recommended field for models;
 *   `Snippet` (~200 chars) is display-only. We prefer Summary, fall back to
 *   Snippet, and only use Content when the user enabled it.
 * - `Count` max is 50 for web.
 * - 10406/10408/10409/10410/10412 are billing/quota errors, **not** auth
 *   failures: mapping them to `auth_invalid` would disable a valid key.
 */
const DEFAULT_COUNT = 10;

const TIME_RANGE_MAP: Record<string, string> = {
  day: "OneDay",
  week: "OneWeek",
  month: "OneMonth",
  year: "OneYear",
};

interface WebItem {
  Title?: unknown;
  Url?: unknown;
  Summary?: unknown;
  Snippet?: unknown;
  SiteName?: unknown;
  PublishTime?: unknown;
  RankScore?: unknown;
}

function quotaOrAuth(code: string): "auth_invalid" | "quota_exceeded" | "rate_limited" | "bad_request" {
  if (code === "10401" || code === "10403") return "auth_invalid";
  if (code === "10406" || code === "10408" || code === "10409" || code === "10410" || code === "10412") {
    return "quota_exceeded";
  }
  if (code === "700429") return "rate_limited";
  return "bad_request";
}

export const doubaoAdapter: SearchProviderAdapter = {
  type: "doubao",
  requiresKey: true,
  supportsTest: true,
 capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "doubao",
        "auth_invalid",
        "Doubao web search requires an API key.",
      );
    }

    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const configuredPath = ctx.config.config["path"];
    const path =
      typeof configuredPath === "string" && configuredPath.trim().startsWith("/")
        ? configuredPath.trim()
        : DEFAULT_PATH;

    const body: Record<string, unknown> = {
      Query: input.query,
      SearchType: "web",
      Count: Math.max(1, Math.min(50, Math.trunc(input.limit))),
    };
    if (input.freshness && input.freshness !== "all") {
      const mapped = TIME_RANGE_MAP[input.freshness];
      if (mapped) body["TimeRange"] = mapped;
    }

    const sites = ctx.config.config["sites"];
    const blockHosts = ctx.config.config["blockHosts"];
    const filter: Record<string, unknown> = {};
    if (typeof sites === "string" && sites.trim()) filter["Sites"] = sites.trim();
    if (typeof blockHosts === "string" && blockHosts.trim()) filter["BlockHosts"] = blockHosts.trim();
    if (filter["Sites"] || filter["BlockHosts"]) body["Filter"] = filter;

    const rewrite = ctx.config.config["queryRewrite"];
    if (typeof rewrite === "boolean") body["QueryControl"] = { QueryRewrite: rewrite };

    const response = await callJson(ctx, {
      url: `${baseUrl}${path}`,
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        "content-type": "application/json",
      },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const metadata = (payload["ResponseMetadata"] ?? {}) as Record<string, unknown>;
    const error = metadata["Error"] as Record<string, unknown> | undefined;
    if (error) {
      const code = String(error["Code"] ?? "");
      throw new ProviderError(
        ctx.config.id,
        "doubao",
        quotaOrAuth(code),
        String(error["Message"] ?? `Volcengine error ${code}`),
        { details: { volcengineCode: code } },
      );
    }

    const result = payload["Result"] as Record<string, unknown> | null | undefined;
    if (!result) {
      throw new ProviderError(
        ctx.config.id,
        "doubao",
        "bad_request",
        "Volcengine returned a null Result without an error code.",
      );
    }

    const items = Array.isArray(result["WebResults"]) ? result["WebResults"] : [];
    const results = items
      .map((entry) => {
        const item = entry as WebItem;
        const mapped = mapItem(item, {
          titlePaths: ["Title"],
          urlPaths: ["Url"],
          snippetPaths: ["Summary", "Snippet"],
          publishedPaths: ["PublishTime"],
          scorePaths: ["RankScore"],
        });
        if (!mapped) return null;
        const site = typeof item.SiteName === "string" && item.SiteName ? item.SiteName : undefined;
        return { ...mapped, ...(site ? { upstream: { providerName: site } } : {}) };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: `${baseUrl}${path}` };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await doubaoAdapter.search(
        { query: "人工智能", limit: DEFAULT_COUNT, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `Doubao web search returned ${results.length} result(s).`
            : "Doubao responded but returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Doubao probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
