#!/usr/bin/env node
/**
 * PRD B8 live paired capture. Two implementations must be routes on the same
 * instance/region; cache bypass and serial AB/BA execution are mandatory.
 * Raw provider rows and hashes are evidence, never synthetic scores.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeUrl } from "../packages/shared/src/url.ts";
import { snapshotFingerprint } from "../packages/core/src/evaluation/snapshot.ts";
import { pairedStratifiedBootstrap } from "../packages/core/src/evaluation/bootstrap.ts";
import { evaluateQuery } from "../packages/core/src/evaluation/metrics.ts";

const MAX_ATTEMPTS = 2;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 90_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 1000;
}

function validateManifest(manifest) {
  assert(manifest && manifest.version === 1, "manifest.version must be 1");
  assert(typeof manifest.region === "string" && manifest.region, "manifest.region is required");
  assert(Array.isArray(manifest.providers) && manifest.providers.length > 0, "manifest.providers is required");
  assert(Array.isArray(manifest.queries) && manifest.queries.length > 0, "manifest.queries is required");
  const ids = new Set();
  for (const query of manifest.queries) {
    assert(typeof query.id === "string" && query.id, "every query needs an id");
    assert(!ids.has(query.id), `duplicate query id: ${query.id}`);
    ids.add(query.id);
    assert(typeof query.query === "string" && query.query.trim(), `query ${query.id} needs text`);
    assert(typeof query.category === "string" && query.category, `query ${query.id} needs a category`);
    assert(typeof query.language === "string" && query.language, `query ${query.id} needs a language`);
  }
  const allowedRequestKeys = new Set([
    "mode", "strategy", "language", "freshness", "timeoutMs", "queryExpansion", "maxSubqueries", "maxRounds",
    "rerank", "embedding", "summarize", "rerankModelId", "embeddingModelId", "chatModelId",
  ]);
  for (const [label, request] of [["request", manifest.request], ...["baseline", "candidate"].map((side) => [`${side}.request`, manifest[side]?.request])]) {
    if (request === undefined) continue;
    assert(request && typeof request === "object" && !Array.isArray(request), `${label} must be an object`);
    for (const key of Object.keys(request)) assert(allowedRequestKeys.has(key), `${label}.${key} is not allowed in frozen evidence requests`);
  }
  for (const side of ["baseline", "candidate"]) {
    const implementation = manifest[side];
    assert(implementation && typeof implementation.commit === "string" && implementation.commit, `${side}.commit is required`);
    assert(typeof implementation.configFingerprint === "string" && implementation.configFingerprint, `${side}.configFingerprint is required`);
    const request = { ...manifest.request, ...implementation.request };
    assert(!(request.mode && request.strategy), `${side} cannot freeze both mode and strategy`);
  }
}

function validateEndpoints(baselineUrl, candidateUrl) {
  const baseline = new URL(baselineUrl);
  const candidate = new URL(candidateUrl);
  assert(baseline.protocol === "https:" || baseline.hostname === "127.0.0.1" || baseline.hostname === "localhost" || baseline.hostname === "::1", "live endpoint must use HTTPS (HTTP is allowed only on loopback)");
  assert(baseline.origin === candidate.origin, "baseline and candidate must use the same instance origin/region");
  return { baseline, candidate };
}

function providerRows(body, requested) {
  const stats = new Map((body?.stats?.providers ?? []).map((stat) => [stat.providerId, stat]));
  const debug = new Map((body?.debug?.perProviderResults ?? []).map((entry) => [entry.providerId, entry]));
  return [...new Set([...requested, ...stats.keys()])].map((providerId) => {
    const stat = stats.get(providerId);
    const entry = debug.get(providerId);
    return {
      providerId,
      providerName: entry?.providerName ?? stat?.providerName ?? providerId,
      providerType: stat?.providerType ?? "unknown",
      ok: stat?.ok ?? (entry?.results?.length ?? 0) > 0,
      ...(stat?.errorCode ? { errorCode: stat.errorCode } : {}),
      ...(Number.isFinite(stat?.latencyMs) ? { latencyMs: stat.latencyMs } : {}),
      results: (entry?.results ?? []).map((result, index) => ({
        documentId: normalizeUrl(result.url) ?? result.id,
        title: result.title,
        url: result.url,
        snippet: result.snippet ?? "",
        rank: index + 1,
      })),
    };
  });
}

function deepRounds(body, envelope) {
  const pairs = body?.debug?.providerQueries ?? [];
  const queries = [...new Set([envelope.query, ...pairs.map((pair) => pair.query)])];
  const budget = body?.deepBudget;
  return queries.map((query, queryIndex) => {
    const providerIds = pairs.filter((pair) => pair.query === query).map((pair) => pair.providerId);
    return {
      ...envelope,
      queryId: queryIndex === 0 ? envelope.queryId : `${envelope.queryId}:q${queryIndex + 1}`,
      query,
      queryIndex,
      kind: queryIndex === 0 ? "original" : "expanded",
      weight: queryIndex === 0 ? 1 : 0.8,
      round: 1,
      providers: providerIds.length ? envelope.providers.filter((provider) => providerIds.includes(provider.providerId)) : envelope.providers,
      providerQueryCalls: queryIndex === 0 ? budget?.providerQueryCalls ?? envelope.providers.length : envelope.providers.length,
      httpRequests: queryIndex === 0 ? budget?.httpRequests ?? envelope.upstreamRequests : 0,
      modelCalls: queryIndex === 0 ? budget?.modelCalls ?? 0 : 0,
      budgetExhausted: budget?.budgetExhausted ?? false,
    };
  });
}

function makeSnapshot({ query, body, implementation, capturedAt, requestCount }) {
  const providers = providerRows(body, implementation.providers);
  const providerFingerprints = Object.fromEntries(providers.map((provider) => [provider.providerId, snapshotFingerprint({
    providerId: provider.providerId,
    configFingerprint: implementation.configFingerprint,
    ok: provider.ok,
    resultCount: provider.results.length,
  })]));
  const envelope = {
    schemaVersion: 2,
    queryId: query.id,
    query: query.query,
    category: query.category,
    language: query.language,
    capturedAt,
    upstreamRequests: requestCount,
    cacheHits: 0,
    providers,
    providerFingerprints,
    modelArtifacts: Object.fromEntries(Object.entries(implementation.modelArtifacts ?? {})
      .filter(([stage, artifact]) => ["embedding", "rerank", "chat"].includes(stage) && artifact && typeof artifact.modelId === "string" && typeof artifact.configFingerprint === "string" && typeof artifact.stageVersion === "string")
      .map(([stage, artifact]) => [stage, { modelId: artifact.modelId, configFingerprint: artifact.configFingerprint, stageVersion: artifact.stageVersion }])),
    deepRounds: [],
  };
  return {
    envelope: { ...envelope, deepRounds: deepRounds(body, envelope) },
    evidenceComplete: Array.isArray(body?.debug?.perProviderResults),
    rawProviderSnapshot: providers,
    providerHashes: Object.fromEntries(providers.map((provider) => [provider.providerId, snapshotFingerprint(provider)])),
    responseHash: snapshotFingerprint(body),
  };
}

async function requestWithRetry({ url, body, token, fetchImpl, now, wait, deadline }) {
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = now();
    let response;
    let networkError = null;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      networkError = error instanceof Error ? error.message : String(error);
    }
    const finishedAt = now();
    const status = response?.status ?? 0;
    const retryAfter = response?.headers?.get?.("retry-after") ?? null;
    let payload = null;
    let parseError = null;
    if (response) {
      let text;
      try {
        text = await response.text();
      } catch (error) {
        networkError = error instanceof Error ? error.message : String(error);
      }
      if (text !== undefined) {
        try {
          payload = text ? JSON.parse(text) : null;
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    const shouldRetry = networkError !== null || status === 429 || (status >= 500 && status <= 599);
    attempts.push({ attempt, startedAt, finishedAt, status, networkError, parseError, retryAfter, retryable: shouldRetry, payload });
    if (!shouldRetry || attempt === MAX_ATTEMPTS) break;
    // Retry-After is a minimum delay, not a request to retry immediately.
    const delay = parseRetryAfter(retryAfter, finishedAt);
    assert(finishedAt + delay <= deadline, "live capture exceeded the 24-hour window");
    await wait(delay);
    assert(now() <= deadline, "live capture exceeded the 24-hour window");
  }
  return attempts;
}

/** Builds B8 paired evidence only from human qrels and successful captured responses. */
export function buildLiveComparison(report, qrels) {
  const base = {
    format: "search-hub.quality.live-comparison/1",
    evidenceKind: "live_paired_abba",
    sameSnapshot: false,
    manifestHash: report.manifestHash,
    qrelsFingerprint: qrels ? snapshotFingerprint(qrels) : null,
    expectedPairs: report.pairs.length,
    perQuery: [],
    metrics: {},
  };
  if (!qrels) return { ...base, status: "INSUFFICIENT_EVIDENCE", reason: "qrels_not_provided" };
  if (qrels.source !== "human") return { ...base, status: "INSUFFICIENT_EVIDENCE", reason: "qrels_not_human" };
  assert(Array.isArray(qrels.queries), "qrels.queries must be an array");
  assert(typeof qrels.judgmentsComplete === "boolean", "qrels.judgmentsComplete must be boolean");
  const qrelsIds = new Set();
  for (const query of qrels.queries) {
    assert(typeof query.queryId === "string" && query.queryId, "every qrel query needs a queryId");
    assert(!qrelsIds.has(query.queryId), `duplicate qrel queryId: ${query.queryId}`);
    qrelsIds.add(query.queryId);
    assert(Array.isArray(query.judgments), `qrels ${query.queryId} judgments must be an array`);
    for (const judgment of query.judgments) {
      assert(typeof judgment.documentId === "string" && judgment.documentId, "judgment documentId is required");
      assert(Number.isInteger(judgment.relevance) && judgment.relevance >= 0 && judgment.relevance <= 3, "judgment relevance must be 0..3");
    }
  }
  const qrelsByQuery = new Map(qrels.queries.map((query) => [query.queryId, query]));
  const pairs = [];
  const perQuery = [];
  for (const pair of report.pairs) {
    const qrel = qrelsByQuery.get(pair.queryId);
    const baseline = pair.captures.baseline;
    const candidate = pair.captures.candidate;
    const reasons = [];
    if (!qrel) reasons.push("no_human_judgments");
    if (!baseline?.ok || !candidate?.ok) reasons.push("execution_failed");
    if (JSON.stringify(baseline?.request) !== JSON.stringify(candidate?.request)) reasons.push("request_mismatch");
    if (reasons.length === 0) {
      const grades = new Map((qrel.judgments ?? []).map((judgment) => [judgment.documentId, judgment.relevance]));
      const relevantTotal = qrels.judgmentsComplete === false ? null : [...grades.values()].filter((grade) => grade >= 2).length;
      const metricsFor = (capture, cutoff) => evaluateQuery(
        capture.finalResults.map((result) => result.documentId),
        { queryId: pair.queryId, grades, relevantTotal },
        { cutoff },
      );
      const baselineMetrics = metricsFor(baseline, 10);
      const candidateMetrics = metricsFor(candidate, 10);
      baselineMetrics.recallAtK = metricsFor(baseline, 20).recallAtK;
      candidateMetrics.recallAtK = metricsFor(candidate, 20).recallAtK;
      pairs.push({
        queryId: pair.queryId,
        language: pair.language,
        category: pair.category,
        judgmentSource: "human",
        judgmentsComplete: qrels.judgmentsComplete === true,
        baseline: baselineMetrics,
        candidate: candidateMetrics,
      });
      perQuery.push({
        queryId: pair.queryId,
        baseline: { ndcgAtK: baselineMetrics.ndcgAtK.value, mrrAtK: baselineMetrics.mrrAtK.value, precisionAtK: baselineMetrics.precisionAtK.value, recallAt20: baselineMetrics.recallAtK.value },
        candidate: { ndcgAtK: candidateMetrics.ndcgAtK.value, mrrAtK: candidateMetrics.mrrAtK.value, precisionAtK: candidateMetrics.precisionAtK.value, recallAt20: candidateMetrics.recallAtK.value },
      });
    } else {
      perQuery.push({ queryId: pair.queryId, excludedReasons: reasons });
    }
  }
  for (const metric of ["ndcgAtK", "mrrAtK", "precisionAtK"]) {
    base.metrics[metric] = pairedStratifiedBootstrap({ pairs, metric });
  }
  const insufficient = Object.values(base.metrics).some((metric) => metric.status === "INSUFFICIENT_EVIDENCE");
  return {
    ...base,
    perQuery,
    pairedN: pairs.length,
    excludedN: report.pairs.length - pairs.length,
    attrition: report.pairs.length ? (report.pairs.length - pairs.length) / report.pairs.length : 1,
    status: insufficient ? "INSUFFICIENT_EVIDENCE" : "SUPPORTED",
    ...(insufficient ? { reason: "paired_evidence_threshold_not_met" } : {}),
  };
}

/** Runs one frozen query set serially, alternating AB/BA by query position. */
export async function runQualityLive({
  manifest,
  baselineUrl,
  candidateUrl,
  outDir,
  token = "",
  qrels = null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
}) {
  validateManifest(manifest);
  const endpoints = validateEndpoints(baselineUrl, candidateUrl);
  const startedAt = now();
  const report = {
    format: "search-hub.quality.live/1",
    protocol: { order: "AB/BA", serial: true, cachePolicy: "bypass", maxAttempts: MAX_ATTEMPTS, maxWindowMs: MAX_WINDOW_MS },
    region: manifest.region,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    origin: endpoints.baseline.origin,
    manifestHash: snapshotFingerprint(manifest),
    qrelsFingerprint: qrels ? snapshotFingerprint(qrels) : null,
    pairs: [],
  };
  for (const [index, query] of manifest.queries.entries()) {
    assert(now() - startedAt <= MAX_WINDOW_MS, "live capture exceeded the 24-hour window");
    const order = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const pair = { queryId: query.id, query: query.query, category: query.category, language: query.language, order, captures: {} };
    for (const side of order) {
      assert(now() - startedAt <= MAX_WINDOW_MS, "live capture exceeded the 24-hour window");
      const implementation = { ...manifest[side], providers: manifest.providers };
      const url = side === "baseline" ? endpoints.baseline : endpoints.candidate;
      const request = {
        ...manifest.request,
        ...implementation.request,
        query: query.query,
        providers: manifest.providers,
        limit: manifest.limit ?? 20,
        perProviderLimit: manifest.perProviderLimit ?? manifest.limit ?? 20,
        skipCache: true,
      };
      if (!request.mode && !request.strategy) request.mode = "basic";
      const attempts = await requestWithRetry({
        url: url.href,
        body: request,
        token,
        fetchImpl,
        now,
        wait,
        deadline: startedAt + MAX_WINDOW_MS,
      });
      const last = attempts[attempts.length - 1];
      const body = last.payload;
      const httpOk = last.status >= 200 && last.status < 300 && body && !body.error;
      const requestCount = attempts.reduce((sum, attempt) => sum + (attempt.payload?.stats?.providers ?? []).reduce((count, stat) => count + (stat.httpRequests ?? stat.attempts ?? 0), 0), 0);
      const capture = {
        implementation: side,
        commit: implementation.commit,
        configFingerprint: implementation.configFingerprint,
        request,
        responseMode: body?.mode ?? null,
        responseStrategy: body?.strategy ?? null,
        appliedStages: body?.appliedStages ?? [],
        attempts: attempts.map(({ payload: _payload, ...attempt }) => attempt),
        latencyMs: attempts.reduce((sum, attempt) => sum + attempt.finishedAt - attempt.startedAt, 0),
        elapsedMs: last.finishedAt - attempts[0].startedAt,
        httpAttempts: attempts.length,
        httpStatus: last.status,
        ok: Boolean(httpOk && body.status !== "failed"),
        upstreamRequests: requestCount,
        cacheHits: 0,
        errors: [
          ...(last.networkError ? [{ code: "network_error", message: last.networkError }] : []),
          ...(last.parseError ? [{ code: "invalid_json", message: last.parseError }] : []),
          ...(!httpOk ? [{ code: `http_${last.status}`, message: body?.error?.message ?? "request failed" }] : []),
          ...(body?.errors ?? []),
          ...(body?.failedSources ?? []),
        ],
        degradations: body?.degradations ?? [],
        finalResults: (body?.results ?? []).map((result) => ({ documentId: normalizeUrl(result.url) ?? result.id, url: result.url, title: result.title })),
      };
      if (httpOk) {
        Object.assign(capture, makeSnapshot({ query, body, implementation, capturedAt: new Date(last.finishedAt).toISOString(), requestCount }));
        if (!capture.evidenceComplete) {
          capture.ok = false;
          capture.errors.push({ code: "missing_per_provider_evidence", message: "response did not include debug.perProviderResults" });
        }
      }
      pair.captures[side] = capture;
    }
    report.pairs.push(pair);
  }
  report.finishedAt = new Date(now()).toISOString();
  report.comparison = buildLiveComparison(report, qrels);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "quality-live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    writeFileSync(resolve(outDir, "quality-live-comparison.json"), `${JSON.stringify(report.comparison, null, 2)}\n`, "utf8");
  }
  return report;
}

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const manifestPath = flag("manifest", null);
  const baselineUrl = flag("baseline-url", null);
  const candidateUrl = flag("candidate-url", null);
  const outDir = flag("out", "deliverables/quality-live");
  const token = flag("token", process.env.SEARCH_HUB_TOKEN ?? "");
  const qrelsPath = flag("qrels", null);
  assert(manifestPath && baselineUrl && candidateUrl, "usage: quality-live.mjs --manifest <json> --qrels <human.json> --baseline-url <url> --candidate-url <same-origin-url> [--out <dir>]");
  assert(token, "--token or SEARCH_HUB_TOKEN is required");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const qrels = qrelsPath ? JSON.parse(readFileSync(qrelsPath, "utf8")) : null;
  const report = await runQualityLive({ manifest, baselineUrl, candidateUrl, outDir, token, qrels });
  console.log(`quality:live — ${report.pairs.length} paired queries, AB/BA, cache bypass, origin=${report.origin}, comparison=${report.comparison.status}`);
  if (report.pairs.some((pair) => !pair.captures.baseline.ok || !pair.captures.candidate.ok)) process.exitCode = 4;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`quality:live — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
