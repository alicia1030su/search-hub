import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "https://qianfan.baidubce.com";
const DEFAULT_PATH = "/v2/ai_search/web_search";

/**
 * Baidu Qianfan AI Search — web_search.
 *
 * Official doc: https://cloud.baidu.com/doc/qianfan-api/s/Jmwbl4qxs
 * - `POST https://qianfan.baidubce.com/v2/ai_search/web_search`
 * - `Authorization: Bearer <API Key>`
 * - Body: `messages` (single-turn: last user content is the query),
 *   `search_source` (`baidu_search_v2` default), `edition`
 *   (`standard` | `turbo` | `pro`), `resource_type_filter`
 *   (`[{type:"web",top_k:N}]`, web top_k max 50), optional `search_filter.match.site`
 *   and `search_recency_filter`.
 * - The real webpages live in **`references[]`**, not `results[]`. Each item has
 *   `title`, `url`, `web_anchor`, `website`, `snippet`, `content`, `date`,
 *   `rerank_score`, `authority_score`, `type`.
 * - This endpoint returns an AI answer plus references. We keep it as
 *   `raw_search` because the adapter returns the references as results; no
 *   answer text is surfaced here.
 */
const DEFAULT_EDITION = "standard";

const ALLOWED_EDITIONS = new Set(["standard", "turbo", "pro"]);

const RECENCY_MAP: Record<string, string> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

interface QianfanReference {
  title?: unknown;
  url?: unknown;
  web_anchor?: unknown;
  website?: unknown;
  snippet?: unknown;
  content?: unknown;
  date?: unknown;
  rerank_score?: unknown;
  type?: unknown;
}

export const qianfanSearchAdapter: SearchProviderAdapter = {
  type: "qianfan-search",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "qianfan-search",
        "auth_invalid",
        "Baidu Qianfan AI Search requires an API key.",
      );
    }

    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const configuredPath = ctx.config.config["path"];
    const path =
      typeof configuredPath === "string" && configuredPath.trim().startsWith("/")
        ? configuredPath.trim()
        : DEFAULT_PATH;

    const editionRaw = ctx.config.config["edition"];
    const edition =
      typeof editionRaw === "string" && ALLOWED_EDITIONS.has(editionRaw) ? editionRaw : DEFAULT_EDITION;

    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: input.query }],
      search_source: "baidu_search_v2",
      edition,
      resource_type_filter: [
        { type: "web", top_k: Math.max(1, Math.min(50, Math.trunc(input.limit))) },
      ],
    };

    const site = ctx.config.config["site"];
    if (typeof site === "string" && site.trim()) {
      body["search_filter"] = { match: { site: [site.trim()] } };
    }
    if (input.freshness && input.freshness !== "all") {
      const mapped = RECENCY_MAP[input.freshness];
      if (mapped) body["search_recency_filter"] = mapped;
    }

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
    if (payload["code"] !== undefined && String(payload["code"]) !== "0") {
      const code = String(payload["code"]);
      throw new ProviderError(
        ctx.config.id,
        "qianfan-search",
        code === "401" || code === "403" ? "auth_invalid" : code === "429" ? "rate_limited" : "bad_request",
        String(payload["message"] ?? `Qianfan error ${code}`),
        { details: { qianfanCode: code } },
      );
    }

    const references = Array.isArray(payload["references"]) ? payload["references"] : [];
    const results = (references as QianfanReference[])
      .filter((item) => item["type"] === undefined || item["type"] === "web")
      .map((item) => {
        const mapped = mapItem(item, {
          titlePaths: ["title", "web_anchor"],
          urlPaths: ["url"],
          snippetPaths: ["snippet", "content"],
          publishedPaths: ["date"],
          scorePaths: ["rerank_score"],
        });
        if (!mapped) return null;
        const siteName =
          typeof item.website === "string" && item.website ? item.website : undefined;
        return { ...mapped, ...(siteName ? { upstream: { providerName: siteName } } : {}) };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: `${baseUrl}${path}` };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await qianfanSearchAdapter.search(
        { query: "北京旅游景区", limit: 10, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `Qianfan AI Search returned ${results.length} reference(s).`
            : "Qianfan responded but returned no web references.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Qianfan probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
