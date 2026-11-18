import type { UpstreamAttribution } from "@search-hub/shared";
import {
  extractDomain,
  jaccardSimilarity,
  normalizeTitle,
  normalizeUrl,
  tokenizeTitle,
} from "@search-hub/shared";

export interface CandidateResult {
  title: string;
  url: string;
  snippet: string;
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
}

export interface DedupedResult extends CandidateResult {
  sources: Array<{
    providerId: string;
    providerName: string;
    providerType: string;
    rank: number;
    score?: number;
    url: string;
  }>;
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
  /** Only compare titles when domains match. */
  sameDomainOnly?: boolean;
}

/**
 * Two-stage de-duplication:
 *  1. exact normalized URL match
 *  2. near-duplicate title match (token Jaccard) on the same registrable domain
 * Every hit keeps its source list so the UI can show where a URL was found.
 */
export function dedupeResults(
  candidates: CandidateResult[],
  options: DedupeOptions = {},
): { results: DedupedResult[]; dropped: DedupDrop[] } {
  const threshold = options.nearDuplicateThreshold ?? 0.82;
  const sameDomainOnly = options.sameDomainOnly ?? true;

  const byUrl = new Map<string, DedupedResult>();
  const dropped: DedupDrop[] = [];

  for (const candidate of candidates) {
    const normalizedUrl = normalizeUrl(candidate.url);
    if (!normalizedUrl) continue;
    // A result without a title is not a usable search result; never invent one.
    if (!candidate.title.trim()) continue;

    const existing = byUrl.get(normalizedUrl);
    if (existing) {
      existing.sources.push({
        providerId: candidate.providerId,
        providerName: candidate.providerName,
        providerType: candidate.providerType,
        rank: candidate.rank,
        ...(candidate.score === undefined ? {} : { score: candidate.score }),
        url: candidate.url,
        ...(candidate.upstream === undefined ? {} : { upstream: candidate.upstream }),
        ...(candidate.upstreamRank === undefined ? {} : { upstreamRank: candidate.upstreamRank }),
      });
      if (candidate.snippet.length > existing.snippet.length) {
        existing.snippet = candidate.snippet;
      }
      if (!existing.publishedAt && candidate.publishedAt) existing.publishedAt = candidate.publishedAt;
      dropped.push({ url: candidate.url, keptUrl: existing.url, reason: "exact_url" });
      continue;
    }

    const domain = extractDomain(normalizedUrl);
    const tokens = tokenizeTitle(candidate.title);

    let nearDuplicate: DedupedResult | undefined;
    if (candidate.title && tokens.size > 2) {
      for (const other of byUrl.values()) {
        if (sameDomainOnly && other.domain !== domain) continue;
        if (!other.title) continue;
        const similarity = jaccardSimilarity(tokens, tokenizeTitle(other.title));
        if (similarity >= threshold) {
          nearDuplicate = other;
          break;
        }
      }
    }

    if (nearDuplicate) {
      nearDuplicate.sources.push({
        providerId: candidate.providerId,
        providerName: candidate.providerName,
        providerType: candidate.providerType,
        rank: candidate.rank,
        ...(candidate.score === undefined ? {} : { score: candidate.score }),
        url: candidate.url,
        ...(candidate.upstream === undefined ? {} : { upstream: candidate.upstream }),
        ...(candidate.upstreamRank === undefined ? {} : { upstreamRank: candidate.upstreamRank }),
      });
      dropped.push({ url: candidate.url, keptUrl: nearDuplicate.url, reason: "near_title" });
      continue;
    }

    byUrl.set(normalizedUrl, {
      ...candidate,
      normalizedUrl,
      domain,
      sources: [
        {
          providerId: candidate.providerId,
          providerName: candidate.providerName,
          providerType: candidate.providerType,
          rank: candidate.rank,
          ...(candidate.score === undefined ? {} : { score: candidate.score }),
          url: candidate.url,
          ...(candidate.upstream === undefined ? {} : { upstream: candidate.upstream }),
          ...(candidate.upstreamRank === undefined ? {} : { upstreamRank: candidate.upstreamRank }),
        },
      ],
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

/**
 * Reciprocal Rank Fusion over per-provider result lists.
 * score(d) = Σ_providers weight_p / (k + rank_p(d))
 * Rank is 1-based within each provider list, which keeps the scoring
 * independent of the providers' own (non-comparable) score scales.
 */
export function fuseWithRrf(deduped: DedupedResult[], options: RrfOptions = {}): RrfOutcome {
  const k = options.k ?? 60;
  const weights = options.providerWeights ?? {};

  const scored = deduped.map((result) => {
    let fusionScore = 0;
    let bestRank = Number.MAX_SAFE_INTEGER;
    const seenProviders = new Set<string>();
    for (const source of result.sources) {
      // A provider that returns the same URL twice must not be counted twice.
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
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });

  return { results: scored };
}

/** Base score used when no fusion is requested: provider rank + source count. */
export function baseScore(result: DedupedResult): number {
  const rankBonus = 1 / Math.max(1, result.rank);
  const multiSourceBonus = Math.min(result.sources.length, 5) * 0.1;
  return Number((rankBonus + multiSourceBonus).toFixed(6));
}

/**
 * The non-RRF ordering used by `basic` mode, and by the offline evaluation lab
 * as its "base ranking" baseline.
 *
 * It lives here so both paths sort identically: an evaluation that ranks with a
 * copy of this comparator would eventually disagree with production and blame
 * the algorithm.
 */
export function orderByBaseRanking(rows: readonly DedupedResult[]): DedupedResult[] {
  return [...rows].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}

export function titleFingerprint(title: string): string {
  return normalizeTitle(title);
}
