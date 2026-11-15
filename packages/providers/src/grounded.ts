import type {
  GroundedAnswer,
  GroundedCitation,
  GroundedDisplay,
  GroundedStatus,
  GroundedSupport,
} from "@search-hub/shared";

/**
 * Shared helpers for grounded-answer adapters.
 *
 * Two rules drive everything here:
 *
 * 1. **Never invent a verification state.** "The tool was offered", "the model
 *    called it", "the call returned content", "there are verifiable URLs" and
 *    "the answer is bound to those URLs" are separate facts, and any of them may
 *    be `unknown` when the vendor response does not carry evidence.
 * 2. **Never forward vendor HTML.** Google's `searchEntryPoint.renderedContent`
 *    is markup; it is parsed here into plain `{label, url}` chips so the admin UI
 *    renders its own elements.
 */

export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** De-duplicates citations by URL; the first title wins. */
export function dedupeCitations(items: GroundedCitation[], limit = 30): GroundedCitation[] {
  const seen = new Set<string>();
  const output: GroundedCitation[] = [];
  for (const item of items) {
    if (!item.url || !isHttpUrl(item.url)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

export interface BuildAnswerInput {
  provider: string;
  text: string;
  citations: GroundedCitation[];
  status: GroundedStatus;
  model?: string;
  searchQueries?: string[];
  supports?: GroundedSupport[];
  display?: GroundedDisplay;
  latencyMs?: number;
  /**
   * Keep the vendor's chunk order 1:1 (no de-duplication) so
   * `groundingSupports[].groundingChunkIndices` still point at the right rows.
   * Deduplicating would silently shift every index.
   */
  preserveCitationOrder?: boolean;
}

export function buildAnswer(input: BuildAnswerInput): GroundedAnswer {
  const citations = input.preserveCitationOrder
    ? input.citations.filter((item) => item.url && isHttpUrl(item.url))
    : dedupeCitations(input.citations);
  return {
    provider: input.provider,
    text: input.text,
    citations,
    status: input.status,
    ...(input.model ? { model: input.model } : {}),
    ...(input.searchQueries && input.searchQueries.length > 0
      ? { searchQueries: input.searchQueries }
      : {}),
    ...(input.supports && input.supports.length > 0 ? { supports: input.supports } : {}),
    ...(input.display ? { display: input.display } : {}),
    ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    ...(input.status.toolInvoked === false ? { degraded: true } : {}),
  };
}

/** Extracts the plain text of an OpenAI-style `content` value. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        if (typeof record["text"] === "string") return record["text"];
      }
      return "";
    })
    .join("");
}

export function openAiStatusToCode(status: number | undefined): "auth_invalid" | "rate_limited" | "quota_exceeded" | "bad_request" {
  if (status === 401 || status === 403) return "auth_invalid";
  if (status === 402) return "quota_exceeded";
  if (status === 429) return "rate_limited";
  return "bad_request";
}

const MAX_SUGGESTIONS = 8;
const MAX_FALLBACK_CHARS = 280;

/**
 * Parses Google's `searchEntryPoint.renderedContent` into plain data.
 *
 * The vendor's HTML is **never** returned. We only extract http(s) anchor
 * targets and their text, and keep a short plain-text fallback for operators who
 * want to compare against the official docs.
 */
export function parseSearchEntryPoint(raw: unknown): GroundedDisplay | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const suggestions: Array<{ label: string; url: string }> = [];
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(raw)) !== null && suggestions.length < MAX_SUGGESTIONS) {
    const url = decodeHtmlEntities(match[1] ?? "").trim();
    const label = stripTags(match[2] ?? "").trim();
    if (!isHttpUrl(url) || !label) continue;
    suggestions.push({ label: label.slice(0, 120), url });
  }

  // Some entry points contain only <div role="button"> chips with no anchor.
  if (suggestions.length === 0) {
    const chip = /<div\b[^>]*>([\s\S]*?)<\/div>/gi;
    while ((match = chip.exec(raw)) !== null && suggestions.length < MAX_SUGGESTIONS) {
      const label = stripTags(match[1] ?? "").trim();
      if (label) suggestions.push({ label: label.slice(0, 120), url: "" });
    }
  }

  const textFallback = stripTags(raw).replace(/\s+/g, " ").trim().slice(0, MAX_FALLBACK_CHARS);
  return {
    suggestions: suggestions.filter((item) => item.label.length > 0),
    ...(textFallback ? { textFallback } : {}),
    // The HTML is intentionally dropped; this flag says so explicitly.
    vendorHtmlWithheld: true,
  };
}

function stripTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/**
 * Normalises vendor `groundingSupports` into our support shape and drops
 * entries whose indices are out of range — a bad index would highlight the wrong
 * sentence in the UI.
 */
export function normalizeSupports(raw: unknown, chunkCount: number, textLength: number): GroundedSupport[] {
  if (!Array.isArray(raw)) return [];
  const output: GroundedSupport[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const segment = (record["segment"] ?? {}) as Record<string, unknown>;
    const start = typeof segment["startIndex"] === "number" ? segment["startIndex"] : undefined;
    const end = typeof segment["endIndex"] === "number" ? segment["endIndex"] : undefined;
    if (start === undefined || end === undefined) continue;
    const safeStart = Math.max(0, Math.min(start, textLength));
    const safeEnd = Math.max(safeStart, Math.min(end, textLength));
    if (safeEnd <= safeStart) continue;
    const indices = Array.isArray(record["groundingChunkIndices"])
      ? (record["groundingChunkIndices"] as unknown[]).filter(
          (value): value is number =>
            typeof value === "number" && Number.isInteger(value) && value >= 0 && value < chunkCount,
        )
      : [];
    if (indices.length === 0) continue;
    output.push({ startIndex: safeStart, endIndex: safeEnd, chunkIndices: indices });
  }
  return output;
}
