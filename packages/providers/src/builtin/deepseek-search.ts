import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_PATH = "/v1/tools/search";

/**
 * DeepSeek Search — standalone structured web search endpoint.
 *
 * Official doc: https://api-docs.deepseek.com/zh-cn/guides/search/
 * - `POST https://api.deepseek.com/v1/tools/search`, `Authorization: Bearer`.
 * - Body: `query` (1–128 chars), `count` (1–50, default 10), `need_content`
 *   (boolean), optional `ori_question` and `localization`.
 * - This is a **raw search API**, not a chat completion: no model is called and
 *   no answer is generated. That is why this adapter is `raw_search` and not
 *   `grounded_answer`.
 * - Response: `{ results: [...] }`, empty array when nothing matched.
 * - Errors use the OpenAI-compatible envelope; 402 is "insufficient balance"
 *   and must map to quota, not auth.
 */
const DEFAULT_COUNT = 10;

interface DeepSeekItem {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
  content?: unknown;
  site_name?: unknown;
  date?: unknown;
  rerank_score?: unknown;
}

export const deepseekSearchAdapter: SearchProviderAdapter = {
  type: "deepseek-search",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "deepseek-search",
        "auth_invalid",
        "DeepSeek Search requires an API key.",
      );
    }

    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const configuredPath = ctx.config.config["path"];
    const path =
      typeof configuredPath === "string" && configuredPath.trim().startsWith("/")
        ? configuredPath.trim()
        : DEFAULT_PATH;

    const needContent = ctx.config.config["needContent"] === true;
    const body: Record<string, unknown> = {
      query: input.query,
      count: Math.max(1, Math.min(50, Math.trunc(input.limit))),
      need_content: needContent,
    };

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
    if (!Array.isArray(payload["results"])) {
      throw new ProviderError(
        ctx.config.id,
        "deepseek-search",
        "bad_request",
        "DeepSeek Search response did not contain a results array.",
      );
    }

    const results = (payload["results"] as DeepSeekItem[])
      .map((item) => {
        const mapped = mapItem(item, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          // `summary` is the long, model-oriented field; `snippet` is display.
          snippetPaths: ["summary", "snippet", "content"],
          publishedPaths: ["date"],
          scorePaths: ["rerank_score"],
        });
        if (!mapped) return null;
        const site = typeof item.site_name === "string" && item.site_name ? item.site_name : undefined;
        return { ...mapped, ...(site ? { upstream: { providerName: site } } : {}) };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: `${baseUrl}${path}` };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await deepseekSearchAdapter.search(
        { query: "DeepSeek 模型", limit: DEFAULT_COUNT, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `DeepSeek Search returned ${results.length} result(s).`
            : "DeepSeek responded but returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `DeepSeek Search probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
