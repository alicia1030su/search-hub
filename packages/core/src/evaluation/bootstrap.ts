import { percentile } from "./primitives.js";
import type { JudgmentSource, MetricValue, QueryMetrics } from "./types.js";

export const BOOTSTRAP_SEED = 118;
export const BOOTSTRAP_ITERATIONS = 10_000;
export const BOOTSTRAP_CI = 0.95;
export const MIN_PAIRED_QUERIES = 24;
export const MIN_CATEGORY_QUERIES = 8;
export const MIN_STRATUM_QUERIES = 4;
export const MAX_ATTRITION = 0.2;

export type BootstrapMetric = "ndcgAtK" | "mrrAtK" | "precisionAtK" | "recallAtK";
export const BOOTSTRAP_METRICS: readonly BootstrapMetric[] = ["ndcgAtK", "mrrAtK", "precisionAtK", "recallAtK"];
const RELEASE_METRICS: readonly BootstrapMetric[] = ["ndcgAtK", "mrrAtK", "precisionAtK"];

/** Deterministic 32-bit PRNG specified by PRD B8. */
export function mulberry32(seed: number = BOOTSTRAP_SEED): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PairedSideMetrics {
  ndcgAtK: number | null;
  mrrAtK: number | null;
  precisionAtK: number | null;
  recallAtK: number | null;
  returnedCount: number;
  provisional?: boolean;
  /** Recall remains N/A unless the entire qrel set is exhaustive. */
  judgmentsComplete?: boolean;
}

export interface PairedQuerySample {
  queryId: string;
  language: string;
  category: string;
  judgmentSource: JudgmentSource;
  baseline: PairedSideMetrics | QueryMetrics;
  candidate: PairedSideMetrics | QueryMetrics;
  status?: "ok" | "failed" | "timeout" | "budget_exhausted" | "cancelled";
  failure?: string;
  provisional?: boolean;
  judgmentsComplete?: boolean;
  exclusionReason?: string;
}

export interface QueryExclusion {
  queryId: string;
  reasons: string[];
}

export interface StratumSummary {
  language: string;
  category: string;
  frozenN: number;
  pairedN: number;
}

export interface ConfidenceInterval {
  lower: number | null;
  upper: number | null;
}

export interface BootstrapMetricResult {
  pairedN: number;
  baselineMean: number | null;
  candidateMean: number | null;
  delta: number | null;
  deltaCi: ConfidenceInterval;
  baselineCi: ConfidenceInterval;
  candidateCi: ConfidenceInterval;
  sufficient: boolean;
}

export type EvidenceVerdict = "SUPPORTED" | "INSUFFICIENT_EVIDENCE";

export interface PairedStratifiedBootstrapResult {
  protocol: { seed: number; iterations: number; ci: number; method: "paired_stratified_percentile"; bca: false };
  verdict: EvidenceVerdict;
  reasons: string[];
  expectedPairs: number;
  pairedN: number;
  excludedN: number;
  attrition: number;
  exclusions: QueryExclusion[];
  strata: StratumSummary[];
  observed: Record<BootstrapMetric, BootstrapMetricResult | null>;
  releaseScore: Record<BootstrapMetric, BootstrapMetricResult | null>;
}

export interface PairedStratifiedBootstrapOptions {
  pairs: readonly PairedQuerySample[];
  metric: BootstrapMetric;
  iterations?: number;
  seed?: number;
}

export interface PairedStratifiedBootstrapSummary {
  metric: BootstrapMetric;
  status: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  observed: BootstrapMetricResult;
  releaseScore: BootstrapMetricResult;
  delta: number | null;
  ci95: ConfidenceInterval;
  strata: StratumSummary[];
  expectedPairs: number;
  pairedN: number;
  excludedN: number;
  attrition: number;
  exclusions: QueryExclusion[];
  reasons: string[];
  protocol: PairedStratifiedBootstrapResult["protocol"];
}

interface CohortRow {
  queryId: string;
  language: string;
  category: string;
  baseline: number;
  candidate: number;
}

function strataFor(rows: readonly CohortRow[]): Array<{ key: string; language: string; category: string; rows: CohortRow[] }> {
  const strata = new Map<string, { key: string; language: string; category: string; rows: CohortRow[] }>();
  for (const row of rows) {
    const key = JSON.stringify([row.language, row.category]);
    const stratum = strata.get(key) ?? { key, language: row.language, category: row.category, rows: [] };
    stratum.rows.push(row);
    strata.set(key, stratum);
  }
  return [...strata.values()]
    .sort((left, right) => left.language.localeCompare(right.language) || left.category.localeCompare(right.category))
    .map((stratum) => ({ ...stratum, rows: [...stratum.rows].sort((left, right) => left.queryId.localeCompare(right.queryId)) }));
}

function scoreCohort(
  rows: readonly CohortRow[],
  expectedStrata: readonly StratumSummary[],
  expectedCategories: ReadonlyMap<string, number>,
): { result: BootstrapMetricResult | null; insufficient: string[] } {
  if (rows.length < MIN_PAIRED_QUERIES) {
    return { result: { pairedN: rows.length, baselineMean: null, candidateMean: null, delta: null, baselineCi: { lower: null, upper: null }, candidateCi: { lower: null, upper: null }, deltaCi: { lower: null, upper: null }, sufficient: false }, insufficient: ["pairedN<24"] };
  }
  const strata = strataFor(rows);
  if (strata.some((stratum) => stratum.rows.length < MIN_STRATUM_QUERIES)) {
    return { result: { pairedN: rows.length, baselineMean: null, candidateMean: null, delta: null, baselineCi: { lower: null, upper: null }, candidateCi: { lower: null, upper: null }, deltaCi: { lower: null, upper: null }, sufficient: false }, insufficient: ["stratum<4"] };
  }
  const insufficient: string[] = [];
  for (const [category, frozenN] of expectedCategories) {
    if (frozenN > 0 && rows.filter((row) => row.category === category).length < MIN_CATEGORY_QUERIES) {
      insufficient.push(`category:${category}<8`);
    }
  }
  const frozenWeights = new Map(expectedStrata.map((stratum) => [JSON.stringify([stratum.language, stratum.category]), stratum.frozenN]));
  const weights = new Map(strata.map((stratum) => [stratum.key, frozenWeights.get(stratum.key) ?? 0]));
  if ([...weights.values()].some((weight) => weight <= 0)) {
    return { result: { pairedN: rows.length, baselineMean: null, candidateMean: null, delta: null, baselineCi: { lower: null, upper: null }, candidateCi: { lower: null, upper: null }, deltaCi: { lower: null, upper: null }, sufficient: false }, insufficient: ["unknown_stratum"] };
  }
  const weightTotal = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const baseline = strata.reduce((sum, stratum) => sum + (stratum.rows.reduce((value, row) => value + row.baseline, 0) / stratum.rows.length) * (weights.get(stratum.key)! / weightTotal), 0);
  const candidate = strata.reduce((sum, stratum) => sum + (stratum.rows.reduce((value, row) => value + row.candidate, 0) / stratum.rows.length) * (weights.get(stratum.key)! / weightTotal), 0);

  const random = mulberry32(BOOTSTRAP_SEED);
  const baselineValues: number[] = [];
  const candidateValues: number[] = [];
  const deltaValues: number[] = [];
  for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
    let resampledBaseline = 0;
    let resampledCandidate = 0;
    // PRD B8: one instance per run, iteration outer loop, sorted strata inner loop.
    for (const stratum of strata) {
      let baselineSum = 0;
      let candidateSum = 0;
      for (let index = 0; index < stratum.rows.length; index += 1) {
        const row = stratum.rows[Math.floor(random() * stratum.rows.length)]!;
        baselineSum += row.baseline;
        candidateSum += row.candidate;
      }
      resampledBaseline += (baselineSum / stratum.rows.length) * (weights.get(stratum.key)! / weightTotal);
      resampledCandidate += (candidateSum / stratum.rows.length) * (weights.get(stratum.key)! / weightTotal);
    }
    baselineValues.push(resampledBaseline);
    candidateValues.push(resampledCandidate);
    deltaValues.push(resampledCandidate - resampledBaseline);
  }
  baselineValues.sort((left, right) => left - right);
  candidateValues.sort((left, right) => left - right);
  deltaValues.sort((left, right) => left - right);
  const interval = (values: number[]): ConfidenceInterval => ({
    lower: percentile(values, 0.025),
    upper: percentile(values, 0.975),
  });
  return {
    result: {
      pairedN: rows.length,
      baselineMean: baseline,
      candidateMean: candidate,
      delta: candidate - baseline,
      baselineCi: interval(baselineValues),
      candidateCi: interval(candidateValues),
      deltaCi: interval(deltaValues),
      sufficient: insufficient.length === 0,
    },
    insufficient,
  };
}

type NormalizedPair = PairedQuerySample & { baseline: PairedSideMetrics; candidate: PairedSideMetrics };

function normalizePair(sample: PairedQuerySample): NormalizedPair {
  const normalizeSide = (side: PairedSideMetrics | QueryMetrics): PairedSideMetrics => {
    const number = (value: number | null | MetricValue): number | null =>
      typeof value === "number" || value === null ? value : value.value;
    return {
      ndcgAtK: number(side.ndcgAtK),
      mrrAtK: number(side.mrrAtK),
      precisionAtK: number(side.precisionAtK),
      recallAtK: number(side.recallAtK),
      returnedCount: side.returnedCount,
      provisional: side.provisional || sample.provisional,
      judgmentsComplete: sample.judgmentsComplete ?? (side as PairedSideMetrics).judgmentsComplete,
    };
  };
  return {
    ...sample,
    status: sample.status ?? (sample.failure ? "failed" : sample.provisional ? "ok" : sample.status),
    exclusionReason: sample.exclusionReason ?? sample.failure,
    baseline: normalizeSide(sample.baseline),
    candidate: normalizeSide(sample.candidate),
  };
}

function metricValue(sample: NormalizedPair, side: "baseline" | "candidate", metric: BootstrapMetric, release: boolean): number | null {
  const value = sample[side];
  if (value.provisional) return null;
  if (value.judgmentsComplete === false && metric === "recallAtK") return null;
  if (release && RELEASE_METRICS.includes(metric) && value.returnedCount === 0) return 0;
  return value[metric];
}

/**
 * Paired, language × category stratified bootstrap. Missing/provisional queries
 * never become zeros; empty results become zeros only in the releaseScore lens.
 */
function bootstrapAllMetrics(
  inputSamples: readonly PairedQuerySample[],
  options: { iterations?: number; seed?: number; metric?: BootstrapMetric } = {},
): PairedStratifiedBootstrapResult {
  if (options.iterations !== undefined && options.iterations !== BOOTSTRAP_ITERATIONS) {
    throw new TypeError("PRD B8 requires exactly 10,000 bootstrap iterations");
  }
  if (options.seed !== undefined && options.seed !== BOOTSTRAP_SEED) {
    throw new TypeError("PRD B8 requires seed 118");
  }
  const samples = inputSamples.map(normalizePair);
  const frozen = [...samples].sort((left, right) => left.queryId.localeCompare(right.queryId));
  if (new Set(frozen.map((sample) => sample.queryId)).size !== frozen.length) {
    throw new TypeError("pairedStratifiedBootstrap requires unique queryIds");
  }
  const exclusions: QueryExclusion[] = [];
  const eligible: NormalizedPair[] = [];
  for (const sample of frozen) {
    const reasons: string[] = [];
    if (sample.exclusionReason) reasons.push(sample.exclusionReason);
    if (sample.status && sample.status !== "ok") reasons.push(sample.status);
    if (sample.judgmentSource !== "human") reasons.push("no_human_judgments");
    if (sample.baseline.provisional || sample.candidate.provisional) reasons.push("provisional");
    for (const metric of RELEASE_METRICS) {
      if ((sample.baseline[metric] === null && sample.baseline.returnedCount !== 0) ||
          (sample.candidate[metric] === null && sample.candidate.returnedCount !== 0)) {
        reasons.push(`missing_metric:${metric}`);
      }
    }
    if (sample.baseline.returnedCount < 0 || sample.candidate.returnedCount < 0) reasons.push("invalid_returned_count");
    if (reasons.length > 0) {
      exclusions.push({ queryId: sample.queryId, reasons: [...new Set(reasons)] });
    } else {
      eligible.push(sample);
    }
  }

  const strata = strataFor(frozen.map((sample) => ({
    queryId: sample.queryId,
    language: sample.language,
    category: sample.category,
    baseline: 0,
    candidate: 0,
  }))).map((stratum) => ({
    language: stratum.language,
    category: stratum.category,
    frozenN: stratum.rows.length,
    pairedN: eligible.filter((sample) => sample.language === stratum.language && sample.category === stratum.category).length,
  }));
  const expectedCategories = new Map<string, number>();
  for (const sample of frozen) expectedCategories.set(sample.category, (expectedCategories.get(sample.category) ?? 0) + 1);
  const expectedPairs = frozen.length;
  const pairedN = eligible.length;
  const excludedN = exclusions.length;
  const attrition = expectedPairs === 0 ? 1 : excludedN / expectedPairs;
  const reasons: string[] = [];
  if (attrition > MAX_ATTRITION) reasons.push("attrition>20%");
  if (pairedN < MIN_PAIRED_QUERIES) reasons.push("pairedN<24");
  for (const stratum of strata) if (stratum.pairedN < MIN_STRATUM_QUERIES) reasons.push(`stratum:${stratum.language}/${stratum.category}<4`);

  const observed = Object.fromEntries(BOOTSTRAP_METRICS.map((metric) => [metric, null])) as Record<BootstrapMetric, BootstrapMetricResult | null>;
  const releaseScore = Object.fromEntries(BOOTSTRAP_METRICS.map((metric) => [metric, null])) as Record<BootstrapMetric, BootstrapMetricResult | null>;
  const scoreReasons = new Set<string>();
  for (const [lens, release] of [["observed", false], ["releaseScore", true]] as const) {
    for (const metric of BOOTSTRAP_METRICS) {
      if (options.metric && options.metric !== metric) continue;
      const rows: CohortRow[] = [];
      for (const sample of eligible) {
        const baseline = metricValue(sample, "baseline", metric, release);
        const candidate = metricValue(sample, "candidate", metric, release);
        if (baseline === null || candidate === null || !Number.isFinite(baseline) || !Number.isFinite(candidate)) continue;
        rows.push({ queryId: sample.queryId, language: sample.language, category: sample.category, baseline, candidate });
      }
      const scored = scoreCohort(rows, strata, expectedCategories);
      (lens === "observed" ? observed : releaseScore)[metric] = scored.result;
      if (metric !== "recallAtK") {
        for (const reason of scored.insufficient) scoreReasons.add(`${lens}:${metric}:${reason}`);
      }
    }
  }
  reasons.push(...scoreReasons);
  const observedNdcg = observed.ndcgAtK;
  const releaseNdcg = releaseScore.ndcgAtK;
  const observedMrr = observed.mrrAtK;
  const releaseMrr = releaseScore.mrrAtK;
  const supported = Boolean(
    reasons.length === 0 && observedNdcg?.sufficient && releaseNdcg?.sufficient &&
    (!observedMrr || observedMrr.sufficient) && (!releaseMrr || releaseMrr.sufficient) &&
    observedNdcg.deltaCi.lower !== null && observedNdcg.deltaCi.lower > 0 &&
    releaseNdcg.deltaCi.lower !== null && releaseNdcg.deltaCi.lower > 0 &&
    (!observedMrr || (observedMrr.delta !== null && observedMrr.delta >= -0.01)) &&
    (!releaseMrr || (releaseMrr.delta !== null && releaseMrr.delta >= -0.01)) &&
    observedNdcg.delta !== null && observedNdcg.delta > 0 && releaseNdcg.delta !== null && releaseNdcg.delta > 0,
  );
  if (reasons.length === 0 && !supported) reasons.push("improvement_not_confirmed_in_both_lenses");

  return {
    protocol: { seed: BOOTSTRAP_SEED, iterations: BOOTSTRAP_ITERATIONS, ci: BOOTSTRAP_CI, method: "paired_stratified_percentile", bca: false },
    verdict: supported ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    reasons: [...new Set(reasons)],
    expectedPairs,
    pairedN,
    excludedN,
    attrition,
    exclusions,
    strata,
    observed,
    releaseScore,
  };
}

/** Public B8 entry point: one frozen metric per call, with both evidence lenses. */
export function pairedStratifiedBootstrap(options: PairedStratifiedBootstrapOptions): PairedStratifiedBootstrapSummary {
  const result = bootstrapAllMetrics(options.pairs, options);
  const observed = result.observed[options.metric]!;
  const releaseScore = result.releaseScore[options.metric]!;
  const structuralReasons = result.reasons.filter((reason) => reason !== "improvement_not_confirmed_in_both_lenses");
  const sufficient = observed.sufficient && releaseScore.sufficient && result.attrition <= MAX_ATTRITION &&
    result.pairedN >= MIN_PAIRED_QUERIES && structuralReasons.length === 0 &&
    (options.metric !== "ndcgAtK" || result.verdict === "SUPPORTED");
  return {
    metric: options.metric,
    status: sufficient ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
    observed,
    releaseScore,
    delta: observed.delta,
    ci95: observed.deltaCi,
    strata: result.strata,
    expectedPairs: result.expectedPairs,
    pairedN: result.pairedN,
    excludedN: result.excludedN,
    attrition: result.attrition,
    exclusions: result.exclusions,
    reasons: result.reasons,
    protocol: result.protocol,
  };
}
