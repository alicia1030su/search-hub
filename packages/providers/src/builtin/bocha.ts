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
import { callJson, expectObject, joinApiPath, mapItem, retryAfterFromHeaders } from "../http.js";

const DEFAULT_BASE_URL = "https://api.bochaai.com";

/**
 * Bocha (博查) Web Search API adapter.
 *
 * Official documentation:
 * https://bocha-ai.feishu.cn/wiki/RXEOw02rFiwzGSkd9mUcqoeAnNK
 * - `POST https://api.bochaai.com/v1/web-search`. A documented alias host,
 *   `https://api.bocha.cn`, appears in some of the vendor's own guides and skill
 *   examples; the default here is `api.bochaai.com` and both work through the
 *   `baseUrl` override.
 * - Auth: `Authorization: Bearer <key>`
 * - Body: `query` (required), `freshness`, `summary`, `count` (1-50, default 10),
 *   `page` (1-based). `include` / `exclude` domain filters exist but are not
 *   wired to this adapter's inputs yet.
 * - `freshness`: `noLimit` | `oneDay` | `oneWeek` | `oneMonth` | `oneYear`
 *   (custom `YYYY-MM-DD..YYYY-MM-DD` ranges are also accepted; the shared
 *   `Freshness` enum has no equivalent, so only the named buckets are used).
 * - Response is Bing-compatible:
 *   `{ code, log_id, msg, data: { webPages: { value: [{ name, url, snippet,
 *   summary, siteName, siteIcon, datePublished, dateLastCrawled, ... }] } } }`
 *   and items are mapped from `data.webPages.value[]`.
 * - Errors: HTTP 400 bad request, 401 invalid key, 403 insufficient balance,
 *   429 rate limit, 500 server error; the body is `{ log_id, message, code }`
 *   and `code` may be a string. Some failures arrive as HTTP 200 with a non-200
 *   `code` in the envelope, so both layers are checked.
 *
 * Verification status: `documented` only. No real API key was available in this
 * repository, so this adapter has never been exercised against the live API.
 * Endpoint reachability was probed once with an invalid key: the host answered
 * HTTP 401 `{"log_id":...,"message":"Invalid API KEY","code":"401"}`.
 */
const FRESHNESS_MAP: Record<Freshness, string> = {
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
  all: "noLimit",
};

/**
 * Bocha sometimes reports failures inside an HTTP 200 envelope. Its statuses are
 * documented as: 400 bad request, 401 invalid key, **403 insufficient balance**,
 * 429 rate limit, 500 server error. 403 is therefore a *quota* problem, not an
 * authentication problem — mapping it to `auth_invalid` would suspend a healthy
 * key. HTTP 403 is remapped the same way via `statusOverrides` in `callJson`.
 */
function envelopeError(
  ctx: ProviderContext,
  code: number,
  message: string,
  retryAfterMs?: number,
): ProviderError {
  const detail = message || `Bocha returned code ${code}`;
  if (code === 401) {
    return new ProviderError(ctx.config.id, "bocha", "auth_invalid", detail, {
      statusCode: 401,
    });
  }
  if (code === 403) {
    return new ProviderError(
      ctx.config.id,
      "bocha",
      "quota_exceeded",
      `${detail}（Bocha 403 = 余额不足/配额耗尽，不是 Key 失效）`,
      { statusCode: 403 },
    );
  }
  if (code === 429) {
    return new ProviderError(ctx.config.id, "bocha", "rate_limited", detail, {
      statusCode: 429,
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (code >= 500) {
    return new ProviderError(ctx.config.id, "bocha", "server_error", detail, {
      statusCode: code,
      retryable: true,
    });
  }
  return new ProviderError(ctx.config.id, "bocha", "bad_request", detail, {
    statusCode: code,
  });
}

export const bochaAdapter: SearchProviderAdapter = {
  type: "bocha",
  requiresKey: true,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "bocha",
        "auth_invalid",
        "Bocha API key is missing. Add a key to this provider before searching.",
      );
    }

    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Path-preserving join: a base like https://gw.example/bocha keeps its prefix.
    const url = joinApiPath(baseUrl, "/v1/web-search");

    const freshness = input.freshness ?? "all";
    const body: Record<string, unknown> = {
      query: input.query,
      freshness: FRESHNESS_MAP[freshness],
      // Bocha's `summary` is the *page's own* summary text, not an LLM answer
      // about the query, so it is safe to request. It defaults to true because
      // `snippet` can come back empty for some results; an operator who wants
      // the smaller payload can set `{ "summary": false }` on the provider.
      summary: ctx.config.config["summary"] !== false,
      // Official range: 1-50.
      count: Math.min(Math.max(input.limit, 1), 50),
      page: 1,
    };

    const response = await callJson(ctx, {
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        Accept: "application/json",
      },
      body,
      // Vendor-specific statuses (documented by Bocha, see the adapter header):
      // 403 means "insufficient balance", NOT an invalid key. Suspending the
      // credential would be wrong; cooling it until the next quota reset is right.
      statusOverrides: { 403: { code: "quota_exceeded", retryable: false } },
    });

    const envelope = expectObject(ctx, response.data, "Bocha response");
    const rawCode = envelope["code"];
    const numericCode =
      typeof rawCode === "number"
        ? rawCode
        : typeof rawCode === "string" && rawCode.trim() !== ""
          ? Number(rawCode)
          : undefined;
    if (numericCode !== undefined && Number.isFinite(numericCode) && numericCode !== 200) {
      const message =
        typeof envelope["message"] === "string"
          ? envelope["message"]
          : typeof envelope["msg"] === "string"
            ? envelope["msg"]
            : "";
      // An envelope-level 429 must still carry the upstream Retry-After window.
      throw envelopeError(ctx, numericCode, message, retryAfterFromHeaders(response.headers));
    }

    const data = envelope["data"];
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ProviderError(
        ctx.config.id,
        "bocha",
        "bad_request",
        "Bocha response did not contain a data object",
      );
    }

    const webPages = (data as Record<string, unknown>)["webPages"];
    if (webPages === undefined || webPages === null) {
      // A successful envelope without `webPages` means "no matches".
      return { results: [], requestUrl: response.url };
    }

    const items = getByPath(webPages, "value");
    if (!Array.isArray(items)) {
      throw new ProviderError(
        ctx.config.id,
        "bocha",
        "bad_request",
        "Bocha response is missing the data.webPages.value array",
      );
    }

    const results = items
      .map((item) =>
        mapItem(item, {
          titlePaths: ["name"],
          urlPaths: ["url"],
          snippetPaths: ["snippet", "summary"],
          publishedPaths: ["datePublished", "dateLastCrawled"],
          languagePaths: ["language"],
        }),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: response.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    const { results } = await bochaAdapter.search(
      { query: "搜索 API", limit: 3, signal: ctx.signal },
      ctx,
    );
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      latencyMs,
      resultCount: results.length,
      message: `Bocha returned ${results.length} result(s) in ${latencyMs}ms`,
      sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
    };
  },
};
