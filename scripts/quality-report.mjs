#!/usr/bin/env node
/**
 * Builds auditable v0.1.18 quality reports from frozen qrels and captured runs.
 *
 * Live AB/BA suites and same-snapshot algorithm comparisons are accepted through
 * separate inputs and are never pooled. All ranking metrics and paired bootstrap
 * calculations come from the core evaluation modules; this script only validates
 * evidence, derives operational signals, and renders the result.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BOOTSTRAP_ITERATIONS,
  BOOTSTRAP_SEED,
  MAX_ATTRITION,
  MIN_CATEGORY_QUERIES,
  MIN_PAIRED_QUERIES,
  MIN_STRATUM_QUERIES,
  pairedStratifiedBootstrap,
} from "../packages/core/src/evaluation/bootstrap.ts";
import { aggregateMetric, evaluateQuery } from "../packages/core/src/evaluation/metrics.ts";
import { round } from "../packages/core/src/evaluation/primitives.ts";
import { normalizeUrl } from "../packages/shared/src/url.ts";

const REPORT_FORMAT = "search-hub.quality.report/1";
const LIVE_FORMAT = "search-hub.quality.live/1";
const RANKING_METRICS = ["precisionAtK", "ndcgAtK", "mrrAtK"];
const CUTOFF = 10;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TypeError(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableFingerprint(value) {
  return sha256(canonical(value));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function unique(values) {
  return [...new Set(values)];
}

function mean(values) {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return null;
  return round(present.reduce((sum, value) => sum + value, 0) / present.length);
}

function total(values) {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return null;
  return round(present.reduce((sum, value) => sum + value, 0));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function metricNumber(metric) {
  return metric?.status === "ok" ? finiteNumber(metric.value) : null;
}

function normalizeDocumentId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return normalizeUrl(value) ?? value.trim();
}

/** Validates the frozen real-web query set and converts labels to core judgments. */
export function parseFrozenQueries(input, options = {}) {
  assert(isRecord(input), "queries input must be an object");
  assert(input.frozen === true, "queries input must be frozen");
  assert(Array.isArray(input.queries) && input.queries.length > 0, "queries input must contain queries");
  if (input.queryCount !== undefined) assert(input.queryCount === input.queries.length, "queries.queryCount does not match queries.length");
  if (input.labelCount !== undefined) assert(input.labelCount === input.queries.reduce((sum, query) => sum + (query.labels?.length ?? 0), 0), "queries.labelCount does not match labels.length");
  const queries = [];
  const ids = new Set();
  let labelCount = 0;
  for (const [index, query] of input.queries.entries()) {
    assert(isRecord(query), `queries[${index}] must be an object`);
    assert(typeof query.queryId === "string" && query.queryId, `queries[${index}].queryId is required`);
    assert(!ids.has(query.queryId), `duplicate queryId: ${query.queryId}`);
    ids.add(query.queryId);
    assert(typeof query.query === "string" && query.query.trim(), `query ${query.queryId} needs text`);
    assert(typeof query.category === "string" && query.category, `query ${query.queryId} needs a category`);
    assert(typeof query.language === "string" && query.language, `query ${query.queryId} needs a language`);
    assert(Array.isArray(query.labels) && query.labels.length > 0, `query ${query.queryId} needs labels`);
    const grades = new Map();
    for (const [labelIndex, label] of query.labels.entries()) {
      assert(isRecord(label), `query ${query.queryId} label ${labelIndex} must be an object`);
      assert(Number.isInteger(label.relevance) && label.relevance >= 0 && label.relevance <= 3, `query ${query.queryId} label ${labelIndex} has invalid relevance`);
      assert(label.provisional === false, `query ${query.queryId} label ${labelIndex} is provisional`);
      assert(typeof label.annotator === "string" && label.annotator, `query ${query.queryId} label ${labelIndex} needs an annotator`);
      const documentId = normalizeUrl(label.normalizedUrl);
      assert(documentId, `query ${query.queryId} label ${labelIndex} needs a valid HTTP(S) normalizedUrl`);
      assert(!grades.has(documentId), `query ${query.queryId} has duplicate normalizedUrl: ${documentId}`);
      grades.set(documentId, label.relevance);
      labelCount += 1;
    }
    queries.push({
      queryId: query.queryId,
      query: query.query,
      category: query.category,
      language: query.language,
      stratum: query.stratum ?? `${query.language}:${query.category}`,
      grades,
      // v0.1.18 qrels deliberately cover only selected pages, never all relevant pages.
      relevantTotal: null,
      judgmentsComplete: false,
      judgmentSource: "human",
    });
  }
  return {
    dataset: {
      name: input.name ?? "frozen quality queries",
      version: input.version ?? null,
      origin: input.origin ?? null,
      queryCount: queries.length,
      labelCount,
      judgmentsComplete: false,
      recall: "N/A",
      recallReason: "qrels_incomplete",
      sha256: options.sha256 ?? null,
    },
    queries,
    byQuery: new Map(queries.map((query) => [query.queryId, query])),
  };
}

function rankedDocuments(side) {
  if (Array.isArray(side)) return side;
  if (!isRecord(side)) return [];
  for (const key of ["finalResults", "documents", "results", "ranked", "ranking"]) {
    const value = side[key];
    if (Array.isArray(value)) return value;
    if (isRecord(value) && Array.isArray(value.documents)) return value.documents;
  }
  return [];
}

function documentIds(documents) {
  return documents.map((document) => {
    const value = isRecord(document) ? (document.documentId ?? document.id ?? document.normalizedUrl ?? document.url) : document;
    return normalizeDocumentId(value);
  }).filter((value) => value !== null);
}

function evaluateSide(capture, judgment) {
  const ranked = documentIds(rankedDocuments(capture));
  const metrics = evaluateQuery(ranked, {
    queryId: judgment.queryId,
    grades: judgment.grades,
    relevantTotal: null,
  }, { cutoff: CUTOFF, judgmentsComplete: false });
  return { ranked, metrics };
}

function captureLatency(capture) {
  return {
    firstResultMs: firstNumber(capture?.firstResultLatencyMs, capture?.firstLatencyMs, capture?.ttfbMs),
    totalMs: firstNumber(capture?.latencyMs, capture?.elapsedMs, capture?.totalLatencyMs),
  };
}

function captureUpstreamRequests(capture) {
  const direct = nonNegativeInteger(capture?.upstreamRequests);
  if (direct !== null) return direct;
  const envelope = nonNegativeInteger(capture?.envelope?.upstreamRequests);
  if (envelope !== null) return envelope;
  const rounds = capture?.envelope?.deepRounds;
  if (Array.isArray(rounds)) {
    const values = rounds.map((item) => nonNegativeInteger(item?.httpRequests)).filter((value) => value !== null);
    if (values.length > 0) return values.reduce((sum, value) => sum + value, 0);
  }
  return null;
}

function capturePeakRss(capture, run) {
  const bytes = firstNumber(capture?.peakRssBytes, capture?.envelope?.peakRssBytes, run?.peakRssBytes);
  if (bytes !== null) return bytes;
  const megaBytes = firstNumber(capture?.peakRssMBytes, run?.peakRssMBytes);
  return megaBytes === null ? null : round(megaBytes * 1024 * 1024);
}

function captureFailureReasons(capture, side) {
  if (!isRecord(capture)) return [`missing_${side}`];
  const reasons = [];
  if (capture.ok === false || capture.success === false) reasons.push(`${side}_failed`);
  const status = String(capture.status ?? "").toLowerCase();
  if (["failed", "error", "cancelled", "canceled"].includes(status)) reasons.push(`${side}_failed`);
  if (["timeout", "timed_out", "deadline_exceeded"].includes(status) || capture.timedOut === true) reasons.push(`${side}_timeout`);
  if (status === "budget_exhausted" || capture.budgetExhausted === true || capture.envelope?.deepRounds?.some((item) => item?.budgetExhausted === true)) reasons.push(`${side}_budget_exhausted`);
  const errorText = JSON.stringify([capture.errors, capture.degradations, capture.error]).toLowerCase();
  if (/timeout|timed[_ -]?out|deadline/.test(errorText)) reasons.push(`${side}_timeout`);
  if (/budget[_ -]?exhaust|resource[_ -]?budget[_ -]?exhaust|quota[_ -]?exhaust/.test(errorText)) reasons.push(`${side}_budget_exhausted`);
  if (capture.evidenceComplete === false) reasons.push(`${side}_evidence_incomplete`);
  return unique(reasons);
}

function requestsMatch(baseline, candidate) {
  if (!isRecord(baseline?.request) || !isRecord(candidate?.request)) return false;
  return canonical(baseline.request) === canonical(candidate.request);
}

function liveEvidenceReasons(capture, side) {
  if (!isRecord(capture) || capture.ok === false) return [];
  const reasons = [];
  if (!isRecord(capture.envelope) || !Array.isArray(capture.rawProviderSnapshot) ||
      !isRecord(capture.providerHashes) || Object.keys(capture.providerHashes).length === 0 ||
      typeof capture.responseHash !== "string" || !/^[a-f0-9]{64}$/i.test(capture.responseHash)) {
    reasons.push(`${side}_evidence_incomplete`);
  }
  return reasons;
}

function bootstrapStatusFor(pairs, metric) {
  return pairedStratifiedBootstrap({ pairs, metric, iterations: BOOTSTRAP_ITERATIONS, seed: BOOTSTRAP_SEED });
}

function provenanceFromLive(run, source, sourceSha256) {
  assert(isRecord(run), `${source}: live report must be an object`);
  assert(run.format === LIVE_FORMAT, `${source}: expected format ${LIVE_FORMAT}`);
  assert(Array.isArray(run.pairs), `${source}: live report pairs must be an array`);
  if (run.comparison?.evidenceKind && run.comparison.evidenceKind !== "live_paired_abba") {
    throw new TypeError(`${source}: live comparison has incompatible evidence kind`);
  }
  const captures = run.pairs.flatMap((pair) => [pair?.captures?.baseline, pair?.captures?.candidate]).filter(isRecord);
  const baselineCommits = unique(captures.filter((capture) => capture.implementation === "baseline").map((capture) => capture.commit).filter(Boolean));
  const candidateCommits = unique(captures.filter((capture) => capture.implementation === "candidate").map((capture) => capture.commit).filter(Boolean));
  assert(baselineCommits.length <= 1 && candidateCommits.length <= 1, `${source}: live evidence mixes multiple implementation commits`);
  const commits = unique([...baselineCommits, ...candidateCommits]);
  const baselineConfigs = unique(captures.filter((capture) => capture.implementation === "baseline").map((capture) => capture.configFingerprint).filter(Boolean));
  const candidateConfigs = unique(captures.filter((capture) => capture.implementation === "candidate").map((capture) => capture.configFingerprint).filter(Boolean));
  assert(baselineConfigs.length <= 1 && candidateConfigs.length <= 1, `${source}: live evidence mixes multiple config fingerprints per implementation`);
  const configFingerprints = unique([...baselineConfigs, ...candidateConfigs]);
  const providers = unique(captures.flatMap((capture) => {
    const requested = Array.isArray(capture.request?.providers) ? capture.request.providers : [];
    const observed = Array.isArray(capture.envelope?.providers) ? capture.envelope.providers.map((provider) => provider.providerId) : [];
    return [...requested, ...observed];
  }).filter((value) => typeof value === "string" && value));
  const providerSets = unique(captures.filter((capture) => Array.isArray(capture.request?.providers)).map((capture) => canonical(capture.request.providers)));
  assert(providerSets.length <= 1, `${source}: live evidence mixes provider sets`);
  if (run.startedAt && run.finishedAt) {
    const startedAt = Date.parse(run.startedAt);
    const finishedAt = Date.parse(run.finishedAt);
    assert(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt, `${source}: invalid live run time window`);
    assert(finishedAt - startedAt <= 24 * 60 * 60 * 1000, `${source}: live run exceeded the 24-hour window`);
  }
  return {
    evidenceKind: "live_paired_abba",
    sameSnapshot: false,
    source,
    sourceSha256,
    format: run.format,
    protocol: run.protocol ?? null,
    region: run.region ?? null,
    origin: run.origin ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    manifestHash: run.manifestHash ?? null,
    suiteStatus: run.status ?? null,
    skipReason: run.skipReason ?? null,
    limitations: run.limitations ?? [],
    baselineCommit: baselineCommits[0] ?? null,
    candidateCommit: candidateCommits[0] ?? null,
    baselineConfigFingerprint: baselineConfigs[0] ?? null,
    candidateConfigFingerprint: candidateConfigs[0] ?? null,
    commits,
    configFingerprints,
    providers,
    providerScope: providers.length > 0 ? providers.join(", ") : "N/A",
    peakRssBytes: run.peakRssBytes ?? (run.peakRssMBytes === undefined ? null : round(run.peakRssMBytes * 1024 * 1024)),
  };
}

function sameSnapshotEvidence(pair) {
  if (typeof pair.snapshotHash === "string" && pair.snapshotHash) return pair.snapshotHash;
  const baselineId = pair.baseline?.snapshotHash ?? pair.baseline?.snapshotId;
  const candidateId = pair.candidate?.snapshotHash ?? pair.candidate?.snapshotId;
  if (baselineId && candidateId && baselineId === candidateId) return String(baselineId);
  const baselineHashes = pair.baseline?.providerHashes ?? pair.baseline?.envelope?.providerFingerprints;
  const candidateHashes = pair.candidate?.providerHashes ?? pair.candidate?.envelope?.providerFingerprints;
  const baselineRaw = pair.baseline?.rawProviderSnapshot ?? pair.baseline?.envelope?.providers;
  const candidateRaw = pair.candidate?.rawProviderSnapshot ?? pair.candidate?.envelope?.providers;
  if (isRecord(baselineHashes) && isRecord(candidateHashes) && Object.keys(baselineHashes).length > 0 &&
      canonical(baselineHashes) === canonical(candidateHashes) && canonical(baselineRaw) === canonical(candidateRaw)) {
    return stableFingerprint({ providerHashes: baselineHashes, rawProviderSnapshot: baselineRaw });
  }
  return null;
}

function algorithmPairs(input) {
  if (Array.isArray(input)) return input;
  let pairs;
  if (Array.isArray(input?.pairs)) pairs = input.pairs;
  else if (Array.isArray(input?.snapshots)) pairs = input.snapshots;
  else if (Array.isArray(input?.runs)) pairs = input.runs;
  else if (Array.isArray(input?.baseline) && Array.isArray(input?.candidate)) {
    const baseline = new Map(input.baseline.map((item) => [item.queryId, item]));
    const candidate = new Map(input.candidate.map((item) => [item.queryId, item]));
    pairs = [...new Set([...baseline.keys(), ...candidate.keys()])].map((queryId) => ({
      queryId,
      baseline: baseline.get(queryId),
      candidate: candidate.get(queryId),
    }));
  } else {
    throw new TypeError("algorithm comparison must contain pairs, snapshots, runs, or baseline/candidate arrays");
  }
  return pairs.map((pair) => pair.snapshotHash || !input.snapshotHash ? pair : { ...pair, snapshotHash: input.snapshotHash });
}

function provenanceFromAlgorithm(input, source, sourceSha256) {
  assert(isRecord(input) || Array.isArray(input), `${source}: algorithm comparison must be an object or pair array`);
  assert(!/live/i.test(String(input?.evidenceKind ?? input?.format ?? "")), `${source}: live evidence cannot be used as a same-snapshot algorithm comparison`);
  return {
    evidenceKind: "same_snapshot_algorithm_comparison",
    sameSnapshot: true,
    source,
    sourceSha256,
    format: input.format ?? null,
    suiteStatus: input.status ?? null,
    skipReason: input.skipReason ?? null,
    limitations: input.limitations ?? [],
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    baselineCommit: input.baselineCommit ?? input.baseline?.commit ?? null,
    candidateCommit: input.candidateCommit ?? input.candidate?.commit ?? null,
    baselineConfigFingerprint: input.baselineConfigFingerprint ?? input.baseline?.configFingerprint ?? null,
    candidateConfigFingerprint: input.candidateConfigFingerprint ?? input.candidate?.configFingerprint ?? null,
    configFingerprints: unique([input.baselineConfigFingerprint ?? input.baseline?.configFingerprint, input.candidateConfigFingerprint ?? input.candidate?.configFingerprint]).filter(Boolean),
    providers: unique(input.providers ?? []),
    providerScope: Array.isArray(input.providers) && input.providers.length > 0 ? input.providers.join(", ") : "N/A",
    snapshotIdentity: "required_per_pair",
    peakRssBytes: firstNumber(input.peakRssBytes, input.peakRssMBytes),
  };
}

function livePairs(run) {
  const byQuery = new Map();
  for (const [index, pair] of run.pairs.entries()) {
    assert(isRecord(pair) && typeof pair.queryId === "string" && pair.queryId, `${run.source ?? "live"}: pair ${index} needs queryId`);
    assert(!byQuery.has(pair.queryId), `${run.source ?? "live"}: duplicate queryId ${pair.queryId}`);
    byQuery.set(pair.queryId, pair);
  }
  return byQuery;
}

function buildSuite({ name, evidenceKind, run, source, sourceSha256, dataset, credentialScope }) {
  const isLive = evidenceKind === "live";
  const provenance = isLive ? provenanceFromLive(run, source, sourceSha256) : provenanceFromAlgorithm(run, source, sourceSha256);
  const pairsById = isLive ? livePairs(run) : new Map(algorithmPairs(run).map((pair, index) => {
    assert(isRecord(pair) && typeof pair.queryId === "string" && pair.queryId, `${source}: algorithm pair ${index} needs queryId`);
    return [pair.queryId, pair];
  }));
  assert(pairsById.size === algorithmPairsForSize(run, isLive), `${source}: duplicate queryId in algorithm comparison`);
  const expectedQueryIds = new Set(dataset.queries.map((query) => query.queryId));
  const unexpected = [...pairsById.keys()].filter((queryId) => !expectedQueryIds.has(queryId));
  assert(unexpected.length === 0, `${source}: queries are not in the frozen set: ${unexpected.join(", ")}`);

  const perQuery = [];
  const samples = [];
  for (const judgment of dataset.queries) {
    const pair = pairsById.get(judgment.queryId);
    const baseline = pair?.captures?.baseline ?? pair?.baseline;
    const candidate = pair?.captures?.candidate ?? pair?.candidate;
    const reasons = [];
    if (!pair) reasons.push("missing_pair");
    if (!isLive) {
      const snapshotHash = pair ? sameSnapshotEvidence(pair) : null;
      if (!snapshotHash) reasons.push("snapshot_identity_unverified");
    }
    if (isLive) {
      reasons.push(...captureFailureReasons(baseline, "baseline"));
      reasons.push(...captureFailureReasons(candidate, "candidate"));
      reasons.push(...liveEvidenceReasons(baseline, "baseline"));
      reasons.push(...liveEvidenceReasons(candidate, "candidate"));
      if (!requestsMatch(baseline, candidate)) reasons.push("request_mismatch");
    } else {
      if (!isRecord(baseline) && !Array.isArray(baseline)) reasons.push("missing_baseline");
      if (!isRecord(candidate) && !Array.isArray(candidate)) reasons.push("missing_candidate");
      const baselineStatus = String(baseline?.status ?? "").toLowerCase();
      const candidateStatus = String(candidate?.status ?? "").toLowerCase();
      if (["failed", "error", "timeout", "timed_out", "budget_exhausted", "cancelled"].includes(baselineStatus)) reasons.push(`baseline_${baselineStatus}`);
      if (["failed", "error", "timeout", "timed_out", "budget_exhausted", "cancelled"].includes(candidateStatus)) reasons.push(`candidate_${candidateStatus}`);
    }
    const baselineEvaluation = evaluateSide(baseline ?? {}, judgment);
    const candidateEvaluation = evaluateSide(candidate ?? {}, judgment);
    if (baselineEvaluation.metrics.provisional || candidateEvaluation.metrics.provisional) reasons.push("provisional_unjudged");
    if (baseline?.evidenceComplete === false) reasons.push("baseline_evidence_incomplete");
    if (candidate?.evidenceComplete === false) reasons.push("candidate_evidence_incomplete");
    const exclusionReason = unique(reasons).join(";");
    const sample = {
      queryId: judgment.queryId,
      language: judgment.language,
      category: judgment.category,
      judgmentSource: "human",
      judgmentsComplete: false,
      baseline: baselineEvaluation.metrics,
      candidate: candidateEvaluation.metrics,
      ...(exclusionReason ? { exclusionReason } : {}),
    };
    samples.push(sample);
    perQuery.push({
      queryId: judgment.queryId,
      query: judgment.query,
      language: judgment.language,
      category: judgment.category,
      stratum: judgment.stratum,
      included: exclusionReason.length === 0,
      excludedReasons: unique(reasons),
      baseline: {
        ...baselineEvaluation.metrics,
        finalResultCount: baselineEvaluation.ranked.length,
        duplicateRows: duplicateRows(baselineEvaluation.ranked),
        duplicateRate: duplicateRate(baselineEvaluation.ranked),
        ...captureLatency(baseline),
        upstreamRequests: captureUpstreamRequests(baseline),
        peakRssBytes: capturePeakRss(baseline, run),
      },
      candidate: {
        ...candidateEvaluation.metrics,
        finalResultCount: candidateEvaluation.ranked.length,
        duplicateRows: duplicateRows(candidateEvaluation.ranked),
        duplicateRate: duplicateRate(candidateEvaluation.ranked),
        ...captureLatency(candidate),
        upstreamRequests: captureUpstreamRequests(candidate),
        peakRssBytes: capturePeakRss(candidate, run),
      },
    });
  }

  const metrics = Object.fromEntries(RANKING_METRICS.map((metric) => [metric, bootstrapStatusFor(samples, metric)]));
  const bootstrapExclusions = new Map(metrics.ndcgAtK.exclusions.map((item) => [item.queryId, item.reasons]));
  for (const query of perQuery) {
    const bootstrapReasons = bootstrapExclusions.get(query.queryId) ?? [];
    query.excludedReasons = unique([...query.excludedReasons, ...bootstrapReasons]);
    query.included = query.excludedReasons.length === 0;
  }
  const included = perQuery.filter((query) => query.included);
  const sideSummary = (side) => {
    const sideQueries = included.map((query) => query[side]);
    const finalCounts = sideQueries.map((query) => query.finalResultCount);
    const duplicateRowCount = sideQueries.reduce((sum, query) => sum + query.duplicateRows, 0);
    const resultTotal = finalCounts.reduce((sum, count) => sum + count, 0);
    return {
      precisionAtK: aggregateMetric(sideQueries, "precisionAtK"),
      ndcgAtK: aggregateMetric(sideQueries, "ndcgAtK"),
      mrrAtK: aggregateMetric(sideQueries, "mrrAtK"),
      recallAtK: aggregateMetric(sideQueries, "recallAtK"),
      effectiveResultCount: { mean: mean(sideQueries.map((query) => query.returnedCount)), total: total(sideQueries.map((query) => query.returnedCount)), sampleN: sideQueries.length },
      finalResultCount: { mean: mean(finalCounts), total: total(finalCounts), sampleN: sideQueries.length },
      duplicateRate: ratio(duplicateRowCount, resultTotal),
      firstResultLatencyMs: { mean: mean(sideQueries.map((query) => query.firstResultMs)), sampleN: sideQueries.filter((query) => query.firstResultMs !== null).length },
      totalLatencyMs: { mean: mean(sideQueries.map((query) => query.totalMs)), total: total(sideQueries.map((query) => query.totalMs)), sampleN: sideQueries.filter((query) => query.totalMs !== null).length },
      upstreamRequests: { total: total(sideQueries.map((query) => query.upstreamRequests)), sampleN: sideQueries.filter((query) => query.upstreamRequests !== null).length },
      peakRssBytes: { max: maxNullable(sideQueries.map((query) => query.peakRssBytes)), sampleN: sideQueries.filter((query) => query.peakRssBytes !== null).length },
    };
  };
  const provenanceComplete = Boolean(
    provenance.baselineCommit && provenance.candidateCommit &&
    provenance.baselineConfigFingerprint && provenance.candidateConfigFingerprint &&
    provenance.providers.length > 0 && provenance.startedAt && provenance.finishedAt,
  );
  const structuralReasons = unique([
    ...(provenanceComplete ? [] : ["provenance_incomplete"]),
    ...(credentialScope === "unknown" ? ["credential_scope_unknown"] : []),
    ...(metrics.ndcgAtK.attrition > MAX_ATTRITION ? ["attrition>20%"] : []),
    ...(metrics.ndcgAtK.pairedN < MIN_PAIRED_QUERIES ? ["pairedN<24"] : []),
    ...metrics.ndcgAtK.strata.filter((stratum) => stratum.pairedN < MIN_STRATUM_QUERIES).map((stratum) => `stratum:${stratum.language}/${stratum.category}<4`),
    ...dataset.queries.map((query) => query.category).filter((category, index, categories) => categories.indexOf(category) === index)
      .filter((category) => perQuery.filter((query) => query.included && query.category === category).length < MIN_CATEGORY_QUERIES)
      .map((category) => `category:${category}<8`),
  ]);
  const supported = structuralReasons.length === 0 && RANKING_METRICS.every((metric) => metrics[metric].status === "SUPPORTED");
  const status = supported ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE";
  const exclusions = perQuery.filter((query) => !query.included).map((query) => ({ queryId: query.queryId, reasons: query.excludedReasons }));
  return {
    name,
    ...provenance,
    status,
    provenanceComplete,
    claim: status === "SUPPORTED" ? "Quality-metric evidence supports the candidate; any release claim must also satisfy the preregistered latency gate." : "No quality-improvement claim is supported by this evidence.",
    credentialScope,
    credentialLimitation: credentialScope === "public"
      ? "Only public/self-hosted providers were in scope; results do not establish paid-provider quality."
      : credentialScope === "paid"
        ? "Paid-provider credentials were in scope; results do not establish public-provider quality."
        : credentialScope === "mixed"
          ? "Mixed public and paid providers were in scope; results must not be generalized to either class alone."
          : "Credential scope was not supplied; public/paid provider conclusions cannot be inferred.",
    dataset: dataset.dataset,
    expectedPairs: dataset.queries.length,
    pairedN: included.length,
    excludedN: exclusions.length,
    attrition: ratio(exclusions.length, dataset.queries.length) ?? 1,
    thresholds: { maxAttrition: MAX_ATTRITION, minPairedN: MIN_PAIRED_QUERIES, minStratumN: MIN_STRATUM_QUERIES, minCategoryN: MIN_CATEGORY_QUERIES },
    reasons: unique([...structuralReasons, ...RANKING_METRICS.flatMap((metric) => metrics[metric].reasons)]),
    baseline: sideSummary("baseline"),
    candidate: sideSummary("candidate"),
    metrics,
    strata: metrics.ndcgAtK.strata,
    exclusions,
    perQuery,
  };
}

function algorithmPairsForSize(run, isLive) {
  return isLive ? run.pairs.length : algorithmPairs(run).length;
}

function duplicateRows(documentIdsList) {
  return documentIdsList.length - new Set(documentIdsList).size;
}

function duplicateRate(documentIdsList) {
  if (documentIdsList.length === 0) return null;
  return ratio(duplicateRows(documentIdsList), documentIdsList.length);
}

function maxNullable(values) {
  const present = values.filter((value) => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function expandLiveInputs(inputs) {
  const expanded = [];
  for (const input of inputs) {
    assert(isRecord(input.report), `${input.source}: live report must be an object`);
    if (!Array.isArray(input.report.suiteReports)) {
      expanded.push(input);
      continue;
    }
    for (const suite of input.report.suiteReports) {
      assert(isRecord(suite) && typeof suite.suiteId === "string" && suite.suiteId, `${input.source}: every suiteReport needs suiteId`);
      expanded.push({
        ...input,
        name: suite.suiteId,
        report: {
          ...input.report,
          status: suite.status,
          skipReason: suite.skipReason,
          limitations: suite.limitations,
          startedAt: suite.startedAt,
          finishedAt: suite.finishedAt,
          pairs: input.report.pairs.filter((pair) => (pair.suiteId ?? "legacy-basic") === suite.suiteId),
          suiteReports: undefined,
        },
      });
    }
  }
  return expanded;
}

/** Creates a complete report object without performing I/O. */
export function buildQualityReport({ queries, queriesSha256, live = [], algorithmComparisons = [], credentialScope = "unknown", generatedAt = new Date().toISOString() }) {
  const dataset = parseFrozenQueries(queries, { sha256: queriesSha256 });
  const suites = [
    ...expandLiveInputs(live).map((input) => buildSuite({ name: input.name, evidenceKind: "live", run: input.report, source: input.source, sourceSha256: input.sourceSha256, dataset, credentialScope })),
    ...algorithmComparisons.map((input) => buildSuite({ name: input.name, evidenceKind: "snapshot", run: input.report, source: input.source, sourceSha256: input.sourceSha256, dataset, credentialScope })),
  ];
  assert(suites.length > 0, "at least one live or same-snapshot comparison input is required");
  const allSupported = suites.length > 0 && suites.every((suite) => suite.status === "SUPPORTED");
  return {
    format: REPORT_FORMAT,
    generatedAt,
    evidencePolicy: {
      rankingCutoff: CUTOFF,
      unjudgedDocuments: "excluded_and_provisional",
      validEmptyResults: "N/A in observed; zero for P@10/MRR@10/nDCG@10 in releaseScore",
      recall: "N/A",
      recallReason: "qrels_incomplete",
      liveAndSnapshot: "never_mixed",
      bootstrap: { seed: BOOTSTRAP_SEED, iterations: BOOTSTRAP_ITERATIONS, paired: true, stratified: true, ci: 0.95, method: "paired_stratified_percentile", bca: false },
      improvementClaim: allSupported ? "All suites provide quality-metric evidence; latency and operational gates remain mandatory." : "Prohibited: at least one suite lacks sufficient paired evidence.",
    },
    dataset: dataset.dataset,
    suites,
    summary: {
      status: allSupported ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE",
      supportedSuites: suites.filter((suite) => suite.status === "SUPPORTED").map((suite) => suite.name),
      insufficientSuites: suites.filter((suite) => suite.status !== "SUPPORTED").map((suite) => suite.name),
      qualityImprovementClaimAllowed: allSupported,
    },
  };
}

function markdownEscape(value) {
  return String(value ?? "N/A").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function fmt(value, digits = 4) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "N/A";
}

function metricCell(metric) {
  if (metric?.status === "na") return `N/A (${metric.reason ?? "not_applicable"})`;
  return fmt(metricNumber(metric));
}

function renderSuite(suite) {
  const lines = [
    `## ${suite.name}`,
    "",
    `- 证据类型：\`${suite.evidenceKind}\`；同快照：\`${suite.sameSnapshot}\``,
    `- 状态：**${suite.status}**；capture=${suite.suiteStatus ?? "N/A"}；skipReason=${suite.skipReason ?? "N/A"}`,
    `- 声明边界：${suite.claim}`,
    `- 已知限制：${suite.limitations.length > 0 ? suite.limitations.join("; ") : "无"}`,
    `- 输入：\`${suite.source}\`；SHA-256：\`${suite.sourceSha256}\``,
    `- 区域/Origin：${suite.region ?? "N/A"} / ${suite.origin ?? "N/A"}`,
    `- 运行时间窗：${suite.startedAt ?? "N/A"} → ${suite.finishedAt ?? "N/A"}`,
    `- 双版本 commit：baseline=${suite.baselineCommit ?? "N/A"}；candidate=${suite.candidateCommit ?? "N/A"}`,
    `- configFingerprint：baseline=${suite.baselineConfigFingerprint ?? "N/A"}；candidate=${suite.candidateConfigFingerprint ?? "N/A"}`,
    `- Provenance 完整：${suite.provenanceComplete}`,
    `- Provider 范围：${suite.providerScope}`,
    `- 凭证范围：${suite.credentialScope}；${suite.credentialLimitation}`,
    `- 配对：expectedPairs=${suite.expectedPairs}；pairedN=${suite.pairedN}；excludedN=${suite.excludedN}；attrition=${fmt(suite.attrition * 100, 2)}%`,
    `- 门槛：attrition≤${suite.thresholds.maxAttrition * 100}%；pairedN≥${suite.thresholds.minPairedN}；每层≥${suite.thresholds.minStratumN}；每分类≥${suite.thresholds.minCategoryN}`,
    `- 未满足原因：${suite.reasons.length > 0 ? suite.reasons.map((reason) => `\`${reason}\``).join(", ") : "无"}`,
    "",
    "### 排序与运行指标",
    "",
    "| 指标 | Baseline | Candidate | Delta |",
    "|---|---:|---:|---:|",
  ];
  for (const metric of RANKING_METRICS) {
    const baseline = suite.baseline[metric];
    const candidate = suite.candidate[metric];
    const delta = metricNumber(baseline) !== null && metricNumber(candidate) !== null ? round(metricNumber(candidate) - metricNumber(baseline)) : null;
    lines.push(`| ${metric === "precisionAtK" ? "P@10" : metric === "ndcgAtK" ? "nDCG@10" : "MRR@10"} | ${metricCell(baseline)} | ${metricCell(candidate)} | ${fmt(delta)} |`);
  }
  lines.push(`| Recall@10 | ${metricCell(suite.baseline.recallAtK)} | ${metricCell(suite.candidate.recallAtK)} | N/A |`);
  for (const [label, key, formatter] of [
    ["有效结果数（均值）", "effectiveResultCount", (value) => fmt(value?.mean, 2)],
    ["最终结果数（均值）", "finalResultCount", (value) => fmt(value?.mean, 2)],
    ["重复比例", "duplicateRate", (value) => value === null ? "N/A" : `${fmt(value * 100, 2)}%`],
    ["首条延迟 ms（均值）", "firstResultLatencyMs", (value) => fmt(value?.mean, 2)],
    ["总延迟 ms（均值）", "totalLatencyMs", (value) => fmt(value?.mean, 2)],
    ["上游请求数（总计）", "upstreamRequests", (value) => fmt(value?.total, 0)],
    ["峰值 RSS bytes", "peakRssBytes", (value) => fmt(value?.max, 0)],
  ]) {
    lines.push(`| ${label} | ${formatter(suite.baseline[key])} | ${formatter(suite.candidate[key])} | N/A |`);
  }
  lines.push("", "### 配对分层 Bootstrap", "", "同一抽样索引同时应用于 baseline/candidate；10,000 次，seed=118，95% 百分位 CI，无 BCa。", "");
  lines.push("| 指标 | 口径 | pairedN | Baseline | Candidate | Delta | Delta 95% CI |");
  lines.push("|---|---|---:|---:|---:|---:|---|");
  for (const metric of RANKING_METRICS) {
    for (const lens of ["observed", "releaseScore"]) {
      const result = suite.metrics[metric][lens];
      lines.push(`| ${metric} | ${lens} | ${result.pairedN} | ${fmt(result.baselineMean)} | ${fmt(result.candidateMean)} | ${fmt(result.delta)} | [${fmt(result.deltaCi.lower)}, ${fmt(result.deltaCi.upper)}] |`);
    }
  }
  lines.push("", "### 分层", "", "| Language | Category | Frozen N | Paired N |", "|---|---|---:|---:|");
  for (const stratum of suite.strata) lines.push(`| ${markdownEscape(stratum.language)} | ${markdownEscape(stratum.category)} | ${stratum.frozenN} | ${stratum.pairedN} |`);
  lines.push("", "### 逐条排除", "", "| Query ID | Reasons |", "|---|---|");
  if (suite.exclusions.length === 0) lines.push("| N/A | 无 |");
  for (const exclusion of suite.exclusions) lines.push(`| ${markdownEscape(exclusion.queryId)} | ${exclusion.reasons.map((reason) => `\`${markdownEscape(reason)}\``).join(", ")} |`);
  lines.push("");
  return lines.join("\n");
}

/** Renders a report as Markdown without changing its evidence verdict. */
export function renderMarkdown(report) {
  const lines = [
    "# Search Hub v0.1.18 真实质量对比报告",
    "",
    `- 生成时间：${report.generatedAt}`,
    `- 总结状态：**${report.summary.status}**`,
    `- 是否允许质量提升声明：**${report.summary.qualityImprovementClaimAllowed ? "是（仍须满足延迟门槛）" : "否"}**`,
    `- 冻结查询集：${report.dataset.name} ${report.dataset.version ?? ""}`,
    `- queries.json SHA-256：\`${report.dataset.sha256 ?? "N/A"}\``,
    `- 查询/qrels：${report.dataset.queryCount} / ${report.dataset.labelCount}`,
    `- Recall：**N/A（qrels_incomplete）**；未标注文档不补 0；有效空结果仅在 releaseScore 中计 0。`,
    "- Live AB/BA 与同快照算法对比始终分 suite 统计，不合并 bootstrap。",
    "",
    "## 证据边界",
    "",
    "- 40 条人工策展查询不是全网随机样本；官方来源占比较高，不能外推所有网页、语言或商业搜索。",
    "- 公开/自托管与付费 Provider 的结论不可互相外推；凭证范围未知时必须保持未知。",
    "- 新闻和时效页面会变化；结论只适用于各 suite 记录的时间窗、commit、configFingerprint 与 Provider 范围。",
    "- 任何提升声明都必须有足够配对、低 attrition、分层/分类样本与双口径方向一致的支持；本报告不会把缺失、失败或超时记为质量 0。",
    "",
  ];
  for (const suite of report.suites) lines.push(renderSuite(suite));
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Writes the JSON and Markdown artifacts and returns their paths. */
export function writeQualityReport(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = resolve(outDir, "quality-report.json");
  const markdownPath = resolve(outDir, "quality-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

function parseArgs(argv) {
  const options = { live: [], algorithmComparisons: [], credentialScope: "unknown", outDir: "deliverables/quality-report" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    if (!["--queries", "--live", "--algorithm-comparison", "--out-dir", "--credential-scope"].includes(flag)) {
      throw new TypeError(`unknown argument: ${argument}`);
    }
    const value = inline ?? argv[++index];
    assert(typeof value === "string" && value && !value.startsWith("--"), `${flag} requires a value`);
    if (flag === "--queries") options.queriesPath = value;
    else if (flag === "--out-dir") options.outDir = value;
    else if (flag === "--credential-scope") {
      assert(["public", "paid", "mixed", "unknown"].includes(value), "--credential-scope must be public, paid, mixed, or unknown");
      options.credentialScope = value;
    } else {
      const suiteSeparator = value.indexOf("=");
      const path = suiteSeparator === -1 ? value : value.slice(suiteSeparator + 1);
      const name = suiteSeparator === -1 ? basename(path).replace(/\.[^.]+$/, "") : value.slice(0, suiteSeparator);
      assert(path, `${flag} requires a path`);
      const entry = { name: name || (flag === "--live" ? "live" : "algorithm"), source: path, sourceSha256: fileSha256(path), report: readJson(path) };
      if (flag === "--live") options.live.push(entry);
      else options.algorithmComparisons.push(entry);
    }
  }
  assert(options.queriesPath, "--queries is required");
  assert(options.live.length > 0 || options.algorithmComparisons.length > 0, "--live or --algorithm-comparison is required");
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("usage: quality-report.mjs --queries <queries.json> --live <suite=report.json> [--live ...] [--algorithm-comparison <suite=report.json>] [--out-dir <dir>] [--credential-scope public|paid|mixed|unknown]");
    return;
  }
  const queriesPath = resolve(options.queriesPath);
  const report = buildQualityReport({
    queries: readJson(queriesPath),
    queriesSha256: fileSha256(queriesPath),
    live: options.live,
    algorithmComparisons: options.algorithmComparisons,
    credentialScope: options.credentialScope,
  });
  const paths = writeQualityReport(report, resolve(options.outDir));
  console.log(`quality:report — ${report.suites.length} suites, status=${report.summary.status}, improvementClaimAllowed=${report.summary.qualityImprovementClaimAllowed}`);
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`Markdown: ${paths.markdownPath}`);
  if (report.summary.status !== "SUPPORTED") process.exitCode = 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`quality:report — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
