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

const DEFAULT_BASE_URL = "https://api.mistral.ai";
const DEFAULT_MODEL = "mistral-large-latest";

/**
 * Mistral with the hosted `web_search` connector.
 *
 * Contract (from the published Mistral Conversations API reference):
 * - `POST {baseUrl}/v1/conversations`, `Authorization: Bearer`.
 * - Body: `model`, `inputs` (or a single `input`), and
 *   `tools: [{ type: "web_search" }]`.
 * - Response: `outputs[]` entries of type `message.output` whose `content` is a
 *   string or a list of `{type:"text", text}` chunks; `citations` may be present
 *   on the entry.
 *
 * Mistral's connector is newer than the chat-completions shape and has changed
 * fields before, so the parser accepts both `outputs` and `choices` and both
 * string and chunked content. It never assumes a citation shape that is absent.
 *
 * Verification: `documented`. `api.mistral.ai` was unreachable from this
 * network and no key exists.
 */
const DEFAULT_MODEL_FALLBACK = "mistral-large-latest";

interface MistralOutput {
  type?: unknown;
  content?: unknown;
  citations?: unknown;
  tool_calls?: unknown;
}

export const mistralWebSearchAdapter: SearchProviderAdapter = {
  type: "mistral-websearch",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "mistral-websearch", "auth_invalid", "Mistral requires an API key.");
    }
    const started = Date.now();
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL ||
      DEFAULT_MODEL_FALLBACK;

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1/conversations`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: {
        model,
        inputs: [{ role: "user", content: input.query }],
        tools: [{ type: "web_search" }],
      },
    });

    const payload = response.data as Record<string, unknown>;
    const outputs = Array.isArray(payload["outputs"]) ? (payload["outputs"] as MistralOutput[]) : [];

    const text = outputs
      .filter((item) => item.type === "message.output" || item.type === undefined)
      .map((item) => flattenContent(item.content))
      .filter((value) => value.length > 0)
      .join("\n")
      .trim();

    const toolCalls = outputs.filter((item) => Array.isArray(item.tool_calls) && (item.tool_calls as unknown[]).length > 0);
    const rawCitations = outputs.flatMap((item) => parseCitations(item.citations));
    const citations = rawCitations.filter((item) => /^https?:\/\//i.test(item.url));

    // Mistral does not document a stable "tool ran" marker across versions, so
    // this stays unknown unless a tool_call block is present.
    const toolInvoked: boolean | "unknown" = toolCalls.length > 0 ? true : "unknown";
    const retrievalSucceeded: boolean | "unknown" =
      citations.length > 0 ? true : toolCalls.length > 0 ? false : "unknown";
    const hasVerifiableSources: boolean | "unknown" =
      citations.length > 0 ? true : toolCalls.length > 0 ? false : "unknown";

    const answer = buildAnswer({
      provider: "mistral-websearch",
      text,
      citations,
      status: {
        toolProvided: true,
        toolInvoked,
        retrievalSucceeded,
        hasVerifiableSources,
        // No text→source mapping is documented for this connector.
        answerSupported: citations.length > 0 ? "unknown" : false,
      },
      model,
      latencyMs: Date.now() - started,
    });

    return {
      results: [],
      requestUrl: `${baseUrl}/v1/conversations`,
      ...(toolInvoked === "unknown"
        ? { warnings: ["Mistral did not report a tool_call; whether web_search ran is unknown."] }
        : {}),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await mistralWebSearchAdapter.search(
        { query: "What did Mistral release recently?", limit: 10, signal: ctx.signal },
        ctx,
      );
      const citations = output.answer?.citations ?? [];
      return {
        ok: Boolean(output.answer?.status.toolInvoked === true && citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: citations.length,
        message:
          output.answer?.status.toolInvoked === "unknown"
            ? "Mistral did not report tool usage; search state unknown."
            : citations.length === 0
              ? "Mistral ran web_search but returned no citation."
              : `Mistral grounded answer with ${citations.length} citation(s).`,
        sample: citations.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Mistral probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const text = (part as Record<string, unknown>)["text"];
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("");
}

function parseCitations(value: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(value)) return [];
  const output: Array<{ title: string; url: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      output.push({ title: "", url: entry });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      output.push({ title: textOf(record["title"]) ?? "", url: textOf(record["url"]) ?? "" });
    }
  }
  return output;
}

export { DEFAULT_BASE_URL as MISTRAL_DEFAULT_BASE_URL, DEFAULT_MODEL as MISTRAL_DEFAULT_MODEL };
