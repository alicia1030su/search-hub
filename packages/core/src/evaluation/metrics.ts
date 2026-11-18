import {
  DEFAULT_CUTOFF,
  DEFAULT_RELEVANCE_THRESHOLD,
  MIN_SAMPLE,
  applyUnjudgedPolicy,
  assertFinite,
  dcg,
  idcg,
  mean,
  reciprocalRank,
  round,
} from "./primitives.js";
import type {
  MetricNaReason,
  MetricValue,
  QueryJudgments,
  QueryMetrics,
  RelevanceGrade,
  UnjudgedPolicy,
} from "./types.js";

export interface QueryMetricOptions {
  cutoff?: number;
  relevanceThreshold?: RelevanceGrade;
  unjudgedPolicy?: UnjudgedPolicy;
  /** Set by the dataset: recall is N/A unless the qrels are exhaustive. */
  judgmentsComplete?: boolean;
}

function na(reason: MetricNaReason, sampleSize = 0, provisionalCount = 0): MetricValue {
  return { value: null, status: "na", reason, sampleSize, provisionalCount, lowSample: false };
}

function ok(value: number, sampleSize: number, provisionalCount: number): MetricValue {
  return {
    value: round(assertFinite(value, "value")),
    status: "ok",
    sampleSize,
    provisionalCount,
    lowSample: sampleSize < MIN_SAMPLE,
  };
}

/** Grades of every judged document, used for the ideal DCG denominator. */
function qrelsGrades(judgments: QueryJudgments): RelevanceGrade[] {
  return [...judgments.grades.values()];
}

/**
 * Computes every ranked-retrieval metric for one query.
 *
 * The order of the checks matters. A query with no judgments is N/A, not zero:
 * reporting 0.0 precision because nobody looked at the results is exactly the
 * false precision this module exists to prevent.
 */
export function evaluateQuery(
  ranked: readonly string[],
  judgments: QueryJudgments,
  options: QueryMetricOptions = {},
): QueryMetrics {
  const cutoff = Math.max(1, Math.floor(options.cutoff ?? DEFAULT_CUTOFF));
  const threshold = options.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const policy = options.unjudgedPolicy ?? "exclude";

  const window = applyUnjudgedPolicy(ranked, judgments.grades, policy, cutoff);
  const judgedInWindow = window.window.filter((item) => item.judged).length;
  // Provisional means "the window that produced this number is not fully
  // judged". Unjudged rows below the cutoff cannot change a @k value.
  const provisional = window.unjudgedInWindow.length > 0;

  const base = {
    queryId: judgments.queryId,
    judgedCount: judgedInWindow,
    unjudgedCount: window.unjudged.length,
    returnedCount: window.effectiveLength,
    provisional,
  };

  if (window.window.length === 0) {
    // Distinguish "the run returned nothing" from "everything in the window is
    // unjudged" — the two need different fixes from the operator.
    const reason: MetricNaReason =
      ranked.length === 0
        ? "no_results"
        : window.unjudgedInWindow.length > 0
          ? "no_judgments"
          : "not_applicable";
    return {
      ...base,
      precisionAtK: na(reason),
      recallAtK: na(reason),
      mrrAtK: na(reason),
      ndcgAtK: na(reason),
    };
  }

  const grades = window.window.map((item) => item.grade);

  // P@k keeps the cutoff as a fixed denominator: a short result list scores
  // lower, it does not get rescaled to a perfect score.
  const relevantInWindow = grades.filter((grade) => grade >= threshold).length;
  const precisionAtK = ok(relevantInWindow / cutoff, 1, provisional ? 1 : 0);

  // Recall needs a denominator that actually means something.
  let recallAtK: MetricValue;
  if (judgments.relevantTotal === null || options.judgmentsComplete === false) {
    recallAtK = na("qrels_incomplete", 1, provisional ? 1 : 0);
  } else if (judgments.relevantTotal === 0) {
    recallAtK = na("no_relevant_documents", 1, provisional ? 1 : 0);
  } else {
    recallAtK = ok(
      Math.min(1, relevantInWindow / judgments.relevantTotal),
      1,
      provisional ? 1 : 0,
    );
  }

  const mrrAtK = ok(reciprocalRank(grades, threshold), 1, provisional ? 1 : 0);

  const ideal = idcg(qrelsGrades(judgments), cutoff);
  const ndcgAtK =
    ideal === 0
      ? // Every judged document is grade 0: there is no ideal ranking to
        // normalise against, so nDCG has no meaning for this query.
        na("no_relevant_documents", 1, provisional ? 1 : 0)
      : ok(dcg(grades, cutoff) / ideal, 1, provisional ? 1 : 0);

  return { ...base, precisionAtK, recallAtK, mrrAtK, ndcgAtK };
}

export type AggregateMetric = "precisionAtK" | "recallAtK" | "mrrAtK" | "ndcgAtK";

/**
 * Averages one metric over many queries.
 *
 * Provisional queries (those with unjudged documents in the top k) are counted
 * but excluded from the headline. If that leaves nothing measured, the result
 * is N/A — never a number built entirely out of assumptions.
 */
export function aggregateMetric(
  perQuery: readonly QueryMetrics[],
  metric: AggregateMetric,
  options: { includeProvisional?: boolean } = {},
): MetricValue {
  const includeProvisional = options.includeProvisional ?? false;
  let provisionalCount = 0;
  const values: number[] = [];

  for (const query of perQuery) {
    const value = query[metric];
    if (query.provisional) {
      provisionalCount += 1;
      if (!includeProvisional) continue;
    }
    if (value.status === "ok" && value.value !== null) values.push(value.value);
  }

  if (values.length === 0) {
    // Say which reason actually applies. "Every query is provisional" and
    // "every query returned nothing" are different problems.
    const reasons = perQuery.map((query) => query[metric].reason).filter((reason): reason is MetricNaReason => reason !== undefined);
    const reason: MetricNaReason =
      provisionalCount > 0 && provisionalCount === perQuery.length
        ? "qrels_incomplete"
        : reasons.length > 0 && reasons.every((item) => item === reasons[0])
          ? reasons[0]!
          : "no_judgments";
    return na(reason, 0, provisionalCount);
  }

  const average = mean(values);
  if (average === null) return na("no_judgments", 0, provisionalCount);
  return ok(average, values.length, provisionalCount);
}
