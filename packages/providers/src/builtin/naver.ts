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
import { paginate } from "../pagination.js";

const DEFAULT_BASE_URL = "https://openapi.naver.com";

/**
 * Naver Search API (Korean web index).
 *
 * Contract (from the published NAVER Developers reference):
 * - `GET {baseUrl}/v1/search/{webkr|news|blog|kin}?query=…&display=…&start=…&sort=…`
 * - Auth: **two headers**, `X-Naver-Client-Id` and `X-Naver-Client-Secret`.
 *   The platform stores a credential pair, so the user enters `id:secret` and
 *   the adapter splits it — a single bearer token would be rejected.
 * - Response: `items[]` with `title`, `link`, `description`, `pubDate` (news) or
 *   `postdate` (blog); Naver wraps matched words in `<b>` so tags must be
 *   stripped.
 *
 * `start` is 1-based, `display` caps at 100, and Naver refuses `start` above
 * 1000 — the planner is bounded accordingly.
 *
 * Verification: `documented`. `openapi.naver.com` answered `401` here (no
 * credential), which confirms host and path.
 */
const MAX_DISPLAY = 100;
const MAX_START = 1000;

interface NaverItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
  postdate?: unknown;
}

export const naverAdapter: SearchProviderAdapter = {
  type: "naver",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "naver",
        "auth_invalid",
        "Naver requires `client_id:client_secret` as the credential.",
      );
    }
    const separator = ctx.apiKey.indexOf(":");
    if (separator <= 0) {
      throw new ProviderError(ctx.config.id, "naver", "auth_invalid", "Naver credential must be `id:secret`.");
    }
    const clientId = ctx.apiKey.slice(0, separator);
    const clientSecret = ctx.apiKey.slice(separator + 1);

    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const kindRaw = ctx.config.config["kind"];
    const kind = typeof kindRaw === "string" && ["webkr", "news", "blog", "kin"].includes(kindRaw) ? kindRaw : "webkr";

    const fetchPage = async (index: number, pageSize: number): Promise<RawSearchResult[]> => {
      const display = Math.max(1, Math.min(MAX_DISPLAY, Math.trunc(pageSize || input.limit)));
      const start = Math.min(MAX_START, index * display + 1);
      const url = new URL(`${baseUrl}/v1/search/${kind}`);
      url.searchParams.set("query", input.query);
      url.searchParams.set("display", String(display));
      url.searchParams.set("start", String(start));
      if (ctx.config.config["sort"] === "date") url.searchParams.set("sort", "date");

      const response = await callJson(ctx, {
        url: url.toString(),
        method: "GET",
        headers: { "X-Naver-Client-Id": clientId, "X-Naver-Client-Secret": clientSecret },
      });
      const payload = response.data as Record<string, unknown>;
      const items = Array.isArray(payload["items"]) ? (payload["items"] as NaverItem[]) : [];
      const rows: RawSearchResult[] = [];
      for (const item of items) {
        const link = typeof item.link === "string" ? item.link : "";
        if (!/^https?:\/\//i.test(link)) continue;
        const published = typeof item.pubDate === "string" ? item.pubDate : item.postdate;
        rows.push({
          title: stripTags(item.title) || link,
          url: link,
          snippet: stripTags(item.description).slice(0, 600),
          ...(typeof published === "string" ? { publishedAt: published } : {}),
          language: "ko",
        });
      }
      return rows;
    };

    const requestUrl = `${baseUrl}/v1/search/${kind}`;

    if (!search) {
      const single = await fetchPage(0, Math.min(input.limit, MAX_DISPLAY));
      return { results: single.slice(0, input.limit), requestUrl };
    }

    const paged = await paginate({ search, fetchPage, maxPages: 10, signal: input.signal });
    const warnings: string[] = [];
    if (paged.exhausted && paged.results.length < search.targetResults) {
      warnings.push(`Naver returned ${paged.results.length} of ${search.targetResults} requested rows in ${paged.requests} request(s).`);
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
      const { results } = await naverAdapter.search({ query: "검색", limit: 5, signal: ctx.signal }, ctx);
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Naver returned ${results.length} result(s).` : "Naver returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Naver probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function stripTags(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

export { DEFAULT_BASE_URL as NAVER_DEFAULT_BASE_URL };
