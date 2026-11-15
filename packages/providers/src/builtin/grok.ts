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
 * was used. When no `web_search_call` item exists, `toolInvoked` is false.
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

    const citations = [
      ...messages.flatMap((item) =>
        (item.content ?? []).flatMap((part) =>
          (part.annotations ?? [])
            .filter((annotation) => annotation.type === "url_citation")
            .map((annotation) => ({
              title: textOf(annotation.title) ?? "",
              url: textOf(annotation.url) ?? "",
            })),
        ),
      ),
      ...searchCalls.flatMap((item) =>
        (item.action?.sources ?? []).map((source) => ({
          title: textOf(source.title) ?? "",
          url: textOf(source.url) ?? "",
        })),
      ),
    ].filter((item) => item.url.length > 0);

    const toolInvoked = searchCalls.length > 0;
    const answer = buildAnswer("grok", text, citations, toolInvoked, model);

    return {
      results: [],
      requestUrl: `${baseUrl}/v1/responses`,
      ...(toolInvoked
        ? {}
        : { warnings: ["Grok answered without a web_search_call; this is not a search result."] }),
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
      return {
        ok: Boolean(answer?.toolInvoked && answer.citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: answer?.citations.length ?? 0,
        message: !answer?.toolInvoked
          ? "Grok responded without a web_search_call (toolInvoked=false)."
          : answer.citations.length === 0
            ? "Grok called web_search but returned no citations."
            : `Grok grounded answer with ${answer.citations.length} citation(s).`,
        sample: (answer?.citations ?? []).slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
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
