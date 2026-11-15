import type { GroundedAnswer, GroundedCitation } from "@search-hub/shared";

/**
 * Shared helpers for grounded-answer adapters.
 *
 * A grounded adapter must be able to say "the model answered **without**
 * searching". That is a first-class outcome here: `toolInvoked=false` is carried
 * all the way to the UI, which renders it as a warning instead of a result.
 */

export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** De-duplicates citations by URL; the first title wins. */
export function dedupeCitations(items: GroundedCitation[], limit = 30): GroundedCitation[] {
  const seen = new Set<string>();
  const output: GroundedCitation[] = [];
  for (const item of items) {
    if (!item.url || !/^https?:\/\//i.test(item.url)) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

export function buildAnswer(
  provider: string,
  text: string,
  citations: GroundedCitation[],
  toolInvoked: boolean,
  model?: string,
): GroundedAnswer {
  return {
    provider,
    text,
    citations: dedupeCitations(citations),
    toolInvoked,
    ...(model ? { model } : {}),
  };
}

/**
 * Extracts the plain text of an OpenAI-style `content` value, which may be a
 * string or an array of `{type:"text", text}` parts.
 */
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

/** Maps an OpenAI-compatible HTTP status onto this platform's error codes. */
export function openAiStatusToCode(status: number | undefined): "auth_invalid" | "rate_limited" | "quota_exceeded" | "bad_request" {
  if (status === 401 || status === 403) return "auth_invalid";
  if (status === 402) return "quota_exceeded";
  if (status === 429) return "rate_limited";
  return "bad_request";
}
