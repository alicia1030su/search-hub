/**
 * Import guards for the evaluation lab.
 *
 * A dataset import is the one place where an operator pastes a document this
 * process did not produce. It is parsed by `JSON.parse`, validated by zod and
 * written to SQLite — none of which executes anything — so the real risks are
 * the boring ones: a payload that quietly allocates, keys that mutate a
 * prototype somewhere downstream, and URLs that describe a scheme the web
 * cannot fetch.
 *
 * Each check below returns a 400 with the offending path. Nothing is silently
 * dropped: a caller that sent a bad row must learn which row it was, or the
 * import becomes a guessing game.
 */

/** Deepest object nesting an import may contain. */
export const MAX_IMPORT_DEPTH = 8;

/** Keys that can mutate a prototype if an object is later merged. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Control characters that have no place in a query, title or note. */
// The range is the point: these are exactly the characters being rejected.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

export class ImportRejection extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.name = "ImportRejection";
    this.path = path;
  }
}

/**
 * Walks the payload once and rejects the three structural hazards.
 *
 * Iterative on purpose: a recursive walk over an attacker-shaped object is a
 * stack overflow waiting to happen, and this function's whole job is to run on
 * input nobody vouched for.
 */
export function assertSafePayload(value: unknown, label = "body"): void {
  const stack: Array<{ node: unknown; path: string; depth: number }> = [
    { node: value, path: label, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, path, depth } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > MAX_IMPORT_DEPTH) {
      throw new ImportRejection(path, `Nesting deeper than ${MAX_IMPORT_DEPTH} levels is not accepted`);
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        stack.push({ node: node[index], path: `${path}[${index}]`, depth: depth + 1 });
      }
      continue;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      if (DANGEROUS_KEYS.has(key)) {
        throw new ImportRejection(`${path}.${key}`, `"${key}" is not an acceptable key`);
      }
      stack.push({
        node: (node as Record<string, unknown>)[key],
        path: `${path}.${key}`,
        depth: depth + 1,
      });
    }
  }
}

/** Rejects control characters in a free-text field. */
export function assertCleanText(value: string, path: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new ImportRejection(path, "Control characters are not allowed");
  }
}

/**
 * A document URL the evaluation can actually identify.
 *
 * Only `http:` and `https:` are accepted. `file:`, `data:` and `javascript:`
 * URLs are not documents in a web search result, and accepting them would let a
 * dataset claim a judgment about something that was never retrievable.
 */
export function assertDocumentUrl(value: string, path: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ImportRejection(path, `"${value}" is not an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImportRejection(path, `"${parsed.protocol}" URLs are not documents; use http or https`);
  }
}

/**
 * A filename safe to put in `Content-Disposition`.
 *
 * Dataset names are operator-supplied and may contain a path separator, a quote
 * or a newline. The download is a JSON body, not a file read, so this is not a
 * traversal risk — but a header carrying a newline is a response-splitting risk,
 * and a name that escapes the download folder surprises the person who
 * downloads it. Everything outside `[A-Za-z0-9._-]` becomes `_`, and an empty
 * result falls back to the dataset id.
 */
export function safeDownloadName(rawName: string, fallbackId: string): string {
  const cleaned = rawName
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/[._]+$/, "")
    .slice(0, 80);
  const base = cleaned.length > 0 ? cleaned : `quality-dataset-${fallbackId}`;
  return `${base}.json`;
}
