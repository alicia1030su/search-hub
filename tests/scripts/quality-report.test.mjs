import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildQualityReport,
  parseFrozenQueries,
  renderMarkdown,
  writeQualityReport,
} from "../../scripts/quality-report.mjs";

const CATEGORIES = ["technical", "academic", "news", "general"];

function fixture(count = 32) {
  const queries = Array.from({ length: count }, (_, index) => {
    const queryId = `q${String(index + 1).padStart(3, "0")}`;
    const primary = `https://example.test/${queryId}/answer`;
    const background = `https://example.test/${queryId}/background`;
    return {
      queryId,
      query: `query ${index + 1}`,
      language: index % 2 === 0 ? "en" : "zh",
      category: CATEGORIES[Math.floor(index / 8) % CATEGORIES.length],
      stratum: `stratum-${Math.floor(index / 8) % CATEGORIES.length}`,
      labels: [
        { relevance: 2, normalizedUrl: primary, title: "Answer", reason: "Direct answer", annotator: "human-test", provisional: false },
        { relevance: 1, normalizedUrl: background, title: "Background", reason: "Background", annotator: "human-test", provisional: false },
      ],
    };
  });
  return {
    frozen: true,
    name: "test frozen queries",
    version: "test-v1",
    origin: "human_curated_real_web",
    queryCount: queries.length,
    labelCount: queries.length * 2,
    judgmentsComplete: false,
    queries,
  };
}

function documents(query, side, extra = []) {
  const primary = `https://example.test/${query.queryId}/answer`;
  const background = `https://example.test/${query.queryId}/background`;
  const ordered = side === "candidate" ? [primary, background] : [background, primary];
  return [...ordered, ...extra].map((url) => ({ documentId: url, url, title: url }));
}

function liveReport(queries, overrides = {}) {
  return {
    format: "search-hub.quality.live/1",
    protocol: { order: "AB/BA", serial: true, cachePolicy: "bypass" },
    region: "test-region",
    origin: "https://same.test",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:10:00.000Z",
    manifestHash: "a".repeat(64),
    peakRssBytes: 50_000_000,
    pairs: queries.map((query, index) => {
      const capture = (side) => ({
        implementation: side,
        commit: side === "baseline" ? "baseline-sha" : "candidate-sha",
        configFingerprint: `${side}-config`,
        request: { query: query.query, providers: ["alpha"], skipCache: true, mode: "basic" },
        ok: true,
        latencyMs: side === "baseline" ? 100 + index : 90 + index,
        firstResultLatencyMs: side === "baseline" ? 40 + index : 35 + index,
        upstreamRequests: side === "baseline" ? 2 : 1,
        peakRssBytes: side === "baseline" ? 50_000_000 : 45_000_000,
        finalResults: documents(query, side),
        evidenceComplete: true,
        rawProviderSnapshot: [{ providerId: "alpha", ok: true, results: [] }],
        providerHashes: { alpha: "e".repeat(64) },
        responseHash: "f".repeat(64),
        envelope: {
          providers: [{ providerId: "alpha", ok: true, results: [] }],
          deepRounds: [],
        },
      });
      return {
        queryId: query.queryId,
        query: query.query,
        category: query.category,
        language: query.language,
        order: index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"],
        captures: { baseline: capture("baseline"), candidate: capture("candidate") },
      };
    }),
    ...overrides,
  };
}

function reportFor(dataset, live = liveReport(dataset.queries), extra = {}) {
  return buildQualityReport({
    queries: dataset,
    queriesSha256: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"),
    live: [{ name: "basic", source: "fixture-live.json", sourceSha256: "b".repeat(64), report: live }],
    credentialScope: "public",
    generatedAt: "2026-01-01T01:00:00.000Z",
    ...extra,
  });
}

test("parses the real frozen v0118 query set and forces Recall to N/A", () => {
  const path = new URL("../fixtures/quality-v0118/queries.json", import.meta.url);
  const raw = readFileSync(path, "utf8");
  const parsed = parseFrozenQueries(JSON.parse(raw), { sha256: createHash("sha256").update(raw).digest("hex") });
  assert.equal(parsed.queries.length, 40);
  assert.equal(parsed.dataset.labelCount, 80);
  assert.equal(parsed.dataset.queryCount, 40);
  assert.equal(parsed.dataset.judgmentsComplete, false);
  assert.equal(parsed.dataset.recall, "N/A");
  assert.ok(parsed.queries.every((query) => query.relevantTotal === null));
});

test("normal paired evidence produces core metrics, bootstrap lenses, provenance and Markdown", () => {
  const queries = fixture();
  const report = reportFor(queries);
  const suite = report.suites[0];
  assert.equal(suite.status, "SUPPORTED");
  assert.equal(suite.expectedPairs, 32);
  assert.equal(suite.pairedN, 32);
  assert.equal(suite.excludedN, 0);
  assert.equal(suite.attrition, 0);
  assert.equal(suite.baselineCommit, "baseline-sha");
  assert.equal(suite.candidateCommit, "candidate-sha");
  assert.deepEqual(suite.configFingerprints.sort(), ["baseline-config", "candidate-config"]);
  assert.equal(suite.providerScope, "alpha");
  assert.equal(suite.credentialScope, "public");
  assert.equal(suite.baseline.recallAtK.status, "na");
  assert.equal(suite.candidate.recallAtK.reason, "qrels_incomplete");
  assert.equal(suite.baseline.upstreamRequests.total, 64);
  assert.equal(suite.candidate.upstreamRequests.total, 32);
  assert.equal(suite.baseline.totalLatencyMs.sampleN, 32);
  assert.equal(suite.baseline.firstResultLatencyMs.sampleN, 32);
  assert.equal(suite.baseline.peakRssBytes.max, 50_000_000);
  for (const metric of ["precisionAtK", "ndcgAtK", "mrrAtK"]) {
    assert.equal(suite.metrics[metric].protocol.seed, 118);
    assert.equal(suite.metrics[metric].protocol.iterations, 10_000);
    assert.equal(suite.metrics[metric].observed.pairedN, 32);
    assert.equal(suite.metrics[metric].releaseScore.pairedN, 32);
  }
  assert.ok(suite.metrics.ndcgAtK.observed.delta > 0);
  assert.ok(suite.metrics.ndcgAtK.releaseScore.delta > 0);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /queries\.json SHA-256/);
  assert.match(markdown, /baseline-sha/);
  assert.match(markdown, /candidate-sha/);
  assert.match(markdown, /Recall@10 \| N\/A/);
  assert.match(markdown, /observed/);
  assert.match(markdown, /releaseScore/);
  assert.match(markdown, /首条延迟/);
  assert.match(markdown, /峰值 RSS/);
  const outDir = mkdtempSync(join(tmpdir(), "quality-report-"));
  try {
    const paths = writeQualityReport(report, outDir);
    assert.equal(JSON.parse(readFileSync(paths.jsonPath, "utf8")).format, "search-hub.quality.report/1");
    assert.equal(readFileSync(paths.markdownPath, "utf8"), markdown);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("failed, timeout and budget-exhausted sides exclude the whole pair and trigger attrition", () => {
  const queries = fixture();
  const live = liveReport(queries.queries);
  for (let index = 0; index < 9; index += 1) {
    const capture = live.pairs[index].captures.baseline;
    if (index === 0) {
      capture.ok = false;
      capture.errors = [{ code: "timeout", message: "deadline" }];
    } else if (index === 1) {
      capture.ok = false;
      capture.envelope.deepRounds = [{ budgetExhausted: true }];
    } else {
      capture.ok = false;
    }
  }
  const suite = reportFor(queries, live).suites[0];
  assert.equal(suite.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(suite.expectedPairs, 32);
  assert.equal(suite.pairedN, 23);
  assert.equal(suite.excludedN, 9);
  assert.ok(Math.abs(suite.attrition - 9 / 32) < 1e-10);
  assert.ok(suite.reasons.includes("attrition>20%"));
  assert.ok(suite.reasons.includes("pairedN<24"));
  assert.ok(suite.exclusions.find((item) => item.queryId === "q001").reasons.includes("baseline_timeout"));
  assert.ok(suite.exclusions.find((item) => item.queryId === "q002").reasons.includes("baseline_budget_exhausted"));
  assert.ok(suite.exclusions.find((item) => item.queryId === "q003").reasons.includes("baseline_failed"));
});

test("valid empty results are N/A in observed and zero only in releaseScore", () => {
  const queries = fixture();
  const live = liveReport(queries.queries);
  for (const pair of live.pairs) pair.captures.candidate.finalResults = [];
  const suite = reportFor(queries, live).suites[0];
  assert.equal(suite.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(suite.pairedN, 32);
  assert.equal(suite.excludedN, 0);
  assert.equal(suite.candidate.ndcgAtK.status, "na");
  assert.equal(suite.candidate.ndcgAtK.reason, "no_results");
  for (const metric of ["precisionAtK", "ndcgAtK", "mrrAtK"]) {
    assert.equal(suite.metrics[metric].observed.pairedN, 0);
    assert.equal(suite.metrics[metric].observed.candidateMean, null);
    assert.equal(suite.metrics[metric].releaseScore.pairedN, 32);
    assert.equal(suite.metrics[metric].releaseScore.candidateMean, 0);
  }
  assert.equal(suite.baseline.recallAtK.status, "na");
  assert.equal(suite.candidate.recallAtK.status, "na");
});

test("small samples and unjudged documents are excluded rather than filled with zero", () => {
  const small = fixture(8);
  const smallSuite = reportFor(small).suites[0];
  assert.equal(smallSuite.status, "INSUFFICIENT_EVIDENCE");
  assert.ok(smallSuite.reasons.includes("pairedN<24"));
  const tinySuite = reportFor(fixture(3)).suites[0];
  assert.ok(tinySuite.reasons.some((reason) => reason.includes("stratum:") && reason.endsWith("<4")));
  assert.ok(tinySuite.reasons.some((reason) => reason.includes("category:") && reason.endsWith("<8")));

  const queries = fixture();
  const live = liveReport(queries.queries);
  const unknown = "https://example.test/q001/unjudged";
  live.pairs[0].captures.baseline.finalResults = [
    { documentId: unknown, url: unknown, title: "Unknown" },
    ...documents(queries.queries[0], "baseline"),
  ];
  const suite = reportFor(queries, live).suites[0];
  const excluded = suite.exclusions.find((item) => item.queryId === "q001");
  assert.ok(excluded.reasons.includes("provisional_unjudged"));
  assert.ok(excluded.reasons.includes("provisional"));
  assert.equal(suite.perQuery[0].baseline.provisional, true);
  assert.equal(suite.perQuery[0].baseline.returnedCount, 2);
  assert.equal(suite.pairedN, 31);
});

test("same-snapshot algorithm comparisons remain separate from live suites", () => {
  const queries = fixture();
  const live = liveReport(queries.queries);
  const algorithm = {
    evidenceKind: "same_snapshot_algorithm_comparison",
    snapshotHash: "c".repeat(64),
    baselineCommit: "baseline-sha",
    candidateCommit: "candidate-sha",
    baselineConfigFingerprint: "baseline-config",
    candidateConfigFingerprint: "candidate-config",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    providers: ["alpha"],
    pairs: queries.queries.map((query) => ({
      queryId: query.queryId,
      baseline: { documents: documents(query, "baseline") },
      candidate: { documents: documents(query, "candidate") },
    })),
  };
  const report = reportFor(queries, live, {
    algorithmComparisons: [{ name: "same-snapshot", source: "algorithm.json", sourceSha256: "d".repeat(64), report: algorithm }],
  });
  assert.equal(report.suites.length, 2);
  assert.equal(report.suites[0].sameSnapshot, false);
  assert.equal(report.suites[1].sameSnapshot, true);
  assert.equal(report.suites[1].evidenceKind, "same_snapshot_algorithm_comparison");
  assert.equal(report.suites[1].pairedN, 32);
  assert.notEqual(report.suites[0].sourceSha256, report.suites[1].sourceSha256);

  const unverified = structuredClone(algorithm);
  delete unverified.snapshotHash;
  const invalid = reportFor(queries, live, {
    algorithmComparisons: [{ name: "unverified", source: "algorithm.json", sourceSha256: "d".repeat(64), report: unverified }],
  });
  assert.ok(invalid.suites[1].exclusions.every((item) => item.reasons.includes("snapshot_identity_unverified")));
  assert.equal(invalid.suites[1].status, "INSUFFICIENT_EVIDENCE");
});

test("multi-suite live capture files are split by suite and skipped suites remain insufficient", () => {
  const queries = fixture();
  const basic = liveReport(queries.queries);
  const rrf = liveReport(queries.queries);
  for (const pair of basic.pairs) pair.suiteId = "basic";
  for (const pair of rrf.pairs) pair.suiteId = "rrf";
  const combined = {
    ...basic,
    pairs: [...basic.pairs, ...rrf.pairs],
    suiteReports: [
      { suiteId: "basic", status: "completed", startedAt: basic.startedAt, finishedAt: basic.finishedAt },
      { suiteId: "rrf", status: "completed", startedAt: rrf.startedAt, finishedAt: rrf.finishedAt },
      { suiteId: "deep", status: "skipped", skipReason: "missing_chat_model", startedAt: basic.startedAt, finishedAt: basic.finishedAt },
    ],
  };
  const report = buildQualityReport({
    queries,
    queriesSha256: "a".repeat(64),
    live: [{ name: "combined", source: "combined.json", sourceSha256: "b".repeat(64), report: combined }],
    credentialScope: "public",
  });
  assert.deepEqual(report.suites.map((suite) => suite.name), ["basic", "rrf", "deep"]);
  assert.equal(report.suites[0].pairedN, 32);
  assert.equal(report.suites[1].pairedN, 32);
  assert.equal(report.suites[2].pairedN, 0);
  assert.equal(report.suites[2].excludedN, 32);
  assert.equal(report.suites[2].skipReason, "missing_chat_model");
  assert.equal(report.summary.qualityImprovementClaimAllowed, false);
  assert.match(renderMarkdown(report), /capture=skipped；skipReason=missing_chat_model/);
});

test("duplicate rows are reported without treating them as new documents", () => {
  const queries = fixture();
  const live = liveReport(queries.queries);
  const primary = documents(queries.queries[0], "baseline")[1];
  live.pairs[0].captures.baseline.finalResults.push(primary);
  const suite = reportFor(queries, live).suites[0];
  assert.equal(suite.perQuery[0].baseline.duplicateRows, 1);
  assert.ok(Math.abs(suite.perQuery[0].baseline.duplicateRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(suite.baseline.duplicateRate - 1 / 65) < 1e-9);
});
