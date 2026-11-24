#!/usr/bin/env node
/** Exact-SHA core disaster-recovery acceptance report generator. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIREMENTS = [
  ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
];
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT IMPLEMENTED"]);
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const NODE = process.execPath;

const COMMANDS = [
  {
    name: "backup-package",
    command: PNPM,
    args: ["exec", "vitest", "run", "tests/unit/backup-package.test.ts", "--maxWorkers=1"],
    requirements: ["R06", "R10", "R22", "A01", "A02", "A03", "A05", "A06"],
    timeoutMs: 300_000,
  },
  {
    name: "backup-snapshot",
    command: PNPM,
    args: ["exec", "vitest", "run", "tests/unit/backup-snapshot.test.ts", "--maxWorkers=1"],
    requirements: ["R01", "R07", "R08", "R09", "R10", "R11", "R21", "A05"],
    timeoutMs: 300_000,
  },
  {
    name: "cli-backup",
    command: PNPM,
    args: ["exec", "vitest", "run", "tests/unit/cli/backup.test.ts", "--maxWorkers=1"],
    requirements: ["R10", "R19", "R21", "R25", "R38", "A03", "A09"],
    timeoutMs: 300_000,
  },
  {
    name: "backup-api",
    command: PNPM,
    args: ["exec", "vitest", "run", "tests/integration/backup.test.ts", "--maxWorkers=1", "--no-file-parallelism"],
    requirements: ["R03", "R04", "R05", "R06", "R09", "R35", "R36", "R37", "A02", "A05", "A09", "A10"],
    timeoutMs: 300_000,
  },
  {
    name: "backup-restore-isolated",
    command: PNPM,
    args: ["exec", "vitest", "run", "tests/integration/backup-restore-isolated.test.ts", "--maxWorkers=1", "--no-file-parallelism"],
    requirements: ["R15", "R16"],
    timeoutMs: 300_000,
  },
  {
    name: "backup-faults",
    command: PNPM,
    args: ["exec", "vitest", "run", "tests/integration/backup-faults.test.ts", "--maxWorkers=1", "--no-file-parallelism"],
    requirements: ["R23", "R24", "R25", "A02", "A10"],
    timeoutMs: 600_000,
  },
  {
    name: "updater-e2e",
    command: NODE,
    args: ["packaging/launcher/updater-test.mjs"],
    requirements: ["R31", "R32", "R33", "A07"],
    timeoutMs: 300_000,
  },
  {
    name: "updater-faults",
    command: NODE,
    args: ["packaging/launcher/updater-faults.mjs"],
    requirements: ["R32", "A07"],
    timeoutMs: 600_000,
  },
  {
    name: "crypto-race",
    command: PNPM,
    args: ["exec", "vitest", "run", "tests/unit/crypto.test.ts", "--maxWorkers=1"],
    requirements: ["A03"],
    timeoutMs: 180_000,
  },
  {
    name: "typecheck",
    command: PNPM,
    args: ["typecheck"],
    requirements: ["R35"],
    timeoutMs: 240_000,
  },
  {
    name: "lint",
    command: PNPM,
    args: ["lint"],
    requirements: ["R35"],
    timeoutMs: 180_000,
  },
  {
    name: "secret-scan",
    command: NODE,
    args: ["scripts/secret-scan.mjs"],
    requirements: ["R37"],
    timeoutMs: 240_000,
  },
];

const COVERED_REQUIREMENTS = [...new Set(COMMANDS.flatMap((entry) => entry.requirements))];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function coreVerdict(dirty, statuses) {
  if (statuses.includes("FAIL")) return "FAIL";
  if (dirty || !statuses.every((status) => status === "PASS")) return "BLOCKED";
  return "PASS";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function source() {
  const commit = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  const diff = spawnSync("git", ["diff", "--binary", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout ?? "";
  return {
    commit,
    releaseCodeFingerprint: codeFingerprint(ROOT, commit),
    dirty: status.length > 0,
    changedPaths: status ? status.split(/\r?\n/).length : 0,
    diffSha256: sha256(diff),
  };
}

function listFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(relative);
  }
  return files.sort();
}

function writeSums(root) {
  const lines = listFiles(root).map((relative) => `${sha256(readFileSync(path.join(root, relative)))}  ${relative}`);
  writeFileSync(path.join(root, "SHA256SUMS"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

function writeReport(root, report) {
  writeFileSync(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeSums(root);
}

function selfCheck() {
  const checks = [];
  checks.push({ name: "requirement_set", ok: REQUIREMENTS.length === 50 && new Set(REQUIREMENTS).size === 50 });
  checks.push({ name: "mapping", ok: COMMANDS.every((entry) => entry.requirements.every((id) => REQUIREMENTS.includes(id))) });
  checks.push({ name: "scope_verdict", ok:
    coreVerdict(false, ["PASS", "PASS"]) === "PASS" &&
    coreVerdict(false, ["PASS", "NOT TESTED"]) === "BLOCKED" &&
    coreVerdict(true, ["PASS"]) === "BLOCKED" &&
    coreVerdict(false, ["FAIL"]) === "FAIL" });
  const root = mkdtempSync(path.join(tmpdir(), "shub-core-acceptance-self-"));
  try {
    mkdirSync(path.join(root, "logs"), { recursive: true });
    writeFileSync(path.join(root, "logs", "sample.txt"), "synthetic\n");
    const requirements = Object.fromEntries(REQUIREMENTS.map((id) => [id, "NOT TESTED"]));
    requirements.R01 = "PASS";
    const requirementEvidence = Object.fromEntries(REQUIREMENTS.map((id) => [id, []]));
    requirementEvidence.R01 = [{ path: "logs/sample.txt", sha256: sha256("synthetic\n") }];
    const report = {
      schemaVersion: 1,
      kind: "search-hub-disaster-recovery-core",
      source: { commit: "a".repeat(40), releaseCodeFingerprint: "b".repeat(64), dirty: false },
      verdict: "BLOCKED",
      acceptanceComplete: false,
      scope: "self-check only",
      requirements,
      requirementEvidence,
      evidence: requirementEvidence,
    };
    writeReport(root, report);
    const sums = readFileSync(path.join(root, "SHA256SUMS"), "utf8");
    checks.push({ name: "report_schema", ok: Object.values(requirements).every((status) => STATUSES.has(status)) });
    checks.push({ name: "evidence_alias", ok: JSON.stringify(report.requirementEvidence) === JSON.stringify(report.evidence) });
    checks.push({ name: "sha256sums", ok: sums.includes(`${sha256(readFileSync(path.join(root, "logs", "sample.txt")))}  logs/sample.txt`) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, checks, tempCleaned: !existsSync(root) }, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
}

async function run() {
  const outputDir = path.resolve(arg("output-dir") ?? "");
  if (!outputDir) throw new Error("--output-dir is required");
  if (existsSync(outputDir) && readdirSync(outputDir).length > 0) throw new Error("output-dir must be new or empty");
  const src = source();
  if (src.dirty && !process.argv.includes("--allow-dirty")) {
    throw new Error("working tree is dirty; exact-SHA acceptance requires a clean tree (use --allow-dirty only for development BLOCKED evidence)");
  }
  mkdirSync(path.join(outputDir, "logs"), { recursive: true });
  const requirements = Object.fromEntries(REQUIREMENTS.map((id) => [id, "NOT TESTED"]));
  const requirementEvidence = Object.fromEntries(REQUIREMENTS.map((id) => [id, []]));
  const commands = [];
  for (const entry of COMMANDS) {
    const startedAt = new Date().toISOString();
    const result = spawnSync(entry.command, entry.args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: entry.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
      env: process.env,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const logPath = `logs/${entry.name}.log`;
    writeFileSync(path.join(outputDir, logPath), `${stdout}\n${stderr}`, { mode: 0o600 });
    const logBytes = readFileSync(path.join(outputDir, logPath));
    const blocked = result.error?.code === "ETIMEDOUT" || result.error?.code === "ENOBUFS" || result.error?.code === "ENOMEM";
    let status = result.status === 0 ? "PASS" : blocked ? "BLOCKED" : "FAIL";
    if (src.dirty && status === "PASS") status = "BLOCKED";
    for (const id of entry.requirements) {
      const previous = requirements[id];
      if (status === "FAIL" || previous === "NOT TESTED" || (status === "BLOCKED" && previous === "PASS")) requirements[id] = status;
      requirementEvidence[id].push({ path: logPath, sha256: sha256(logBytes), command: entry.name, status });
    }
    commands.push({ name: entry.name, command: [entry.command, ...entry.args].join(" "), status, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, startedAt, finishedAt: new Date().toISOString(), log: logPath });
  }
  const allPass = Object.values(requirements).every((status) => status === "PASS");
  const verdict = coreVerdict(src.dirty, COVERED_REQUIREMENTS.map((id) => requirements[id]));
  const report = {
    schemaVersion: 1,
    kind: "search-hub-disaster-recovery-core",
    source: src,
    verdict,
    acceptanceComplete: allPass && !src.dirty,
    scope: "core command subset; platform, performance and release evidence are aggregated separately",
    coveredRequirements: COVERED_REQUIREMENTS,
    requirements,
    requirementEvidence,
    evidence: requirementEvidence,
    commands,
    generatedAt: new Date().toISOString(),
  };
  writeReport(outputDir, report);
  process.stdout.write(`${JSON.stringify({ verdict, acceptanceComplete: report.acceptanceComplete, report: "report.json", commandCount: commands.length, dirty: src.dirty }, null, 2)}\n`);
  process.exitCode = verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 75;
}

if (process.argv.includes("--help")) {
  process.stdout.write("usage: core-acceptance.mjs --self-check | --run --output-dir <dir> [--allow-dirty]\n");
} else if (process.argv.includes("--self-check")) {
  selfCheck();
} else if (process.argv.includes("--run")) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  process.stderr.write("usage: core-acceptance.mjs --self-check | --run --output-dir <dir> [--allow-dirty]\n");
  process.exitCode = 2;
}
