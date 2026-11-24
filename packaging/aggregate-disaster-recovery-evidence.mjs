#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPublicEvidence, codeFingerprint, sha256 } from "../scripts/lib/resource-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIREMENTS = Object.freeze([
  ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
]);
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT IMPLEMENTED"]);
const REPORT_NAMES = new Set(["report.json", "manifest.json"]);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") &&
    !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && !value.split("/").includes("..");
}

function listFiles(root) {
  const files = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    for (const entry of readdirSync(path.join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`dr_aggregate_symlink:${relativePath}`);
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`dr_aggregate_non_file:${relativePath}`);
    }
  }
  return files.sort();
}

function parseSums(text) {
  const sums = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    check(Boolean(match), `dr_aggregate_invalid_sum:${line}`);
    const [, digest, name] = match;
    check(safeRelative(name) && !sums.has(name), `dr_aggregate_unsafe_sum:${name}`);
    sums.set(name, digest);
  }
  return sums;
}

function findReports(root) {
  const reportsRoot = path.join(root, "reports");
  if (!existsSync(reportsRoot)) return [];
  return listFiles(reportsRoot)
    .filter((name) => REPORT_NAMES.has(path.posix.basename(name)) || name.endsWith("-report.json"))
    .map((name) => path.join(reportsRoot, name));
}

function completePerformanceSchedule(report) {
  const schedule = report.schedule ?? {};
  const sizes = Array.isArray(schedule.sizesMiB) ? schedule.sizesMiB : [];
  if (![10, 64, 256].every((size) => sizes.includes(size)) || schedule.measuredRounds < 5 ||
      schedule.freshProcessRounds < 1 || schedule.singleRoundSmoke === true || !Array.isArray(report.results)) return false;
  return [10, 64, 256].every((size) => {
    const result = report.results.find((entry) => entry?.sizeMiB === size);
    return result?.result === "PASS" && result.growth?.result === "PASS" && result.resourceComplete === true &&
      Array.isArray(result.rounds) && result.rounds.length >= 5 &&
      Array.isArray(result.freshProcessRounds) && result.freshProcessRounds.length >= 1;
  });
}

function hasPerformanceR34Subset(reportPaths, commit, fingerprint) {
  for (const candidate of reportPaths) {
    try {
      const report = JSON.parse(readFileSync(candidate, "utf8"));
      if (report.kind === "search-hub-disaster-recovery-performance" &&
          report.source?.commit === commit && report.source?.releaseCodeFingerprint === fingerprint &&
          report.source?.dirty === false && report.requirementEvidence?.R34?.performanceSubset === "PASS" &&
          completePerformanceSchedule(report)) return true;
    } catch {
      // The main validation pass reports malformed/tampered evidence explicitly.
    }
  }
  return false;
}

function findCoveringSums(reportPath, reportsRoot) {
  let directory = path.dirname(reportPath);
  while (directory.startsWith(reportsRoot)) {
    const sumsPath = path.join(directory, "SHA256SUMS");
    if (existsSync(sumsPath)) {
      const sums = parseSums(readFileSync(sumsPath, "utf8"));
      const relative = path.relative(directory, reportPath).split(path.sep).join("/");
      if (sums.has(relative)) return { sumsPath, sums, relative };
    }
    if (directory === reportsRoot) break;
    directory = path.dirname(directory);
  }
  throw new Error(`dr_report_sums_missing:${path.relative(reportsRoot, reportPath).split(path.sep).join("/")}`);
}

function normalizeStatus(value, report, id) {
  check(STATUSES.has(value), `dr_report_status_invalid:${report}/${id}=${value}`);
  return value;
}

export function aggregateDisasterRecoveryEvidence({ repoRoot = REPO_ROOT, commit, evidenceDir }) {
  check(/^[0-9a-f]{40}$/.test(commit ?? ""), "dr_aggregate_commit_invalid");
  check(existsSync(evidenceDir), "dr_aggregate_evidence_dir_missing");
  const fingerprint = codeFingerprint(repoRoot, commit);
  const reportsRoot = path.join(evidenceDir, "reports");
  const reportPaths = findReports(evidenceDir);
  const requirements = Object.fromEntries(REQUIREMENTS.map((id) => [id, "NOT TESTED"]));
  const evidence = Object.fromEntries(REQUIREMENTS.map((id) => [id, []]));
  const performanceOnly = Object.fromEntries(REQUIREMENTS.map((id) => [id, false]));
  const specialized = Object.fromEntries(REQUIREMENTS.map((id) => [id, false]));
  const reports = [];

  for (const reportPath of reportPaths) {
    const relativeReport = path.relative(evidenceDir, reportPath).split(path.sep).join("/");
    const bytes = readFileSync(reportPath);
    const report = JSON.parse(bytes.toString("utf8"));
    assertPublicEvidence(report);
    check(report.schemaVersion === 1 && typeof report.kind === "string", `dr_report_schema_invalid:${relativeReport}`);
    check(report.source?.commit === commit, `dr_report_commit_mismatch:${relativeReport}`);
    check(report.source?.releaseCodeFingerprint === fingerprint, `dr_report_fingerprint_mismatch:${relativeReport}`);
    check(report.source?.dirty === false, `dr_report_dirty_source:${relativeReport}`);
    const covering = findCoveringSums(reportPath, reportsRoot);
    check(covering.sums.get(covering.relative) === sha256(bytes), `dr_report_sums_mismatch:${relativeReport}`);
    const reportDigest = sha256(bytes);
    reports.push({ path: relativeReport, sha256: reportDigest, kind: report.kind });
    check(report.requirements && typeof report.requirements === "object" && !Array.isArray(report.requirements), `dr_report_requirements_missing:${relativeReport}`);
    for (const [id, rawStatus] of Object.entries(report.requirements)) {
      check(REQUIREMENTS.includes(id), `dr_report_requirement_unknown:${relativeReport}/${id}`);
      let status = normalizeStatus(rawStatus, relativeReport, id);
      const isPerformance = report.kind === "search-hub-disaster-recovery-performance";
      const isPerformanceFullRequirement = isPerformance && ["R34", "A04", "A11"].includes(id);
      if (status === "PASS" && report.kind === "search-hub-disaster-recovery-memory-loop" && id === "R34" &&
          !hasPerformanceR34Subset(reportPaths, commit, fingerprint)) status = "BLOCKED";
      if (status === "PASS") {
        const requirementEvidence = report.requirementEvidence?.[id] ?? report.evidence?.[id];
        check(requirementEvidence && (!Array.isArray(requirementEvidence) || requirementEvidence.length > 0), `dr_report_pass_without_evidence:${relativeReport}/${id}`);
        check(!isPerformanceFullRequirement, `dr_performance_cannot_pass_full_requirement:${id}`);
      }
      if (isPerformanceFullRequirement && status !== "PASS") {
        performanceOnly[id] = true;
      } else if (!isPerformance) {
        specialized[id] = true;
        if (status === "FAIL") {
          requirements[id] = "FAIL";
        } else if (status === "NOT IMPLEMENTED" || status === "BLOCKED") {
          const priority = { "NOT TESTED": 0, PASS: 1, "NOT IMPLEMENTED": 2, BLOCKED: 3, FAIL: 4 };
          if (priority[status] > priority[requirements[id]]) requirements[id] = status;
        } else if (status === "PASS" && requirements[id] === "NOT TESTED") {
          requirements[id] = "PASS";
        }
      } else if (status === "FAIL") {
        requirements[id] = "FAIL";
      } else if (status === "PASS" && requirements[id] === "NOT TESTED") {
        requirements[id] = "PASS";
      }
      if (!evidence[id].some((entry) => entry.path === relativeReport)) {
        evidence[id].push({ path: relativeReport, sha256: reportDigest, kind: report.kind, status });
      }
    }
  }

  // A performance subset can explain why a full requirement is not covered,
  // but it can never override an independent complete platform/core report.
  for (const id of REQUIREMENTS) {
    if (performanceOnly[id] && !specialized[id] && requirements[id] === "NOT TESTED") {
      const statuses = evidence[id]
        .filter((entry) => entry.kind === "search-hub-disaster-recovery-performance")
        .map((entry) => entry.status);
      if (statuses.includes("BLOCKED")) requirements[id] = "BLOCKED";
      else if (statuses.includes("NOT IMPLEMENTED")) requirements[id] = "NOT IMPLEMENTED";
    }
  }

  const failed = REQUIREMENTS.some((id) => requirements[id] === "FAIL");
  const allPass = REQUIREMENTS.every((id) => requirements[id] === "PASS");
  const gate = {
    schemaVersion: 1,
    suite: "search-hub-disaster-recovery-v0.1.15",
    releaseCommit: commit,
    releaseCodeFingerprint: fingerprint,
    source: { commit, dirty: false },
    verdict: failed ? "FAIL" : allPass ? "PASS" : "BLOCKED",
    acceptanceComplete: allPass,
    requirements,
    evidence,
    reports,
  };
  assertPublicEvidence(gate);
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "gate.json"), `${JSON.stringify(gate, null, 2)}\n`, "utf8");
  const files = listFiles(evidenceDir).filter((name) => name !== "SHA256SUMS");
  const sums = files.map((name) => `${sha256(readFileSync(path.join(evidenceDir, name)))}  ${name}`).sort();
  writeFileSync(path.join(evidenceDir, "SHA256SUMS"), `${sums.join("\n")}\n`, "utf8");
  return { gate, gatePath: path.join(evidenceDir, "gate.json"), sumsPath: path.join(evidenceDir, "SHA256SUMS"), reportCount: reports.length };
}

async function main() {
  const commit = arg("commit");
  if (!commit) throw new Error("--commit is required");
  const evidenceDir = arg("evidence-dir", path.join(REPO_ROOT, "docs", "evidence", "v0.1.15", "disaster-recovery"));
  const result = aggregateDisasterRecoveryEvidence({ commit, evidenceDir });
  console.log(JSON.stringify({ verdict: result.gate.verdict, acceptanceComplete: result.gate.acceptanceComplete, reportCount: result.reportCount, gatePath: result.gatePath }, null, 2));
  if (result.gate.verdict !== "PASS" && !process.argv.includes("--allow-incomplete")) process.exitCode = 75;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`disaster recovery aggregation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
