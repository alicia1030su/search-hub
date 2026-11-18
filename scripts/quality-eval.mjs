#!/usr/bin/env node
/**
 * Offline search-quality gate.
 *
 * Three things this script is, and one it is not:
 *
 *  - it **is** a reproducible regression gate: same fixture, same code, same
 *    numbers on every machine, with no network and no API key;
 *  - it **is** the place where the metric maths is re-checked against
 *    hand-computed expectations, so a formula regression fails CI;
 *  - it **is** a comparison of fusion strategies over identical snapshots;
 *  - it is **not** a measurement of any real search vendor. Every number comes
 *    from a synthetic fixture whose URLs live under `*.fixture.test`.
 *
 * Exit codes: 0 pass, 1 regression or failed self-check, 2 bad usage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  aggregateMetric,
  compareRankings,
  coreFixture,
  costSummary,
  dcg,
  evaluateQuery,
  judgmentsForQuery,
  latencyStats,
  rankSnapshot,
  rrfCandidates,
  splitQueries,
} from "../packages/core/src/evaluation/index.ts";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
function has(name) {
  return args.includes(`--${name}`);
}

const outPath = flag("out", null);
const baselinePath = flag("baseline", null);
const maxDrop = Number(flag("max-drop", "0.02"));
const cutoff = Number(flag("cutoff", "10"));
const requireHoldout = !has("no-holdout");
const verbose = has("verbose");

if (!Number.isFinite(maxDrop) || maxDrop < 0) {
  console.error("--max-drop must be a non-negative number");
  process.exit(2);
}
if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 50) {
  console.error("--cutoff must be an integer between 1 and 50");
  process.exit(2);
}

const fixture = coreFixture();
const judgmentsByQuery = new Map();
for (const judgment of fixture.judgments) {
  const list = judgmentsByQuery.get(judgment.queryId) ?? [];
  list.push({ documentId: judgment.documentId, relevance: judgment.relevance });
  judgmentsByQuery.set(judgment.queryId, list);
}
const queryMeta = new Map(fixture.queries.map((query) => [query.id, query]));
const snapshots = new Map(fixture.snapshots.map((snapshot) => [snapshot.queryId, snapshot]));

const judged = fixture.queries.map((query) =>
  judgmentsForQuery(query.id, judgmentsByQuery.get(query.id) ?? [], fixture.dataset.judgmentsComplete),
);

// --------------------------------------------------------------- self-checks
// Hand-computed expectations. A failure here means the metric formula changed,
// not that the fixture got worse.
const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

const perfectJudgments = {
  queryId: "self",
  grades: new Map([
    ["https://a.fixture.test/1", 3],
    ["https://b.fixture.test/1", 2],
    ["https://c.fixture.test/1", 1],
  ]),
  relevantTotal: 2,
};
const perfect = evaluateQuery(
  ["https://a.fixture.test/1", "https://b.fixture.test/1", "https://c.fixture.test/1"],
  perfectJudgments,
  { cutoff: 10 },
);
check("nDCG@10 of an ideal ordering is 1", Math.abs(perfect.ndcgAtK.value - 1) < 1e-9, perfect.ndcgAtK.value);
check("P@10 of 2 relevant in 10 is 0.2", Math.abs(perfect.precisionAtK.value - 0.2) < 1e-9);
check("MRR@10 of a first-position hit is 1", Math.abs(perfect.mrrAtK.value - 1) < 1e-9);
check("Recall@10 of 2 of 2 is 1", Math.abs(perfect.recallAtK.value - 1) < 1e-9);

const reversed = evaluateQuery(
  ["https://c.fixture.test/1", "https://b.fixture.test/1", "https://a.fixture.test/1"],
  perfectJudgments,
  { cutoff: 10 },
);
check("nDCG drops when the ranking is reversed", reversed.ndcgAtK.value < perfect.ndcgAtK.value);

const handDcg = 7 / Math.log2(2) + 3 / Math.log2(3) + 1 / Math.log2(4);
check("DCG uses 2^rel - 1 and log2(i + 1)", Math.abs(dcg([3, 2, 1], 10) - handDcg) < 1e-12, handDcg);

const shallowRecall = evaluateQuery(
  ["https://a.fixture.test/1"],
  { queryId: "self", grades: new Map([["https://a.fixture.test/1", 3]]), relevantTotal: null },
  { cutoff: 10 },
).recallAtK;
check("recall is N/A when the qrels are incomplete", shallowRecall.status === "na" && shallowRecall.reason === "qrels_incomplete");

const unjudged = evaluateQuery(
  ["https://x.fixture.test/unjudged", "https://a.fixture.test/1"],
  { queryId: "self", grades: new Map([["https://a.fixture.test/1", 3]]), relevantTotal: 1 },
  { cutoff: 10 },
);
check("an unjudged document is excluded, not scored as 0", unjudged.provisional && unjudged.mrrAtK.value === 1);

const noJudgments = evaluateQuery(["https://a.fixture.test/1"], { queryId: "self", grades: new Map(), relevantTotal: null });
check("a query with no judgments is N/A, not 0", noJudgments.precisionAtK.status === "na");

const emptyLatency = latencyStats([]);
check("empty latency is N/A, not 0", emptyLatency.p50 === null);
const unknownCost = costSummary({ requests: 10, cacheHits: 0, requestsByProvider: { alpha: 10 } });
check("unspecified cost is unknown, not 0", unknownCost.unknownCost && unknownCost.knownCost === null);

// ------------------------------------------------------------------ rankings
function evaluateFusion(fusion, queryIds) {
  const perQuery = [];
  const ranked = [];
  for (const entry of judged) {
    if (queryIds && !queryIds.has(entry.queryId)) continue;
    const snapshot = snapshots.get(entry.queryId);
    if (!snapshot) continue;
    const list = rankSnapshot(snapshot, fusion, { limit: cutoff });
    ranked.push(list);
    perQuery.push(
      evaluateQuery(
        list.documents.map((document) => document.documentId),
        { queryId: entry.queryId, grades: entry.grades, relevantTotal: entry.relevantTotal },
        { cutoff },
      ),
    );
  }
  return {
    ranked,
    perQuery,
    metrics: {
      precisionAtK: aggregateMetric(perQuery, "precisionAtK"),
      recallAtK: aggregateMetric(perQuery, "recallAtK"),
      mrrAtK: aggregateMetric(perQuery, "mrrAtK"),
      ndcgAtK: aggregateMetric(perQuery, "ndcgAtK"),
    },
  };
}

const allQueryIds = new Set(fixture.queries.map((query) => query.id));
const split = splitQueries([...allQueryIds], 0.5);
const developmentIds = new Set(split.development);
const holdoutIds = new Set(split.holdout);

const strategies = [
  { name: "single:alpha", fusion: { strategy: "single", providerId: "alpha" } },
  { name: "base", fusion: { strategy: "base" } },
  { name: "rrf:k=60", fusion: { strategy: "rrf", k: 60 } },
];
for (const candidate of rrfCandidates()) {
  if (candidate.k === 60) continue;
  strategies.push({ name: `rrf:k=${candidate.k}`, fusion: candidate });
}

const full = new Map();
for (const strategy of strategies) {
  full.set(strategy.name, evaluateFusion(strategy.fusion));
}

// Development half chooses the k; the holdout half reports it.
const developmentScores = [];
for (const candidate of rrfCandidates()) {
  const result = evaluateFusion({ strategy: "rrf", k: candidate.k }, developmentIds);
  developmentScores.push({ k: candidate.k, ndcgAtK: result.metrics.ndcgAtK });
}
let chosenK = null;
let best = -Infinity;
for (const entry of developmentScores) {
  if (entry.ndcgAtK.status !== "ok") continue;
  if (entry.ndcgAtK.value > best) {
    best = entry.ndcgAtK.value;
    chosenK = entry.k;
  }
}

const baselineHoldout = evaluateFusion({ strategy: "rrf", k: 60 }, holdoutIds);
const chosenHoldout =
  chosenK === null ? null : evaluateFusion({ strategy: "rrf", k: chosenK }, holdoutIds);
const holdoutComparison =
  chosenHoldout === null
    ? null
    : compareRankings({
        metric: "ndcgAtK",
        baseline: baselineHoldout.ranked,
        candidate: chosenHoldout.ranked,
        judgments: judged.filter((entry) => holdoutIds.has(entry.queryId)),
        metricsFor: (ranked, judgment) =>
          evaluateQuery(
            ranked.documents.map((document) => document.documentId),
            { queryId: judgment.queryId, grades: judgment.grades, relevantTotal: judgment.relevantTotal },
            { cutoff },
          ),
      });

// ---------------------------------------------------------------- regression
const report = {
  format: "search-hub.quality.report/1",
  generatedAt: new Date().toISOString(),
  origin: fixture.dataset.origin,
  dataset: {
    id: fixture.dataset.id,
    name: fixture.dataset.name,
    version: fixture.dataset.version,
    queries: fixture.queries.length,
    judgments: fixture.judgments.length,
    judgmentsComplete: fixture.dataset.judgmentsComplete,
  },
  cutoff,
  note:
    "Synthetic fixture: these numbers validate the evaluation machinery and guard against ranking regressions. They are not a measurement of any real search vendor.",
  selfChecks: checks,
  strategies: Object.fromEntries(
    [...full.entries()].map(([name, result]) => [
      name,
      {
        fusion: strategies.find((item) => item.name === name).fusion,
        metrics: result.metrics,
        perCategory: categoryBreakdown(result.perQuery),
        response: responseSignals(result.ranked),
      },
    ]),
  ),
  selection: {
    split: { development: split.development.length, holdout: split.holdout.length },
    developmentScores,
    chosenK,
    holdout: holdoutComparison,
    evidence:
      holdoutComparison === null
        ? "INSUFFICIENT_EVIDENCE"
        : holdoutComparison.verdict === "insufficient_evidence"
          ? "INSUFFICIENT_EVIDENCE"
          : "sufficient",
  },
};

function categoryBreakdown(perQuery) {
  const byCategory = new Map();
  for (const metrics of perQuery) {
    const meta = queryMeta.get(metrics.queryId);
    const category = meta?.category ?? "general";
    const list = byCategory.get(category) ?? [];
    list.push(metrics);
    byCategory.set(category, list);
  }
  return Object.fromEntries(
    [...byCategory.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([category, list]) => [category, { nDCG: aggregateMetric(list, "ndcgAtK"), queries: list.length }]),
  );
}

function responseSignals(rankedLists) {
  const counts = rankedLists.map((list) => list.documents.length);
  const total = counts.reduce((sum, value) => sum + value, 0);
  return {
    resultCount: counts.length === 0 ? null : Number((total / counts.length).toFixed(4)),
    emptyResultRate: counts.filter((value) => value === 0).length / Math.max(1, counts.length),
  };
}

const failedChecks = checks.filter((item) => !item.passed);
if (failedChecks.length > 0) {
  console.error("quality:self-check failed:");
  for (const item of failedChecks) console.error(`  - ${item.name}`);
  if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.exit(1);
}

// Regression against a previous report of the same format.
let regression = null;
if (baselinePath) {
  let previous;
  try {
    previous = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (error) {
    console.error(`cannot read --baseline ${baselinePath}: ${error.message}`);
    process.exit(2);
  }
  const metric = "ndcgAtK";
  const before = previous?.strategies?.["rrf:k=60"]?.metrics?.[metric]?.value ?? null;
  const after = report.strategies["rrf:k=60"].metrics[metric].value ?? null;
  if (before === null || after === null) {
    regression = {
      metric,
      before,
      after,
      delta: null,
      status: "INSUFFICIENT_EVIDENCE",
      note: "one side has no measured value; no regression verdict is possible",
    };
  } else {
    const delta = Number((after - before).toFixed(6));
    regression = {
      metric,
      before,
      after,
      delta,
      status: delta < -maxDrop ? "REGRESSION" : "ok",
      threshold: maxDrop,
    };
  }
  report.regression = regression;
}

if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

// ---------------------------------------------------------------------- print
const line = (label, metrics) =>
  `${label.padEnd(12)} nDCG@${cutoff}=${fmt(metrics.ndcgAtK)} MRR@${cutoff}=${fmt(metrics.mrrAtK)} P@${cutoff}=${fmt(metrics.precisionAtK)} R@${cutoff}=${fmt(metrics.recallAtK)}`;
function fmt(metric) {
  if (metric.status === "na") return `N/A (${metric.reason})`;
  return metric.value.toFixed(4);
}

if (verbose) {
  console.log("self-checks:");
  for (const item of checks) console.log(`  ${item.passed ? "PASS" : "FAIL"}  ${item.name}`);
  console.log("");
  console.log("strategies (all 14 fixture queries):");
  for (const [name, result] of full) console.log(`  ${line(name, result.metrics)}`);
  console.log("");
  console.log(`selection: development=${split.development.length} holdout=${split.holdout.length} chosen k=${chosenK}`);
  console.log(`holdout verdict: ${report.selection.evidence}${holdoutComparison ? ` (${holdoutComparison.verdict})` : ""}`);
  if (regression) console.log(`regression: ${regression.status} ${JSON.stringify(regression)}`);
} else {
  console.log(`quality:eval — ${fixture.dataset.origin}, ${fixture.queries.length} queries, ${fixture.judgments.length} judgments`);
  for (const [name, result] of full) console.log(`  ${line(name, result.metrics)}`);
  console.log(`  selection: dev=${split.development.length} holdout=${split.holdout.length} k=${chosenK} evidence=${report.selection.evidence}`);
}

if (regression && regression.status === "REGRESSION") {
  console.error(
    `\nREGRESSION: nDCG@${cutoff} for rrf:k=60 fell from ${regression.before} to ${regression.after} (delta ${regression.delta}, threshold -${maxDrop})`,
  );
  process.exit(1);
}

if (requireHoldout && report.selection.evidence === "INSUFFICIENT_EVIDENCE") {
  // Not a failure: the fixture is small by design and the honest answer is that
  // the holdout cannot separate the candidates. Say it, do not fake a winner.
  console.log("\nINSUFFICIENT_EVIDENCE: the holdout split cannot support a winner claim.");
}

console.log(`\nPASS: metric self-checks ${checks.length}/${checks.length}${outPath ? `, report written to ${outPath}` : ""}`);
process.exit(0);
