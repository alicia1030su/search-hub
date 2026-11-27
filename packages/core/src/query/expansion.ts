export type QueryLanguage = "zh" | "en" | "ja" | "mixed" | "und";
export type ExpansionKind = "original" | "synonym" | "reordered" | "keywords" | "translation" | "rewrite";
export type ExpansionSource = "original" | "rule" | "model";

export interface ExpansionRequest {
  query: string;
  queryExpansion?: boolean;
  strategy?: "auto" | "fast" | "balanced" | "quality" | "deep";
  locale?: string;
}

export interface ExpandedQuery {
  query: string;
  kind: ExpansionKind;
  weight: number;
  reason: string;
  source: ExpansionSource;
  language: QueryLanguage;
}

export type ModelExpander = (
  query: string,
  signal?: AbortSignal,
) => unknown | Promise<unknown>;

export interface ExpansionOptions {
  /** Total query budget, including the original query. */
  maxQueries?: number;
  signal?: AbortSignal;
  modelExpander?: ModelExpander;
}

export interface ExpansionResult {
  originalQuery: string;
  queries: ExpandedQuery[];
  language: QueryLanguage;
  skippedReason?: string;
  skippedReasons: string[];
}

const MAX_QUERY_LENGTH = 160;
const MAX_MODEL_OUTPUTS = 8;

const SYNONYMS: ReadonlyArray<readonly [string, string]> = [
  ["ai", "artificial intelligence"],
  ["artificial intelligence", "AI"],
  ["llm", "large language model"],
  ["large language model", "LLM"],
  ["rag", "retrieval augmented generation"],
  ["retrieval augmented generation", "RAG"],
  ["机器学习", "machine learning"],
  ["machine learning", "机器学习"],
  ["深度学习", "deep learning"],
  ["deep learning", "深度学习"],
  ["数据库", "database"],
  ["database", "数据库"],
];

const TRANSLATIONS: Readonly<Record<string, string>> = {
  "machine learning": "机器学习",
  "deep learning": "深度学习",
  "large language model": "大语言模型",
  "artificial intelligence": "人工智能",
  "database": "数据库",
  tutorial: "教程",
  example: "示例",
  examples: "示例",
  guide: "指南",
  "机器学习": "machine learning",
  "深度学习": "deep learning",
  "大语言模型": "large language model",
  "人工智能": "artificial intelligence",
  "数据库": "database",
  "教程": "tutorial",
  "示例": "example",
  "指南": "guide",
};

const EN_STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "from", "how", "i", "in", "is", "it", "me", "of", "on", "or", "the", "to", "what", "when", "where", "which", "who", "why", "with",
]);

const ZH_PREFIXES = ["请问", "如何", "怎么", "怎样", "为什么", "什么是", "是什么", "哪些", "哪个", "什么", "关于", "有关"];
const EN_PREFIXES = ["what is", "what are", "how to", "how do i", "how can i", "why is", "why are", "tell me about"];

/** Identity only: never use this value as the displayed or executed query. */
export function normalizeQueryIdentity(query: string): string {
  return query.normalize("NFKC").toLowerCase().replace(/ß/gu, "ss").replace(/ς/gu, "σ").replace(/\s+/gu, " ").trim();
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function detectQueryLanguage(query: string): QueryLanguage {
  const normalized = query.normalize("NFKC");
  if (!normalized.trim()) return "und";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized)) return "ja";
  const hasCjk = /\p{Script=Han}/u.test(normalized);
  const hasLatin = /\p{Script=Latin}/u.test(normalized);
  if (hasCjk && hasLatin) return "mixed";
  if (hasCjk) return "zh";
  if (hasLatin) return "en";
  return "und";
}

function originalResult(request: ExpansionRequest, language: QueryLanguage, reason?: string): ExpansionResult {
  return {
    originalQuery: request.query,
    language,
    queries: [{
      query: request.query,
      kind: "original",
      weight: 1,
      reason: "original user query",
      source: "original",
      language,
    }],
    skippedReasons: reason ? [reason] : [],
    ...(reason ? { skippedReason: reason } : {}),
  };
}

function contentWords(query: string): string[] {
  return normalizeQueryIdentity(query)
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(" ")
    .filter((word) => word.length > 1 && !EN_STOP_WORDS.has(word));
}

function anchors(query: string): Set<string> {
  const result = new Set<string>();
  for (const word of contentWords(query)) {
    if (/^[a-z0-9]+$/u.test(word)) result.add(word);
  }
  const han = query.normalize("NFKC").match(/\p{Script=Han}+/gu) ?? [];
  for (const run of han) {
    if (run.length === 1) result.add(run);
    for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2));
  }
  return result;
}

/** Latin names/acronyms, URLs, email addresses and explicitly quoted text are immutable. */
function properNouns(query: string): string[] {
  const nouns = new Set<string>();
  for (const match of query.matchAll(/[\w.+%-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s]+|《[^》]+》|[A-Z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*/gu)) {
    const value = match[0].replace(/^《|》$/g, "");
    const looksLikeSentenceStart = match.index === 0 && /^[A-Z][a-z]+$/u.test(value);
    if (value.length > 1 && !looksLikeSentenceStart && !["AI", "LLM", "RAG"].includes(value)) nouns.add(normalizeQueryIdentity(value));
  }
  for (const match of query.matchAll(/\b[A-Z]{2,}(?:-[A-Z0-9]+)*\b/g)) {
    if (!["AI", "LLM", "RAG"].includes(match[0])) nouns.add(normalizeQueryIdentity(match[0]));
  }
  return [...nouns];
}

function containsProperNouns(candidate: string, required: readonly string[]): boolean {
  const normalized = normalizeQueryIdentity(candidate);
  return required.every((noun) => normalized.includes(noun));
}

function keywordRelevance(query: string, candidate: string): number {
  const originalAnchors = anchors(query);
  const candidateAnchors = anchors(candidate);
  let overlap = 0;
  for (const anchor of originalAnchors) if (candidateAnchors.has(anchor)) overlap += 1;
  const required = Math.min(4, originalAnchors.size);
  return required === 0 ? 0 : overlap / required;
}

function modelCandidateIsValid(query: string, candidate: string, locale?: string): boolean {
  if (!candidate || candidate.length > MAX_QUERY_LENGTH || candidate.length > query.length * 6 + 24) return false;
  if (normalizeQueryIdentity(candidate) === normalizeQueryIdentity(query)) return false;
  if (hasControlCharacters(candidate)) return false;
  const requiredNouns = properNouns(query);
  if (!containsProperNouns(candidate, requiredNouns)) return false;
  const introducedNouns = properNouns(candidate).filter((noun) => !requiredNouns.some((required) => required === noun || required.includes(noun) || noun.includes(required)));
  if (introducedNouns.length > 0) return false;
  const originalLanguage = detectQueryLanguage(query);
  const candidateLanguage = detectQueryLanguage(candidate);
  if (locale && /^zh(?:-|$)/i.test(locale)) {
    if (!["zh", "mixed"].includes(candidateLanguage)) return false;
  } else if (locale && /^en(?:-|$)/i.test(locale)) {
    if (!["en", "mixed"].includes(candidateLanguage)) return false;
  } else if (locale && /^ja(?:-|$)/i.test(locale)) {
    if (candidateLanguage !== "ja") return false;
  } else if (candidateLanguage !== originalLanguage) {
    return false;
  }
  return keywordRelevance(query, candidate) >= 0.5;
}

function ruleCandidates(request: ExpansionRequest): ExpandedQuery[] {
  const { query } = request;
  const normalized = normalizeQueryIdentity(query);
  const language = detectQueryLanguage(query);
  const requiredNouns = properNouns(query);
  const candidates: ExpandedQuery[] = [];
  const add = (candidate: string, kind: ExpansionKind, weight: number, reason: string): void => {
    const cleaned = candidate.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!cleaned || cleaned.length > MAX_QUERY_LENGTH) return;
    if (!containsProperNouns(cleaned, requiredNouns)) return;
    if (kind !== "translation" && keywordRelevance(query, cleaned) < 0.5) return;
    candidates.push({ query: cleaned, kind, weight, reason, source: "rule", language: detectQueryLanguage(cleaned) });
  };

  let keywordQuery = query.normalize("NFKC").trim();
  for (const prefix of ZH_PREFIXES) {
    if (keywordQuery.startsWith(prefix)) {
      keywordQuery = keywordQuery.slice(prefix.length).trim();
    }
  }
  keywordQuery = keywordQuery
    .replace(/^(?:what is|what are|how to|how do i|how can i|why is|why are|tell me about)\s+/iu, "")
    .replace(/[?？!！。]+$/gu, "")
    .replace(/^(?:请问|请)[\s，,]*/u, "")
    .trim();
  if ((language === "zh" && keywordQuery.length >= 4) || contentWords(keywordQuery).length >= 2) {
    add(keywordQuery, "keywords", 0.7, "removed question phrasing");
  }

  for (const [source, replacement] of SYNONYMS) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = language === "zh" || language === "mixed" || /[\p{Script=Han}]/u.test(source)
      ? new RegExp(escaped, "gu")
      : new RegExp(`(?<![\\p{Letter}\\p{Number}])${escaped}(?![\\p{Letter}\\p{Number}])`, "giu");
    if (expression.test(query)) {
      expression.lastIndex = 0;
      add(query.replace(expression, (matched) => properNouns(matched).length > 0 ? matched : replacement), "synonym", 0.8, `deterministic synonym: ${source} -> ${replacement}`);
    }
  }

  const englishPrefix = EN_PREFIXES.find((prefix) => normalized.startsWith(`${prefix} `));
  if (englishPrefix && contentWords(query).length >= 2) {
    add(`${query.slice(englishPrefix.length).trim()} ${englishPrefix}`, "reordered", 0.75, "reordered question prefix");
  }

  if (["zh", "en", "mixed"].includes(language)) {
    const words = contentWords(query);
    if (words.length > 0) {
      const translatedWords = words.map((word) => TRANSLATIONS[word]).filter(Boolean);
      if (translatedWords.length === words.length) {
        add(translatedWords.join(" "), "translation", 0.75, "deterministic bilingual term mapping");
      } else {
        // Prefer the longest dictionary phrases before single-word mapping.
        const remaining = normalizeQueryIdentity(query);
        const hanLength = (remaining.match(/\p{Script=Han}/gu) ?? []).length;
        const latinLength = (remaining.match(/[a-z]/giu) ?? []).length;
        const translateFromHan = language === "zh" || (language === "mixed" && hanLength > latinLength);
        const entries = Object.entries(TRANSLATIONS)
          .filter(([source]) => /\p{Script=Han}/u.test(source) === translateFromHan)
          .sort(([left], [right]) => right.length - left.length);
        const pattern = entries.map(([source]) => {
          const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return /\p{Script=Han}/u.test(source) ? escaped : `(?<![\\p{Letter}\\p{Number}])${escaped}(?![\\p{Letter}\\p{Number}])`;
        }).join("|");
        if (pattern) {
          const expression = new RegExp(`(?:${pattern})`, "giu");
          const matches = [...remaining.matchAll(expression)];
          if (matches.length >= Math.min(2, words.length)) {
            const translated = remaining.replace(expression, (matched) => ` ${entries.find(([source]) => normalizeQueryIdentity(source) === normalizeQueryIdentity(matched))?.[1] ?? matched} `);
            add(translated, "translation", 0.75, "deterministic bilingual term mapping");
          }
        }
      }
    }
  }
  return candidates;
}

function modelOutputQueries(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.filter((value): value is string => typeof value === "string");
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.query === "string") return [record.query];
    if (typeof record.rewrite === "string") return [record.rewrite];
    if (Array.isArray(record.queries)) return record.queries.filter((value): value is string => typeof value === "string");
  }
  return [];
}

/**
 * Bounded, deterministic query planning. The original always remains q1; model
 * rewrites are additive only and must pass local language/keyword/proper-noun checks.
 */
export async function expandQuery(request: ExpansionRequest, options: ExpansionOptions = {}): Promise<ExpansionResult> {
  const query = typeof request.query === "string" ? request.query : "";
  const safeRequest = { ...request, query };
  const language = detectQueryLanguage(query);
  const budget = Number.isFinite(options.maxQueries) ? Math.min(4, Math.max(1, Math.floor(options.maxQueries!))) : 3;
  if (request.queryExpansion === false) return originalResult(safeRequest, language, "expansion_disabled");
  if (request.strategy === "fast") return originalResult(safeRequest, language, "fast_strategy");
  if (!query.trim() || language === "und" || language === "ja") return originalResult(safeRequest, language, "no_safe_rule_expansion");
  if (options.signal?.aborted) return originalResult(safeRequest, language, "cancelled");

  const skippedReasons: string[] = [];
  const accepted: ExpandedQuery[] = [];
  const identities = new Set([normalizeQueryIdentity(query)]);
  const accept = (candidate: ExpandedQuery): void => {
    const identity = normalizeQueryIdentity(candidate.query);
    if (!identity || identities.has(identity) || accepted.length + 2 > budget) return;
    identities.add(identity);
    accepted.push(candidate);
  };

  for (const candidate of ruleCandidates(safeRequest)) {
    if (accepted.length + 2 > budget) break;
    accept(candidate);
  }

  if (options.modelExpander && accepted.length + 2 <= budget && !options.signal?.aborted) {
    try {
      const output = await options.modelExpander(query, options.signal);
      if (options.signal?.aborted) {
        skippedReasons.push("cancelled");
      } else {
        for (const raw of modelOutputQueries(output).slice(0, MAX_MODEL_OUTPUTS)) {
          if (accepted.length + 2 > budget) break;
          if (hasControlCharacters(raw)) continue;
          const candidate = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
          if (!modelCandidateIsValid(query, candidate, request.locale)) continue;
          accept({ query: candidate, kind: "rewrite", weight: 0.8, reason: "validated model rewrite", source: "model", language: detectQueryLanguage(candidate) });
        }
      }
    } catch {
      skippedReasons.push(options.signal?.aborted ? "cancelled" : "model_failed");
    }
  } else if (options.signal?.aborted) {
    skippedReasons.push("cancelled");
  } else if (!options.modelExpander) {
    skippedReasons.push("model_unavailable");
  }

  return {
    originalQuery: query,
    queries: [{
      query,
      kind: "original",
      weight: 1,
      reason: "original user query",
      source: "original",
      language,
    }, ...accepted],
    language,
    skippedReasons,
    ...(skippedReasons[0] ? { skippedReason: skippedReasons[0] } : {}),
  };
}
