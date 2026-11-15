import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";
import { buildAnswer, contentText, textOf } from "../grounded.js";

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com";
const DEFAULT_MODEL = "mimo-v2.6-pro";

/**
 * Xiaomi MiMo — OpenAI-compatible Chat Completions with the `web_search` tool.
 *
 * Official docs (verified 2026-11-15):
 * https://mimo.mi.com/docs/zh-CN/api/chat/openai-api-post
 * - `POST {baseUrl}/v1/chat/completions`, `Authorization: Bearer`.
 * - Tool shape: `tools: [{ type: "web_search", force_search, max_keyword, limit }]`
 *   — these are **not** `function` tools; `type` is literally `web_search`.
 * - `force_search`: when true the model must search; when false it decides.
 * - Response: `choices[0].message.content` plus
 *   `choices[0].message.annotations[]`, where each annotation carries a
 *   `"web_search tool call"` object with `title`, `url`, `summary`, `site_name`,
 *   `publish_time`, `logo_url`.
 * - The tool must be enabled in the Xiaomi console first; without it the API
 *   returns an error rather than silently answering.
 */
const DEFAULT_MODEL_FALLBACK = "mimo-v2.6-pro";

interface MimoAnnotation {
  type?: unknown;
  "web_search tool call"?: {
    title?: unknown;
    url?: unknown;
    summary?: unknown;
    site_name?: unknown;
    publish_time?: unknown;
  };
}

export const mimoAdapter: SearchProviderAdapter = {
  type: "mimo",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "mimo", "auth_invalid", "Xiaomi MiMo requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL || DEFAULT_MODEL_FALLBACK;

    const forceSearch = ctx.config.config["forceSearch"] === true;
    const maxKeyword = toRange(ctx.config.config["maxKeyword"], 5, 1, 50);
    const limit = toRange(ctx.config.config["searchLimit"], 5, 1, 50);

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: input.query }],
      tools: [
        {
          type: "web_search",
          force_search: forceSearch,
          max_keyword: maxKeyword,
          limit,
        },
      ],
    };

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1/chat/completions`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
    const message = (choices[0] as Record<string, unknown> | undefined)?.["message"] as
      | Record<string, unknown>
      | undefined;
    if (!message) {
      throw new ProviderError(ctx.config.id, "mimo", "bad_request", "MiMo returned no message choices.");
    }

    const text = contentText(message["content"]).trim();
    const annotations = Array.isArray(message["annotations"]) ? (message["annotations"] as MimoAnnotation[]) : [];
    const citations = annotations
      .map((annotation) => annotation["web_search tool call"])
      .filter((call): call is NonNullable<typeof call> => Boolean(call))
      .map((call) => ({
        title: textOf(call.title) ?? "",
        url: textOf(call.url) ?? "",
        ...(textOf(call.summary) ? { snippet: textOf(call.summary)! } : {}),
        ...(textOf(call.publish_time) ? { publishedAt: textOf(call.publish_time)! } : {}),
      }))
      .filter((item) => item.url.length > 0);

    const toolInvoked = citations.length > 0;
    const answer = buildAnswer("mimo", text, citations, toolInvoked, model);

    return {
      results: [],
      requestUrl: `${baseUrl}/v1/chat/completions`,
      ...(toolInvoked ? {} : { warnings: ["MiMo answered without web_search annotations; this is not a search result."] }),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await mimoAdapter.search(
        { query: "小米 MiMo 最新发布", limit: 10, signal: ctx.signal },
        ctx,
      );
      const answer = output.answer;
      return {
        ok: Boolean(answer?.toolInvoked && answer.citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: answer?.citations.length ?? 0,
        message: !answer?.toolInvoked
          ? "MiMo responded without web_search annotations (toolEnabled=false or no search needed)."
          : `MiMo grounded answer with ${answer.citations.length} citation(s).`,
        sample: (answer?.citations ?? []).slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `MiMo probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function toRange(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

export { DEFAULT_MODEL as MIMO_DEFAULT_MODEL };
