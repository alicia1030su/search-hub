#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";
import { MAIN_PUSH_WORKFLOWS } from "../../packaging/release-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MEMORY_SIZES = Object.freeze([10, 64, 256]);
const PERFORMANCE_SIZES = Object.freeze([10, 64, 128, 256]);
const CLI_REPORTS = Object.freeze(["cli-windows-x64", "cli-linux-x64", "cli-linux-arm64", "cli-node22"]);
const PLATFORM_REPORTS = Object.freeze(["platform-windows", "platform-linux-x64", "platform-linux-arm64", "platform-docker", "platform-systemd"]);
const PLATFORM_KINDS = Object.freeze({
  "platform-windows": "search-hub-platform-windows",
  "platform-linux-x64": "search-hub-platform-linux",
  "platform-linux-arm64": "search-hub-platform-linux",
  "platform-docker": "search-hub-platform-docker",
  "platform-systemd": "search-hub-platform-systemd",
});
const RELEASE_REQUIREMENTS = Object.freeze(["A08", "A11", "A12", "R35"]);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") &&
    !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && !value.split("/").includes("..");
}

function listFiles(root) {
  const files = [];
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`release_status_symlink:${path.posix.join(directory, entry.name)}`);
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files.sort();
}

function sourceMatches(report, commit, fingerprint) {
  return report?.source?.commit === commit && report.source?.releaseCodeFingerprint === fingerprint && report.source?.dirty === false;
}

function statusFor(check) {
  if (check.ok) return "PASS";
  return check.failure === true ? "FAIL" : "BLOCKED";
}

function completePerformance(report) {
  const schedule = report.schedule ?? {};
  const sizes = Array.isArray(schedule.sizesMiB) ? schedule.sizesMiB : [];
  if (!PERFORMANCE_SIZES.every((size) => sizes.includes(size)) || schedule.measuredRounds < 5 ||
      schedule.freshProcessRounds < 1 || schedule.singleRoundSmoke === true || !Array.isArray(report.results)) return false;
  return PERFORMANCE_SIZES.every((size) => {
    const result = report.results.find((entry) => entry?.sizeMiB === size);
    return result?.result === "PASS" && result.growth?.result === "PASS" && result.resourceComplete === true &&
      result.sourceUnchanged === true && Array.isArray(result.rounds) && result.rounds.length >= 5 &&
      result.rounds.every((round) => round.result === "PASS") &&
      Array.isArray(result.freshProcessRounds) && result.freshProcessRounds.length >= 1 &&
      result.freshProcessRounds.every((round) => round.result === "PASS");
  });
}

function completeMemory(report) {
  const schedule = report.schedule ?? {};
  const loop = report.loop ?? {};
  return report.verdict === "PASS" && report.requirements?.R34 === "PASS" &&
    schedule.rounds >= 5 && schedule.sameProcess === true && schedule.adapterMode === "final" &&
    report.tool?.gcAvailable === true && loop.spawnCount === 0 &&
    Array.isArray(loop.measured) && loop.measured.length >= 5 &&
    loop.measured.every((round) => round.result === "PASS" && round.cleanup?.ok === true && round.cleanup?.removed === true) &&
    loop.growth?.result === "PASS";
}

function gateMatches(gate, commit, fingerprint) {
  if (gate?.schemaVersion !== 2 || gate.phase !== "candidate" || gate.sha !== commit ||
      gate.evidence?.releaseCodeFingerprint !== fingerprint || !Number.isSafeInteger(gate.ciRunId) || gate.ciRunId <= 0 ||
      !Number.isSafeInteger(gate.candidateRunId) || gate.candidateRunId <= 0 || !Array.isArray(gate.runs)) return false;
  if (gate.runs.length !== MAIN_PUSH_WORKFLOWS.length) return false;
  const paths = gate.runs.map((run) => run?.workflowPath).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...MAIN_PUSH_WORKFLOWS].sort())) return false;
  return gate.runs.every((run) => run?.headSha === commit && run.event === "push" && run.headBranch === "main" && run.conclusion === "success");
}

function displayPath(evidenceDir, file) {
  const relative = path.relative(evidenceDir, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) ? relative.split(path.sep).join("/") : path.basename(file);
}

function copyEvidence(outputDir, evidenceDir, sourcePath) {
  const relative = path.relative(evidenceDir, sourcePath).split(path.sep).join("/");
  if (!safeRelative(relative)) throw new Error(`release_status_evidence_outside_root:${sourcePath}`);
  const destination = path.posix.join("evidence", relative);
  mkdirSync(path.dirname(path.join(outputDir, destination)), { recursive: true });
  copyFileSync(sourcePath, path.join(outputDir, destination));
  return destination;
}

export function deriveReleaseStatuses({ repoRoot = REPO_ROOT, commit, evidenceDir, candidateGatePath, outputDir, sourceDirty = null, candidateWorkflowPath = path.join(repoRoot, ".github", "workflows", "release-candidate.yml"), releaseWorkflowPath = path.join(repoRoot, ".github", "workflows", "release.yml") }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("release_status_commit_invalid");
  const fingerprint = codeFingerprint(repoRoot, commit);
  const dirty = sourceDirty ?? (spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout ?? "").trim().length > 0;
  const checks = [];
  const addCheck = (name, ok, paths = [], failure = false) => {
    checks.push({ name, ok, status: statusFor({ ok, failure }), evidence: paths.map((file) => displayPath(evidenceDir, file)) });
  };

  addCheck("clean-source", !dirty);

  const gate = existsSync(candidateGatePath) ? readJson(candidateGatePath) : null;
  addCheck("candidate-gate", gateMatches(gate, commit, fingerprint), [candidateGatePath], gate?.runs?.some((run) => run?.conclusion === "failure") === true);

  const corePath = path.join(evidenceDir, "reports", "core", "report.json");
  const core = existsSync(corePath) ? readJson(corePath) : null;
  const coreCommandsPass = Array.isArray(core?.commands) && core.commands.length > 0 && core.commands.every((command) => command.status === "PASS" && command.exitCode === 0);
  addCheck("core", Boolean(core && core.kind === "search-hub-disaster-recovery-core" && sourceMatches(core, commit, fingerprint) && core.verdict === "PASS" && coreCommandsPass), core ? [corePath] : [], core?.verdict === "FAIL" || core?.commands?.some((command) => command.status === "FAIL") === true);

  const performancePath = path.join(evidenceDir, "reports", "performance", "manifest.json");
  const performance = existsSync(performancePath) ? readJson(performancePath) : null;
  addCheck("performance", Boolean(performance && sourceMatches(performance, commit, fingerprint) && performance.kind === "search-hub-disaster-recovery-performance" && performance.verdict === "PASS" && performance.acceptanceComplete === true && completePerformance(performance)), performance ? [performancePath] : [], performance?.verdict === "FAIL" || performance?.results?.some((result) => result.result === "FAIL") === true);

  const memoryBySize = new Map();
  if (existsSync(path.join(evidenceDir, "reports"))) {
    for (const relative of listFiles(path.join(evidenceDir, "reports"))) {
      if (path.posix.basename(relative) !== "manifest.json") continue;
      const file = path.join(evidenceDir, "reports", relative);
      const report = readJson(file);
      if (report?.kind !== "search-hub-disaster-recovery-memory-loop") continue;
      const size = report.schedule?.sizeMiB;
      if (!MEMORY_SIZES.includes(size)) continue;
      const entries = memoryBySize.get(size) ?? [];
      entries.push({ file, report });
      memoryBySize.set(size, entries);
    }
  }
  const memoryEntries = [...memoryBySize.values()].flat();
  const memoryPass = MEMORY_SIZES.every((size) => {
    const entries = memoryBySize.get(size) ?? [];
    return entries.length > 0 && entries.every((entry) => sourceMatches(entry.report, commit, fingerprint) && completeMemory(entry.report));
  });
  addCheck("memory-loop", memoryPass, memoryEntries.map((entry) => entry.file), memoryEntries.some((entry) => entry.report.verdict === "FAIL" || entry.report.loop?.growth?.result === "FAIL"));

  const cliReports = CLI_REPORTS.map((slug) => {
    const file = path.join(evidenceDir, "reports", slug, "report.json");
    return { slug, file, report: existsSync(file) ? readJson(file) : null };
  });
  const cliPass = cliReports.every(({ report }) => {
    const evidence = report?.requirementEvidence?.A04 ?? report?.evidence?.A04;
    return sourceMatches(report, commit, fingerprint) && report.kind === "search-hub-cli-package" && report.verdict === "PASS" && report.requirements?.A04 === "PASS" && Array.isArray(evidence) && evidence.length > 0;
  });
  addCheck("cli-packages", cliPass, cliReports.map(({ file }) => file).filter(existsSync), cliReports.some(({ report }) => report?.verdict === "FAIL" || report?.requirements?.A04 === "FAIL"));

  const platformPass = PLATFORM_REPORTS.every((slug) => {
    const file = path.join(evidenceDir, "reports", slug, "report.json");
    if (!existsSync(file)) return false;
    const report = readJson(file);
    const valid = sourceMatches(report, commit, fingerprint) && report.kind === PLATFORM_KINDS[slug] && report.verdict === "PASS";
    return valid;
  });
  addCheck("platforms", platformPass, PLATFORM_REPORTS.map((slug) => path.join(evidenceDir, "reports", slug, "report.json")).filter(existsSync), PLATFORM_REPORTS.some((slug) => {
    const file = path.join(evidenceDir, "reports", slug, "report.json");
    return existsSync(file) && readJson(file).verdict === "FAIL";
  }));

  const workflowsPass = existsSync(candidateWorkflowPath) && existsSync(releaseWorkflowPath);
  addCheck("release-workflows", workflowsPass, [candidateWorkflowPath, releaseWorkflowPath].filter(existsSync), false);

  const failed = checks.some((check) => check.status === "FAIL");
  const passed = checks.every((check) => check.ok);
  const verdict = failed ? "FAIL" : passed ? "PASS" : "BLOCKED";
  const statuses = Object.fromEntries(RELEASE_REQUIREMENTS.map((id) => [id, verdict]));

  mkdirSync(outputDir, { recursive: true });
  const evidenceMap = {};
  for (const id of RELEASE_REQUIREMENTS) {
    const files = [];
    if (id === "A08") {
      for (const slug of PLATFORM_REPORTS) files.push(path.join(evidenceDir, "reports", slug, "report.json"));
    } else if (id === "A11") {
      files.push(corePath, performancePath, ...memoryEntries.map((entry) => entry.file), ...CLI_REPORTS.map((slug) => path.join(evidenceDir, "reports", slug, "report.json")), ...PLATFORM_REPORTS.map((slug) => path.join(evidenceDir, "reports", slug, "report.json")), candidateGatePath);
    } else if (id === "A12") {
      files.push(candidateGatePath, candidateWorkflowPath, releaseWorkflowPath);
    } else {
      files.push(corePath, candidateGatePath);
    }
    evidenceMap[id] = files.filter(existsSync).map((file) => {
      if (path.relative(evidenceDir, file) && !path.relative(evidenceDir, file).startsWith(`..${path.sep}`) && path.relative(evidenceDir, file) !== "..") {
        return copyEvidence(outputDir, evidenceDir, file);
      }
      const name = path.basename(file);
      const destination = path.join(outputDir, name);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(file, destination);
      return name;
    });
  }

  const result = {
    schemaVersion: 1,
    kind: "search-hub-candidate-release-statuses",
    source: { commit, releaseCodeFingerprint: fingerprint, dirty },
    verdict,
    statuses,
    checks,
    evidenceMap,
  };
  writeFileSync(path.join(outputDir, "derived-release-statuses.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function main() {
  const result = deriveReleaseStatuses({
    commit: arg("source-sha"),
    evidenceDir: path.resolve(arg("evidence-dir")),
    candidateGatePath: path.resolve(arg("candidate-gate")),
    outputDir: path.resolve(arg("output-dir")),
  });
  console.log(JSON.stringify({ verdict: result.verdict, statuses: result.statuses, checks: result.checks.map((check) => ({ name: check.name, status: check.status })) }, null, 2));
  if (result.verdict !== "PASS") process.exitCode = result.verdict === "FAIL" ? 1 : 75;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`release status derivation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
