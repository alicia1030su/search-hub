import { extractDomain } from "@search-hub/shared";
import { MIN_SAMPLE, mean, percentile, round } from "./primitives.js";
import type { CostSummary, LatencyStats, MetricValue } from "./types.js";

/**
 * Quality signals that say nothing about relevance.
 *
 * These are deliberately kept apart from P@k / nDCG: more results, more sources
 * or fewer duplicates is not "better search", and a dashboard that mixes the
 * two invites exactly that conclusion.
 */
export interface ResultSetQuality {
  /** How many documents are in the list. */
  resultCount: number;
  /** Share of documents whose normalized URL appears more than once. */
  duplicateRate: number;
  /** Distinct registrable domains (www. stripped). */
  uniqueDomainCount: number;
  /** Providers that contributed at least one document. */
  providerCoverage: number;
  /**
   * Source diversity = (number of contributing providers) /
   * min(providers asked, documents returned), capped at 1.
   *
   * With one provider it is 1 by definition; it only becomes meaningful as a
   * multi-source signal. It is reported so the denominator is visible instead
   * of hidden inside a blended score.
   */
  sourceDiversity: number;
}

export function resultSetQuality(input: {
  documentUrls: readonly string[];
  providersAsked: number;
  providersContributing: number;
}): ResultSetQuality {
  const urls = input.documentUrls;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const url of urls) {
    if (seen.has(url)) duplicates += 1;
    else seen.add(url);
  }
  const domains = new Set<string>();
  for (const url of seen) {
    const domain = extractDomain(url);
    if (domain) domains.add(domain);
  }
  const denominator = Math.min(
    Math.max(1, input.providersAsked),
    Math.max(1, seen.size),
  );
  const coverage = Math.min(input.providersContributing, denominator);

  return {
    resultCount: seen.size,
    duplicateRate: urls.length === 0 ? 0 : round(duplicates / urls.length),
    uniqueDomainCount: domains.size,
    providerCoverage: input.providersContributing,
    sourceDiversity: round(coverage / denominator),
  };
}

/**
 * Rate of a boolean condition across queries.
 *
 * Reported as N/A when there are no queries at all: "0% of queries failed" and
 * "no queries were run" are very different statements.
 */
export function rateMetric(conditions: readonly boolean[]): MetricValue {
  if (conditions.length === 0) {
    return { value: null, status: "na", reason: "not_applicable", sampleSize: 0, provisionalCount: 0, lowSample: false };
  }
  const hits = conditions.filter(Boolean).length;
  return {
    value: round(hits / conditions.length),
    status: "ok",
    sampleSize: conditions.length,
    provisionalCount: 0,
    lowSample: conditions.length < MIN_SAMPLE,
  };
}

export function meanMetric(values: readonly number[]): MetricValue {
  if (values.length === 0) {
    return { value: null, status: "na", reason: "not_applicable", sampleSize: 0, provisionalCount: 0, lowSample: false };
  }
  const average = mean(values);
  if (average === null) {
    return { value: null, status: "na", reason: "not_applicable", sampleSize: 0, provisionalCount: 0, lowSample: false };
  }
  return {
    value: round(average),
    status: "ok",
    sampleSize: values.length,
    provisionalCount: 0,
    lowSample: values.length < MIN_SAMPLE,
  };
}

/**
 * Latency distribution.
 *
 * Percentiles over a handful of samples are indicative at best, so `lowSample`
 * travels with the numbers and the UI shows it.
 */
export function latencyStats(samples: readonly number[]): LatencyStats {
  const values = samples.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (values.length === 0) {
    return { count: 0, p50: null, p95: null, mean: null, min: null, max: null, lowSample: true };
  }
  const average = mean(values);
  return {
    count: values.length,
    p50: percentile(values, 0.5) === null ? null : round(percentile(values, 0.5)!),
    p95: percentile(values, 0.95) === null ? null : round(percentile(values, 0.95)!),
    mean: average === null ? null : round(average),
    min: round(values[0]!),
    max: round(values[values.length - 1]!),
    lowSample: values.length < MIN_SAMPLE,
  };
}

/**
 * Cost accounting, where "unknown" is a value and not a zero.
 *
 * `unitCosts` is the operator's own price list; a provider missing from it
 * makes the total unknowable, and `unknownCost` says so instead of quietly
 * treating the missing provider as free.
 */
export function costSummary(input: {
  /** Physical upstream requests. */
  requests: number;
  cacheHits: number;
  /** Logical searches the caller asked for. Defaults to the request count. */
  logicalSearches?: number;
  /** Adapter invocations including retries. Defaults to the request count. */
  adapterAttempts?: number;
  /** Per-provider request counts, so each can be priced separately. */
  requestsByProvider?: Readonly<Record<string, number>>;
  unitCosts?: Readonly<Record<string, number>>;
}): CostSummary {
  const byProvider = input.requestsByProvider ?? {};
  const prices = input.unitCosts ?? {};
  const providers = Object.keys(byProvider);

  let known = 0;
  let unknownCost = false;
  for (const providerId of providers) {
    const price = prices[providerId];
    if (price === undefined || !Number.isFinite(price) || price < 0) {
      unknownCost = true;
      continue;
    }
    known += price * (byProvider[providerId] ?? 0);
  }

  // No price list at all: we know the request count and nothing about money.
  const hasAnyPrice = providers.some((providerId) => {
    const price = prices[providerId];
    return price !== undefined && Number.isFinite(price) && price >= 0;
  });

  return {
    requests: input.requests,
    logicalSearches: input.logicalSearches ?? input.requests,
    adapterAttempts: input.adapterAttempts ?? input.requests,
    httpRequests: input.requests,
    // Never derived from the request count: a vendor that bills per search or
    // per result would be misreported, and `null` is the honest answer.
    billableUnits: null,
    cacheHits: input.cacheHits,
    knownCost: hasAnyPrice && !unknownCost ? round(known, 6) : null,
    estimatedCost: unknownCost || !hasAnyPrice ? null : round(known, 6),
    unknownCost: unknownCost || !hasAnyPrice,
  };
}
