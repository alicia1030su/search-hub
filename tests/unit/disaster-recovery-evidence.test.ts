import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";
import { verifyDisasterRecoveryEvidence } from "../../packaging/verify-disaster-recovery-evidence.mjs";
import { aggregateDisasterRecoveryEvidence } from "../../packaging/aggregate-disaster-recovery-evidence.mjs";

const root = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const requirements = Object.fromEntries([
  ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
].map((id) => [id, "PASS"]));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const evidenceDir = mkdtempSync(join(tmpdir(), "search-hub-dr-gate-"));
  temporary.push(evidenceDir);
  mkdirSync(join(evidenceDir, "reports"));
  const report = JSON.stringify({ result: "PASS", synthetic: true });
  writeFileSync(join(evidenceDir, "reports", "acceptance.json"), report);
  const gate = {
    schemaVersion: 1,
    suite: "search-hub-disaster-recovery-v0.1.15",
    releaseCommit: commit,
    releaseCodeFingerprint: codeFingerprint(root, commit),
    verdict: "PASS",
    source: { dirty: false },
    requirements: { ...requirements },
    evidence: Object.fromEntries(Object.keys(requirements).map((id) => [id, [{ path: "reports/acceptance.json", sha256: hash(report) }]])),
  };
  const gateBytes = JSON.stringify(gate, null, 2);
  writeFileSync(join(evidenceDir, "gate.json"), gateBytes);
  writeFileSync(join(evidenceDir, "SHA256SUMS"), `${hash(gateBytes)}  gate.json\n${hash(report)}  reports/acceptance.json\n`);
  return { evidenceDir, gate };
}

describe("v0.1.15 disaster recovery release gate", () => {
  it("accepts only exact-SHA evidence with R01-R38 and A01-A12 all PASS", () => {
    const { evidenceDir } = fixture();
    expect(verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toMatchObject({ ok: true, verdict: "PASS", requirementCount: 50 });
  });

  it("allows an explicitly incomplete CI subset without treating it as a release gate", () => {
    const { evidenceDir, gate } = fixture();
    gate.requirements.R01 = "NOT TESTED";
    gate.verdict = "BLOCKED";
    gate.evidence.R01 = [];
    const gateBytes = JSON.stringify(gate);
    writeFileSync(join(evidenceDir, "gate.json"), gateBytes);
    writeFileSync(join(evidenceDir, "SHA256SUMS"), `${hash(gateBytes)}  gate.json\n${hash(readFileSync(join(evidenceDir, "reports", "acceptance.json")))}  reports/acceptance.json\n`);
    expect(() => verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_gate_not_pass/);
    expect(verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir, requireAllPass: false })).toMatchObject({
      ok: true, verdict: "BLOCKED", requirementCount: 50,
    });
  });

  it("rejects BLOCKED, NOT TESTED and missing requirement evidence", () => {
    const { evidenceDir, gate } = fixture();
    gate.requirements.A12 = "BLOCKED";
    writeFileSync(join(evidenceDir, "gate.json"), JSON.stringify(gate));
    expect(() => verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_gate_(?:not_pass|verdict_mismatch)/);
    gate.requirements.A12 = "PASS";
    delete (gate.evidence as Record<string, unknown>).R38;
    const updatedGate = JSON.stringify(gate);
    writeFileSync(join(evidenceDir, "gate.json"), updatedGate);
    writeFileSync(join(evidenceDir, "SHA256SUMS"), `${hash(updatedGate)}  gate.json\n${hash(readFileSync(join(evidenceDir, "reports", "acceptance.json")))}  reports/acceptance.json\n`);
    expect(() => verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_requirement_evidence_empty:R38/);
  });

  it("rejects a different source SHA and tampered evidence bytes", () => {
    const { evidenceDir } = fixture();
    expect(() => verifyDisasterRecoveryEvidence({ repoRoot: root, commit: "a".repeat(40), evidenceDir })).toThrow(/dr_gate_commit_mismatch/);
    writeFileSync(join(evidenceDir, "reports", "acceptance.json"), "tampered");
    expect(() => verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_evidence_sha256_mismatch/);
  });

  it("rejects an unlisted file instead of ignoring it", () => {
    const { evidenceDir } = fixture();
    writeFileSync(join(evidenceDir, "reports", "unlisted.json"), "{}");
    expect(() => verifyDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(/dr_evidence_file_set_mismatch/);
    expect(readFileSync(join(evidenceDir, "SHA256SUMS"), "utf8")).toContain("gate.json");
  });

  it("preserves NOT IMPLEMENTED instead of disguising it as NOT TESTED", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "search-hub-dr-aggregate-"));
    temporary.push(evidenceDir);
    mkdirSync(join(evidenceDir, "reports", "core"), { recursive: true });
    const report = {
      schemaVersion: 1,
      kind: "synthetic-core-report",
      source: { commit, releaseCodeFingerprint: codeFingerprint(root, commit), dirty: false },
      requirements: { R01: "NOT IMPLEMENTED", R02: "NOT TESTED" },
      requirementEvidence: {},
    };
    const bytes = JSON.stringify(report);
    writeFileSync(join(evidenceDir, "reports", "core", "manifest.json"), bytes);
    writeFileSync(join(evidenceDir, "reports", "core", "SHA256SUMS"), `${hash(bytes)}  manifest.json\n`);
    const result = aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir });
    expect(result.gate.requirements.R01).toBe("NOT IMPLEMENTED");
    expect(result.gate.requirements.R02).toBe("NOT TESTED");
    expect(result.gate.verdict).toBe("BLOCKED");
  });

  it("does not let cross-process performance pass R34, A04 or A11", () => {
    for (const id of ["R34", "A04", "A11"]) {
      const evidenceDir = mkdtempSync(join(tmpdir(), "search-hub-dr-aggregate-"));
      temporary.push(evidenceDir);
      mkdirSync(join(evidenceDir, "reports", "performance"), { recursive: true });
      const report = {
        schemaVersion: 1,
        kind: "search-hub-disaster-recovery-performance",
        source: { commit, releaseCodeFingerprint: codeFingerprint(root, commit), dirty: false },
        requirements: { [id]: "PASS" },
        requirementEvidence: { [id]: { performanceSubset: "PASS" } },
      };
      const bytes = JSON.stringify(report);
      writeFileSync(join(evidenceDir, "reports", "performance", "manifest.json"), bytes);
      writeFileSync(join(evidenceDir, "reports", "performance", "SHA256SUMS"), `${hash(bytes)}  manifest.json\n`);
      expect(() => aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir })).toThrow(`dr_performance_cannot_pass_full_requirement:${id}`);
    }
  });

  it("requires both performanceSubset and same-process PASS for R34", () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), "search-hub-dr-aggregate-"));
    temporary.push(evidenceDir);
    mkdirSync(join(evidenceDir, "reports", "memory-loop"), { recursive: true });
    const fingerprint = codeFingerprint(root, commit);
    const memory = {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-memory-loop",
      source: { commit, releaseCodeFingerprint: fingerprint, dirty: false },
      requirements: { R34: "PASS" },
      requirementEvidence: { R34: { scope: "same-process-core-verifier" } },
    };
    const memoryBytes = JSON.stringify(memory);
    writeFileSync(join(evidenceDir, "reports", "memory-loop", "manifest.json"), memoryBytes);
    writeFileSync(join(evidenceDir, "reports", "memory-loop", "SHA256SUMS"), `${hash(memoryBytes)}  manifest.json\n`);
    expect(aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir }).gate.requirements.R34).toBe("BLOCKED");

    mkdirSync(join(evidenceDir, "reports", "performance"), { recursive: true });
    const performance = {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-performance",
      source: { commit, releaseCodeFingerprint: fingerprint, dirty: false },
      schedule: { sizesMiB: [10, 64, 128, 256], measuredRounds: 5, freshProcessRounds: 5, singleRoundSmoke: false },
      results: [10, 64, 256].map((sizeMiB) => ({ sizeMiB, result: "PASS", growth: { result: "PASS" }, resourceComplete: true, rounds: Array.from({ length: 5 }, () => ({ result: "PASS" })), freshProcessRounds: [{ result: "PASS" }] })),
      requirements: { R34: "BLOCKED" },
      requirementEvidence: { R34: { performanceSubset: "PASS", sameProcessEvidence: "NOT TESTED" } },
    };
    const performanceBytes = JSON.stringify(performance);
    writeFileSync(join(evidenceDir, "reports", "performance", "manifest.json"), performanceBytes);
    writeFileSync(join(evidenceDir, "reports", "performance", "SHA256SUMS"), `${hash(performanceBytes)}  manifest.json\n`);
    expect(aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir }).gate.requirements.R34).toBe("PASS");

    performance.schedule.measuredRounds = 4;
    const incompleteBytes = JSON.stringify(performance);
    writeFileSync(join(evidenceDir, "reports", "performance", "manifest.json"), incompleteBytes);
    writeFileSync(join(evidenceDir, "reports", "performance", "SHA256SUMS"), `${hash(incompleteBytes)}  manifest.json\n`);
    expect(aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir }).gate.requirements.R34).toBe("BLOCKED");

    mkdirSync(join(evidenceDir, "reports", "failure"), { recursive: true });
    const failure = {
      schemaVersion: 1,
      kind: "independent-r34-failure",
      source: { commit, releaseCodeFingerprint: fingerprint, dirty: false },
      requirements: { R34: "FAIL" },
      requirementEvidence: { R34: { reason: "sustained growth" } },
    };
    const failureBytes = JSON.stringify(failure);
    writeFileSync(join(evidenceDir, "reports", "failure", "manifest.json"), failureBytes);
    writeFileSync(join(evidenceDir, "reports", "failure", "SHA256SUMS"), `${hash(failureBytes)}  manifest.json\n`);
    const failed = aggregateDisasterRecoveryEvidence({ repoRoot: root, commit, evidenceDir }).gate;
    expect(failed.requirements.R34).toBe("FAIL");
    expect(failed.verdict).toBe("FAIL");
  });
});
