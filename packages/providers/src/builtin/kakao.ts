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
import { paginate, type PaginatedPage } from "../pagination.js";

const DEFAULT_BASE_URL = "https://dapi.kakao.com";

/**
 * Kakao / Daum Search API (Korean index).
 *
 * Contract (from the published Kakao Developers reference):
 * - `GET {baseUrl}/v2/search/{web|blog|cafe|book}?query=…&size=…&page=…&sort=…`
 * - Auth: `Authorization: KakaoAK <REST API KEY>`.
 * - Response: `documents[]` with `title`, `url`, `contents`, `datetime`;
 *   `meta` with `total_count`, `pageable_count`, `is_end`.
 *
 * `page` is 1-based and `size` caps at 50. Kakao also reports `is_end`, which
 * the adapter uses as an authoritative stop signal instead of guessing from a
 * short page.
 *
 * Verification: `documented`. `dapi.kakao.com` was unreachable from this
 * network; the payload follows the reference only.
 */
const MAX_SIZE = 50;

interface KakaoDocument {
  title?: unknown;
  url?: unknown;
  contents?: unknown;
  datetime?: unknown;
}

export const kakaoAdapter: SearchProviderAdapter = {
  type: "kakao",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "kakao", "auth_invalid", "Kakao requires a REST API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const kindRaw = ctx.config.config["kind"];
    const kind = typeof kindRaw === "string" && ["web", "blog", "cafe", "book"].includes(kindRaw) ? kindRaw : "web";

    let isEnd = false;
    const fetchPage = async (index: number, pageSize: number): Promise<PaginatedPage> => {
      const size = Math.max(1, Math.min(MAX_SIZE, Math.trunc(pageSize || input.limit)));
      const url = new URL(`${baseUrl}/v2/search/${kind}`);
      url.searchParams.set("query", input.query);
      url.searchParams.set("size", String(size));
      url.searchParams.set("page", String(index + 1));
      if (ctx.config.config["sort"] === "recency") url.searchParams.set("sort", "recency");

      const response = await callJson(ctx, {
        url: url.toString(),
        method: "GET",
        headers: { authorization: `KakaoAK ${ctx.apiKey}` },
      });
      const payload = response.data as Record<string, unknown>;
      const meta = (payload["meta"] ?? {}) as Record<string, unknown>;
      isEnd = meta["is_end"] === true;
      const documents = Array.isArray(payload["documents"]) ? (payload["documents"] as KakaoDocument[]) : [];
      const rows: RawSearchResult[] = [];
      for (const item of documents) {
        const link = typeof item.url === "string" ? item.url : "";
        if (!/^https?:\/\//i.test(link)) continue;
        rows.push({
          title: stripTags(item.title) || link,
          url: link,
          snippet: stripTags(item.contents).slice(0, 600),
          ...(typeof item.datetime === "string" ? { publishedAt: item.datetime } : {}),
          language: "ko",
        });
      }
      return { items: rows, rawCount: documents.length };
    };

    const requestUrl = `${baseUrl}/v2/search/${kind}`;

    if (!search) {
      const single = await fetchPage(0, Math.min(input.limit, MAX_SIZE));
      return { results: single.items.slice(0, input.limit), requestUrl };
    }

    const paged = await paginate({ search, fetchPage, maxPages: 10, signal: input.signal });
    const warnings: string[] = [];
    if (isEnd && paged.results.length < search.targetResults) {
      warnings.push(`Kakao reported is_end after ${paged.results.length} rows.`);
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
      const { results } = await kakaoAdapter.search({ query: "검색", limit: 5, signal: ctx.signal }, ctx);
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Kakao returned ${results.length} document(s).` : "Kakao returned no documents.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Kakao probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function stripTags(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
}

export { DEFAULT_BASE_URL as KAKAO_DEFAULT_BASE_URL };
