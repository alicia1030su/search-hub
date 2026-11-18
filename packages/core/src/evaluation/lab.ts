import { normalizeUrl } from "@search-hub/shared";
import {
  dedupeResults,
  fuseWithRrf,
  orderByBaseRanking,
  type CandidateResult,
  type DedupedResult,
} from "../fusion/fuse.js";
import type { FusionParameters, ProviderSnapshot, QuerySnapshot, RankedList } from "./types.js";

/**
 * Stable document identity.
 *
 * A document is its normalized URL. The raw URL is kept beside it for audit,
 * but two rows that normalize to the same URL are the same document — anything
 * else lets a tracking parameter split one page into two "distinct" results and
 * inflate a score.
 *
 * Non-HTTP rows have no identity here and are dropped: the evaluation lab is
 * about web search, and inventing an id from a list position would silently
 * change meaning between runs.
 */
export function documentIdFor(rawUrl: string): string | null {
  return normalizeUrl(rawUrl);
}

function toCandidates(snapshot: QuerySnapshot): CandidateResult[] {
  const candidates: CandidateResult[] = [];
  for (const provider of snapshot.providers) {
    for (const result of provider.results) {
      if (!documentIdFor(result.url)) continue;
      candidates.push({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        ...(result.score === undefined ? {} : { score: result.score }),
        providerId: provider.providerId,
        providerName: provider.providerName,
        providerType: provider.providerType,
        rank: result.rank,
        retrievedAt: snapshot.capturedAt,
      });
    }
  }
  return candidates;
}

function toRanked(
  snapshot: QuerySnapshot,
  rows: readonly DedupedResult[],
  fusion: FusionParameters,
): RankedList {
  return {
    queryId: snapshot.queryId,
    documents: rows.map((row) => ({
      documentId: row.normalizedUrl,
      url: row.url,
      title: row.title,
    })),
    fusion,
  };
}

/**
 * Produces one ranked list from a snapshot, without any network call.
 *
 * Every strategy goes through the **same** `dedupeResults` and the same
 * ordering helper the production search path uses, so a comparison between two
 * strategies is a comparison of ranking functions over identical input, not a
 * comparison of two pipelines.
 */
export function rankSnapshot(
  snapshot: QuerySnapshot,
  fusion: FusionParameters,
  options: { limit?: number } = {},
): RankedList {
  const limit = Math.max(1, Math.min(100, options.limit ?? 10));

  if (fusion.strategy === "single") {
    const providerId = fusion.providerId;
    if (!providerId) throw new Error("fusion.strategy=single requires providerId");
    const provider = snapshot.providers.find((item) => item.providerId === providerId);
    if (!provider) throw new Error(`provider ${providerId} is not part of this snapshot`);

    // A single-provider baseline is that provider's own order, but it goes
    // through the *same* de-duplication as the fused lists. Otherwise the
    // comparison is between two different document sets and any difference
    // could come from de-duplication rather than from fusion.
    const single = dedupeResults(toCandidates({ ...snapshot, providers: [provider] }));
    return toRanked(snapshot, orderByBaseRanking(single.results).slice(0, limit), fusion);
  }

  const deduped = dedupeResults(toCandidates(snapshot));

  if (fusion.strategy === "rrf") {
    const rrf = fuseWithRrf(deduped.results, {
      ...(fusion.k === undefined ? {} : { k: fusion.k }),
      ...(fusion.providerWeights === undefined ? {} : { providerWeights: fusion.providerWeights }),
    });
    return toRanked(snapshot, rrf.results.slice(0, limit), fusion);
  }

  return toRanked(snapshot, orderByBaseRanking(deduped.results).slice(0, limit), fusion);
}

/**
 * Candidate parameter grid for the offline RRF lab.
 *
 * Only `k` and provider weights are varied; the ranking function itself stays
 * the production one. Nothing here is a claim that any value is "best" — that
 * is what the holdout comparison decides, and only when there is enough
 * evidence.
 */
export function rrfCandidates(values: readonly number[] = [20, 40, 60, 80, 100]): FusionParameters[] {
  const unique = [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))];
  unique.sort((a, b) => a - b);
  return unique.map((k) => ({ strategy: "rrf" as const, k }));
}

export type { ProviderSnapshot };
