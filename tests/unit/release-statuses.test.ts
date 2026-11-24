import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";
// @ts-expect-error -- plain ESM release evidence module
import { deriveReleaseStatuses } from "../../tests/disaster-recovery/derive-release-statuses.mjs";

const root = resolve(import.meta.dirname, "../..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const fingerprint = codeFingerprint(root, commit);
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function source() {
  return { commit, releaseCodeFingerprint: fingerprint, dirty: false };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "search-hub-release-status-"));
  temporary.push(directory);
  const evidenceDir = join(directory, "final-dr");
  const outputDir = join(evidenceDir, "reports", "release");
  const candidateGatePath = join(directory, "candidate-gate.json");
  writeJson(join(evidenceDir, "reports", "core", "report.json"), {
    schemaVersion: 1,
    kind: "search-hub-disaster-recovery-core",
    source: source(),
    verdict: "PASS",
    acceptanceComplete: false,
    commands: [{ name: "backup-api", status: "PASS", exitCode: 0 }],
    coveredRequirements: ["R35"],
    requirements: { R35: "PASS" },
    requirementEvidence: { R35: [{ path: "logs/backup-api.log", status: "PASS" }] },
  });
  writeJson(join(evidenceDir, "reports", "performance", "manifest.json"), {
    schemaVersion: 1,
    kind: "search-hub-disaster-recovery-performance",
    source: source(),
    verdict: "PASS",
    acceptanceComplete: true,
    schedule: { sizesMiB: [10, 64, 128, 256], measuredRounds: 5, freshProcessRounds: 5, singleRoundSmoke: false },
    results: [10, 64, 128, 256].map((sizeMiB) => ({
      sizeMiB,
      result: "PASS",
      growth: { result: "PASS" },
      resourceComplete: true,
      sourceUnchanged: true,
      rounds: Array.from({ length: 5 }, () => ({ result: "PASS" })),
      freshProcessRounds: Array.from({ length: 5 }, () => ({ result: "PASS" })),
    })),
    requirements: {},
    requirementEvidence: {},
  });
  for (const sizeMiB of [10, 64, 256]) {
    writeJson(join(evidenceDir, "reports", "performance", "reports", `memory-loop-${sizeMiB}`, "manifest.json"), {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-memory-loop",
      source: source(),
      verdict: "PASS",
      schedule: { sizeMiB, rounds: 5, warmup: 2, sameProcess: true, adapterMode: "final" },
      tool: { gcAvailable: true },
      loop: {
        spawnCount: 0,
        measured: Array.from({ length: 5 }, () => ({ result: "PASS", cleanup: { ok: true, removed: true } })),
        growth: { result: "PASS" },
      },
      requirements: { R34: "PASS" },
      requirementEvidence: { R34: { result: "PASS" } },
    });
  }
  for (const slug of ["cli-windows-x64", "cli-linux-x64", "cli-linux-arm64", "cli-node22"]) {
    writeJson(join(evidenceDir, "reports", slug, "report.json"), {
      schemaVersion: 1,
      kind: "search-hub-cli-package",
      source: source(),
      verdict: "PASS",
      requirements: { A04: "PASS" },
      requirementEvidence: { A04: [{ path: "cli-acceptance.log" }] },
    });
  }
  for (const slug of ["platform-windows", "platform-linux-x64", "platform-linux-arm64", "platform-docker", "platform-systemd"]) {
    writeJson(join(evidenceDir, "reports", slug, "report.json"), {
      schemaVersion: 1,
      kind: slug === "platform-windows" ? "search-hub-platform-windows" : slug.startsWith("platform-linux-") ? "search-hub-platform-linux" : `search-hub-${slug}`,
      source: source(),
      verdict: "PASS",
      requirements: {},
      requirementEvidence: {},
    });
  }
  writeJson(candidateGatePath, {
    schemaVersion: 2,
    phase: "candidate",
    sha: commit,
    candidateRunId: 123,
    ciRunId: 456,
    evidence: { releaseCodeFingerprint: fingerprint },
    runs: ["ci.yml", "cli.yml", "docker.yml", "systemd.yml", "upgrade.yml"].map((workflowPath) => ({
      workflowPath,
      headSha: commit,
      event: "push",
      headBranch: "main",
      conclusion: "success",
    })),
  });
  return { directory, evidenceDir, outputDir, candidateGatePath };
}

function derive(value: ReturnType<typeof fixture>) {
  return deriveReleaseStatuses({ repoRoot: root, commit, evidenceDir: value.evidenceDir, candidateGatePath: value.candidateGatePath, outputDir: value.outputDir, sourceDirty: false });
}

describe("candidate release status derivation", () => {
  it("derives A08/A11/A12/R35 only from complete passing evidence", () => {
    const value = fixture();
    const result = derive(value);
    expect(result.verdict).toBe("PASS");
    expect(result.statuses).toEqual({ A08: "PASS", A11: "PASS", A12: "PASS", R35: "PASS" });
    expect(result.evidenceMap.A11.join("\n")).toContain("memory-loop-10");
    expect(result.evidenceMap.A11.join("\n")).toContain("memory-loop-64");
    expect(result.evidenceMap.A11.join("\n")).toContain("memory-loop-256");
    expect(result.evidenceMap.A11.join("\n")).toContain("cli-windows-x64");
    expect(result.evidenceMap.A11.join("\n")).toContain("platform-systemd");
    for (const references of Object.values(result.evidenceMap) as string[][]) {
      for (const reference of references) expect(existsSync(join(value.outputDir, reference))).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(value.outputDir, "derived-release-statuses.json"), "utf8")).verdict).toBe("PASS");
  });

  it("requires integrated memory reports to record GC availability", () => {
    const performance = readFileSync(join(root, "tests", "disaster-recovery", "backup-performance.mjs"), "utf8");
    expect(performance).toContain('gcAvailable: typeof globalThis.gc === "function"');
  });

  it("blocks when any required memory-loop report is missing", () => {
    const value = fixture();
    rmSync(join(value.evidenceDir, "reports", "performance", "reports", "memory-loop-64"), { recursive: true });
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED" } });
  });

  it("fails when a platform report failed", () => {
    const value = fixture();
    const file = join(value.evidenceDir, "reports", "platform-docker", "report.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.verdict = "FAIL";
    writeJson(file, report);
    expect(derive(value)).toMatchObject({ verdict: "FAIL", statuses: { A08: "FAIL", A11: "FAIL" } });
  });

  it("blocks when a CLI report is missing", () => {
    const value = fixture();
    rmSync(join(value.evidenceDir, "reports", "cli-node22"), { recursive: true });
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED" } });
  });

  it("blocks when the candidate gate does not contain all five exact-SHA main-push runs", () => {
    const value = fixture();
    const gate = JSON.parse(readFileSync(value.candidateGatePath, "utf8"));
    gate.runs.pop();
    writeJson(value.candidateGatePath, gate);
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A12: "BLOCKED", R35: "BLOCKED" } });
  });

  it("requires five scheduled and measured fresh-process rounds", () => {
    const value = fixture();
    const file = join(value.evidenceDir, "reports", "performance", "manifest.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.schedule.freshProcessRounds = 4;
    writeJson(file, report);
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED" } });

    report.schedule.freshProcessRounds = 5;
    report.results[0].freshProcessRounds = report.results[0].freshProcessRounds.slice(0, 4);
    writeJson(file, report);
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED" } });
  });

  it("blocks an incomplete performance schedule even when its verdict says PASS", () => {
    const value = fixture();
    const file = join(value.evidenceDir, "reports", "performance", "manifest.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.schedule.measuredRounds = 4;
    writeJson(file, report);
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED" } });
  });

  it("blocks a dirty source tree even when every report is otherwise PASS", () => {
    const value = fixture();
    const result = deriveReleaseStatuses({ repoRoot: root, commit, evidenceDir: value.evidenceDir, candidateGatePath: value.candidateGatePath, outputDir: value.outputDir, sourceDirty: true });
    expect(result).toMatchObject({ verdict: "BLOCKED", source: { dirty: true } });
  });

  it("blocks when a covered core requirement has no evidence", () => {
    const value = fixture();
    const file = join(value.evidenceDir, "reports", "core", "report.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.requirementEvidence.R35 = [];
    writeJson(file, report);
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED", R35: "BLOCKED" } });
  });

  it("blocks when a covered core requirement is not PASS", () => {
    const value = fixture();
    const file = join(value.evidenceDir, "reports", "core", "report.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.requirements.R35 = "NOT TESTED";
    writeJson(file, report);
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED", R35: "BLOCKED" } });
  });

  it("blocks a core subset report that is not PASS", () => {
    const value = fixture();
    const file = join(value.evidenceDir, "reports", "core", "report.json");
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.verdict = "BLOCKED";
    writeJson(file, report);
    expect(derive(value)).toMatchObject({ verdict: "BLOCKED", statuses: { A11: "BLOCKED", R35: "BLOCKED" } });
  });
});
