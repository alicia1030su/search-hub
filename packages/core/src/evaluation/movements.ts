/**
 * Document-level rank movements between two experiments.
 *
 * "The score dropped by 0.04" is not a finding. "This answer fell from position
 * 2 to position 9, and the document that replaced it is unjudged" is one. This
 * module turns the first statement into the second.
 *
 * Three rules make the output trustworthy:
 *
 *  1. A document that exists on one side only is `entered` or `exited`, and its
 *     `deltaPositions` is **null** — not 0 (which would read as "did not move")
 *     and not Infinity (which would poison any average).
 *  2. A document that exists on neither side cannot appear: it was not part of
 *     either ranking, and listing it would invent a change.
 *  3. Unjudged documents are counted but hidden by default. They cannot be said
 *     to have improved or degraded only the ranking, because nobody graded them;
 *     the caller gets `hiddenUnjudgedMovements` and can ask for them explicitly.
 */
import type { QueryCategory, RelevanceGrade } from "./types.js";

export type MovementKind = "up" | "down" | "entered" | "exited" | "same";

export interface RankedDocument {
  documentId: string;
  url: string;
  title: string;
}

export interface DocumentMovement {
  documentId: string;
  url: string;
  title: string;
  /** `null` when the document has no judgement — never 0, which means "judged irrelevant". */
  relevance: RelevanceGrade | null;
  /** 1-based position in the baseline, or `null` when it was not there. */
  baselineRank: number | null;
  /** 1-based position in the candidate, or `null` when it is not there. */
  candidateRank: number | null;
  /**
   * `baselineRank - candidateRank`: positive is an improvement. `null` when the
   * document appears on one side only, because "moved by 5" is not meaningful
   * for a document that was not ranked at all.
   */
  deltaPositions: number | null;
  movement: MovementKind;
}

export interface QueryMovements {
  queryId: string;
  category: QueryCategory;
  rows: DocumentMovement[];
  /** Judged documents that changed position, before the per-query cap. */
  changedCount: number;
  /** Unjudged documents that changed position and were withheld. */
  hiddenUnjudgedMovements: number;
  /** Judged changes dropped by `maxPerQuery`. */
  truncatedCount: number;
}

export interface MovementsOptions {
  /** Judged rows kept per query, biggest movement first. Default 20. */
  maxPerQuery?: number;
  /** Include unjudged documents. Default false: they cannot be scored. */
  includeUnjudged?: boolean;
}

function positionMap(documents: readonly RankedDocument[]): Map<string, { rank: number; doc: RankedDocument }> {
  const map = new Map<string, { rank: number; doc: RankedDocument }>();
  documents.forEach((doc, index) => {
    // First occurrence wins: a ranking that repeats a URL still has one position
    // that matters, and the earlier one is where a reader would meet it.
    if (!map.has(doc.documentId)) map.set(doc.documentId, { rank: index + 1, doc });
  });
  return map;
}

function movementKind(delta: number | null, baselineRank: number | null, candidateRank: number | null): MovementKind {
  if (baselineRank === null) return "entered";
  if (candidateRank === null) return "exited";
  if (delta === null || delta === 0) return "same";
  return delta > 0 ? "up" : "down";
}

/**
 * Movements for one query.
 *
 * Ordering is deterministic: largest absolute movement first, then documents
 * that entered or exited, then URL. Two identical inputs must produce byte-
 * identical output, or a stored comparison could not be diffed.
 */
export function queryMovements(
  queryId: string,
  category: QueryCategory,
  baseline: readonly RankedDocument[],
  candidate: readonly RankedDocument[],
  grades: ReadonlyMap<string, RelevanceGrade>,
  options: MovementsOptions = {},
): QueryMovements {
  const maxPerQuery = Math.max(1, options.maxPerQuery ?? 20);
  const includeUnjudged = options.includeUnjudged ?? false;
  const before = positionMap(baseline);
  const after = positionMap(candidate);

  const rows: DocumentMovement[] = [];
  const ids = new Set<string>([...before.keys(), ...after.keys()]);

  for (const documentId of ids) {
    const left = before.get(documentId);
    const right = after.get(documentId);
    if (!left && !right) continue;
    const grade = grades.get(documentId);
    const baselineRank = left?.rank ?? null;
    const candidateRank = right?.rank ?? null;
    const deltaPositions =
      baselineRank !== null && candidateRank !== null ? baselineRank - candidateRank : null;
    rows.push({
      documentId,
      url: (right?.doc ?? left!.doc).url,
      title: (right?.doc ?? left!.doc).title,
      relevance: grade ?? null,
      baselineRank,
      candidateRank,
      deltaPositions,
      movement: movementKind(deltaPositions, baselineRank, candidateRank),
    });
  }

  const unjudgedChanges = rows.filter((row) => row.relevance === null && row.movement !== "same");
  const judgedChanges = rows.filter((row) => row.relevance !== null && row.movement !== "same");

  const sortRows = (a: DocumentMovement, b: DocumentMovement): number => {
    const aMagnitude = a.deltaPositions === null ? Number.POSITIVE_INFINITY : Math.abs(a.deltaPositions);
    const bMagnitude = b.deltaPositions === null ? Number.POSITIVE_INFINITY : Math.abs(b.deltaPositions);
    if (aMagnitude !== bMagnitude) return bMagnitude - aMagnitude;
    const enterOrder = (row: DocumentMovement): number => (row.movement === "entered" || row.movement === "exited" ? 0 : 1);
    if (enterOrder(a) !== enterOrder(b)) return enterOrder(a) - enterOrder(b);
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  };

  judgedChanges.sort(sortRows);
  const keptJudged = judgedChanges.slice(0, maxPerQuery);
  const truncatedCount = Math.max(0, judgedChanges.length - keptJudged.length);

  const visible = includeUnjudged
    ? [...keptJudged, ...unjudgedChanges.slice(0, maxPerQuery)].sort(sortRows)
    : keptJudged;

  return {
    queryId,
    category,
    rows: visible,
    changedCount: judgedChanges.length,
    hiddenUnjudgedMovements: includeUnjudged ? 0 : unjudgedChanges.length,
    truncatedCount,
  };
}
