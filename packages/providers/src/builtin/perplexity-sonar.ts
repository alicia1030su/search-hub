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

const DEFAULT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_MODEL = "sonar";

/**
 * Perplexity Sonar — the grounded **answer** product.
 *
 * Contract (from the published Perplexity chat completions reference):
 * - `POST {baseUrl}/chat/completions`, `Authorization: Bearer`.
 * - Body: `model` (`sonar` / `sonar-pro` / `sonar-reasoning`), `messages`.
 * - Response: `choices[0].message.content` plus top-level `citations[]` (URLs)
 *   and `search_results[]` (`title`, `url`, `date`).
 *
 * This is deliberately separate from `perplexity-search`: that endpoint is a
 * retrieval API returning pages, this one returns a synthesized answer. Putting
 * them behind one provider would let an answer appear in the web-result list.
 *
 * Verification: `documented`. `api.perplexity.ai` was unreachable here and no
 * key exists.
 */
const DEFAULT_MODEL_FALLBACK = "sonar";

interface SonarSearchResult {
  title?: unknown;
  url?: unknown;
  date?: unknown;
}

export const perplexitySonarAdapter: SearchProviderAdapter = {
  type: "perplexity-sonar",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "perplexity-sonar", "auth_invalid", "Perplexity requires an API key.");
    }
    const started = Date.now();
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL ||
      DEFAULT_MODEL_FALLBACK;

    const response = await callJson(ctx, {
      url: `${baseUrl}/chat/completions`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: {
        model,
        messages: [{ role: "user", content: input.query }],
        // Ask for the structured result list, not just bare URLs.
        return_related_questions: false,
        web_search_options: { search_context_size: "medium" },
      },
    });

    const payload = response.data as Record<string, unknown>;
    const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
    const message = (choices[0] as Record<string, unknown> | undefined)?.["message"] as
      | Record<string, unknown>
      | undefined;
    if (!message) {
      throw new ProviderError(ctx.config.id, "perplexity-sonar", "bad_request", "Perplexity returned no choices.");
    }
    const text = contentText(message["content"]).trim();

    const structured = Array.isArray(payload["search_results"])
      ? (payload["search_results"] as SonarSearchResult[])
      : [];
    const fromStructured = structured.map((item) => ({
      title: textOf(item.title) ?? "",
      url: textOf(item.url) ?? "",
      ...(textOf(item.date) ? { publishedAt: textOf(item.date)! } : {}),
    }));
    const fromCandidates = Array.isArray(payload["citations"])
      ? (payload["citations"] as unknown[])
          .filter((value): value is string => typeof value === "string")
          .map((url) => ({ title: "", url }))
      : [];
    const citations = [...fromStructured, ...fromCandidates].filter((item) =>
      /^https?:\/\//i.test(item.url),
    );

    // Sonar always searches, but the proof is the returned source list; without
    // it we cannot claim a citation exists.
    const toolInvoked: boolean | "unknown" = citations.length > 0 ? true : text.length > 0 ? "unknown" : "unknown";
    const hasVerifiableSources: boolean | "unknown" = citations.length > 0 ? true : "unknown";

    const answer = buildAnswer({
      provider: "perplexity-sonar",
      text,
      citations,
      status: {
        toolProvided: true,
        toolInvoked,
        retrievalSucceeded: hasVerifiableSources,
        hasVerifiableSources,
        // Sonar returns [n] markers in the text when citations are used.
        answerSupported: citations.length > 0 ? /\[\d{1,3}\]/.test(text) : false,
      },
      model,
      latencyMs: Date.now() - started,
    });

    return {
      results: [],
      requestUrl: `${baseUrl}/chat/completions`,
      ...(citations.length === 0
        ? { warnings: ["Perplexity returned an answer without any citation URL."] }
        : {}),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await perplexitySonarAdapter.search(
        { query: "What is the latest Perplexity model?", limit: 10, signal: ctx.signal },
        ctx,
      );
      const citations = output.answer?.citations ?? [];
      return {
        ok: citations.length > 0,
        latencyMs: Date.now() - started,
        resultCount: citations.length,
        message:
          citations.length === 0
            ? "Perplexity answered without citation URLs."
            : `Perplexity grounded answer with ${citations.length} citation(s).`,
        sample: citations.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Perplexity Sonar probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as PERPLEXITY_SONAR_DEFAULT_BASE_URL, DEFAULT_MODEL as PERPLEXITY_SONAR_DEFAULT_MODEL };
