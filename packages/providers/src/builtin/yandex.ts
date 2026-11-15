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

const DEFAULT_BASE_URL = "https://searchapi.api.cloud.yandex.net";

/**
 * Yandex Cloud Search API v2 (the officially licensed web search product).
 *
 * Contract (from the published Yandex Cloud Search API v2 reference):
 * - `POST {baseUrl}/v2/web/search`, `Authorization: Api-Key <secret>`.
 * - Body: `{ query: { search_web: { query_text, page, docs_on_page } }, ... }`.
 * - Response: `{ query: { search_web: { results: [{ title, url, passages: [{ text }] }] } } }`.
 *
 * Yandex also still documents the legacy XML API (`yandex.com/search/xml`), but
 * that one is XML+POST, has a per-IP quota and is being superseded; the Cloud
 * JSON API is the one implemented here. The legacy endpoint is **not** used.
 *
 * `page` is 0-based and `docs_on_page` caps at 100 in the reference, so the
 * planner maps directly.
 *
 * Verification: `documented`. The host was unreachable from this network and no
 * key exists, so the body/response shape follows the reference only.
 */
const DEFAULT_PAGE_SIZE = 10;
const MAX_DOCS = 100;

interface YandexPassage {
  text?: unknown;
}

interface YandexResult {
  title?: unknown;
  url?: unknown;
  passages?: unknown;
  modtime?: unknown;
}

export const yandexAdapter: SearchProviderAdapter = {
  type: "yandex",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "yandex", "auth_invalid", "Yandex Cloud requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const target = Math.max(1, Math.min(MAX_DOCS, Math.trunc(search?.targetResults ?? input.limit)));
    const pageSize = search?.pageSize && search.pageSize > 0 ? Math.min(MAX_DOCS, search.pageSize) : DEFAULT_PAGE_SIZE;

    const collected: RawSearchResult[] = [];
    const seen = new Set<string>();
    const budget = Math.max(1, search?.maxRequestsPerSearch ?? 1);
    let requests = 0;

    for (let page = 0; page < budget; page += 1) {
      const body = {
        query: {
          search_web: {
            query_text: input.query,
            page,
            docs_on_page: Math.min(pageSize, MAX_DOCS),
          },
        },
      };
      const response = await callJson(ctx, {
        url: `${baseUrl}/v2/web/search`,
        method: "POST",
        headers: { authorization: `Api-Key ${ctx.apiKey}`, "content-type": "application/json" },
        body,
      });
      requests += 1;

      const payload = response.data as Record<string, unknown>;
      const queryBlock = (payload["query"] ?? {}) as Record<string, unknown>;
      const web = (queryBlock["search_web"] ?? {}) as Record<string, unknown>;
      const results = Array.isArray(web["results"]) ? (web["results"] as YandexResult[]) : [];
      for (const item of results) {
        const link = typeof item.url === "string" ? item.url : "";
        if (!/^https?:\/\//i.test(link) || seen.has(link)) continue;
        seen.add(link);
        const passages = Array.isArray(item.passages) ? (item.passages as YandexPassage[]) : [];
        const snippet = passages
          .map((passage) => (typeof passage.text === "string" ? passage.text : ""))
          .join(" ")
          .trim();
        collected.push({
          title: typeof item.title === "string" && item.title ? item.title : link,
          url: link,
          snippet: snippet.slice(0, 600),
          ...(typeof item.modtime === "string" ? { publishedAt: item.modtime } : {}),
          language: "ru",
        });
      }
      if (collected.length >= target || results.length < pageSize) break;
    }

    const warnings: string[] = [];
    if (collected.length < target) {
      warnings.push(`Yandex returned ${collected.length} of ${target} requested rows in ${requests} request(s).`);
    }

    return {
      results: collected.slice(0, input.limit),
      requestUrl: `${baseUrl}/v2/web/search`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await yandexAdapter.search({ query: "поиск", limit: 5, signal: ctx.signal }, ctx);
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Yandex returned ${results.length} result(s).` : "Yandex returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Yandex probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as YANDEX_DEFAULT_BASE_URL };
