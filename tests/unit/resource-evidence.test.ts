import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { BASELINE_COMMIT, BENCHMARK_COMMIT, assertPublicEvidence, codeFingerprint, createRawFile, gzipJson, machineFingerprint, readGzipJson, sanitizeEvidence, scopeFingerprint, sha256 } from "../../scripts/lib/resource-evidence.mjs";
// @ts-expect-error -- plain ESM resource module
import { buildSummary } from "../../scripts/build-resource-evidence.mjs";
// @ts-expect-error -- plain ESM packaging module
import { verifyEvidence } from "../../packaging/verify-resource-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function machine() {
  return { platform: "win32", arch: "x64", cpus: 16, totalMemoryBytes: 16_000_000_000, hostname: "SECRET-HOST" };
}

function reports() {
  const metadata = { machine: machine(), node: "v22.22.2", pnpm: "12.18.0", sourceCommit: BENCHMARK_COMMIT, requests: 20000, repeat: 5, testConcurrency: 1, concurrency: 100 };
  return {
    cacheCapacity: {
      baseline: { sourceCommit: BASELINE_COMMIT, fixture: { maxEntries: 200, maxBytes: 1048576 }, actual: { entries: 17, bytes: 2229227 }, invariantPassed: false, exitCode: 0 },
      candidate: { metadata, fixture: { maxEntries: 200, maxBytes: 1048576 }, actual: { entries: 7, bytes: 917917 }, invariantPassed: true, otherTablesUnchanged: true, exitCode: 0 },
    },
    cacheHit: {
      baseline: { metadata: { ...metadata, sourceCommit: BASELINE_COMMIT }, summary: { mutatingSqlPer1000HitsMedian: 2000, p95MsMedian: 0.6 } },
      candidate: { metadata, summary: { mutatingSqlPer1000HitsMedian: 2000, p95MsMedian: 0.7 }, rounds: [{}, {}] },
    },
    cacheStampede: {
      baseline: { metadata: { ...metadata, sourceCommit: BASELINE_COMMIT }, upstreamCalls: 100, p95Ms: 379 },
      candidate: { metadata, upstreamCalls: 1, responseCount: 100, consistent: true, completed: true, p50Ms: 283, p95Ms: 329, rssPeakBytes: 100, mutatingSql: 403, commits: 401, dbFileBytes: 1, walFileBytes: 2 },
    },
    cacheStorage: {
      baseline: { metadata: { ...metadata, sourceCommit: BASELINE_COMMIT }, rounds: [{ maintenanceMs: 45, dbFileBytes: 2, walFileBytes: 3, vacuumPerformed: false }] },
      candidate: { metadata, rounds: [{ maintenanceMs: 21, dbFileBytes: 1, walFileBytes: 2, vacuumPerformed: false }] },
    },
  };
}

const verdict = {
  C01: { status: "PASS" }, C08: { status: "PASS_NO_OPTIMIZATION" }, C09: { status: "PASS" },
  C10: { status: "N/A" }, C12: { status: "PASS" },
};

describe("resource evidence", () => {
  it("computes stable tree and per-benchmark scope fingerprints", () => {
    expect(codeFingerprint(root, "HEAD")).toMatch(/^[0-9a-f]{64}$/);
    expect(codeFingerprint(root, "HEAD")).toBe(codeFingerprint(root, "HEAD"));
    expect(scopeFingerprint(root, "HEAD", "cacheHit")).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeFingerprint(root, "HEAD", "cacheHit")).not.toBe(scopeFingerprint(root, "HEAD", "cacheStampede"));
  });

  it("removes host identity, argv/env, raw logs, SQL and absolute paths", () => {
    const clean = sanitizeEvidence({ hostname: "SECRET-HOST", argv: ["node"], env: { TOKEN: "secret" }, stderr: "raw", sql: "SELECT", query: "real query", command: "C:\\private\\node.exe", nested: [{ path: "/Users/secret/file" }] });
    expect(clean).toEqual({ command: "[redacted-path]", nested: [{ path: "[redacted-path]" }] });
    expect(() => assertPublicEvidence({ hostname: "SECRET-HOST" })).toThrow(/forbidden_evidence_key/);
    expect(() => assertPublicEvidence({ command: "C:\\private\\node.exe" })).toThrow(/forbidden_evidence_value/);
  });

  it("gzip round-trips public JSON with a decompressed hash", () => {
    const packed = gzipJson({ value: 1, hostname: "SECRET-HOST" });
    const unpacked = readGzipJson(packed.compressed);
    expect(unpacked.value).toEqual({ value: 1 });
    expect(unpacked.decompressedSha256).toBe(packed.decompressedSha256);
    expect(sha256(packed.compressed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds a summary with separate baseline, benchmark and release fingerprints", () => {
    const summary = buildSummary({ repoRoot: root, releaseRef: BENCHMARK_COMMIT, artifactsDir: ".", reports: reports(), verdict, pkg: { devDependencies: { vitest: "5.1.0", "@playwright/test": "1.64.1" } }, generatedAt: "2026-11-23T00:00:00.000Z" });
    expect(summary.baseline.commit).toBe(BASELINE_COMMIT);
    expect(summary.benchmarkCode.commit).toBe(BENCHMARK_COMMIT);
    expect(summary.releaseCode.codeFingerprint).toBe(codeFingerprint(root, BENCHMARK_COMMIT));
    expect(summary.baseline.machineFingerprint).toBe(machineFingerprint(machine()));
    expect(summary.environment.paidVendor).toBe(false);
    expect(summary.benchmarks.cacheHit.status).toBe("PASS_NO_OPTIMIZATION");
    expect(summary.benchmarks.cacheHit.command).toContain("node --import tsx");
    expect(summary.benchmarks.cacheStorage.summary.vacuumPerformed).toBe(false);
    expect(summary.environment.vitest).toBe("5.1.0");
    expect(summary.cacheCapacity.otherTablesUnchanged).toBe(true);
    expect(summary.rawFiles).toEqual([]);
  });

  it("verifies hashes, gzip payloads, fingerprints and capacity evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "search-hub-evidence-test-"));
    temporary.push(directory);
    const summary = buildSummary({ repoRoot: root, releaseRef: "HEAD", artifactsDir: ".", reports: reports(), verdict, pkg: { devDependencies: { vitest: "5.1.0", "@playwright/test": "1.64.1" } }, generatedAt: "2026-11-23T00:00:00.000Z" });
    summary.verdict.sha256 = sha256("verdict");
    summary.verdict.bytes = 7;
    const descriptors = [];
    for (const benchmark of Object.values(summary.benchmarks) as Array<{ rawFiles: string[] }>) {
      for (const relativePath of benchmark.rawFiles) {
        const sourcePath = join(directory, `${relativePath}.source.json`);
        mkdirSync(join(directory, relativePath, ".."), { recursive: true });
        writeFileSync(sourcePath, JSON.stringify({ benchmark: relativePath, hostname: "SECRET-HOST" }));
        const raw = createRawFile(relativePath, sourcePath);
        writeFileSync(join(directory, relativePath), raw.compressed);
        descriptors.push(raw.descriptor);
      }
    }
    summary.rawFiles = descriptors;
    const summaryPath = join(directory, "cache-benchmark-summary.json");
    const sumsPath = join(directory, "SHA256SUMS");
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    writeFileSync(sumsPath, [`${sha256(readFileSync(summaryPath))}  cache-benchmark-summary.json`, ...descriptors.map((entry) => `${entry.sha256}  ${entry.path}`)].join("\n"));
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(verifyEvidence({ repoRoot: root, commit, summaryPath, sumsPath, evidenceDir: directory }).ok).toBe(true);
    writeFileSync(sumsPath, `${readFileSync(sumsPath, "utf8")}\n${"0".repeat(64)}  extra.json.gz\n`);
    expect(() => verifyEvidence({ repoRoot: root, commit, summaryPath, sumsPath, evidenceDir: directory })).toThrow(/9 entries/);
  });
});
