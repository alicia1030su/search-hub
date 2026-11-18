import { MIN_SAMPLE, mean, round } from "./primitives.js";
import { aggregateMetric, type AggregateMetric } from "./metrics.js";
import type {
  ComparisonRow,
  ComparisonSummary,
  QueryMetrics,
  QuerySnapshot,
  RankedList,
  RelevanceGrade,
} from "./types.js";

/** Smallest mean difference that may be called a change rather than noise. */
export const MIN_EFFECT = 0.01;

export interface JudgedQuery {
  queryId: string;
  query: string;
  category: string;
  /**
   * Every label this query carries, primary first.
   *
   * Optional so an existing caller that only knows the primary label keeps
   * compiling; `compareRankings` does not read it.
   */
  categories?: readonly string[];
  grades: Map<string, RelevanceGrade>;
  relevantTotal: number | null;
}

/**
 * Compares two ranked lists over the same queries.
 *
 * The comparison is only allowed to declare a winner when there is enough
 * measured evidence: enough comparable queries, and a mean difference above
 * {@link MIN_EFFECT}. Otherwise it says `insufficient_evidence`, which is a
 * result, not a failure.
 */
export function compareRankings(input: {
  metric: AggregateMetric;
  baseline: readonly RankedList[];
  candidate: readonly RankedList[];
  judgments: readonly JudgedQuery[];
  metricsFor: (ranked: RankedList, judged: JudgedQuery) => QueryMetrics;
  minSample?: number;
}): ComparisonSummary {
  const minSample = input.minSample ?? MIN_SAMPLE;
  const byQuery = new Map(input.judgments.map((item) => [item.queryId, item]));

  const baselineMetrics: QueryMetrics[] = [];
  const candidateMetrics: QueryMetrics[] = [];
  const rows: ComparisonRow[] = [];

  const candidateByQuery = new Map(input.candidate.map((item) => [item.queryId, item]));
  const seen = new Set<string>();

  for (const ranked of input.baseline) {
    const judged = byQuery.get(ranked.queryId);
    const other = candidateByQuery.get(ranked.queryId);
    if (!judged || !other) continue;
    seen.add(ranked.queryId);

    const base = input.metricsFor(ranked, judged);
    const cand = input.metricsFor(other, judged);
    baselineMetrics.push(base);
    candidateMetrics.push(cand);

    const baseValue = base[input.metric].value;
    const candValue = cand[input.metric].value;
    const comparable = baseValue !== null && candValue !== null;
    const delta = comparable ? round(candValue - baseValue) : null;
    rows.push({
      queryId: ranked.queryId,
      query: judged.query,
      category: judged.category as ComparisonRow["category"],
      baseline: baseValue,
      candidate: candValue,
      delta,
      verdict:
        delta === null
          ? "not_comparable"
          : delta > 0
            ? "improved"
            : delta < 0
              ? "degraded"
              : "unchanged",
    });
  }

  // A query only one side ran is not a comparison; say so instead of skipping
  // it silently.
  for (const judged of input.judgments) {
    if (seen.has(judged.queryId)) continue;
    const missing = !candidateByQuery.has(judged.queryId);
    if (!missing) continue;
    rows.push({
      queryId: judged.queryId,
      query: judged.query,
      category: judged.category as ComparisonRow["category"],
      baseline: null,
      candidate: null,
      delta: null,
      verdict: "not_comparable",
    });
  }

  const baselineAgg = aggregateMetric(baselineMetrics, input.metric);
  const candidateAgg = aggregateMetric(candidateMetrics, input.metric);

  const comparableRows = rows.filter((row) => row.delta !== null);
  const deltas = comparableRows.map((row) => row.delta!);
  const meanDelta = mean(deltas);

  if (baselineAgg.value === null || candidateAgg.value === null || deltas.length < minSample) {
    return {
      metric: input.metric,
      baseline: baselineAgg,
      candidate: candidateAgg,
      absoluteDelta: null,
      relativeDelta: null,
      improved: rows.filter((row) => row.verdict === "improved"),
      degraded: rows.filter((row) => row.verdict === "degraded"),
      comparableQueries: deltas.length,
      verdict: "insufficient_evidence",
      reason:
        baselineAgg.status === "na"
          ? "the baseline has no measured value for this metric"
          : candidateAgg.status === "na"
            ? "the candidate has no measured value for this metric"
            : `only ${deltas.length} comparable queries; at least ${minSample} are required`,
    };
  }

  const absoluteDelta = round(candidateAgg.value - baselineAgg.value);
  const relativeDelta =
    baselineAgg.value === 0 ? null : round((candidateAgg.value - baselineAgg.value) / baselineAgg.value);

  const verdict: ComparisonSummary["verdict"] =
    meanDelta !== null && Math.abs(meanDelta) >= MIN_EFFECT
      ? meanDelta > 0
        ? "candidate_better"
        : "baseline_better"
      : "no_difference";

  return {
    metric: input.metric,
    baseline: baselineAgg,
    candidate: candidateAgg,
    absoluteDelta,
    relativeDelta,
    improved: rows.filter((row) => row.verdict === "improved"),
    degraded: rows.filter((row) => row.verdict === "degraded"),
    comparableQueries: deltas.length,
    verdict,
    ...(verdict === "no_difference"
      ? { reason: `mean difference is below the ${MIN_EFFECT} threshold` }
      : {}),
  };
}

/** Convenience: build a lookup of snapshots by query id. */
export function indexSnapshots(snapshots: readonly QuerySnapshot[]): Map<string, QuerySnapshot> {
  return new Map(snapshots.map((snapshot) => [snapshot.queryId, snapshot]));
}
