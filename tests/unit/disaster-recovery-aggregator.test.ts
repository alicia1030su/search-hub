import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";
import { aggregateDisasterRecoveryEvidence } from "../../packaging/aggregate-disaster-recovery-evidence.mjs";
import { verifyDisasterRecoveryEvidence } from "../../packaging/verify-disaster-recovery-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const fingerprint = codeFingerprint(root, commit);
const ids = [
  ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function writeReport(evidenceDir: string, relative: string, report: unknown) {
  const file = join(evidenceDir, "reports", relative);
  mkdirSync(join(file, ".."), { recursive: true });
  const bytes = JSON.stringify(report, null, 2);
  writeFileSync(file, bytes);
  const sumsPath = join(file, "..", "SHA256SUMS");
  const name = relative.split("/").at(-1)!;
  const existing = existsSync(sumsPath) ? readFileSync(sumsPath, "utf8").split("\n").filter((line) => line && !line.endsWith(`  ${name}`)).join("\n") : "";
  writeFileSync(sumsPath, `${existing}${existing ? "\n" : ""}${hash(bytes)}  ${name}\n`);
}

function fixture(): string {
  const evidenceDir = mkdtempSync(join(tmpdir(), "search-hub-dr-aggregate-"));
  temporary.push(evidenceDir);
  mkdirSync(join(evidenceDir, "reports", "performance"), { recursive: true });
  return evidenceDir;
}

function source() {
  return { commit, releaseCodeFingerprint: fingerprint, dirty: false };
}

describe("disaster recovery evidence aggregator", () => {
  it("merges independent PASS reports without letting performance BLOCKED override full A04/A11 evidence", () => {
    const evidenceDir = fixture();
    writeReport(evidenceDir, "performance/manifest.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-performance",
      source: source(),
      requirements: { R20: "PASS", R34: "BLOCKED", A04: "BLOCKED", A11: "BLOCKED" },
      requirementEvidence: { R20: { result: "PASS" }, R34: { performanceSubset: "PASS" }, A04: { result: "BLOCKED" }, A11: { performanceSubset: "PASS" } },
    });
    const requirements = Object.fromEntries(ids.map((id) => [id, "PASS"]));
    writeReport(evidenceDir, "platform/report.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-platform",
      source: source(),
      requirements,
      requirementEvidence: Object.fromEntries(ids.map((id) => [id, { result: "PASS" }])),
    });
    const result = aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir });
    expect(result.gate.verdict).toBe("PASS");
    expect(result.gate.acceptanceComplete).toBe(true);
    expect(result.gate.requirements.A04).toBe("PASS");
    expect(verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toMatchObject({ ok: true, requirementCount: 50 });
  });

  it("keeps performance-only missing requirements NOT TESTED and the gate BLOCKED", () => {
    const evidenceDir = fixture();
    writeReport(evidenceDir, "performance/manifest.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-performance",
      source: source(),
      requirements: { R20: "PASS", R34: "BLOCKED", A04: "BLOCKED", A11: "BLOCKED" },
      requirementEvidence: { R20: { result: "PASS" }, R34: { performanceSubset: "PASS" }, A04: { result: "BLOCKED" }, A11: { performanceSubset: "PASS" } },
    });
    const result = aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir });
    expect(result.gate.verdict).toBe("BLOCKED");
    expect(result.gate.requirements.R01).toBe("NOT TESTED");
    expect(result.gate.requirements.R20).toBe("PASS");
    expect(result.gate.requirements.A04).toBe("BLOCKED");
    expect(() => verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_gate_not_pass/);
  });

  it("rejects wrong SHA/fingerprint and a performance report claiming full A04/A11 PASS", () => {
    const evidenceDir = fixture();
    writeReport(evidenceDir, "performance/manifest.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-performance",
      source: { ...source(), commit: "a".repeat(40) },
      requirements: { R20: "PASS" },
      requirementEvidence: { R20: { result: "PASS" } },
    });
    expect(() => aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_report_commit_mismatch/);
    writeReport(evidenceDir, "performance/manifest.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-performance",
      source: source(),
      requirements: { A04: "PASS" },
      requirementEvidence: { A04: { result: "PASS" } },
    });
    expect(() => aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_performance_cannot_pass_full_requirement/);
  });

  it("requires every report to be covered by a SHA256SUMS file", () => {
    const evidenceDir = fixture();
    const file = join(evidenceDir, "reports", "report.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, kind: "search-hub-dr-test", source: source(), requirements: {}, requirementEvidence: {} }));
    expect(() => aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_report_sums_missing/);
  });

  it("lets a later non-performance BLOCKED or FAIL override an earlier platform PASS", () => {
    const evidenceDir = fixture();
    writeReport(evidenceDir, "platform-pass/report.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-platform",
      source: source(),
      requirements: { R26: "PASS" },
      requirementEvidence: { R26: { result: "PASS" } },
    });
    writeReport(evidenceDir, "platform-blocked/report.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-platform",
      source: source(),
      requirements: { R26: "BLOCKED" },
      requirementEvidence: { R26: { result: "BLOCKED" } },
    });
    expect(aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir }).gate.requirements.R26).toBe("BLOCKED");

    writeReport(evidenceDir, "platform-failed/report.json", {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-platform",
      source: source(),
      requirements: { R26: "FAIL" },
      requirementEvidence: { R26: { result: "FAIL" } },
    });
    const failed = aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir }).gate;
    expect(failed.requirements.R26).toBe("FAIL");
    expect(failed.verdict).toBe("FAIL");
  });
});
