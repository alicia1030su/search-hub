import type { RelevanceGrade, UnjudgedPolicy } from "./types.js";

/** Fixed denominator for P@k and the default cutoff everywhere else. */
export const DEFAULT_CUTOFF = 10;

/** Documents at or above this grade count as relevant for binary metrics. */
export const DEFAULT_RELEVANCE_THRESHOLD: RelevanceGrade = 2;

/**
 * Accumulates per-query metric values into one headline number.
 *
 * Three rules make the aggregate honest:
 *
 *  1. A query whose judgments are incomplete is **not** silently averaged in.
 *     It is counted in `provisionalCount` and left out of the headline, because
 *     a number that mixes measured and assumed queries cannot be labelled.
 *  2. If every query is provisional, the aggregate is N/A rather than a value
 *     computed entirely from assumptions.
 *  3. `sampleSize` is always reported, and `lowSample` flags a count below
 *     {@link MIN_SAMPLE}. A comparison on three queries must not claim a
 *     conclusion.
 */
export const MIN_SAMPLE = 8;

export function round(value: number, digits = 10): number {
  return Number(value.toFixed(digits));
}

/** Throws rather than returning NaN/Infinity: those must never reach a caller. */
export function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Metric ${label} produced a non-finite value (${String(value)})`);
  }
  return value;
}

export interface JudgedWindow {
  /** Documents considered for @k metrics, after the unjudged policy. */
  window: Array<{ documentId: string; grade: RelevanceGrade; judged: boolean }>;
  /** Documents in the ranked list that have no judgment at all. */
  unjudged: string[];
  /** Length of the ranking after the policy was applied (before the cutoff). */
  effectiveLength: number;
  /** Total documents handed in. */
  rankedCount: number;
}

/**
 * Applies the unjudged-document policy to a ranked list.
 *
 * `exclude` drops unjudged documents so they cannot move a relevant one down.
 * `as_zero` keeps them as grade 0, which is a pessimistic bound rather than a
 * measurement — callers must label the result as provisional either way.
 */
export function applyUnjudgedPolicy(
  ranked: readonly string[],
  grades: ReadonlyMap<string, RelevanceGrade>,
  policy: UnjudgedPolicy,
  cutoff: number,
): JudgedWindow {
  const unjudged: string[] = [];
  const effective: Array<{ documentId: string; grade: RelevanceGrade; judged: boolean }> = [];

  for (const documentId of ranked) {
    const grade = grades.get(documentId);
    if (grade === undefined) {
      unjudged.push(documentId);
      if (policy === "as_zero") {
        effective.push({ documentId, grade: 0, judged: false });
      }
      continue;
    }
    effective.push({ documentId, grade, judged: true });
  }

  return {
    window: effective.slice(0, Math.max(0, cutoff)),
    unjudged,
    effectiveLength: effective.length,
    rankedCount: ranked.length,
  };
}

/** `gain(rel) = 2^rel - 1`, the standard graded gain used by nDCG. */
export function gain(grade: RelevanceGrade): number {
  return 2 ** grade - 1;
}

/** Discount for the 1-based position `i`: `log2(i + 1)`. */
export function discount(position: number): number {
  // Position 1 is guaranteed by callers; a defensive guard keeps log2(1) = 0
  // out of a denominator.
  return Math.log2(Math.max(2, position + 1));
}

/**
 * Discounted cumulative gain over a graded window.
 * `i` is 1-based and the discount is `log2(i + 1)`, so position 1 has no loss.
 */
export function dcg(grades: readonly RelevanceGrade[], cutoff: number): number {
  let total = 0;
  const limit = Math.min(cutoff, grades.length);
  for (let index = 0; index < limit; index += 1) {
    const position = index + 1;
    total += gain(grades[index]!) / discount(position);
  }
  return total;
}

/**
 * Ideal DCG: the same grades sorted descending, truncated to the cutoff.
 *
 * It is computed from the **judgment set**, not from whatever the run happened
 * to return, so a query that missed every relevant document still has a
 * non-zero denominator and scores near zero instead of dividing by zero.
 */
export function idcg(qrelsGrades: readonly RelevanceGrade[], cutoff: number): number {
  const sorted = [...qrelsGrades].sort((a, b) => b - a);
  return dcg(sorted, cutoff);
}

/** `1 / rank` for the first relevant document, 0 when there is none. */
export function reciprocalRank(grades: readonly RelevanceGrade[], threshold: RelevanceGrade): number {
  for (let index = 0; index < grades.length; index += 1) {
    if (grades[index]! >= threshold) return 1 / (index + 1);
  }
  return 0;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Nearest-rank percentile with linear interpolation between neighbours. */
export function percentile(sortedValues: readonly number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const clamped = Math.min(1, Math.max(0, p));
  const position = (sortedValues.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower]!;
  const weight = position - lower;
  return sortedValues[lower]! * (1 - weight) + sortedValues[upper]! * weight;
}
