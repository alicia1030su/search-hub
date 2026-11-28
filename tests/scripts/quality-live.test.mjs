import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildLiveComparison, parseRetryAfter, runQualityLive } from "../../scripts/quality-live.mjs";

function manifest(count = 3) {
  return {
    version: 1,
    region: "test-region",
    providers: ["alpha"],
    limit: 20,
    perProviderLimit: 20,
    baseline: { commit: "base-sha", configFingerprint: "base-config" },
    candidate: { commit: "candidate-sha", configFingerprint: "candidate-config" },
    queries: Array.from({ length: count }, (_, index) => ({
      id: `q${index + 1}`,
      query: `query ${index + 1}`,
      category: "technical",
      language: "zh",
    })),
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function searchBody() {
  return {
    status: "completed",
    results: [{ id: "https://a.test/1", title: "A", url: "https://a.test/1", snippet: "evidence" }],
    stats: { providers: [{ providerId: "alpha", providerName: "Alpha", providerType: "fixture", ok: true, attempts: 1, httpRequests: 2, latencyMs: 3 }] },
    debug: {
      perProviderResults: [{ providerId: "alpha", providerName: "Alpha", results: [{ id: "https://a.test/1", title: "A", url: "https://a.test/1", snippet: "evidence" }] }],
      providerQueries: [{ providerId: "alpha", query: "query 1" }],
    },
    deepBudget: { providerQueryCalls: 1, httpRequests: 2, modelCalls: 0, budgetExhausted: false },
    errors: [],
    degradations: [],
  };
}

function options(overrides = {}) {
  let clock = 1_000;
  return {
    manifest: manifest(),
    baselineUrl: "https://same.test/baseline",
    candidateUrl: "https://same.test/candidate",
    now: () => (clock += 10),
    wait: async () => undefined,
    ...overrides,
  };
}

test("AB/BA order is frozen, serial, cache-bypassing and saves v2 raw evidence", async () => {
  const calls = [];
  let active = 0;
  const fetchImpl = async (url, init) => {
    active += 1;
    assert.equal(active, 1, "queries and implementations must be serial");
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    await Promise.resolve();
    active -= 1;
    return response(searchBody());
  };
  const dir = mkdtempSync(join(tmpdir(), "quality-live-"));
  try {
    const report = await runQualityLive({ ...options({ fetchImpl }), outDir: dir });
    assert.deepEqual(calls.map((call) => `${new URL(call.url).pathname}:${call.body.query}`), [
      "/baseline:query 1", "/candidate:query 1",
      "/candidate:query 2", "/baseline:query 2",
      "/baseline:query 3", "/candidate:query 3",
    ]);
    assert.ok(calls.every((call) => call.body.skipCache === true));
    assert.equal(report.protocol.order, "AB/BA");
    assert.equal(report.protocol.serial, true);
    const capture = report.pairs[0].captures.baseline;
    assert.equal(capture.envelope.schemaVersion, 2);
    assert.equal(capture.envelope.language, "zh");
    assert.equal(capture.envelope.upstreamRequests, 2);
    assert.equal(capture.envelope.cacheHits, 0);
    assert.equal(capture.rawProviderSnapshot[0].results.length, 1);
    assert.match(capture.providerHashes.alpha, /^[a-f0-9]{64}$/);
    assert.match(capture.responseHash, /^[a-f0-9]{64}$/);
    assert.equal(capture.envelope.deepRounds[0].httpRequests, 2);
    assert.equal(capture.httpAttempts, 1);
    assert.equal(capture.latencyMs, 10);
    const saved = JSON.parse(readFileSync(join(dir, "quality-live-report.json"), "utf8"));
    assert.equal(saved.manifestHash, report.manifestHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("429 retries once and respects Retry-After; requests across attempts are counted", async () => {
  const waits = [];
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return count === 1 ? response({ error: { message: "busy" } }, 429, { "retry-after": "2" }) : response(searchBody());
  };
  const report = await runQualityLive(options({
    manifest: manifest(1),
    fetchImpl,
    wait: async (ms) => waits.push(ms),
  }));
  assert.deepEqual(waits, [2000]);
  const capture = report.pairs[0].captures.baseline;
  assert.equal(capture.httpAttempts, 2);
  assert.equal(capture.attempts[0].retryAfter, "2");
  assert.equal(capture.upstreamRequests, 2);
});

test("network errors and 5xx retry at most twice; auth failures never retry", async () => {
  for (const failure of ["network", 503, 401]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (failure === "network") throw new TypeError("socket closed");
      return response({ error: { message: "failure" } }, failure);
    };
    const report = await runQualityLive(options({ manifest: manifest(1), fetchImpl }));
    assert.equal(calls, failure === 401 ? 2 : 4);
    assert.equal(report.pairs[0].captures.baseline.ok, false);
    assert.equal(report.pairs[0].captures.baseline.httpAttempts, failure === 401 ? 1 : 2);
  }
});

test("rejects cross-origin and insecure remote endpoints before fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return response(searchBody());
  };
  await assert.rejects(runQualityLive(options({
    baselineUrl: "https://one.test/search",
    candidateUrl: "https://two.test/search",
    fetchImpl,
  })), /same instance origin/);
  await assert.rejects(runQualityLive(options({
    baselineUrl: "http://remote.test/search",
    candidateUrl: "http://remote.test/candidate",
    fetchImpl,
  })), /HTTPS/);
  assert.equal(called, false);
});

test("Retry-After supports seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("3", 0), 3000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 0), 5000);
  assert.equal(parseRetryAfter(null, 0), 1000);
});

test("frozen implementation requests cover rrf/rerank/deep without allowing both mode and strategy", async () => {
  for (const mode of ["basic", "rrf", "rerank", "deep"]) {
    const seen = [];
    const input = options({
      manifest: {
        ...manifest(1),
        baseline: { commit: "base", configFingerprint: "cfg", request: { mode } },
        candidate: { commit: "candidate", configFingerprint: "cfg", request: { mode } },
      },
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(init.body));
        return response(searchBody());
      },
    });
    const report = await runQualityLive(input);
    assert.ok(seen.every((request) => request.mode === mode));
    assert.equal(report.pairs[0].captures.baseline.request.mode, mode);
    assert.equal(report.pairs[0].captures.baseline.responseMode, null);
  }
  await assert.rejects(runQualityLive(options({
    manifest: { ...manifest(1), baseline: { commit: "base", configFingerprint: "cfg", request: { mode: "deep", strategy: "deep" } } },
  })), /both mode and strategy/);
  await assert.rejects(runQualityLive(options({
    manifest: { ...manifest(1), request: { apiKey: "canary" } },
  })), /not allowed/);
});

test("missing per-provider debug evidence is a failed capture, not an empty success", async () => {
  const body = searchBody();
  delete body.debug.perProviderResults;
  const report = await runQualityLive(options({
    manifest: manifest(1),
    fetchImpl: async () => response(body),
  }));
  assert.equal(report.pairs[0].captures.baseline.ok, false);
  assert.equal(report.pairs[0].captures.baseline.evidenceComplete, false);
  assert.equal(report.pairs[0].captures.baseline.errors[0].code, "missing_per_provider_evidence");
});

test("human qrels produce observed/releaseScore evidence and never mix snapshot with live", async () => {
  const qrels = {
    source: "human",
    judgmentsComplete: true,
    queries: [{ queryId: "q1", judgments: [{ documentId: "https://a.test/1", relevance: 3 }] }],
  };
  const report = await runQualityLive(options({ manifest: manifest(1), qrels, fetchImpl: async () => response(searchBody()) }));
  assert.equal(report.comparison.evidenceKind, "live_paired_abba");
  assert.equal(report.comparison.sameSnapshot, false);
  assert.equal(report.comparison.perQuery[0].baseline.ndcgAtK, 1);
  assert.equal(report.comparison.metrics.ndcgAtK.observed.pairedN, 1);
  assert.equal(report.comparison.metrics.ndcgAtK.releaseScore.pairedN, 1);
  assert.equal(report.comparison.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(buildLiveComparison(report, null).reason, "qrels_not_provided");
  assert.equal(buildLiveComparison(report, { ...qrels, source: "machine_generated" }).reason, "qrels_not_human");
});

test("empty live results stay N/A in observed and become zero only in releaseScore", async () => {
  const qrels = {
    source: "human", judgmentsComplete: true,
    queries: Array.from({ length: 24 }, (_, index) => ({ queryId: `q${index + 1}`, judgments: [{ documentId: "https://a.test/1", relevance: 3 }] })),
  };
  const report = await runQualityLive(options({
    manifest: manifest(24), qrels,
    fetchImpl: async (url) => {
      const body = searchBody();
      if (new URL(url).pathname === "/candidate") body.results = [];
      return response(body);
    },
  }));
  assert.equal(report.comparison.metrics.ndcgAtK.observed.pairedN, 0);
  assert.equal(report.comparison.metrics.ndcgAtK.releaseScore.pairedN, 24);
  assert.equal(report.comparison.metrics.ndcgAtK.releaseScore.candidateMean, 0);
});

test("model metadata cannot smuggle credentials and request cannot enable cache", async () => {
  const seen = [];
  const input = options({
    manifest: {
      ...manifest(1),
      request: { language: "en" },
      baseline: { commit: "base", configFingerprint: "cfg", modelArtifacts: { chat: { modelId: "m", configFingerprint: "c", stageVersion: "v", apiKey: "canary" } } },
    },
    fetchImpl: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return response(searchBody());
    },
  });
  const report = await runQualityLive(input);
  assert.equal(seen[0].skipCache, true);
  assert.deepEqual(seen[0].providers, ["alpha"]);
  assert.equal(seen[0].query, "query 1");
  assert.equal(seen[0].language, "en");
  await assert.rejects(runQualityLive(options({ manifest: { ...manifest(1), request: { skipCache: false } } })), /not allowed/);
  await assert.rejects(runQualityLive(options({ manifest: { ...manifest(1), request: { providers: [] } } })), /not allowed/);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("canary"));
  assert.deepEqual(Object.keys(report.pairs[0].captures.baseline.envelope.modelArtifacts.chat).sort(), ["configFingerprint", "modelId", "stageVersion"]);
});
