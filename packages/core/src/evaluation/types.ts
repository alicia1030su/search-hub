/**
 * Types for the search-quality evaluation lab.
 *
 * The definitions in this file are the contract that the metric engine, the
 * API and the CLI all share. They are deliberately explicit about the things
 * that are easy to get quietly wrong in an IR evaluation:
 *
 *  - an **unjudged** document is not a **non-relevant** document;
 *  - a **synthetic fixture** is not a measurement of a vendor;
 *  - a **missing** qrel set cannot produce a recall figure.
 */

/** Human relevance grade. 0 = off-topic, 3 = fully answers the intent. */
export type RelevanceGrade = 0 | 1 | 2 | 3;

/** A document counts as relevant for binary metrics at this grade or above. */
export const RELEVANT_THRESHOLD: RelevanceGrade = 2;

export const RELEVANCE_GRADES: readonly RelevanceGrade[] = [0, 1, 2, 3];

/**
 * Where a judgment came from. Only `human` may be treated as ground truth.
 *
 * `synthetic_fixture` marks grades written by hand for a fixture whose search
 * results are also fixtures; it validates the machinery, never a vendor.
 */
export type JudgmentSource = "human" | "machine_generated" | "synthetic_fixture";

export type QueryCategory =
  | "general"
  | "chinese"
  | "english"
  | "code"
  | "academic"
  | "news"
  | "documentation"
  | "factual"
  | "multi_hop";

export const QUERY_CATEGORIES: readonly QueryCategory[] = [
  "general",
  "chinese",
  "english",
  "code",
  "academic",
  "news",
  "documentation",
  "factual",
  "multi_hop",
];

/** How a dataset came to exist, which decides what its scores may claim. */
export type DatasetOrigin = "manual" | "imported" | "synthetic_fixture";

export type DatasetStatus = "draft" | "frozen";

export interface QualityDataset {
  id: string;
  name: string;
  description: string;
  language: string;
  /**
   * Monotonic version, bumped by `freeze`. A run always records the version it
   * used, so a later edit cannot silently reinterpret an old score.
   */
  version: number;
  status: DatasetStatus;
  origin: DatasetOrigin;
  /**
   * True only when every document a provider could return has a judgment —
   * which in practice means "the operator says this qrel set is exhaustive for
   * this fixture". Recall is reported as N/A until it is true.
   */
  judgmentsComplete: boolean;
  createdAt: string;
  updatedAt: string;
  frozenAt: string | null;
}

export interface QualityQuery {
  id: string;
  datasetId: string;
  query: string;
  category: QueryCategory;
  language: string;
  /** What the searcher wanted; used by assessors, not by any metric. */
  intent: string;
  notes: string;
  createdAt: string;
}

export interface QualityJudgment {
  id: string;
  datasetId: string;
  queryId: string;
  /** Normalized document identity, not a list position or a row id. */
  documentId: string;
  relevance: RelevanceGrade;
  assessor: string;
  source: JudgmentSource;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A document's identity across runs.
 *
 * `normalizedUrl` is the primary key of a document: the same URL with tracking
 * parameters, a trailing slash or a different scheme case must resolve to the
 * same id. `rawUrl` is kept for audit only.
 */
export interface DocumentIdentity {
  documentId: string;
  normalizedUrl: string;
  rawUrl: string;
}

/** One provider's ordered result list for one query at capture time. */
export interface ProviderSnapshot {
  providerId: string;
  providerName: string;
  providerType: string;
  /** 1-based rank inside this provider's own list. */
  results: Array<{
    documentId: string;
    title: string;
    url: string;
    snippet: string;
    rank: number;
    score?: number;
  }>;
  ok: boolean;
  errorCode?: string;
  latencyMs?: number;
}

/** Everything one query produced: ordered per provider, not yet fused. */
export interface QuerySnapshot {
  queryId: string;
  query: string;
  category: QueryCategory;
  /** One entry per provider that was asked, whether it failed or not. */
  providers: ProviderSnapshot[];
  capturedAt: string;
  /** Total upstream HTTP requests this query caused. */
  upstreamRequests: number;
  /** Upstream requests served from a cache instead of a vendor. */
  cacheHits: number;
}

export type FusionStrategy = "single" | "base" | "rrf";

export interface FusionParameters {
  strategy: FusionStrategy;
  /** RRF constant; ignored unless strategy is `rrf`. */
  k?: number;
  /** Per-provider multiplicative weight; defaults to 1 for everyone. */
  providerWeights?: Record<string, number>;
  /** Only meaningful for `single`: which provider to use. */
  providerId?: string;
}

/** A ranked list produced by applying a fusion strategy to a snapshot. */
export interface RankedList {
  queryId: string;
  documents: Array<{ documentId: string; url: string; title: string }>;
  fusion: FusionParameters;
}

/**
 * How an unjudged document is treated inside a metric.
 *
 * `exclude` is the default and the honest choice: an unjudged document is
 * removed from the ranking rather than being scored as irrelevant, and the
 * result is marked provisional. `as_zero` exists so an operator can see how
 * sensitive a conclusion is to missing judgments — it is never the headline
 * number.
 */
export type UnjudgedPolicy = "exclude" | "as_zero";

export interface QueryJudgments {
  queryId: string;
  /** Judged documents only. A document absent from this map is unjudged. */
  grades: Map<string, RelevanceGrade>;
  /**
   * Number of documents the qrels call relevant. `null` when the judgment set
   * is not complete, which makes recall unknowable rather than zero.
   */
  relevantTotal: number | null;
}

export type MetricName =
  | "precisionAtK"
  | "recallAtK"
  | "mrrAtK"
  | "ndcgAtK"
  | "duplicateRate"
  | "uniqueDomainCount"
  | "providerCoverage"
  | "sourceDiversity"
  | "resultCount"
  | "emptyResultRate"
  | "failedQueryRate"
  | "partialQueryRate";

/** Why a metric could not be computed. These reach the UI verbatim. */
export type MetricNaReason =
  | "no_results"
  | "no_judgments"
  | "qrels_incomplete"
  | "no_relevant_documents"
  | "not_applicable";

export interface MetricValue {
  /** Numeric value, or `null` when the metric is genuinely not computable. */
  value: number | null;
  /** `na` means "cannot be computed", never "zero". */
  status: "ok" | "na";
  reason?: MetricNaReason;
  /** How many queries (or samples) produced the number. */
  sampleSize: number;
  /** Queries dropped from the headline because their judgments are incomplete. */
  provisionalCount: number;
  /** True when the sample is too small to support a comparative claim. */
  lowSample: boolean;
}

export interface QueryMetrics {
  queryId: string;
  /** Number of judged documents inside the ranked list. */
  judgedCount: number;
  unjudgedCount: number;
  /** Length of the ranked list considered for @k metrics. */
  returnedCount: number;
  /** Unjudged documents were removed before scoring. */
  provisional: boolean;
  precisionAtK: MetricValue;
  recallAtK: MetricValue;
  mrrAtK: MetricValue;
  ndcgAtK: MetricValue;
}

export interface LatencyStats {
  count: number;
  p50: number | null;
  p95: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Below this many samples a percentile is indicative, not measured. */
  lowSample: boolean;
}

/**
 * What one run actually spent, in the three units that differ from each other.
 *
 * They are kept apart because conflating them is how a budget silently fails:
 * one search over three providers may be 3 adapter attempts and 7 HTTP requests,
 * and the vendor bills the second number.
 */
export interface CostSummary {
  /**
   * Upstream HTTP requests issued.
   *
   * Before v0.1.9 this counted adapter attempts, which under-reported every
   * paginated provider. `httpRequests` is the same number under its real name.
   */
  requests: number;
  /** Logical searches the caller asked for (one per query × provider set). */
  logicalSearches: number;
  /** Adapter invocations, retries included. This is what the key scheduler meters. */
  adapterAttempts: number;
  /** Physical HTTP requests: pages, retries and redirect hops. */
  httpRequests: number;
  /**
   * What the vendor will invoice, or `null` when it cannot be known.
   *
   * Search vendors bill by request, by result, by search, or by a plan quota;
   * without the operator's contract this is unknowable, and `null` says so
   * instead of pretending the request count is the bill.
   */
  billableUnits: number | null;
  /** Requests answered from cache, which cost nothing upstream. */
  cacheHits: number;
  /** Costs the operator has configured for these providers, when known. */
  knownCost: number | null;
  /** Known plus estimated, when every provider has a price. */
  estimatedCost: number | null;
  /** True when at least one provider has no price, so no total may be claimed. */
  unknownCost: boolean;
}

/** A run's immutable record of what it measured and against what. */
export interface QualityRunContext {
  runId: string;
  datasetId: string;
  datasetVersion: number;
  /** Dataset origin decides what the numbers may be called. */
  datasetOrigin: DatasetOrigin;
  mode: "offline" | "live";
  fusion: FusionParameters;
  limit: number;
  /** Commit and engine version make a regression attributable. */
  codeCommit: string | null;
  engineVersion: string;
  startedAt: string;
  finishedAt: string | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
}

export interface ComparisonRow {
  queryId: string;
  query: string;
  category: QueryCategory;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  verdict: "improved" | "degraded" | "unchanged" | "not_comparable";
}

export interface ComparisonSummary {
  metric: "ndcgAtK" | "mrrAtK" | "precisionAtK" | "recallAtK";
  baseline: MetricValue;
  candidate: MetricValue;
  absoluteDelta: number | null;
  relativeDelta: number | null;
  improved: ComparisonRow[];
  degraded: ComparisonRow[];
  comparableQueries: number;
  /**
   * `insufficient_evidence` is a first-class verdict: it is what a comparison
   * with too few queries or too many unjudged documents must say instead of
   * declaring a winner.
   */
  verdict: "candidate_better" | "baseline_better" | "no_difference" | "insufficient_evidence";
  reason?: string;
}
