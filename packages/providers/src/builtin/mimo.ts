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
 * - This adapter only calls the non-streaming endpoint. In streaming mode the
 *   annotations arrive on the deltas of each `choices[0]`, which would need a
 *   separate accumulator; the request therefore never sets `stream: true`.
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
    const started = Date.now();
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

    // Annotations are documented on `message.annotations[]`. A tool call that
    // ran but returned nothing can also appear as an annotation without the
    // `"web_search tool call"` payload, so presence of an annotation is the
    // evidence that the tool was invoked, independent of whether URLs came back.
    const annotations = Array.isArray(message["annotations"])
      ? (message["annotations"] as MimoAnnotation[])
      : [];
    const searchCalls = annotations
      .map((annotation) => annotation["web_search tool call"])
      .filter((call): call is NonNullable<typeof call> => Boolean(call));
    const citations = searchCalls
      .map((call) => ({
        title: textOf(call.title) ?? "",
        url: textOf(call.url) ?? "",
        ...(textOf(call.summary) ? { snippet: textOf(call.summary)! } : {}),
        ...(textOf(call.publish_time) ? { publishedAt: textOf(call.publish_time)! } : {}),
      }))
      .filter((item) => /^https?:\/\//i.test(item.url));

    // Evidence-based status:
    //  - no message at all is already an error above.
    //  - annotations present without a payload still proves the tool ran.
    const annotationPresent = annotations.length > 0;
    const toolInvoked: boolean | "unknown" =
      searchCalls.length > 0 || annotationPresent ? true : message["annotations"] === undefined || message["annotations"] === null ? false : "unknown";
    const retrievalSucceeded: boolean | "unknown" =
      toolInvoked === true ? citations.length > 0 : "unknown";
    const hasVerifiableSources: boolean | "unknown" =
      toolInvoked === "unknown" ? "unknown" : citations.length > 0;
    // MiMo does not publish a text→source mapping, so support cannot be proven
    // from the response alone.
    const answerSupported: boolean | "unknown" =
      citations.length > 0 ? "unknown" : false;

    const answer = buildAnswer({
      provider: "mimo",
      text,
      citations,
      status: {
        toolProvided: true,
        toolInvoked,
        retrievalSucceeded,
        hasVerifiableSources,
        answerSupported,
      },
      model,
      latencyMs: Date.now() - started,
    });

    return {
      results: [],
      requestUrl: `${baseUrl}/v1/chat/completions`,
      ...(toolInvoked === false
        ? { warnings: ["MiMo answered without web_search annotations; this is not a search result."] }
        : {}),
      ...(toolInvoked === true && citations.length === 0
        ? { warnings: ["MiMo invoked web_search but returned no citation URL."] }
        : {}),
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
      const citations = answer?.citations ?? [];
      return {
        ok: Boolean(answer?.status.toolInvoked === true && citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: citations.length,
        message:
          answer?.status.toolInvoked === false
            ? "MiMo responded without web_search annotations (tool disabled or no search needed)."
            : answer?.status.toolInvoked === "unknown"
              ? "MiMo response did not state whether web_search ran; state unknown."
              : citations.length === 0
                ? "MiMo invoked web_search but returned no citation."
                : `MiMo grounded answer with ${citations.length} citation(s).`,
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
