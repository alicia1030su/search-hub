import type { SearchQueryOrigin, UpstreamAttribution } from "@search-hub/shared";
import {
  extractDomain,
  jaccardSimilarity,
  normalizeTitle,
  normalizeUrl,
  tokenizeTitle,
} from "@search-hub/shared";

export interface CandidateSource {
  providerId: string;
  providerName: string;
  providerType: string;
  rank: number;
  score?: number;
  url: string;
  upstream?: UpstreamAttribution;
  upstreamRank?: number;
}

export interface CandidateResult {
  title: string;
  url: string;
  snippet: string;
  body?: string;
  publishedAt?: string;
  score?: number;
  language?: string;
  /** Upstream attribution when the row arrived through a gateway adapter. */
  upstream?: UpstreamAttribution;
  /** Vendor-assigned position; never used as a source name. */
  upstreamRank?: number;
  raw?: unknown;
  providerId: string;
  providerName: string;
  providerType: string;
  rank: number;
  retrievedAt: string;
  /** Deep-search callers may provide already-merged provenance. */
  sources?: CandidateSource[];
  queryOrigins?: SearchQueryOrigin[];
}

export interface DedupedResult extends CandidateResult {
  sources: CandidateSource[];
  normalizedUrl: string;
  domain: string;
}

export interface DedupDrop {
  url: string;
  keptUrl: string;
  reason: "exact_url" | "near_title";
}

export interface DedupeOptions {
  /** Jaccard threshold on title tokens for near-duplicate detection. */
  nearDuplicateThreshold?: number;
  /** Jaccard threshold on body/snippet tokens for near-duplicate detection. */
  bodySimilarityThreshold?: number;
  /** Minimum non-whitespace body characters required before near-title merging. */
  minBodyChars?: number;
  /** Only compare titles when domains match. */
  sameDomainOnly?: boolean;
}

/** NFKC/casefold tokenizer for body similarity: latin/digital words and CJK bigrams. */
export function tokenizeContent(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g)?.filter((token) => token.length >= 2) ?? [];
  const cjk = normalized.match(/[\u4e00-\u9fff]/g) ?? [];
  const bigrams = new Set<string>();
  for (let index = 0; index < cjk.length - 1; index += 1) {
    bigrams.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  return new Set([...latin, ...bigrams]);
}

function bodyText(candidate: Pick<CandidateResult, "body" | "snippet">): string {
  return candidate.body ?? candidate.snippet;
}

/** Near-title duplicates require same domain, high title similarity and real body similarity. */
export function isNearDuplicate(
  left: Pick<CandidateResult, "url" | "title" | "snippet" | "body">,
  right: Pick<CandidateResult, "url" | "title" | "snippet" | "body">,
  options: DedupeOptions = {},
): boolean {
  const leftUrl = normalizeUrl(left.url);
  const rightUrl = normalizeUrl(right.url);
  if (!leftUrl || !rightUrl || extractDomain(leftUrl) !== extractDomain(rightUrl)) return false;
  const titleThreshold = options.nearDuplicateThreshold ?? 0.82;
  if (jaccardSimilarity(tokenizeTitle(left.title), tokenizeTitle(right.title)) < titleThreshold) return false;

  const leftBody = bodyText(left);
  const rightBody = bodyText(right);
  const minBodyChars = options.minBodyChars ?? 20;
  if (leftBody.replace(/\s/g, "").length < minBodyChars || rightBody.replace(/\s/g, "").length < minBodyChars) {
    return false;
  }
  return jaccardSimilarity(tokenizeContent(leftBody), tokenizeContent(rightBody)) >=
    (options.bodySimilarityThreshold ?? 0.7);
}

function sourceFor(candidate: CandidateResult): CandidateSource {
  return {
    providerId: candidate.providerId,
    providerName: candidate.providerName,
    providerType: candidate.providerType,
    rank: candidate.rank,
    ...(candidate.score === undefined ? {} : { score: candidate.score }),
    url: candidate.url,
    ...(candidate.upstream === undefined ? {} : { upstream: candidate.upstream }),
    ...(candidate.upstreamRank === undefined ? {} : { upstreamRank: candidate.upstreamRank }),
  };
}

function mergeCandidate(target: DedupedResult, candidate: CandidateResult): void {
  target.sources.push(...(candidate.sources?.map((source) => ({ ...source })) ?? [sourceFor(candidate)]));
  if (candidate.queryOrigins?.length) {
    target.queryOrigins = [...(target.queryOrigins ?? []), ...candidate.queryOrigins.map((origin) => ({ ...origin }))];
  }
  if (candidate.snippet.length > target.snippet.length) target.snippet = candidate.snippet;
  if (candidate.body && (!target.body || candidate.body.length > target.body.length)) target.body = candidate.body;
  if (!target.publishedAt && candidate.publishedAt) target.publishedAt = candidate.publishedAt;
  target.rank = Math.min(target.rank, candidate.rank);
}

/**
 * Two-stage de-duplication:
 *  1. exact normalized URL match
 *  2. same-domain near-title match only when title and body both satisfy their thresholds
 * Every hit keeps its source list and deep-query provenance.
 */
export function dedupeResults(
  candidates: CandidateResult[],
  options: DedupeOptions = {},
): { results: DedupedResult[]; dropped: DedupDrop[] } {
  const byUrl = new Map<string, DedupedResult>();
  const dropped: DedupDrop[] = [];

  for (const candidate of candidates) {
    const normalizedUrl = normalizeUrl(candidate.url);
    if (!normalizedUrl || !candidate.title.trim()) continue;

    const existing = byUrl.get(normalizedUrl);
    if (existing) {
      mergeCandidate(existing, candidate);
      dropped.push({ url: candidate.url, keptUrl: existing.url, reason: "exact_url" });
      continue;
    }

    const domain = extractDomain(normalizedUrl);
    let nearDuplicate: DedupedResult | undefined;
    for (const other of byUrl.values()) {
      if (options.sameDomainOnly !== false && other.domain !== domain) continue;
      if (isNearDuplicate(candidate, other, options)) {
        nearDuplicate = other;
        break;
      }
    }

    if (nearDuplicate) {
      mergeCandidate(nearDuplicate, candidate);
      dropped.push({ url: candidate.url, keptUrl: nearDuplicate.url, reason: "near_title" });
      continue;
    }

    byUrl.set(normalizedUrl, {
      ...candidate,
      normalizedUrl,
      domain,
      rank: candidate.rank,
      sources: candidate.sources?.map((source) => ({ ...source })) ?? [sourceFor(candidate)],
      ...(candidate.queryOrigins?.length ? { queryOrigins: candidate.queryOrigins.map((origin) => ({ ...origin })) } : {}),
    });
  }

  return { results: [...byUrl.values()], dropped };
}

export interface RrfOptions {
  /** Standard RRF constant; 60 is the value from the original paper. */
  k?: number;
  /** Per-source multiplicative weight (provider quality tuning). */
  providerWeights?: Record<string, number>;
}

export interface RrfOutcome {
  results: Array<DedupedResult & { fusionScore: number; bestRank: number }>;
}

/** Reciprocal Rank Fusion over per-provider result lists. */
export function fuseWithRrf(deduped: DedupedResult[], options: RrfOptions = {}): RrfOutcome {
  const k = options.k ?? 60;
  const weights = options.providerWeights ?? {};

  const scored = deduped.map((result) => {
    let fusionScore = 0;
    let bestRank = Number.MAX_SAFE_INTEGER;
    const seenProviders = new Set<string>();
    for (const source of result.sources) {
      if (seenProviders.has(source.providerId)) continue;
      seenProviders.add(source.providerId);
      const weight = weights[source.providerId] ?? 1;
      fusionScore += weight / (k + Math.max(1, source.rank));
      bestRank = Math.min(bestRank, source.rank);
    }
    return {
      ...result,
      fusionScore,
      bestRank: bestRank === Number.MAX_SAFE_INTEGER ? 1 : bestRank,
    };
  });

  scored.sort((a, b) => {
    if (b.fusionScore !== a.fusionScore) return b.fusionScore - a.fusionScore;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return a.normalizedUrl < b.normalizedUrl ? -1 : a.normalizedUrl > b.normalizedUrl ? 1 : 0;
  });

  return { results: scored };
}

export interface LayeredRrfQuery {
  id: string;
  weight: number;
}

export interface LayeredRrfOptions {
  k?: number;
  providerWeights?: Record<string, number>;
}

export type LayeredRrfResult<T> = T & {
  deepScore: number;
  queriesContaining: number;
  bestRank: number;
};

/**
 * Deep-search fusion from PRD B3: normalise each query's local RRF independently,
 * then combine query-weighted normalised scores with cross-query coverage.
 */
export function fuseLayeredRrf<T extends Pick<DedupedResult, "normalizedUrl" | "sources" | "queryOrigins">>(
  documents: T[],
  queries: LayeredRrfQuery[],
  options: LayeredRrfOptions = {},
): Array<LayeredRrfResult<T>> {
  const k = options.k ?? 60;
  const weights = options.providerWeights ?? {};
  const queryWeights = new Map(queries.map((query) => [query.id, query.weight]));
  const totalWeight = queries.reduce((sum, query) => sum + query.weight, 0);
  const localByDocument = new Map<string, Map<string, number>>();
  const normalizedOrigins = new Map<string, SearchQueryOrigin[]>();
  const maxLocalByQuery = new Map<string, number>();

  for (const document of documents) {
    const bestByQueryProvider = new Map<string, Map<string, SearchQueryOrigin>>();
    for (const origin of document.queryOrigins ?? []) {
      if (!queryWeights.has(origin.queryId)) continue;
      let byProvider = bestByQueryProvider.get(origin.queryId);
      if (!byProvider) {
        byProvider = new Map();
        bestByQueryProvider.set(origin.queryId, byProvider);
      }
      const previous = byProvider.get(origin.providerId);
      if (!previous || origin.rank < previous.rank) {
        byProvider.set(origin.providerId, {
          ...origin,
          score: (weights[origin.providerId] ?? 1) / (k + Math.max(1, origin.rank)),
        });
      }
    }

    const local = new Map<string, number>();
    const origins: SearchQueryOrigin[] = [];
    for (const [queryId, byProvider] of bestByQueryProvider) {
      let score = 0;
      for (const origin of byProvider.values()) {
        score += origin.score;
        origins.push(origin);
      }
      local.set(queryId, score);
      maxLocalByQuery.set(queryId, Math.max(maxLocalByQuery.get(queryId) ?? 0, score));
    }
    origins.sort((a, b) => a.round - b.round || a.queryIndex - b.queryIndex || a.providerId.localeCompare(b.providerId) || a.rank - b.rank);
    normalizedOrigins.set(document.normalizedUrl, origins);
    localByDocument.set(document.normalizedUrl, local);
  }

  const scored = documents.map((document) => {
    const local = localByDocument.get(document.normalizedUrl) ?? new Map<string, number>();
    let weightedNormalized = 0;
    let queriesContaining = 0;
    let bestRank = Number.MAX_SAFE_INTEGER;
    for (const query of queries) {
      const value = local.get(query.id) ?? 0;
      if (value > 0) queriesContaining += 1;
      const maxLocal = maxLocalByQuery.get(query.id) ?? 0;
      if (maxLocal > 0) weightedNormalized += query.weight * (value / maxLocal);
    }
    for (const origin of normalizedOrigins.get(document.normalizedUrl) ?? []) {
      bestRank = Math.min(bestRank, origin.rank);
    }
    const coverage = queries.length > 0 ? queriesContaining / queries.length : 0;
    const deepScore = totalWeight > 0
      ? 0.7 * (weightedNormalized / totalWeight) + 0.3 * coverage
      : 0;
    return {
      ...document,
      queryOrigins: normalizedOrigins.get(document.normalizedUrl) ?? [],
      deepScore,
      queriesContaining,
      bestRank: bestRank === Number.MAX_SAFE_INTEGER ? 1 : bestRank,
    };
  });

  scored.sort((a, b) => {
    if (b.deepScore !== a.deepScore) return b.deepScore - a.deepScore;
    if (b.queriesContaining !== a.queriesContaining) return b.queriesContaining - a.queriesContaining;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return a.normalizedUrl < b.normalizedUrl ? -1 : a.normalizedUrl > b.normalizedUrl ? 1 : 0;
  });

  return scored;
}

/** Base score used when no fusion is requested: provider rank + source count. */
export function baseScore(result: DedupedResult): number {
  const rankBonus = 1 / Math.max(1, result.rank);
  const multiSourceBonus = Math.min(result.sources.length, 5) * 0.1;
  return Number((rankBonus + multiSourceBonus).toFixed(6));
}

/** Basic-mode ordering, shared with the offline evaluation lab. */
export function orderByBaseRanking(rows: readonly DedupedResult[]): DedupedResult[] {
  return [...rows].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return a.normalizedUrl < b.normalizedUrl ? -1 : a.normalizedUrl > b.normalizedUrl ? 1 : 0;
  });
}

export function titleFingerprint(title: string): string {
  return normalizeTitle(title);
}
