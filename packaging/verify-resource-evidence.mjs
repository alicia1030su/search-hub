#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BASELINE_COMMIT, BENCHMARK_COMMIT, RAW_BENCHMARKS, STATUSES,
  assertPublicEvidence, codeFingerprint, readGzipJson, resolveCommit, scopeFingerprint, sha256,
} from "../scripts/lib/resource-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function parseSums(text) {
  const entries = [];
  for (const line of text.split("\n").map((value) => value.trim()).filter(Boolean)) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) throw new Error(`invalid_sha256_line:${line}`);
    entries.push({ sha256: match[1], path: match[2] });
  }
  return entries;
}

export function verifyEvidence({ repoRoot = REPO_ROOT, commit, summaryPath, sumsPath, evidenceDir }) {
  check(/^[0-9a-f]{40}$/i.test(commit ?? ""), "commit must be a full SHA");
  check(existsSync(summaryPath), `summary_missing:${summaryPath}`);
  check(existsSync(sumsPath), `sums_missing:${sumsPath}`);
  const summaryBytes = readFileSync(summaryPath);
  const summary = JSON.parse(summaryBytes.toString("utf8"));
  assertPublicEvidence(summary);
  check(summary.schemaVersion === 1, "unsupported summary schema");
  check(summary.suite === "search-hub-resource-v0.1.14", "unexpected evidence suite");
  check(summary.baseline?.commit === BASELINE_COMMIT, "baseline commit mismatch");
  check(summary.benchmarkCode?.commit === BENCHMARK_COMMIT, "benchmark commit mismatch");
  check(summary.releaseCode?.codeFingerprint === codeFingerprint(repoRoot, commit), "release code fingerprint mismatch");
  check(summary.benchmarkCode?.codeFingerprint === codeFingerprint(repoRoot, BENCHMARK_COMMIT), "benchmark code fingerprint mismatch");
  check(summary.baseline?.codeFingerprint === codeFingerprint(repoRoot, BASELINE_COMMIT), "baseline code fingerprint mismatch");
  check(summary.baseline?.machineFingerprint === summary.benchmarkCode?.machineFingerprint, "machine fingerprint mismatch");
  check(summary.environment?.paidVendor === false, "paid vendor evidence is not allowed");
  check(summary.codeDelta?.from === BENCHMARK_COMMIT, "codeDelta.from mismatch");
  check(summary.codeDelta?.to === summary.releaseCode?.computedFromRef, "codeDelta.to mismatch");
  check(Array.isArray(summary.codeDelta?.changedPaths), "codeDelta.changedPaths missing");
  check(Array.isArray(summary.codeDelta?.benchmarkRelevantChangedPaths), "codeDelta benchmark paths missing");
  check(summary.verdict?.sha256 && summary.verdict?.bytes > 0, "verdict source evidence missing");
  for (const [key, value] of Object.entries(summary.verdict?.checks ?? {})) {
    check(/^C\d+$/.test(key), `invalid verdict check:${key}`);
    check(STATUSES.has(value?.status), `invalid verdict status:${key}`);
    check(value.status !== "N/A" || key === "C10", `N/A is only allowed for C10:${key}`);
  }

  const sums = parseSums(readFileSync(sumsPath, "utf8"));
  check(sums.length === 9, `SHA256SUMS must contain 9 entries, got ${sums.length}`);
  const byPath = new Map(sums.map((entry) => [entry.path, entry.sha256]));
  check(byPath.get("cache-benchmark-summary.json") === sha256(summaryBytes), "summary hash mismatch");
  check(Array.isArray(summary.rawFiles) && summary.rawFiles.length === 8, "rawFiles must contain 8 entries");
  const expectedPaths = new Set();
  for (const name of RAW_BENCHMARKS) {
    const stem = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    expectedPaths.add(`raw/${stem}-baseline.json.gz`);
    expectedPaths.add(`raw/${stem}-candidate.json.gz`);
  }
  check(new Set(summary.rawFiles.map((entry) => entry.path)).size === 8, "duplicate raw file");
  for (const descriptor of summary.rawFiles) {
    check(expectedPaths.has(descriptor.path), `unexpected raw file:${descriptor.path}`);
    const filePath = path.join(evidenceDir, descriptor.path);
    check(existsSync(filePath), `raw file missing:${descriptor.path}`);
    const bytes = readFileSync(filePath);
    check(bytes.byteLength === descriptor.bytes, `raw size mismatch:${descriptor.path}`);
    check(sha256(bytes) === descriptor.sha256, `raw hash mismatch:${descriptor.path}`);
    check(byPath.get(descriptor.path) === descriptor.sha256, `SHA256SUMS mismatch:${descriptor.path}`);
    const unpacked = readGzipJson(bytes);
    check(unpacked.decompressedSha256 === descriptor.decompressedSha256, `decompressed hash mismatch:${descriptor.path}`);
    assertPublicEvidence(unpacked.value);
  }
  check([...byPath.keys()].sort().join("\n") === ["cache-benchmark-summary.json", ...expectedPaths].sort().join("\n"), "SHA256SUMS path set mismatch");

  for (const name of RAW_BENCHMARKS) {
    const benchmark = summary.benchmarks?.[name];
    check(benchmark, `benchmark missing:${name}`);
    check(STATUSES.has(benchmark.status), `invalid benchmark status:${name}`);
    check(benchmark.scopeFingerprint?.atBenchmark === scopeFingerprint(repoRoot, benchmark.candidate.commitAtRun, name), `scope atBenchmark mismatch:${name}`);
    check(benchmark.scopeFingerprint?.atRelease === scopeFingerprint(repoRoot, commit, name), `scope atRelease mismatch:${name}`);
    const applicable = benchmark.scopeFingerprint.atBenchmark === benchmark.scopeFingerprint.atRelease;
    check(benchmark.scopeFingerprint.applicable === applicable, `scope applicable mismatch:${name}`);
    check(applicable ? benchmark.status !== "BLOCKED" : benchmark.status === "BLOCKED", `status/applicable mismatch:${name}`);
    const stem = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    check(JSON.stringify(benchmark.rawFiles) === JSON.stringify([`raw/${stem}-baseline.json.gz`, `raw/${stem}-candidate.json.gz`]), `benchmark rawFiles mismatch:${name}`);
  }

  const capacity = summary.cacheCapacity;
  check(capacity?.maxEntries === 200 && capacity?.maxBytes === 1048576, "capacity limits mismatch");
  check(capacity?.baselineEntriesAfter === 17 && capacity?.baselineBytesAfter === 2229227, "capacity baseline mismatch");
  check(capacity?.candidateWithinLimits === true, "candidate capacity limits failed");
  check(candidateCapacityWithinBounds(capacity), "candidate capacity bounds failed");
  check(capacity?.otherTablesUnchanged === true, "other tables changed during capacity benchmark");
  return { ok: true, releaseCommit: commit, releaseCodeFingerprint: summary.releaseCode.codeFingerprint, rawFileCount: summary.rawFiles.length };
}

function candidateCapacityWithinBounds(capacity) {
  return Number.isSafeInteger(capacity.candidateEntriesAfter) && capacity.candidateEntriesAfter >= 0 && capacity.candidateEntriesAfter <= capacity.maxEntries &&
    Number.isSafeInteger(capacity.candidateBytesAfter) && capacity.candidateBytesAfter >= 0 && capacity.candidateBytesAfter <= capacity.maxBytes;
}

async function main() {
  const commit = arg("commit", resolveCommit(REPO_ROOT));
  const evidenceDir = arg("evidence-dir", path.join(REPO_ROOT, "docs", "evidence", "v0.1.14"));
  const summaryPath = arg("summary", path.join(evidenceDir, "cache-benchmark-summary.json"));
  const sumsPath = arg("sums", path.join(evidenceDir, "SHA256SUMS"));
  try {
    const result = verifyEvidence({ commit, summaryPath, sumsPath, evidenceDir });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`resource evidence verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
