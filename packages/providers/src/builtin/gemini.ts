import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";
import { buildAnswer, normalizeSupports, parseSearchEntryPoint, textOf } from "../grounded.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.8-flash";

/**
 * Gemini — Google Search grounding.
 *
 * Docs (verified 2026-11-15): https://ai.google.dev/gemini-api/docs/google-search
 * - `POST {baseUrl}/v1beta/models/{model}:generateContent`, `x-goog-api-key`.
 * - Tool: `tools: [{ google_search: {} }]` (legacy `google_search_retrieval`
 *   applies to older models only).
 * - `candidates[0].groundingMetadata` carries the grounding record:
 *   `webSearchQueries`, `searchEntryPoint.renderedContent`,
 *   `groundingChunks[].web.{uri,title}` and `groundingSupports[]`.
 *
 * Display rules honoured here:
 * - `searchEntryPoint` is parsed into plain `{label, url}` chips; the vendor's
 *   HTML is dropped on purpose (`vendorHtmlWithheld: true`) so an arbitrary
 *   provider response can never inject markup into the admin page.
 * - `groundingSupports[].groundingChunkIndices` index into `groundingChunks`, so
 *   citations are kept in **vendor order** (no de-duplication) — de-duplicating
 *   would shift every index and highlight the wrong sentence.
 * - A response without `groundingMetadata` is reported as `toolInvoked:
 *   "unknown"`, not `false`: the API does not say whether the model decided not
 *   to search or searched without returning metadata.
 */
const DEFAULT_MODEL_FALLBACK = "gemini-3.8-flash";

interface GeminiChunk {
  web?: { uri?: unknown; title?: unknown };
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: unknown }> };
  groundingMetadata?: {
    webSearchQueries?: unknown;
    searchEntryPoint?: { renderedContent?: unknown };
    groundingChunks?: GeminiChunk[];
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
    const started = Date.now();
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL ||
      DEFAULT_MODEL_FALLBACK;

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

    const metadata = candidate.groundingMetadata;
    const chunks = Array.isArray(metadata?.groundingChunks) ? metadata!.groundingChunks! : [];

    // Vendor order preserved: groundingSupports indices refer to this array.
    const citations = chunks.map((chunk, index) => ({
      title: textOf(chunk.web?.title) ?? "",
      url: textOf(chunk.web?.uri) ?? "",
      providerIndex: index + 1,
    }));
    const verifiable = citations.filter((item) => /^https?:\/\//i.test(item.url));

    const queries = Array.isArray(metadata?.webSearchQueries)
      ? (metadata!.webSearchQueries as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    const supports = normalizeSupports(metadata?.groundingSupports, chunks.length, text.length);
    const display = parseSearchEntryPoint(metadata?.searchEntryPoint?.renderedContent);

    // Evidence-based status:
    //  - no groundingMetadata at all -> cannot tell whether search ran.
    //  - metadata present -> grounding happened, so the tool was used.
    const toolInvoked: boolean | "unknown" = metadata ? true : "unknown";
    const retrievalSucceeded: boolean | "unknown" = metadata ? verifiable.length > 0 : "unknown";
    const hasVerifiableSources: boolean | "unknown" = metadata ? verifiable.length > 0 : "unknown";
    const answerSupported: boolean | "unknown" = supports.length > 0 ? true : metadata ? false : "unknown";

    const answer = buildAnswer({
      provider: "gemini",
      text,
      citations,
      preserveCitationOrder: true,
      status: {
        toolProvided: true,
        toolInvoked,
        retrievalSucceeded,
        hasVerifiableSources,
        answerSupported,
      },
      model,
      searchQueries: queries,
      supports,
      ...(display ? { display } : {}),
      latencyMs: Date.now() - started,
    });

    return {
      results: [],
      requestUrl: `${baseUrl}/v1beta/models/${model}:generateContent`,
      ...(toolInvoked === true && verifiable.length === 0
        ? { warnings: ["Gemini reported grounding metadata but returned no verifiable citation URL."] }
        : {}),
      ...(toolInvoked === "unknown"
        ? {
            warnings: [
              "Gemini returned no groundingMetadata: the model may have answered without searching. Treat as unverified.",
            ],
          }
        : {}),
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
      const ok = answer?.status.toolInvoked === true && answer.citations.length > 0;
      return {
        ok: Boolean(ok),
        latencyMs: Date.now() - started,
        resultCount: answer?.citations.length ?? 0,
        message:
          answer?.status.toolInvoked === "unknown"
            ? "Gemini returned no grounding metadata; search state unknown."
            : answer?.status.toolInvoked === true && answer.citations.length === 0
              ? "Gemini invoked Google Search but returned no citation URL."
              : `Gemini grounded answer with ${answer?.citations.length ?? 0} citation(s).`,
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
