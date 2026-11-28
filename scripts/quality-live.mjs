#!/usr/bin/env node
/**
 * PRD B8 live paired capture. Two implementations must be routes on the same
 * instance/region; cache bypass and serial AB/BA execution are mandatory.
 * Raw provider rows and hashes are evidence, never synthetic scores.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotFingerprint } from "../packages/core/src/evaluation/snapshot.ts";

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
  for (const side of ["baseline", "candidate"]) {
    const implementation = manifest[side];
    assert(implementation && typeof implementation.commit === "string" && implementation.commit, `${side}.commit is required`);
    assert(typeof implementation.configFingerprint === "string" && implementation.configFingerprint, `${side}.configFingerprint is required`);
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
        documentId: result.id,
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

/** Runs one frozen query set serially, alternating AB/BA by query position. */
export async function runQualityLive({
  manifest,
  baselineUrl,
  candidateUrl,
  outDir,
  token = "",
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
      const attempts = await requestWithRetry({
        url: url.href,
        body: {
          ...manifest.request,
          query: query.query,
          mode: "basic",
          providers: manifest.providers,
          limit: manifest.limit ?? 20,
          perProviderLimit: manifest.perProviderLimit ?? manifest.limit ?? 20,
          skipCache: true,
        },
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
      };
      if (httpOk) Object.assign(capture, makeSnapshot({ query, body, implementation, capturedAt: new Date(last.finishedAt).toISOString(), requestCount }));
      pair.captures[side] = capture;
    }
    report.pairs.push(pair);
  }
  report.finishedAt = new Date(now()).toISOString();
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "quality-live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
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
  assert(manifestPath && baselineUrl && candidateUrl, "usage: quality-live.mjs --manifest <json> --baseline-url <url> --candidate-url <same-origin-url> [--out <dir>]");
  assert(token, "--token or SEARCH_HUB_TOKEN is required");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const report = await runQualityLive({ manifest, baselineUrl, candidateUrl, outDir, token });
  console.log(`quality:live — ${report.pairs.length} paired queries, AB/BA, cache bypass, origin=${report.origin}`);
  if (report.pairs.some((pair) => !pair.captures.baseline.ok || !pair.captures.candidate.ok)) process.exitCode = 4;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`quality:live — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
