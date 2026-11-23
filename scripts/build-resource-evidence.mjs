#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyEvidence } from "../packaging/verify-resource-evidence.mjs";
import {
  BASELINE_COMMIT, BENCHMARK_COMMIT, EVIDENCE_VERSION, RAW_BENCHMARKS,
  changedPaths, codeFingerprint, createRawFile, gzipJson, machineFingerprint, readGzipJson,
  resolveCommit, sanitizeEvidence, scopeFingerprint, sha256, validateStatus,
} from "./lib/resource-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HISTORICAL_RELEASE_COMMIT = "c35778169bde2737e566f53aa176abfa10519d27";
const COMMANDS = Object.freeze({
  cacheCapacity: "node --import tsx scripts/bench-cache-capacity.mjs --label {label}",
  cacheHit: "node --import tsx scripts/bench-cache-hit.mjs --requests 20000 --repeat 5 --label {label}",
  cacheStampede: "node --import tsx scripts/bench-cache-stampede.mjs --concurrency 100 --label {label}",
  cacheStorage: "node --import tsx scripts/bench-cache-storage.mjs --repeat 5 --label {label}",
});
const VERDICT_KEYS = Object.freeze({ cacheCapacity: "C01", cacheHit: "C08", cacheStampede: "C09", cacheStorage: "C12" });

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function median(values) {
  return percentile(values.filter((value) => Number.isFinite(value)), 0.5);
}

function max(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length > 0 ? Math.max(...valid) : null;
}

function benchmarkSummary(name, report) {
  if (name === "cacheCapacity") return { actual: report.actual, invariantPassed: report.invariantPassed, otherTablesUnchanged: report.otherTablesUnchanged, cacheTablesExcluded: report.cacheTablesExcluded, exitCode: report.exitCode };
  if (name === "cacheHit") return report.summary;
  if (name === "cacheStampede") {
    return {
      upstreamCalls: report.upstreamCalls,
      responseCount: report.responseCount,
      consistent: report.consistent,
      completed: report.completed,
      p50Ms: report.p50Ms,
      p95Ms: report.p95Ms,
      rssPeakBytes: report.rssPeakBytes,
      mutatingSql: report.mutatingSql,
      commits: report.commits,
      dbFileBytes: report.dbFileBytes,
      walFileBytes: report.walFileBytes,
    };
  }
  const rounds = Array.isArray(report.rounds) ? report.rounds : [];
  return {
    rounds: rounds.length,
    maintenanceMsMedian: median(rounds.map((round) => round.maintenanceMs)),
    maintenanceMsMax: max(rounds.map((round) => round.maintenanceMs)),
    dbFileBytes: rounds.at(-1)?.dbFileBytes ?? null,
    walFileBytes: rounds.at(-1)?.walFileBytes ?? null,
    vacuumPerformed: rounds.some((round) => round.vacuumPerformed === true),
  };
}

function commitAtRun(name, label, report, fallback) {
  return report.metadata?.sourceCommit ?? report.sourceCommit ?? (name === "cacheCapacity" && label === "baseline" ? BASELINE_COMMIT : fallback);
}

function environmentFrom(reports, pkg) {
  const metadata = reports.cacheHit.candidate.metadata ?? reports.cacheStampede.candidate.metadata ?? {};
  const machine = metadata.machine ?? {};
  return sanitizeEvidence({
    platform: machine.platform ?? null,
    arch: machine.arch ?? null,
    cpus: machine.cpus ?? null,
    totalMemoryBytes: machine.totalMemoryBytes ?? null,
    node: metadata.node ?? null,
    pnpm: metadata.pnpm ?? null,
    vitest: typeof pkg.devDependencies?.vitest === "string" ? pkg.devDependencies.vitest.replace(/^[^0-9]+/, "") : null,
    playwright: pkg.devDependencies?.["@playwright/test"] ?? null,
    sqlite: "better-sqlite3/WAL",
    paidVendor: false,
  });
}

function protocolFrom(reports) {
  const hit = reports.cacheHit.candidate.metadata ?? {};
  const stampede = reports.cacheStampede.candidate.metadata ?? {};
  const storage = reports.cacheStorage.candidate.metadata ?? {};
  return sanitizeEvidence({
    percentile: "nearest-rank",
    fixture: "fixed-local-no-paid-vendor",
    requests: hit.requests ?? null,
    repeat: hit.repeat ?? null,
    concurrency: stampede.concurrency ?? 1,
    testConcurrency: hit.testConcurrency ?? 1,
    storageRepeat: storage.repeat ?? null,
    warmupHits: 100,
  });
}

export function buildSummary({ repoRoot, releaseRef, artifactsDir, reports, verdict, pkg, generatedAt = new Date().toISOString() }) {
  const releaseCommit = resolveCommit(repoRoot, releaseRef);
  const baselineCommit = BASELINE_COMMIT;
  const benchmarkCommit = BENCHMARK_COMMIT;
  const releaseCode = codeFingerprint(repoRoot, releaseCommit);
  const benchmarkCode = codeFingerprint(repoRoot, benchmarkCommit);
  const baselineCode = codeFingerprint(repoRoot, baselineCommit);
  const baselineMachine = machineFingerprint(reports.cacheHit.baseline.metadata?.machine ?? reports.cacheCapacity.candidate.metadata?.machine ?? {});
  const benchmarkMachine = machineFingerprint(reports.cacheHit.candidate.metadata?.machine ?? reports.cacheStampede.candidate.metadata?.machine ?? {});
  const delta = changedPaths(repoRoot, benchmarkCommit, releaseCommit);
  const relevant = delta.filter((entry) => RAW_BENCHMARKS.some((name) => {
    const atBenchmark = scopeFingerprint(repoRoot, benchmarkCommit, name);
    const atRelease = scopeFingerprint(repoRoot, releaseCommit, name);
    return atBenchmark !== atRelease;
  }));

  const benchmarks = {};
  for (const name of RAW_BENCHMARKS) {
    const baseline = reports[name].baseline;
    const candidate = reports[name].candidate;
    const candidateCommit = commitAtRun(name, "candidate", candidate, benchmarkCommit);
    const atBenchmark = scopeFingerprint(repoRoot, candidateCommit, name);
    const atRelease = scopeFingerprint(repoRoot, releaseCommit, name);
    const applicable = atBenchmark === atRelease;
    const verdictStatus = verdict[VERDICT_KEYS[name]]?.status ?? "FAIL";
    validateStatus(verdictStatus);
    const status = applicable ? verdictStatus : "BLOCKED";
    benchmarks[name] = {
      command: COMMANDS[name],
      status,
      baseline: { commitAtRun: commitAtRun(name, "baseline", baseline, baselineCommit) },
      candidate: { commitAtRun: candidateCommit },
      rounds: Array.isArray(candidate.rounds) ? candidate.rounds.length : 1,
      summary: benchmarkSummary(name, candidate),
      scopeFingerprint: { atBenchmark, atRelease, applicable },
      rawFiles: [
        `raw/${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-baseline.json.gz`,
        `raw/${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-candidate.json.gz`,
      ],
    };
  }

  const candidateCapacity = reports.cacheCapacity.candidate;
  const baselineCapacity = reports.cacheCapacity.baseline;
  const summary = {
    schemaVersion: 1,
    suite: `search-hub-resource-${EVIDENCE_VERSION}`,
    generatedAt,
    baseline: { commit: baselineCommit, codeFingerprint: baselineCode, machineFingerprint: baselineMachine },
    benchmarkCode: { commit: benchmarkCommit, codeFingerprint: benchmarkCode, machineFingerprint: benchmarkMachine },
    releaseCode: { codeFingerprint: releaseCode, computedFromRef: releaseRef, computedAt: generatedAt },
    environment: environmentFrom(reports, pkg),
    protocol: protocolFrom(reports),
    benchmarks,
    cacheCapacity: {
      maxEntries: candidateCapacity.fixture?.maxEntries ?? null,
      maxBytes: candidateCapacity.fixture?.maxBytes ?? null,
      baselineEntriesAfter: baselineCapacity.actual?.entries ?? null,
      baselineBytesAfter: baselineCapacity.actual?.bytes ?? null,
      candidateEntriesAfter: candidateCapacity.actual?.entries ?? null,
      candidateBytesAfter: candidateCapacity.actual?.bytes ?? null,
      candidateWithinLimits: candidateCapacity.invariantPassed === true,
      otherTablesUnchanged: candidateCapacity.otherTablesUnchanged ?? verdict.C01?.otherTablesUnchanged ?? null,
    },
    codeDelta: {
      from: benchmarkCommit,
      to: releaseRef,
      changedPaths: delta,
      benchmarkRelevantChangedPaths: relevant,
    },
    verdict: {
      source: `artifacts/${EVIDENCE_VERSION}/candidate/cache-verdict.json`,
      sha256: null,
      bytes: null,
      checks: Object.fromEntries(Object.entries(verdict).filter(([key]) => /^C\d+$/.test(key)).map(([key, value]) => [key, sanitizeEvidence(value)])),
    },
    rawFiles: [],
  };
  return summary;
}

function historicalRuntimeSummary(sourceDir, releaseRef, pkg) {
  const previous = readJson(path.join(sourceDir, "cache-benchmark-summary.json"));
  const reports = {};
  for (const name of RAW_BENCHMARKS) {
    const benchmark = previous.benchmarks?.[name];
    if (!Array.isArray(benchmark?.rawFiles) || benchmark.rawFiles.length !== 2) throw new Error(`historical_raw_files_missing:${name}`);
    reports[name] = {
      baseline: readGzipJson(readFileSync(path.join(sourceDir, benchmark.rawFiles[0]))).value,
      candidate: readGzipJson(readFileSync(path.join(sourceDir, benchmark.rawFiles[1]))).value,
    };
  }
  const summary = buildSummary({ repoRoot: REPO_ROOT, releaseRef, artifactsDir: sourceDir, reports, verdict: previous.verdict?.checks ?? {}, pkg });
  summary.verdict.sha256 = previous.verdict?.sha256 ?? null;
  summary.verdict.bytes = previous.verdict?.bytes ?? null;
  summary.historicalRawEvidence = {
    suite: previous.suite,
    generatedAt: previous.generatedAt,
    releaseCode: previous.releaseCode,
    sourceDir: path.relative(REPO_ROOT, sourceDir).replaceAll("\\", "/"),
  };
  return summary;
}

function parseArgs(args) {
  const options = {
    artifactsDir: arg("artifacts-dir", path.join(REPO_ROOT, "artifacts", EVIDENCE_VERSION)),
    releaseRef: arg("release-ref", "HEAD"),
    outputDir: arg("output-dir", path.join(REPO_ROOT, "docs", "evidence", EVIDENCE_VERSION)),
    sourceEvidenceDir: arg("source-evidence-dir", path.join(REPO_ROOT, "docs", "evidence", EVIDENCE_VERSION)),
    runtimeOutput: arg("runtime-output"),
    runtimeOnly: args.includes("--runtime-only"),
  };
  if (!options.artifactsDir || !options.releaseRef || !options.outputDir) throw new Error("artifacts-dir/release-ref/output-dir are required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.runtimeOnly && path.resolve(options.sourceEvidenceDir) === path.resolve(options.outputDir)) throw new Error("runtime-only output must not overwrite historical evidence");
  mkdirSync(options.outputDir, { recursive: true });
  const summaryPath = path.join(options.outputDir, "cache-benchmark-summary.json");
  const sumsPath = path.join(options.outputDir, "SHA256SUMS");
  let summary;
  let rawDescriptors = [];
  if (options.runtimeOnly) {
    verifyEvidence({
      repoRoot: REPO_ROOT,
      commit: HISTORICAL_RELEASE_COMMIT,
      summaryPath: path.join(options.sourceEvidenceDir, "cache-benchmark-summary.json"),
      sumsPath: path.join(options.sourceEvidenceDir, "SHA256SUMS"),
      evidenceDir: options.sourceEvidenceDir,
    });
    const previous = readJson(path.join(options.sourceEvidenceDir, "cache-benchmark-summary.json"));
    rawDescriptors = previous.rawFiles;
    if (!Array.isArray(rawDescriptors) || rawDescriptors.length !== 8) throw new Error("historical_raw_descriptors_missing");
    for (const descriptor of rawDescriptors) {
      const target = path.join(options.outputDir, descriptor.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(options.sourceEvidenceDir, descriptor.path)));
    }
    summary = historicalRuntimeSummary(options.sourceEvidenceDir, options.releaseRef, readJson(path.join(REPO_ROOT, "package.json")));
    summary.rawFiles = rawDescriptors;
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } else {
    const reports = {};
    for (const name of RAW_BENCHMARKS) {
      const fileStem = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      reports[name] = {
        baseline: readJson(path.join(options.artifactsDir, "baseline", `${fileStem}.json`)),
        candidate: readJson(path.join(options.artifactsDir, "candidate", `${fileStem}.json`)),
      };
    }
    const verdictPath = path.join(options.artifactsDir, "candidate", "cache-verdict.json");
    const verdictBytes = readFileSync(verdictPath);
    const verdict = JSON.parse(verdictBytes.toString("utf8"));
    const pkg = readJson(path.join(REPO_ROOT, "package.json"));
    summary = buildSummary({ repoRoot: REPO_ROOT, releaseRef: options.releaseRef, artifactsDir: options.artifactsDir, reports, verdict, pkg });
    summary.verdict.sha256 = sha256(verdictBytes);
    summary.verdict.bytes = verdictBytes.byteLength;
    for (const name of RAW_BENCHMARKS) {
      const fileStem = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      for (const label of ["baseline", "candidate"]) {
        const relativePath = `raw/${fileStem}-${label}.json.gz`;
        const raw = createRawFile(relativePath, path.join(options.artifactsDir, label, `${fileStem}.json`));
        mkdirSync(path.dirname(path.join(options.outputDir, relativePath)), { recursive: true });
        writeFileSync(path.join(options.outputDir, relativePath), raw.compressed);
        rawDescriptors.push(raw.descriptor);
      }
    }
    summary.rawFiles = rawDescriptors;
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  const summaryBytes = readFileSync(summaryPath);
  const sums = [
    `${sha256(summaryBytes)}  cache-benchmark-summary.json`,
    ...rawDescriptors.map((entry) => `${entry.sha256}  ${entry.path}`),
  ].sort((a, b) => a.localeCompare(b));
  writeFileSync(sumsPath, `${sums.join("\n")}\n`, "utf8");
  const sumsBytes = readFileSync(sumsPath);
  const runtime = {
    schemaVersion: 1,
    suite: summary.suite,
    generatedAt: new Date().toISOString(),
    releaseCommit: resolveCommit(REPO_ROOT, options.releaseRef),
    releaseCodeFingerprint: summary.releaseCode.codeFingerprint,
    benchmarkCommit: summary.benchmarkCode.commit,
    summarySha256: sha256(summaryBytes),
    sumsSha256: sha256(sumsBytes),
    rawFileCount: rawDescriptors.length,
  };
  if (options.runtimeOutput) {
    mkdirSync(path.dirname(options.runtimeOutput), { recursive: true });
    writeFileSync(options.runtimeOutput, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ summaryPath, sumsPath, runtimeOutput: options.runtimeOutput, releaseCommit: runtime.releaseCommit, rawFileCount: runtime.rawFileCount }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
