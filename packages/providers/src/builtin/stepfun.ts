import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";
import { textOf } from "../grounded.js";

const DEFAULT_BASE_URL = "https://api.stepfun.com";
const DEFAULT_PATH = "/v1/search";

/**
 * StepFun (阶跃星辰) — standalone web search API.
 *
 * Official docs (verified 2026-11-15):
 * https://platform.stepfun.com/docs/zh/api-reference/Search/search
 * - `POST https://api.stepfun.com/v1/search`, `Authorization: Bearer`.
 * - Body: `query` (required), `n` (1–20, default 10), `category`
 *   (`programming` | `research` | `gov` | `business`, empty = all).
 * - Response: `{ query, category, results: [{ url, position, title, time,
 *   snippet, content }] }`.
 * - IMPORTANT: this is `raw_search`, not a grounded answer. The docs state that
 *   models such as `step-5-preview` do **not** support a built-in `web_search`
 *   tool in Chat Completions; the standalone endpoint is the documented path.
 *   There is also a remote MCP endpoint
 *   (`https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp`), which is a
 *   separate integration and not used here.
 */
interface StepFunResult {
  url?: unknown;
  title?: unknown;
  snippet?: unknown;
  content?: unknown;
  time?: unknown;
  position?: unknown;
}

const CATEGORIES = new Set(["programming", "research", "gov", "business"]);

export const stepfunAdapter: SearchProviderAdapter = {
  type: "stepfun",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "stepfun", "auth_invalid", "StepFun requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const configuredPath = ctx.config.config["path"];
    const path =
      typeof configuredPath === "string" && configuredPath.trim().startsWith("/")
        ? configuredPath.trim()
        : DEFAULT_PATH;

    const body: Record<string, unknown> = {
      query: input.query,
      n: Math.max(1, Math.min(20, Math.trunc(input.limit))),
    };
    const category = ctx.config.config["category"];
    if (typeof category === "string" && CATEGORIES.has(category)) body["category"] = category;

    const response = await callJson(ctx, {
      url: `${baseUrl}${path}`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    if (!Array.isArray(payload["results"])) {
      throw new ProviderError(
        ctx.config.id,
        "stepfun",
        "bad_request",
        "StepFun response did not contain a results array.",
      );
    }

    const results = (payload["results"] as StepFunResult[])
      .map((item) => {
        const mapped = mapItem(item, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["snippet", "content"],
          publishedPaths: ["time"],
        });
        if (!mapped) return null;
        const position = typeof item.position === "number" ? item.position : undefined;
        return {
          ...mapped,
          ...(position === undefined ? {} : { upstream: { providerName: `rank ${position}` } }),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: `${baseUrl}${path}` };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await stepfunAdapter.search(
        { query: "人工智能", limit: 10, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `StepFun search returned ${results.length} result(s).`
            : "StepFun responded but returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `StepFun probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { textOf };
