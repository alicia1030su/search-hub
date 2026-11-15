import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

const DEFAULT_BASE_URL = "https://metaso.cn";

/**
 * 秘塔搜索 (Metaso) Search API.
 *
 * Protocol, verified 2026-11-15:
 * - The官方控制台 (https://metaso.cn/search-api/playground) documents
 *   `POST https://metaso.cn/api/v1/search`.
 * - A probe without a key returned `{"errCode":2005,"errMsg":"API密钥无效"}`
 *   **with HTTP 200**, which confirms both the host and the path, and proves the
 *   API reports failures inside the body rather than via the status code.
 * - Auth: `Authorization: Bearer <key>`.
 * - Body: `q`, `scope`, `size`, `page`, plus the documented switches
 *   `includeSummary`, `includeRawContent`, `conciseSnippet`.
 * - Response: `{ credits, total, webpages: [{ title, link, snippet, score, date }],
 *   searchParameters }`.
 *
 * `size` is sent as a **string** because every documented example (including the
 * console's own cURL snippet) quotes it; some SDK examples pass a number. The
 * string form is the one the vendor shows, so it is the safer of the two.
 *
 * `scope` is not a free-form filter: a topic/博士 scope returns a different index,
 * not the web. The adapter therefore defaults to `webpage` and, when another
 * scope is configured, adds a warning so the caller cannot mistake it for
 * general web search.
 *
 * Verification: `documented`. The path and error envelope are confirmed by a
 * real unauthenticated call, but no 秘塔 key exists here, so the success payload
 * has not been observed.
 */
const SCOPES = new Set(["webpage", "document", "scholar", "news", "paper"]);

const SCOPE_LABEL: Record<string, string> = {
  webpage: "全网",
  document: "文库",
  scholar: "学术",
  news: "资讯",
  paper: "论文",
};

interface MetasoPage {
  title?: unknown;
  link?: unknown;
  url?: unknown;
  snippet?: unknown;
  date?: unknown;
  score?: unknown;
}

export const metasoAdapter: SearchProviderAdapter = {
  type: "metaso",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "metaso", "auth_invalid", "秘塔搜索需要 API Key。");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = `${baseUrl}/api/v1/search`;

    const search = ctx.config.search;
    const scopeRaw = typeof ctx.config.config["scope"] === "string" ? ctx.config.config["scope"] : "webpage";
    const scope = SCOPES.has(scopeRaw) ? scopeRaw : "webpage";
    const size = Math.max(1, Math.min(50, Math.trunc(search?.targetResults ?? input.limit)));
    const page = 1;

    const body: Record<string, unknown> = {
      q: input.query,
      scope,
      // Documented as a string in the console's own example.
      size: String(size),
      page: String(page),
      includeSummary: false,
      includeRawContent: false,
      conciseSnippet: false,
    };
    const include = search?.includeDomains ?? [];
    if (include.length > 0) body["includeDomains"] = include;

    const response = await callJson(ctx, {
      url,
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    assertMetasoError(ctx, payload);

    const pages = Array.isArray(payload["webpages"])
      ? (payload["webpages"] as MetasoPage[])
      : // Some published examples show `results`; accept it rather than throw,
        // but never invent a second shape.
        Array.isArray(payload["results"])
        ? (payload["results"] as MetasoPage[])
        : [];

    const results: RawSearchResult[] = [];
    for (const item of pages) {
      const link =
        typeof item.link === "string" && item.link
          ? item.link
          : typeof item.url === "string"
            ? item.url
            : "";
      if (!/^https?:\/\//i.test(link)) continue;
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : link,
        url: link,
        snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 600) : "",
        ...(typeof item.date === "string" && item.date ? { publishedAt: item.date } : {}),
      });
      if (results.length >= input.limit) break;
    }

    const warnings: string[] = [];
    if (scope !== "webpage") {
      warnings.push(
        `秘塔当前 scope=${scope}（${SCOPE_LABEL[scope] ?? scope}），它检索的是该专有索引而不是全网网页。`,
      );
    }
    if (results.length === 0 && pages.length === 0) {
      warnings.push("秘塔未返回任何网页结果；可尝试换关键词或把 scope 设为 webpage。");
    }

    return { results, requestUrl: url, ...(warnings.length > 0 ? { warnings } : {}) };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await metasoAdapter.search(
        { query: "搜索引擎", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `秘塔返回 ${results.length} 条网页结果。`
            : "秘塔响应成功但没有网页结果。",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `秘塔探测失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/**
 * 秘塔 answers HTTP 200 even for a bad key, so the body decides.
 * 2005 = invalid key. Anything else is reported verbatim: guessing a cause would
 * hide a real problem such as an exhausted quota.
 */
function assertMetasoError(ctx: ProviderContext, payload: Record<string, unknown>): void {
  const code = payload["errCode"];
  if (code === undefined || code === null || code === 0) return;
  const message = typeof payload["errMsg"] === "string" ? payload["errMsg"] : `errCode ${String(code)}`;
  if (Number(code) === 2005) {
    throw new ProviderError(
      ctx.config.id,
      "metaso",
      "auth_invalid",
      `秘塔拒绝了该 API Key：${message}。请在 https://metaso.cn/search-api/api-keys 重新生成，` +
        "并确认余额（新账号通常有试用额度）。",
    );
  }
  throw new ProviderError(ctx.config.id, "metaso", "bad_request", `秘塔返回错误 ${String(code)}：${message}`);
}

export { DEFAULT_BASE_URL as METASO_DEFAULT_BASE_URL };
