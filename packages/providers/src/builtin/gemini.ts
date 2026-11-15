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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.8-flash";

/**
 * Gemini — Google Search grounding.
 *
 * Official docs (verified 2026-11-15):
 * https://ai.google.dev/gemini-api/docs/google-search
 * - `POST {baseUrl}/v1beta/models/{model}:generateContent`, `x-goog-api-key`.
 * - Tool: `tools: [{ google_search: {} }]` (the older `google_search_retrieval`
 *   is only for legacy models and is deliberately not used here).
 * - Response: `candidates[0].content.parts[].text` plus
 *   `candidates[0].groundingMetadata` with `webSearchQueries`,
 *   `groundingChunks[].web.{uri,title}` and `groundingSupports[]`.
 * - The model decides whether to search. If `groundingMetadata` is absent or has
 *   no chunks, `toolInvoked` is false: the pipeline must not claim a search
 *   happened.
 *
 * `gemini-3.8-flash` is the default because the docs list it as a currently
 * supported grounding model; the model id is user-editable because Google
 * retires model ids frequently.
 */
const DEFAULT_MODEL_FALLBACK = "gemini-3.8-flash";

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: unknown }> };
  groundingMetadata?: {
    webSearchQueries?: unknown;
    groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>;
    groundingSupports?: unknown;
  };
  finishReason?: unknown;
}

export const geminiAdapter: SearchProviderAdapter = {
  type: "gemini",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "gemini", "auth_invalid", "Gemini requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL || DEFAULT_MODEL_FALLBACK;

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: input.query }] }],
      tools: [{ google_search: {} }],
    };

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": ctx.apiKey },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const candidates = Array.isArray(payload["candidates"]) ? (payload["candidates"] as GeminiCandidate[]) : [];
    const candidate = candidates[0];
    if (!candidate) {
      throw new ProviderError(
        ctx.config.id,
        "gemini",
        "bad_request",
        "Gemini returned no candidates (the prompt may have been blocked).",
        { details: payload["promptFeedback"] },
      );
    }

    const text =
      (candidate.content?.parts ?? [])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim() || "";
    const chunkMap = candidate.groundingMetadata?.groundingChunks ?? [];
    const citations = chunkMap
      .map((chunk) => ({
        title: textOf(chunk.web?.title) ?? "",
        url: textOf(chunk.web?.uri) ?? "",
      }))
      .filter((item) => item.url.length > 0);
    const queries = Array.isArray(candidate.groundingMetadata?.webSearchQueries)
      ? (candidate.groundingMetadata!.webSearchQueries as unknown[]).filter(
          (query): query is string => typeof query === "string",
        )
      : [];
    const toolInvoked = citations.length > 0 || queries.length > 0;

    const answer = buildAnswer("gemini", text, citations, toolInvoked, model);
    return {
      results: [],
      requestUrl: `${baseUrl}/v1beta/models/${model}:generateContent`,
      ...(toolInvoked ? {} : { warnings: ["Gemini answered without calling Google Search; this is not a search result."] }),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await geminiAdapter.search(
        { query: "Who won the 2024 UEFA European Championship?", limit: 10, signal: ctx.signal },
        ctx,
      );
      const answer = output.answer;
      return {
        ok: Boolean(answer?.toolInvoked && answer.citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: answer?.citations.length ?? 0,
        message: !answer?.toolInvoked
          ? "Gemini responded but did not invoke Google Search (toolInvoked=false)."
          : answer.citations.length === 0
            ? "Gemini invoked search but returned no citations."
            : `Gemini grounded answer with ${answer.citations.length} citation(s).`,
        sample: (answer?.citations ?? []).slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Gemini probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_MODEL as GEMINI_DEFAULT_MODEL };
