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

const DEFAULT_BASE_URL = "https://api.x.ai";
const DEFAULT_MODEL = "grok-4.7";

/**
 * xAI Grok — Responses API with the `web_search` server-side tool.
 *
 * Official docs (verified 2026-11-15):
 * https://docs.x.ai/developers/tools/web-search
 * - `POST {baseUrl}/v1/responses`, `Authorization: Bearer`.
 * - Tool: `tools: [{ type: "web_search" }]`, optional
 *   `filters.allowed_domains` / `filters.excluded_domains` (max 5, mutually
 *   exclusive).
 * - The final text is in `output[]` items of type `message` →
 *   `content[]` of type `output_text` → `text`.
 * - Whether the tool actually ran is visible in `output[]` items of type
 *   `web_search_call`. Citations are `annotations[]` of type `url_citation`
 *   (`url`, `title`, `start_index`, `end_index`) on those output_text blocks.
 *
 * Important: xAI documents that `web_search` being *available* does not mean it
 * was used. Citations appear in three different places and all are collected:
 *   1. `output[].content[].annotations[type=url_citation]` (text-anchored),
 *   2. `output[]` type `web_search_call` → `action.sources[]` (audit trail),
 *   3. response-level `citations[]` (plain URLs).
 * Only (1) proves the answer is supported by a source, so `answerSupported` is
 * true only when annotations exist.
 */
const DEFAULT_MODEL_FALLBACK = "grok-4.7";

interface XaiOutputItem {
  type?: unknown;
  content?: Array<{
    type?: unknown;
    text?: unknown;
    annotations?: Array<{ type?: unknown; url?: unknown; title?: unknown }>;
  }>;
  action?: { sources?: Array<{ url?: unknown; title?: unknown }> };
  status?: unknown;
}

export const grokAdapter: SearchProviderAdapter = {
  type: "grok",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "grok", "auth_invalid", "xAI Grok requires an API key.");
    }
    const started = Date.now();
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL || DEFAULT_MODEL_FALLBACK;

    const allowed = ctx.config.config["allowedDomains"];
    const excluded = ctx.config.config["excludedDomains"];
    const tool: Record<string, unknown> = { type: "web_search" };
    const allowedList = splitDomains(allowed);
    const excludedList = splitDomains(excluded);
    if (allowedList.length > 0 && excludedList.length > 0) {
      throw new ProviderError(
        ctx.config.id,
        "grok",
        "bad_request",
        "xAI rejects a web_search tool that sets both allowed_domains and excluded_domains.",
      );
    }
    if (allowedList.length > 0) tool["filters"] = { allowed_domains: allowedList.slice(0, 5) };
    if (excludedList.length > 0) tool["filters"] = { excluded_domains: excludedList.slice(0, 5) };

    const body: Record<string, unknown> = {
      model,
      input: [{ role: "user", content: input.query }],
      tools: [tool],
      // Ask for the source list of each search action, not just inline links.
      include: ["web_search_call.action.sources"],
    };

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1/responses`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const output = Array.isArray(payload["output"]) ? (payload["output"] as XaiOutputItem[]) : [];
    const searchCalls = output.filter((item) => item.type === "web_search_call");
    const messages = output.filter((item) => item.type === "message");

    const text = messages
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n")
      .trim();

    // xAI exposes citations in three shapes; losing any of them drops real
    // sources. 1) inline url_citation annotations, 2) sources on the search
    // call, 3) response-level plain URL list.
    const responseCitations = Array.isArray(payload["citations"])
      ? (payload["citations"] as unknown[])
          .filter((value): value is string => typeof value === "string")
          .map((url) => ({ title: "", url }))
      : [];
    const annotationCitations = messages.flatMap((item) =>
        (item.content ?? []).flatMap((part) =>
          (part.annotations ?? [])
            .filter((annotation) => annotation.type === "url_citation")
            .map((annotation) => ({
              title: textOf(annotation.title) ?? "",
              url: textOf(annotation.url) ?? "",
            })),
        ),
      );
    const actionCitations = searchCalls.flatMap((item) =>
      (item.action?.sources ?? []).map((source) => ({
        title: textOf(source.title) ?? "",
        url: textOf(source.url) ?? "",
      })),
    );
    const citations = [...annotationCitations, ...actionCitations, ...responseCitations].filter((item) =>
      /^https?:\/\//i.test(item.url),
    );

    // Evidence-based status. No output at all -> unknown; a message with no
    // web_search_call means the model answered from its own knowledge.
    const toolInvoked: boolean | "unknown" =
      searchCalls.length > 0 ? true : messages.length > 0 ? false : "unknown";
    const retrievalSucceeded: boolean | "unknown" =
      toolInvoked === true ? citations.length > 0 : toolInvoked === false ? false : "unknown";
    const hasVerifiableSources: boolean | "unknown" =
      toolInvoked === "unknown" ? "unknown" : citations.length > 0;
    // Inline url_citation annotations are the only text-anchored evidence that
    // the answer uses a source; a bare sources list is an audit trail.
    const answerSupported: boolean | "unknown" =
      annotationCitations.length > 0 ? true : toolInvoked === "unknown" ? "unknown" : false;

    const answer = buildAnswer({
      provider: "grok",
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
      requestUrl: `${baseUrl}/v1/responses`,
      ...(toolInvoked === false
        ? { warnings: ["Grok answered without a web_search_call; this is not a search result."] }
        : {}),
      ...(toolInvoked === true && hasVerifiableSources === false
        ? { warnings: ["Grok called web_search but returned no citable URL."] }
        : {}),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await grokAdapter.search(
        { query: "What did xAI ship in the last 7 days?", limit: 10, signal: ctx.signal },
        ctx,
      );
      const answer = output.answer;
      const citations = answer?.citations ?? [];
      const status = answer?.status;
      return {
        ok: Boolean(status?.toolInvoked === true && citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: citations.length,
        message:
          status?.toolInvoked === "unknown"
            ? "Grok returned no output; search state unknown."
            : status?.toolInvoked === false
              ? "Grok responded without a web_search_call (no search)."
              : citations.length === 0
                ? "Grok called web_search but returned no citation."
                : `Grok grounded answer with ${citations.length} citation(s).`,
        sample: citations.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Grok probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function splitDomains(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,|\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.includes("://"));
}

export { DEFAULT_MODEL as GROK_DEFAULT_MODEL };
