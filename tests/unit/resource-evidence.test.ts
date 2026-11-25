import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { BASELINE_COMMIT, BENCHMARK_COMMIT, assertPublicEvidence, codeFingerprint, createRawFile, gzipJson, machineFingerprint, readGzipJson, sanitizeEvidence, scopeFingerprint, sha256 } from "../../scripts/lib/resource-evidence.mjs";
// @ts-expect-error -- plain ESM resource module
import { buildSummary } from "../../scripts/build-resource-evidence.mjs";
// @ts-expect-error -- plain ESM packaging module
import { verifyEvidence } from "../../packaging/verify-resource-evidence.mjs";
// @ts-expect-error -- plain ESM resource module
import { stageResourceEvidence } from "../../scripts/stage-resource-evidence.mjs";
import { aggregateDisasterRecoveryEvidence } from "../../packaging/aggregate-disaster-recovery-evidence.mjs";
import { combineReleaseEvidence, verifyCombinedReleaseEvidence } from "../../packaging/release-evidence.mjs";
import * as releaseEvidenceModule from "../../packaging/release-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const RESOURCE_RUNTIME_ARTIFACT = (releaseEvidenceModule as unknown as { RESOURCE_RUNTIME_ARTIFACT: string }).RESOURCE_RUNTIME_ARTIFACT;
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
  it("generates and verifies exact-SHA release evidence in main-push CI without committed self-reference", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("name: Resource evidence verification");
    expect(ci).not.toMatch(/resource-evidence:[\s\S]{0,250}?\n    if:/);
    expect(ci).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(ci).toContain('--release-ref "$GITHUB_SHA"');
    expect(ci).toContain("--source-evidence-dir docs/evidence/v0.1.14");
    expect(ci).toContain("--sizes 10,64,128,256");
    expect(ci).toContain("--rounds 5");
    expect(ci).toContain("--fresh-rounds 5");
    expect(ci).toContain("node --expose-gc --import tsx tests/disaster-recovery/backup-memory-loop.mjs --self-check");
    expect(ci).toContain("node --expose-gc --import tsx tests/disaster-recovery/backup-performance.mjs --run");
    expect(ci).not.toContain("aggregate-disaster-recovery-evidence.mjs");
    expect(ci).not.toContain("--allow-incomplete");
    expect(ci).not.toContain("verify-disaster-recovery-evidence.mjs");
    expect(ci).not.toContain("release-evidence.mjs verify-combined");
    const candidate = readFileSync(join(root, ".github", "workflows", "release-candidate.yml"), "utf8");
    expect(candidate).toContain("core-acceptance.mjs --run");
    expect(candidate).toContain("platform-windows.ps1");
    expect(candidate).toContain("platform-linux.sh");
    expect(candidate).toContain("platform-docker.sh");
    expect(candidate).toContain("platform-systemd.sh");
    expect(candidate).toContain("node packaging/aggregate-disaster-recovery-evidence.mjs");
    expect(candidate).toContain("release-evidence.mjs combine");
    expect(candidate).toContain("verify-disaster-recovery-evidence.mjs");
    expect(ci).toContain("name: release-evidence-v${{ env.VERSION }}");
    expect(ci).toContain("name: release-evidence-diagnostics-v${{ env.VERSION }}");
    expect(ci).not.toContain("docs/evidence/v0.1.15");
    expect(ci).not.toContain("--output-dir docs/evidence/v0.1.14");
  });

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
    expect(summary.suite).toBe("search-hub-resource-v0.1.14");
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

  it("stages a flat upload/download artifact layout with eight raw files", () => {
    const directory = mkdtempSync(join(tmpdir(), "search-hub-evidence-stage-"));
    temporary.push(directory);
    const evidenceDir = join(directory, "docs");
    const outputDir = join(directory, "artifact");
    mkdirSync(join(evidenceDir, "raw"), { recursive: true });
    writeFileSync(join(evidenceDir, "cache-benchmark-summary.json"), "{}");
    writeFileSync(join(evidenceDir, "SHA256SUMS"), "sums");
    for (let index = 0; index < 8; index += 1) writeFileSync(join(evidenceDir, "raw", `cache-${index}.json.gz`), "gzip");
    const runtimePath = join(directory, "runtime.json");
    const doctorPath = join(directory, "doctor.json");
    writeFileSync(runtimePath, "{}");
    writeFileSync(doctorPath, "{}");
    const disasterRecoveryDir = join(directory, "dr-source");
    const disasterReport = join(disasterRecoveryDir, "reports", "core", "report.json");
    mkdirSync(join(disasterRecoveryDir, "reports", "core"), { recursive: true });
    writeFileSync(disasterReport, '{"verdict":"PASS"}\n');
    const files = stageResourceEvidence({ evidenceDir, runtimePath, doctorPath, disasterRecoveryDir, outputDir });
    expect(files).toHaveLength(13);
    expect(readdirSync(outputDir).sort()).toEqual(["SHA256SUMS", "cache-benchmark-summary.json", "disaster-recovery", "raw", "resource-doctor.json", RESOURCE_RUNTIME_ARTIFACT]);
    expect(readdirSync(join(outputDir, "raw"))).toHaveLength(8);
    expect(readFileSync(join(outputDir, "disaster-recovery", "reports", "core", "report.json"), "utf8")).toBe('{"verdict":"PASS"}\n');
    expect(() => stageResourceEvidence({ evidenceDir, runtimePath, doctorPath, disasterRecoveryDir, outputDir: directory })).toThrow(/stage_output_would_remove_source/);
  });

  it("rebinds historical cache raw evidence to the exact release without deleting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "search-hub-historical-runtime-"));
    temporary.push(directory);
    const evidenceDir = join(directory, "evidence");
    const runtimePath = join(directory, RESOURCE_RUNTIME_ARTIFACT);
    execFileSync(process.execPath, ["scripts/build-resource-evidence.mjs", "--runtime-only", "--release-ref", "HEAD", "--source-evidence-dir", "docs/evidence/v0.1.14", "--output-dir", evidenceDir, "--runtime-output", runtimePath], { cwd: root, encoding: "utf8" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(verifyEvidence({ repoRoot: root, commit, summaryPath: join(evidenceDir, "cache-benchmark-summary.json"), sumsPath: join(evidenceDir, "SHA256SUMS"), evidenceDir })).toMatchObject({ ok: true, rawFileCount: 8 });
    expect(JSON.parse(readFileSync(runtimePath, "utf8")).releaseCodeFingerprint).toBe(codeFingerprint(root, commit));
    expect(readdirSync(join(root, "docs", "evidence", "v0.1.14", "raw"))).toHaveLength(8);
  });

  it("refuses to rebind tampered historical cache evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "search-hub-tampered-history-"));
    temporary.push(directory);
    const sourceDir = join(directory, "history");
    cpSync(join(root, "docs", "evidence", "v0.1.14"), sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "raw", "cache-hit-candidate.json.gz"), "tampered");
    expect(() => execFileSync(process.execPath, ["scripts/build-resource-evidence.mjs", "--runtime-only", "--release-ref", "HEAD", "--source-evidence-dir", sourceDir, "--output-dir", join(directory, "output"), "--runtime-output", join(directory, "runtime.json")], { cwd: root, encoding: "utf8", stdio: "pipe" })).toThrow(/raw (?:hash|size) mismatch/);
  });

  it("verifies a combined exact-SHA artifact against raw resource evidence and the aggregated DR gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "search-hub-combined-evidence-"));
    temporary.push(directory);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const runtimePath = join(directory, RESOURCE_RUNTIME_ARTIFACT);
    execFileSync(process.execPath, ["scripts/build-resource-evidence.mjs", "--runtime-only", "--release-ref", commit, "--source-evidence-dir", "docs/evidence/v0.1.14", "--output-dir", directory, "--runtime-output", runtimePath], { cwd: root, encoding: "utf8" });
    const drDir = join(directory, "disaster-recovery");
    const reportDir = join(drDir, "reports", "full");
    mkdirSync(reportDir, { recursive: true });
    const ids = [
      ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
    ];
    const report = {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-test",
      source: { commit, releaseCodeFingerprint: codeFingerprint(root, commit), dirty: false },
      requirements: Object.fromEntries(ids.map((id) => [id, "PASS"])),
      requirementEvidence: Object.fromEntries(ids.map((id) => [id, { result: "PASS" }])),
    };
    const reportBytes = JSON.stringify(report);
    writeFileSync(join(reportDir, "report.json"), reportBytes);
    writeFileSync(join(reportDir, "SHA256SUMS"), `${sha256(reportBytes)}  report.json\n`);
    expect(aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir: drDir }).gate.verdict).toBe("PASS");
    const combinedPath = join(directory, "resource-evidence.json");
    combineReleaseEvidence({ resourcePath: runtimePath, disasterRecoveryDir: drDir, output: combinedPath, commit });
    expect(verifyCombinedReleaseEvidence({ combinedPath, disasterRecoveryDir: drDir, commit })).toMatchObject({ ok: true, requirementCount: 50 });
    const combined = JSON.parse(readFileSync(combinedPath, "utf8"));
    combined.resource.generatedAt = "tampered";
    writeFileSync(combinedPath, JSON.stringify(combined));
    expect(() => verifyCombinedReleaseEvidence({ combinedPath, disasterRecoveryDir: drDir, commit })).toThrow(/combined_resource_runtime_mismatch/);
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
