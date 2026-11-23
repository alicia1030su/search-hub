#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function read(file) { return JSON.parse(readFileSync(file, "utf8")); }
function percentile(values, fraction) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  return valid.length ? valid[Math.max(0, Math.ceil(valid.length * fraction) - 1)] : null;
}
function ratio(baseline, candidate) {
  return Number.isFinite(baseline) && baseline !== 0 ? (candidate - baseline) / baseline : null;
}

const artifactsDir = arg("artifacts-dir", path.join(repoRoot, "artifacts", "v0.1.14"));
const templatePath = arg("template", path.join(artifactsDir, "candidate", "cache-verdict.json"));
const outputPath = arg("output", templatePath);
const template = read(templatePath);
const baseline = {
  capacity: read(path.join(artifactsDir, "baseline", "cache-capacity.json")),
  hit: read(path.join(artifactsDir, "baseline", "cache-hit.json")),
  stampede: read(path.join(artifactsDir, "baseline", "cache-stampede.json")),
  storage: read(path.join(artifactsDir, "baseline", "cache-storage.json")),
};
const candidate = {
  capacity: read(path.join(artifactsDir, "candidate", "cache-capacity.json")),
  hit: read(path.join(artifactsDir, "candidate", "cache-hit.json")),
  stampede: read(path.join(artifactsDir, "candidate", "cache-stampede.json")),
  storage: read(path.join(artifactsDir, "candidate", "cache-storage.json")),
};
const candidateCommit = candidate.hit.metadata?.sourceCommit ?? candidate.capacity.metadata?.sourceCommit;
if (!/^[0-9a-f]{40}$/.test(candidateCommit ?? "")) throw new Error("candidate sourceCommit missing");
for (const report of Object.values(candidate)) {
  if ((report.metadata?.sourceCommit ?? report.sourceCommit) !== candidateCommit) throw new Error("candidate benchmark commit mismatch");
}
const hitRounds = candidate.hit.rounds;
const storageRounds = candidate.storage.rounds;
const baselineHitRounds = baseline.hit.rounds;
const baselineStorageRounds = baseline.storage.rounds;
const candidateP95Median = percentile(hitRounds.map((round) => round.p95Ms), 0.5);
const candidateP95Max = Math.max(...hitRounds.map((round) => round.p95Ms));
const candidateRssMedian = percentile(hitRounds.map((round) => round.rssPeakBytes), 0.5);
const candidateRssMax = Math.max(...hitRounds.map((round) => round.rssPeakBytes));
const candidateSql = percentile(hitRounds.map((round) => round.mutatingSqlPer1000Hits), 0.5);
const baselineP95Median = percentile(baselineHitRounds.map((round) => round.p95Ms), 0.5);
const baselineP95Max = Math.max(...baselineHitRounds.map((round) => round.p95Ms));
const baselineRssMedian = percentile(baselineHitRounds.map((round) => round.rssPeakBytes), 0.5);
const baselineRssMax = Math.max(...baselineHitRounds.map((round) => round.rssPeakBytes));
const baselineSql = percentile(baselineHitRounds.map((round) => round.mutatingSqlPer1000Hits), 0.5);
const rssGatePassed = ratio(baselineRssMedian, candidateRssMedian) <= 0.05 && ratio(baselineRssMax, candidateRssMax) <= 0.05;
const p95GatePassed = ratio(baselineP95Median, candidateP95Median) <= 0.05 && ratio(baselineP95Max, candidateP95Max) <= 0.05;
const sqlGatePassed = candidateSql < baselineSql;
const maintenanceMedian = percentile(storageRounds.map((round) => round.maintenanceMs), 0.5);
const maintenanceMax = Math.max(...storageRounds.map((round) => round.maintenanceMs));
const baselineMaintenanceMedian = percentile(baselineStorageRounds.map((round) => round.maintenanceMs), 0.5);
const baselineMaintenanceMax = Math.max(...baselineStorageRounds.map((round) => round.maintenanceMs));
const capacityPassed = candidate.capacity.invariantPassed === true && candidate.capacity.otherTablesUnchanged === true &&
  candidate.capacity.actual.entries <= candidate.capacity.fixture.maxEntries && candidate.capacity.actual.bytes <= candidate.capacity.fixture.maxBytes;
const stampedePassed = candidate.stampede.completed === true && candidate.stampede.consistent === true && candidate.stampede.upstreamCalls < baseline.stampede.upstreamCalls;
const storagePassed = maintenanceMedian <= baselineMaintenanceMedian && maintenanceMax <= baselineMaintenanceMax;
const verdict = {
  ...template,
  candidateCommit,
  candidateBenchmarkCommits: { cacheHit: candidateCommit, cacheStampede: candidateCommit, cacheStorage: candidateCommit, cacheCapacity: candidateCommit },
  machine: `${candidate.hit.metadata.machine.platform} ${candidate.hit.metadata.machine.arch}, Node ${candidate.hit.metadata.node}, pnpm ${candidate.hit.metadata.pnpm}, ${candidate.hit.metadata.machine.cpus} logical CPUs`,
  C01: {
    status: capacityPassed ? "PASS" : "FAIL",
    baseline: { entries: baseline.capacity.actual.entries, bytes: baseline.capacity.actual.bytes },
    candidate: { entries: candidate.capacity.actual.entries, bytes: candidate.capacity.actual.bytes, evicted: candidate.capacity.put.evicted },
    limits: { maxEntries: candidate.capacity.fixture.maxEntries, maxBytes: candidate.capacity.fixture.maxBytes },
    otherTablesUnchanged: candidate.capacity.otherTablesUnchanged,
  },
  C08: {
    status: rssGatePassed ? (p95GatePassed && sqlGatePassed ? "PASS" : "PASS_NO_OPTIMIZATION") : "FAIL",
    evidenceCommit: candidateCommit,
    baselineMutatingSqlPer1000Hits: baselineSql,
    candidateMutatingSqlPer1000Hits: candidateSql,
    sqlReductionRatio: baselineSql ? (baselineSql - candidateSql) / baselineSql : 0,
    baselineP95MsMedian: baselineP95Median,
    candidateP95MsMedian: candidateP95Median,
    p95MedianChangeRatio: ratio(baselineP95Median, candidateP95Median),
    baselineP95MsMax: baselineP95Max,
    candidateP95MsMax: candidateP95Max,
    p95MaxChangeRatio: ratio(baselineP95Max, candidateP95Max),
    baselineRssPeakBytesMedian: baselineRssMedian,
    candidateRssPeakBytesMedian: candidateRssMedian,
    rssMedianChangeRatio: ratio(baselineRssMedian, candidateRssMedian),
    baselineRssPeakBytesMax: baselineRssMax,
    candidateRssPeakBytesMax: candidateRssMax,
    rssMaxChangeRatio: ratio(baselineRssMax, candidateRssMax),
    rssGatePassed,
    p95GatePassed,
    sqlGatePassed,
    decision: rssGatePassed ? "RSS stayed within the 5% gate; SQL/P95 optimization gates are reported independently." : "RSS regression exceeded the 5% gate.",
  },
  C09: {
    status: stampedePassed ? "PASS" : "FAIL",
    baselineUpstreamCalls: baseline.stampede.upstreamCalls,
    candidateUpstreamCalls: candidate.stampede.upstreamCalls,
    responseCount: candidate.stampede.responseCount,
    consistent: candidate.stampede.consistent,
    baselineP95Ms: baseline.stampede.p95Ms,
    candidateP95Ms: candidate.stampede.p95Ms,
    candidateRssPeakBytes: candidate.stampede.rssPeakBytes,
    candidateMutatingSql: candidate.stampede.mutatingSql,
    candidateCommits: candidate.stampede.commits,
    candidateDbFileBytes: candidate.stampede.dbFileBytes,
    candidateWalFileBytes: candidate.stampede.walFileBytes,
  },
  C12: {
    status: storagePassed ? "PASS" : "FAIL",
    baselineMaintenanceMedianMs: baselineMaintenanceMedian,
    candidateMaintenanceMedianMs: maintenanceMedian,
    baselineMaintenanceMaxMs: baselineMaintenanceMax,
    candidateMaintenanceMaxMs: maintenanceMax,
    baselineDbFileBytes: baselineStorageRounds.at(-1)?.dbFileBytes ?? null,
    candidateDbFileBytes: storageRounds.at(-1)?.dbFileBytes ?? null,
    baselineWalFileBytes: baselineStorageRounds.at(-1)?.walFileBytes ?? null,
    candidateWalFileBytes: storageRounds.at(-1)?.walFileBytes ?? null,
    osPageCacheBytes: null,
    osPageCacheReason: "page_cache_not_reliably_attributable",
    vacuumPerformed: storageRounds.every((round) => round.vacuumPerformed === false),
  },
};
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, candidateCommit, C01: verdict.C01.status, C08: verdict.C08.status, C09: verdict.C09.status, C12: verdict.C12.status }, null, 2));
