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

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic Claude with the server-side `web_search` tool.
 *
 * Contract (from the published Anthropic Messages API reference):
 * - `POST {baseUrl}/v1/messages`, headers `x-api-key` and
 *   `anthropic-version: 2023-06-01`.
 * - Body: `model`, `max_tokens`, `messages`, and
 *   `tools: [{ type: "web_search_20250305", name: "web_search", max_uses }]`.
 * - Response `content[]` blocks:
 *   `server_tool_use` (the query), `web_search_tool_result` (the results:
 *   `web_search_result` items with `url`, `title`, `page_age`), and `text`
 *   blocks whose `citations[]` carry `url`/`title`/`cited_text`.
 *
 * `toolInvoked` is true only when a `server_tool_use` block exists. `max_uses`
 * is the vendor's own cap on searches per request and is mapped from
 * `maxRequestsPerSearch`.
 *
 * Verification: `documented`. `api.anthropic.com` answered `403` here (no key),
 * which confirms host and path.
 */
interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: { query?: unknown };
  content?: unknown;
  citations?: Array<{ url?: unknown; title?: unknown; cited_text?: unknown }>;
}

interface WebSearchResultItem {
  type?: unknown;
  url?: unknown;
  title?: unknown;
  page_age?: unknown;
}

export const anthropicWebSearchAdapter: SearchProviderAdapter = {
  type: "anthropic-websearch",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "anthropic-websearch", "auth_invalid", "Anthropic requires an API key.");
    }
    const started = Date.now();
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL;

    const maxUses = Math.max(1, Math.min(10, ctx.config.search?.maxRequestsPerSearch ?? 3));
    const body: Record<string, unknown> = {
      model,
      max_tokens: 2048,
      messages: [{ role: "user", content: input.query }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }],
    };

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1/messages`,
      method: "POST",
      headers: {
        "x-api-key": ctx.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const blocks = Array.isArray(payload["content"]) ? (payload["content"] as AnthropicBlock[]) : [];
    if (blocks.length === 0) {
      throw new ProviderError(ctx.config.id, "anthropic-websearch", "bad_request", "Anthropic returned no content blocks.");
    }

    const toolUses = blocks.filter((block) => block.type === "server_tool_use");
    const toolResults = blocks.filter((block) => block.type === "web_search_tool_result");
    const textBlocks = blocks.filter((block) => block.type === "text");

    const text = textBlocks
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("\n")
      .trim();

    const resultCitations = toolResults.flatMap((block) =>
      Array.isArray(block.content)
        ? (block.content as WebSearchResultItem[])
            .filter((item) => item.type === "web_search_result")
            .map((item) => ({
              title: textOf(item.title) ?? "",
              url: textOf(item.url) ?? "",
              ...(textOf(item.page_age) ? { publishedAt: textOf(item.page_age)! } : {}),
            }))
        : [],
    );
    const inlineCitations = textBlocks.flatMap((block) =>
      (block.citations ?? []).map((citation) => ({
        title: textOf(citation.title) ?? "",
        url: textOf(citation.url) ?? "",
      })),
    );
    const citations = [...resultCitations, ...inlineCitations].filter((item) =>
      /^https?:\/\//i.test(item.url),
    );

    const toolInvoked: boolean | "unknown" = toolUses.length > 0 ? true : "unknown";
    const retrievalSucceeded: boolean | "unknown" =
      toolResults.length > 0 ? resultCitations.length > 0 : "unknown";
    const hasVerifiableSources: boolean | "unknown" =
      toolInvoked === "unknown" ? "unknown" : citations.length > 0;
    const answerSupported: boolean | "unknown" =
      inlineCitations.length > 0 ? true : toolInvoked === "unknown" ? "unknown" : false;

    const answer = buildAnswer({
      provider: "anthropic-websearch",
      text,
      citations,
      status: { toolProvided: true, toolInvoked, retrievalSucceeded, hasVerifiableSources, answerSupported },
      model,
      latencyMs: Date.now() - started,
    });

    return {
      results: [],
      requestUrl: `${baseUrl}/v1/messages`,
      ...(toolInvoked === "unknown"
        ? { warnings: ["Anthropic returned no server_tool_use block; whether web_search ran is unknown."] }
        : {}),
      ...(toolInvoked === true && citations.length === 0
        ? { warnings: ["Anthropic ran web_search but returned no citable URL."] }
        : {}),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await anthropicWebSearchAdapter.search(
        { query: "What is the latest Claude release?", limit: 10, signal: ctx.signal },
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
            ? "Claude responded without a server_tool_use block; search state unknown."
            : citations.length === 0
              ? "Claude ran web_search but returned no citation."
              : `Claude grounded answer with ${citations.length} citation(s).`,
        sample: citations.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Anthropic probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as ANTHROPIC_DEFAULT_BASE_URL, DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL };
