import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";
import { buildAnswer, textOf } from "../grounded.js";

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5";

/**
 * OpenAI Responses API with the hosted `web_search` tool.
 *
 * Contract (from the published Responses API reference):
 * - `POST {baseUrl}/v1/responses`, `Authorization: Bearer`.
 * - Body: `model`, `input`, `tools: [{ type: "web_search" }]`.
 * - `output[]` contains `web_search_call` items when the tool actually ran and
 *   `message` items whose `content[]` is `output_text` with
 *   `annotations[type=url_citation]` (`url`, `title`, `start_index`, `end_index`).
 *
 * Same evidence rule as Grok: the tool being *available* proves nothing. With
 * no `web_search_call` in `output[]`, `toolInvoked` is false and the answer is
 * marked degraded so it never reads as a search result.
 *
 * Verification: `documented`. `api.openai.com` was unreachable from this
 * network and no key exists.
 */
const DEFAULT_MODEL_FALLBACK = "gpt-5";

interface OpenAiContentPart {
  type?: unknown;
  text?: unknown;
  annotations?: Array<{ type?: unknown; url?: unknown; title?: unknown }>;
}

interface OpenAiOutputItem {
  type?: unknown;
  content?: OpenAiContentPart[];
  action?: { sources?: Array<{ url?: unknown; title?: unknown }> };
}

export const openaiWebSearchAdapter: SearchProviderAdapter = {
  type: "openai-websearch",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "openai-websearch", "auth_invalid", "OpenAI requires an API key.");
    }
    const started = Date.now();
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL ||
      DEFAULT_MODEL_FALLBACK;

    const tool: Record<string, unknown> = { type: "web_search" };
    // Domain filters are optional and mutually exclusive at OpenAI as well.
    if (ctx.config.search?.includeDomains?.length) {
      tool["filters"] = { allowed_domains: ctx.config.search.includeDomains.slice(0, 5) };
    }

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1/responses`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: { model, input: input.query, tools: [tool] },
    });

    const payload = response.data as Record<string, unknown>;
    const output = Array.isArray(payload["output"]) ? (payload["output"] as OpenAiOutputItem[]) : [];
    const searchCalls = output.filter((item) => item.type === "web_search_call");
    const messages = output.filter((item) => item.type === "message");

    const text = messages
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n")
      .trim();

    const annotationCitations = messages.flatMap((item) =>
      (item.content ?? []).flatMap((part) =>
        (part.annotations ?? [])
          .filter((annotation) => annotation.type === "url_citation")
          .map((annotation) => ({ title: textOf(annotation.title) ?? "", url: textOf(annotation.url) ?? "" })),
      ),
    );
    const actionCitations = searchCalls.flatMap((item) =>
      (item.action?.sources ?? []).map((source) => ({
        title: textOf(source.title) ?? "",
        url: textOf(source.url) ?? "",
      })),
    );
    const citations = [...annotationCitations, ...actionCitations].filter((item) =>
      /^https?:\/\//i.test(item.url),
    );

    const toolInvoked: boolean | "unknown" =
      searchCalls.length > 0 ? true : messages.length > 0 ? false : "unknown";
    const retrievalSucceeded: boolean | "unknown" =
      toolInvoked === true ? citations.length > 0 : toolInvoked === false ? false : "unknown";
    const hasVerifiableSources: boolean | "unknown" =
      toolInvoked === "unknown" ? "unknown" : citations.length > 0;
    const answerSupported: boolean | "unknown" =
      annotationCitations.length > 0 ? true : toolInvoked === "unknown" ? "unknown" : false;

    const answer = buildAnswer({
      provider: "openai-websearch",
      text,
      citations,
      status: { toolProvided: true, toolInvoked, retrievalSucceeded, hasVerifiableSources, answerSupported },
      model,
      latencyMs: Date.now() - started,
    });

    return {
      results: [],
      requestUrl: `${baseUrl}/v1/responses`,
      ...(toolInvoked === false
        ? { warnings: ["OpenAI answered without a web_search_call; this is not a search result."] }
        : {}),
      ...(toolInvoked === true && citations.length === 0
        ? { warnings: ["OpenAI called web_search but returned no citable URL."] }
        : {}),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await openaiWebSearchAdapter.search(
        { query: "What changed in the OpenAI API recently?", limit: 10, signal: ctx.signal },
        ctx,
      );
      const citations = output.answer?.citations ?? [];
      const status = output.answer?.status;
      return {
        ok: Boolean(status?.toolInvoked === true && citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: citations.length,
        message:
          status?.toolInvoked === "unknown"
            ? "OpenAI returned no output; search state unknown."
            : status?.toolInvoked === false
              ? "OpenAI answered without calling web_search."
              : citations.length === 0
                ? "OpenAI called web_search but returned no citation."
                : `OpenAI grounded answer with ${citations.length} citation(s).`,
        sample: citations.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `OpenAI probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as OPENAI_DEFAULT_BASE_URL, DEFAULT_MODEL as OPENAI_DEFAULT_MODEL };
