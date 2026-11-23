#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyEvidence } from "./verify-resource-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_WORKFLOWS = Object.freeze({
  "ci.yml": "CI",
  "docker.yml": "Docker",
  "systemd.yml": "systemd service lifecycle",
  "upgrade.yml": "Upgrade and update fault injection",
  "cli.yml": "CLI packages",
});

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function selectLatestRuns(runs, sha) {
  const selected = new Map();
  for (const workflowRun of runs) {
    if (workflowRun.head_sha !== sha || workflowRun.event !== "push" || workflowRun.head_branch !== "main") continue;
    if (!Object.hasOwn(REQUIRED_WORKFLOWS, workflowRun.path)) continue;
    const current = selected.get(workflowRun.path);
    const key = `${workflowRun.created_at ?? ""}:${workflowRun.id ?? 0}`;
    const currentKey = current ? `${current.created_at ?? ""}:${current.id ?? 0}` : "";
    if (!current || key > currentKey) selected.set(workflowRun.path, workflowRun);
  }
  return selected;
}

export function evaluateRuns(runs, sha) {
  const selected = selectLatestRuns(runs, sha);
  const ready = [];
  const pending = [];
  const failed = [];
  for (const [workflowPath, workflowRun] of selected) {
    if (workflowRun.status !== "completed") pending.push({ workflowPath, run: workflowRun });
    else if (workflowRun.conclusion !== "success") failed.push({ workflowPath, run: workflowRun });
    else ready.push({ workflowPath, run: workflowRun });
  }
  for (const workflowPath of Object.keys(REQUIRED_WORKFLOWS)) {
    if (!selected.has(workflowPath)) pending.push({ workflowPath, run: null });
  }
  return { ready, pending, failed, allGreen: ready.length === Object.keys(REQUIRED_WORKFLOWS).length };
}

export function verifyAnnotatedTag(repoRoot, tag, expectedVersion = null) {
  const type = run("git", ["cat-file", "-t", `refs/tags/${tag}`], { cwd: repoRoot }).trim();
  if (type !== "tag") throw new Error(`tag_not_annotated:${tag}`);
  const commit = run("git", ["rev-parse", `${tag}^{commit}`], { cwd: repoRoot }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("tag_commit_invalid");
  const mainRef = run("git", ["rev-parse", "--verify", "origin/main"], { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).trim();
  run("git", ["merge-base", "--is-ancestor", commit, mainRef], { cwd: repoRoot });
  if (expectedVersion) {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    if (pkg.version !== expectedVersion) throw new Error(`tag_version_mismatch:${tag}/${pkg.version}`);
  }
  return { tag, tagObject: run("git", ["rev-parse", `refs/tags/${tag}`], { cwd: repoRoot }).trim(), commit };
}

function listRuns(repoSlug, sha, env) {
  const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repoSlug}/actions/runs?head_sha=${sha}&per_page=100`], { env }));
  return pages.flatMap((page) => Array.isArray(page.workflow_runs) ? page.workflow_runs : []);
}

function verifyArtifact(repoRoot, commit, artifactDir) {
  const runtimePath = path.join(artifactDir, "resource-evidence-v0114.json");
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  if (runtime.releaseCommit !== commit) throw new Error("artifact releaseCommit mismatch");
  if (runtime.releaseCodeFingerprint !== verifyEvidence({
    repoRoot,
    commit,
    summaryPath: path.join(artifactDir, "cache-benchmark-summary.json"),
    sumsPath: path.join(artifactDir, "SHA256SUMS"),
    evidenceDir: artifactDir,
  }).releaseCodeFingerprint) throw new Error("artifact releaseCodeFingerprint mismatch");
  return { runtimePath, runtime };
}

async function main() {
  const tag = arg("tag");
  if (!tag) throw new Error("--tag is required");
  const repoSlug = arg("repo", process.env.GITHUB_REPOSITORY ?? "alicia1030su/search-hub");
  const pollSeconds = Number(arg("poll-seconds", "60"));
  const maxAttempts = Number(arg("max-attempts", "60"));
  if (!Number.isInteger(pollSeconds) || pollSeconds < 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("poll-seconds/max-attempts must be non-negative/positive integers");
  }
  const reportPath = arg("report", path.join(REPO_ROOT, "artifacts", "v0.1.14", "release-gate.json"));
  const env = { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "" };
  const stable = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  const tagInfo = verifyAnnotatedTag(REPO_ROOT, tag, stable?.[1] ?? null);
  const sha = tagInfo.commit;
  let evaluation = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    evaluation = evaluateRuns(listRuns(repoSlug, sha, env), sha);
    if (evaluation.failed.length > 0) {
      throw new Error(`latest workflow terminal failure: ${evaluation.failed.map((entry) => `${entry.workflowPath}=${entry.run?.conclusion}`).join(",")}`);
    }
    if (evaluation.allGreen) break;
    if (attempt === maxAttempts) throw new Error(`workflow gate timeout: ${evaluation.pending.map((entry) => entry.workflowPath).join(",")}`);
    await delay(pollSeconds * 1000);
  }
  const ciRun = evaluation.ready.find((entry) => entry.workflowPath === "ci.yml").run;
  const temporary = mkdtempSync(path.join(tmpdir(), "search-hub-release-gate-"));
  try {
    run("gh", ["run", "download", String(ciRun.id), "--repo", repoSlug, "-n", "resource-evidence-v0114", "-D", temporary], { env });
    const evidence = verifyArtifact(REPO_ROOT, sha, temporary);
    const report = {
      schemaVersion: 1,
      tag: tagInfo,
      requiredWorkflows: REQUIRED_WORKFLOWS,
      runs: evaluation.ready.map(({ workflowPath, run: workflowRun }) => ({
        workflowPath,
        id: workflowRun.id,
        url: workflowRun.html_url,
        attempt: workflowRun.run_attempt,
        headSha: workflowRun.head_sha,
        conclusion: workflowRun.conclusion,
      })),
      ciRunId: ciRun.id,
      evidence: {
        releaseCommit: evidence.runtime.releaseCommit,
        releaseCodeFingerprint: evidence.runtime.releaseCodeFingerprint,
        summarySha256: evidence.runtime.summarySha256,
        sumsSha256: evidence.runtime.sumsSha256,
        rawFileCount: evidence.runtime.rawFileCount,
      },
    };
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ciRunId=${ciRun.id}\n`, "utf8");
    console.log(JSON.stringify({ reportPath, sha, ciRunId: ciRun.id, workflows: report.runs.length }, null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`release gate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
