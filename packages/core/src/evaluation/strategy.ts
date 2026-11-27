import type { SearchQueryOrigin } from "@search-hub/shared";
import { dedupeResults, fuseLayeredRrf, type CandidateResult } from "../fusion/fuse.js";
import { documentIdFor, rankSnapshot } from "./lab.js";
import { deserializeSnapshot, type DeepQuerySnapshot, type EvaluationSnapshot, type RankedDeepDocument } from "./snapshot.js";
import type { FusionParameters, ProviderSnapshot, QuerySnapshot, RankedList } from "./types.js";

export type RankStrategy = "fusion" | "embedding" | "rerank" | "route" | "deep";

export interface RankStrategyOptions {
  strategy: RankStrategy;
  limit?: number;
  fusion?: FusionParameters;
  /** Extra frozen scores may be supplied by a runner, but live model calls never are. */
  modelArtifacts?: EvaluationSnapshot["modelArtifacts"];
}

export interface DeepRankedList extends RankedList {
  documents: Array<RankedList["documents"][number] & Partial<RankedDeepDocument>>;
}

function candidatesFor(snapshot: QuerySnapshot, provider?: ProviderSnapshot): CandidateResult[] {
  const result: CandidateResult[] = [];
  for (const item of provider ? [provider] : snapshot.providers) {
    for (const row of item.results) {
      const documentId = documentIdFor(row.url);
      if (!documentId) continue;
      result.push({
        title: row.title,
        url: row.url,
        snippet: row.snippet,
        providerId: item.providerId,
        providerName: item.providerName,
        providerType: item.providerType,
        rank: row.rank,
        retrievedAt: snapshot.capturedAt,
        ...(row.score === undefined ? {} : { score: row.score }),
      });
    }
  }
  return result;
}

function frozenScores(
  snapshot: EvaluationSnapshot,
  stage: "embedding" | "rerank",
  extra: EvaluationSnapshot["modelArtifacts"] = {},
): Record<string, number> {
  const selected = extra[stage] ?? snapshot.modelArtifacts[stage];
  if (!selected) throw new Error(`missing frozen modelArtifacts for ${stage}`);
  if (!selected.scores) throw new Error(`missing frozen scores for ${stage}`);
  return selected.scores;
}

function modelRanked(
  snapshot: EvaluationSnapshot,
  stage: "embedding" | "rerank",
  options: RankStrategyOptions,
  limit: number,
): DeepRankedList {
  const scores = frozenScores(snapshot, stage, options.modelArtifacts);
  const fusion = options.fusion ?? { strategy: "base" as const };
  const rows = dedupeResults(candidatesFor(snapshot)).results.map((row) => ({
    ...row,
    score: scores[row.normalizedUrl] ?? 0,
  }));
  rows.sort((left, right) =>
    right.score - left.score || left.rank - right.rank || right.sources.length - left.sources.length ||
    (left.normalizedUrl < right.normalizedUrl ? -1 : left.normalizedUrl > right.normalizedUrl ? 1 : 0),
  );
  return {
    queryId: snapshot.queryId,
    fusion: { ...fusion, strategy: "base" },
    documents: rows.slice(0, limit).map((row) => ({
      documentId: row.normalizedUrl,
      url: row.url,
      title: row.title,
      deepScore: row.score,
      queriesContaining: row.sources.length,
      bestRank: row.rank,
      sourcesCount: row.sources.length,
    })),
  };
}

function deepQuery(snapshot: QuerySnapshot, queryIndex: number): DeepQuerySnapshot {
  if ((snapshot as Partial<DeepQuerySnapshot>).round !== undefined) return snapshot as DeepQuerySnapshot;
  return { ...snapshot, queryIndex, kind: "original", weight: 1, round: 1, providerQueryCalls: snapshot.providers.length, httpRequests: snapshot.upstreamRequests, modelCalls: 0, budgetExhausted: false };
}

/**
 * Ranks only frozen provider rows. Model stages read capture-time artifacts and
 * never invoke a model; deep uses PRD B3 layered RRF and retains queryOrigins.
 */
export function rankStrategy(
  input: EvaluationSnapshot | QuerySnapshot | readonly ProviderSnapshot[],
  options: RankStrategyOptions,
): RankedList | DeepRankedList {
  const snapshot = deserializeSnapshot(input);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
  const fusion: FusionParameters = options.fusion ?? { strategy: "rrf", k: 60 };

  if (options.strategy === "fusion" || options.strategy === "route") {
    if (options.strategy === "route") {
      const routeArtifact = snapshot.route;
      if (!routeArtifact) throw new Error("missing frozen route artifact");
      return rankSnapshot(snapshot, { ...fusion, strategy: fusion.strategy === "single" ? "single" : "rrf", providerWeights: routeArtifact.providerWeights }, { limit });
    }
    return rankSnapshot(snapshot, fusion, { limit });
  }
  if (options.strategy === "embedding" || options.strategy === "rerank") {
    return modelRanked(snapshot, options.strategy, options, limit);
  }

  const queries = new Map<string, DeepQuerySnapshot>();
  const addQuery = (query: DeepQuerySnapshot): void => {
    const key = query.query.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
    const existing = queries.get(key);
    if (!existing) {
      queries.set(key, { ...query, providers: query.providers.map((provider) => ({ ...provider, results: provider.results.map((result) => ({ ...result })) })) });
      return;
    }
    // Equivalent NFKC/casefold queries execute once, but later evidence is
    // merged rather than discarded (each provider keeps its own best rank).
    for (const provider of query.providers) {
      const target = existing.providers.find((item) => item.providerId === provider.providerId);
      if (!target) {
        existing.providers.push(provider);
      } else {
        target.results.push(...provider.results);
      }
    }
  };
  addQuery(deepQuery(snapshot, 0));
  for (const query of snapshot.deepRounds) addQuery(query);
  const ordered = [...queries.values()].sort((left, right) =>
    left.round - right.round || left.queryIndex - right.queryIndex || left.queryId.localeCompare(right.queryId),
  );
  const candidates: CandidateResult[] = [];
  for (const query of ordered) {
    for (const provider of query.providers) {
      for (const candidate of candidatesFor(query, provider)) {
        const origin: SearchQueryOrigin = {
          queryId: query.queryId,
          query: query.query,
          queryIndex: query.queryIndex,
          kind: query.kind,
          round: query.round,
          weight: query.weight,
          providerId: provider.providerId,
          rank: candidate.rank,
          score: 0,
        };
        candidates.push({ ...candidate, queryOrigins: [origin] });
      }
    }
  }
  const deduped = dedupeResults(candidates).results;
  const ranked = fuseLayeredRrf(deduped, ordered.map((query) => ({ id: query.queryId, weight: query.weight })), {
    k: fusion.strategy === "rrf" ? fusion.k : 60,
    ...(fusion.providerWeights ? { providerWeights: fusion.providerWeights } : {}),
  });
  return {
    queryId: snapshot.queryId,
    fusion,
    documents: ranked.slice(0, limit).map((row) => ({
      documentId: row.normalizedUrl,
      url: row.url,
      title: row.title,
      deepScore: row.deepScore,
      queriesContaining: row.queriesContaining,
      bestRank: row.bestRank,
      sourcesCount: row.sources.length,
      queryOrigins: row.queryOrigins ?? [],
    })),
  };
}

export interface StrategyMovement {
  queryId: string;
  documentId: string;
  from: number | null;
  to: number | null;
  delta: number | null;
}

export interface CompareRankStrategiesOptions {
  snapshot: EvaluationSnapshot | QuerySnapshot | readonly ProviderSnapshot[];
  baseline: RankStrategy;
  candidate: RankStrategy;
  limit?: number;
  fusion?: FusionParameters;
  modelArtifacts?: EvaluationSnapshot["modelArtifacts"];
}

/** Compares two pure replay rankings without fetching or invoking any model. */
export function compareRankStrategies(options: CompareRankStrategiesOptions): {
  baseline: RankedList | DeepRankedList;
  candidate: RankedList | DeepRankedList;
  entered: StrategyMovement[];
  exited: StrategyMovement[];
  moved: StrategyMovement[];
  unchanged: StrategyMovement[];
} {
  const shared = { limit: options.limit, fusion: options.fusion, modelArtifacts: options.modelArtifacts };
  const baseline = rankStrategy(options.snapshot, { ...shared, strategy: options.baseline });
  const candidate = rankStrategy(options.snapshot, { ...shared, strategy: options.candidate });
  const baselinePositions = new Map(baseline.documents.map((document, index) => [document.documentId, index + 1]));
  const candidatePositions = new Map(candidate.documents.map((document, index) => [document.documentId, index + 1]));
  const entered: StrategyMovement[] = [];
  const exited: StrategyMovement[] = [];
  const moved: StrategyMovement[] = [];
  const unchanged: StrategyMovement[] = [];
  for (const [documentId, to] of candidatePositions) {
    const from = baselinePositions.get(documentId) ?? null;
    const movement = { queryId: baseline.queryId, documentId, from, to, delta: from === null ? null : from - to };
    if (from === null) entered.push(movement);
    else if (from === to) unchanged.push(movement);
    else moved.push(movement);
  }
  for (const [documentId, from] of baselinePositions) {
    if (!candidatePositions.has(documentId)) exited.push({ queryId: baseline.queryId, documentId, from, to: null, delta: null });
  }
  return { baseline, candidate, entered, exited, moved, unchanged };
}
