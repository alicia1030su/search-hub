#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CANDIDATE_EVIDENCE_ARTIFACT, CANDIDATE_WORKFLOW, CI_RELEASE_EVIDENCE_ARTIFACT, PACKAGE_ARTIFACTS,
  RELEASE_EVIDENCE_VERSION, RESOURCE_EVIDENCE_VERSION, RESOURCE_RUNTIME_ARTIFACT,
  sha256File, verifyCandidateAttestationFiles, verifyCandidateManifest, verifyGhcrInspection,
} from "./release-evidence.mjs";
import { aggregateDisasterRecoveryEvidence } from "./aggregate-disaster-recovery-evidence.mjs";
import { verifyDisasterRecoveryEvidence } from "./verify-disaster-recovery-evidence.mjs";
import { verifyEvidence } from "./verify-resource-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_WORKFLOWS = Object.freeze({
  "ci.yml": "CI",
  "docker.yml": "Docker",
  "systemd.yml": "systemd service lifecycle",
  "upgrade.yml": "Upgrade and update fault injection",
  "cli.yml": "CLI packages",
});
export const PREFLIGHT_WORKFLOWS = Object.freeze({ ...REQUIRED_WORKFLOWS, [CANDIDATE_WORKFLOW]: "Release candidate" });

export function githubRepoApiPath(repoSlug, ...segments) {
  const repoParts = String(repoSlug).split("/");
  if (repoParts.length !== 2 || repoParts.some((part) => !part)) throw new Error("github_repo_slug_invalid");
  return ["repos", ...repoParts, ...segments].map((part) => encodeURIComponent(String(part))).join("/");
}

export function ghApiArgv(endpoint) {
  if (typeof endpoint !== "string" || !endpoint || /\s/.test(endpoint)) throw new Error("github_api_endpoint_invalid");
  return ["api", endpoint];
}

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

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMainPush(workflowRun) {
  return workflowRun.event === "push" && workflowRun.head_branch === "main";
}

export function selectLatestRuns(runs, sha, { includeCandidate = false } = {}) {
  const selected = new Map();
  for (const workflowRun of runs) {
    if (workflowRun.head_sha !== sha || typeof workflowRun.path !== "string") continue;
    // Strip only the canonical prefix: other/ci.yml cannot satisfy a gate.
    const workflowPath = workflowRun.path.replace(/^\.github\/workflows\//, "");
    if (workflowPath === CANDIDATE_WORKFLOW) {
      if (!includeCandidate || workflowRun.event !== "workflow_dispatch") continue;
    } else if (!Object.hasOwn(REQUIRED_WORKFLOWS, workflowPath) || !isMainPush(workflowRun)) {
      continue;
    }
    const current = selected.get(workflowPath);
    const key = `${workflowRun.created_at ?? ""}:${workflowRun.id ?? 0}`;
    const currentKey = current ? `${current.created_at ?? ""}:${current.id ?? 0}` : "";
    if (!current || key > currentKey) selected.set(workflowPath, workflowRun);
  }
  return selected;
}

export function evaluateRuns(runs, sha, options = {}) {
  const selected = selectLatestRuns(runs, sha, options);
  const required = options.includeCandidate ? PREFLIGHT_WORKFLOWS : REQUIRED_WORKFLOWS;
  const ready = [];
  const pending = [];
  const failed = [];
  for (const [workflowPath, workflowRun] of selected) {
    if (workflowRun.status !== "completed") pending.push({ workflowPath, run: workflowRun });
    else if (workflowRun.conclusion !== "success") failed.push({ workflowPath, run: workflowRun });
    else ready.push({ workflowPath, run: workflowRun });
  }
  for (const workflowPath of Object.keys(required)) {
    if (!selected.has(workflowPath)) pending.push({ workflowPath, run: null });
  }
  return { ready, pending, failed, allGreen: ready.length === Object.keys(required).length };
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
  const endpoint = `${githubRepoApiPath(repoSlug, "actions", "runs")}?head_sha=${encodeURIComponent(sha)}&per_page=100`;
  const pages = JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint], { env }));
  return pages.flatMap((page) => Array.isArray(page.workflow_runs) ? page.workflow_runs : []);
}

function ghJson(endpoint, env, { allowNotFound = false } = {}) {
  try {
    return JSON.parse(run("gh", ghApiArgv(endpoint), { env, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    if (allowNotFound && /HTTP 404|Not Found/i.test(`${error.message}\n${error.stderr ?? ""}`)) return null;
    throw error;
  }
}

function verifyArtifact(repoRoot, commit, artifactDir) {
  const runtimePath = path.join(artifactDir, RESOURCE_RUNTIME_ARTIFACT);
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  if (runtime.schemaVersion !== 1 || runtime.releaseCommit !== commit) throw new Error("artifact runtime schema/commit mismatch");
  if (runtime.suite !== `search-hub-resource-${RESOURCE_EVIDENCE_VERSION}`) throw new Error("artifact resource suite mismatch");
  const summaryPath = path.join(artifactDir, "cache-benchmark-summary.json");
  const sumsPath = path.join(artifactDir, "SHA256SUMS");
  const resource = verifyEvidence({ repoRoot, commit, summaryPath, sumsPath, evidenceDir: artifactDir });
  if (runtime.releaseCodeFingerprint !== resource.releaseCodeFingerprint ||
      runtime.summarySha256 !== sha256File(summaryPath) || runtime.sumsSha256 !== sha256File(sumsPath) ||
      runtime.rawFileCount !== resource.rawFileCount) {
    throw new Error("artifact runtime fingerprint/digest mismatch");
  }
  const evidenceDir = path.join(artifactDir, "disaster-recovery");
  if (!existsSync(evidenceDir)) throw new Error("ci_disaster_recovery_subset_missing");
  const subset = aggregateDisasterRecoveryEvidence({ repoRoot, commit, evidenceDir });
  const disasterRecovery = {
    ok: subset.gate.verdict === "PASS",
    releaseCommit: subset.gate.releaseCommit,
    releaseCodeFingerprint: subset.gate.releaseCodeFingerprint,
    verdict: subset.gate.verdict,
    requirementCount: 50,
    evidenceFileCount: subset.gate.reports.length,
    gateSha256: sha256File(subset.gatePath),
    sumsSha256: sha256File(subset.sumsPath),
    final: false,
  };
  return { combinedPath: null, combined: null, runtimePath, runtime, disasterRecovery };
}

function verifyTagAbsent(repoSlug, tag, env) {
  let local = "";
  try {
    local = run("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { /* absent locally */ }
  if (local) throw new Error(`tag_already_exists_locally:${tag}`);
  const remote = ghJson(githubRepoApiPath(repoSlug, "git", "ref", "tags", tag), env, { allowNotFound: true });
  if (remote) throw new Error(`tag_already_exists_remotely:${tag}`);
}

function verifyRemoteTag(repoSlug, tagInfo, env) {
  const remote = ghJson(githubRepoApiPath(repoSlug, "git", "ref", "tags", tagInfo.tag), env);
  if (remote?.object?.type !== "tag" || remote.object.sha !== tagInfo.tagObject) {
    throw new Error(`remote_tag_moved_or_not_annotated:${tagInfo.tag}`);
  }
  const tagObject = ghJson(githubRepoApiPath(repoSlug, "git", "tags", tagInfo.tagObject), env);
  if (tagObject?.object?.type !== "commit" || tagObject.object.sha !== tagInfo.commit) {
    throw new Error(`remote_tag_commit_mismatch:${tagInfo.tag}`);
  }
}

function verifyCandidateEvidence(repoSlug, candidateRun, manifest, env) {
  verifyCandidateManifest(manifest, {
    version: manifest.version,
    sourceSha: candidateRun.head_sha,
    runId: candidateRun.id,
    attempt: candidateRun.run_attempt,
  });
  if (manifest.sourceSha !== candidateRun.head_sha) throw new Error("candidate_manifest_source_mismatch");
  const artifactsEndpoint = `${githubRepoApiPath(repoSlug, "actions", "runs", String(candidateRun.id), "artifacts")}?per_page=100`;
  const artifacts = ghJson(artifactsEndpoint, env).artifacts ?? [];
  const byName = new Map(artifacts.filter((artifact) => !artifact.expired).map((artifact) => [artifact.name, artifact]));
  for (const name of [...PACKAGE_ARTIFACTS, CANDIDATE_EVIDENCE_ARTIFACT]) {
    if (!byName.has(name)) throw new Error(`candidate_artifact_missing:${name}`);
  }
  const temporary = mkdtempSync(path.join(tmpdir(), "search-hub-candidate-preflight-"));
  try {
    run("gh", ["run", "download", String(candidateRun.id), "--repo", repoSlug, "-n", CANDIDATE_EVIDENCE_ARTIFACT, "-D", temporary], { env });
    const sumsBytes = readFileSync(path.join(temporary, "SHA256SUMS"));
    if (sha256Bytes(sumsBytes) !== manifest.sha256sumsSha256) throw new Error("candidate_sums_sha256_mismatch");
    const combinedPath = path.join(temporary, "resource-evidence.json");
    const combined = JSON.parse(readFileSync(combinedPath, "utf8"));
    if (combined.suite !== `search-hub-release-evidence-${RELEASE_EVIDENCE_VERSION}` || combined.releaseCommit !== candidateRun.head_sha || combined.resource?.suite !== `search-hub-resource-${RESOURCE_EVIDENCE_VERSION}` || combined.disasterRecovery?.verdict !== "PASS") {
      throw new Error("candidate_release_evidence_mismatch");
    }
    if (sha256File(combinedPath) !== manifest.resourceEvidence?.sha256) throw new Error("candidate_resource_evidence_sha256_mismatch");
    verifyGhcrInspection(JSON.parse(readFileSync(path.join(temporary, "image-inspection.json"), "utf8")), manifest.image.digest, manifest.image);
    verifyCandidateAttestationFiles(manifest, path.join(temporary, "attestations"), sha256Bytes(readFileSync(path.join(temporary, "candidate-manifest.json"))));
    const verificationDirectory = path.join(temporary, "attestations", "verification");
    const verificationReports = existsSync(verificationDirectory) ? readdirSync(verificationDirectory).filter((name) => name.endsWith(".json")) : [];
    if (verificationReports.length !== manifest.assets.length + 2) throw new Error("candidate_attestation_verification_reports_missing");
    for (const name of verificationReports) {
      const report = JSON.parse(readFileSync(path.join(verificationDirectory, name), "utf8"));
      if (!Array.isArray(report) || report.length === 0 || !report[0]?.verificationResult) throw new Error(`candidate_attestation_verification_invalid:${name}`);
    }
    const disasterRecovery = verifyDisasterRecoveryEvidence({ repoRoot: REPO_ROOT, commit: candidateRun.head_sha, evidenceDir: path.join(temporary, "disaster-recovery") });
    if (combined.disasterRecovery?.gateSha256 !== disasterRecovery.gateSha256 || combined.disasterRecovery?.sumsSha256 !== disasterRecovery.sumsSha256) {
    throw new Error("candidate_combined_disaster_recovery_mismatch");
  }
    if (manifest.disasterRecovery?.gateSha256 !== disasterRecovery.gateSha256 || manifest.disasterRecovery?.sumsSha256 !== disasterRecovery.sumsSha256 || manifest.disasterRecovery?.verdict !== "PASS") {
      throw new Error("candidate_disaster_recovery_mismatch");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function resolveSourceSha(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("--sha must be a full lowercase commit SHA");
  try {
    run("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: REPO_ROOT });
  } catch {
    run("git", ["fetch", "--no-tags", "origin", sha], { cwd: REPO_ROOT });
  }
  const resolved = run("git", ["rev-parse", `${sha}^{commit}`], { cwd: REPO_ROOT }).trim();
  if (resolved !== sha) throw new Error("source_sha_not_exact_commit");
  run("git", ["fetch", "--no-tags", "origin", "main"], { cwd: REPO_ROOT });
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { cwd: REPO_ROOT });
  return resolved;
}

async function main() {
  const phase = arg("phase", "tag");
  if (!["candidate", "preflight", "tag"].includes(phase)) throw new Error("--phase must be candidate, preflight or tag");
  const repoSlug = arg("repo", process.env.GITHUB_REPOSITORY ?? "alicia1030su/search-hub");
  const env = { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "" };
  const tag = arg("tag");
  const stable = tag ? /^v(\d+\.\d+\.\d+)$/.exec(tag) : null;
  const version = arg("version", stable?.[1] ?? null);
  let sha = arg("sha");
  let tagInfo = null;
  if (phase === "candidate") {
    if (!version || !sha) throw new Error("candidate phase requires --version and --sha");
    sha = resolveSourceSha(sha);
  } else if (phase === "preflight") {
    if (!version || !sha || !tag) throw new Error("preflight requires --version, --sha and --tag");
    sha = resolveSourceSha(sha);
    if (!new RegExp(`^v${version.replace(/\./g, "\\.")}$`).test(tag)) throw new Error("preflight_tag_version_mismatch");
    verifyTagAbsent(repoSlug, tag, env);
  } else {
    if (!tag) throw new Error("--tag is required");
    tagInfo = verifyAnnotatedTag(REPO_ROOT, tag, stable?.[1] ?? null);
    sha = tagInfo.commit;
    const eventSha = arg("event-sha");
    if (eventSha && eventSha !== sha) throw new Error(`tag_event_sha_mismatch:${eventSha}/${sha}`);
  }
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  if (version && pkg.version !== version) throw new Error(`package_version_mismatch:${pkg.version}/${version}`);
  const pollSeconds = Number(arg("poll-seconds", "60"));
  const maxAttempts = Number(arg("max-attempts", "60"));
  if (!Number.isInteger(pollSeconds) || pollSeconds < 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("poll-seconds/max-attempts must be non-negative/positive integers");
  }
  const includeCandidate = phase !== "candidate";
  let evaluation = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    evaluation = evaluateRuns(listRuns(repoSlug, sha, env), sha, { includeCandidate });
    if (evaluation.failed.length > 0) {
      throw new Error(`latest workflow terminal failure: ${evaluation.failed.map((entry) => `${entry.workflowPath}=${entry.run?.conclusion}`).join(",")}`);
    }
    if (evaluation.allGreen) break;
    if (attempt === maxAttempts) throw new Error(`workflow gate timeout: ${evaluation.pending.map((entry) => entry.workflowPath).join(",")}`);
    await delay(pollSeconds * 1000);
  }
  const ciRun = evaluation.ready.find((entry) => entry.workflowPath === "ci.yml").run;
  const candidateEntry = evaluation.ready.find((entry) => entry.workflowPath === CANDIDATE_WORKFLOW);
  const candidateRun = candidateEntry?.run ?? null;
  const temporary = mkdtempSync(path.join(tmpdir(), "search-hub-release-gate-"));
  try {
    run("gh", ["run", "download", String(ciRun.id), "--repo", repoSlug, "-n", CI_RELEASE_EVIDENCE_ARTIFACT, "-D", temporary], { env });
    const evidence = verifyArtifact(REPO_ROOT, sha, temporary);
    let candidate = null;
    if (candidateRun) {
      const requestedRun = Number(arg("candidate-run", "0"));
      if (requestedRun && requestedRun !== candidateRun.id) throw new Error(`candidate_run_not_latest:${candidateRun.id}/${requestedRun}`);
      const candidateTemporary = mkdtempSync(path.join(tmpdir(), "search-hub-candidate-evidence-"));
      try {
        run("gh", ["run", "download", String(candidateRun.id), "--repo", repoSlug, "-n", CANDIDATE_EVIDENCE_ARTIFACT, "-D", candidateTemporary], { env });
        const manifest = JSON.parse(readFileSync(path.join(candidateTemporary, "candidate-manifest.json"), "utf8"));
        if (manifest.version !== version) throw new Error("candidate_version_mismatch");
        if (manifest.ciRunId !== ciRun.id) throw new Error("candidate_ci_run_mismatch");
        verifyCandidateEvidence(repoSlug, candidateRun, manifest, env);
        candidate = { runId: candidateRun.id, attempt: candidateRun.run_attempt, image: manifest.image, resourceEvidence: manifest.resourceEvidence, disasterRecovery: manifest.disasterRecovery };
      } finally {
        rmSync(candidateTemporary, { recursive: true, force: true });
      }
    }
    if (phase === "tag") verifyRemoteTag(repoSlug, tagInfo, env);
    const reportPath = arg("report", path.join(REPO_ROOT, "artifacts", "v0.1.15", phase === "candidate" ? "candidate-gate.json" : "release-gate.json"));
    const report = {
      schemaVersion: 2,
      phase,
      sha,
      version,
      tag: tagInfo,
      requiredWorkflows: includeCandidate ? PREFLIGHT_WORKFLOWS : REQUIRED_WORKFLOWS,
      candidateRunId: phase === "candidate" ? Number(process.env.GITHUB_RUN_ID ?? 0) || null : candidateRun?.id ?? null,
      candidateAttempt: phase === "candidate" ? Number(process.env.GITHUB_RUN_ATTEMPT ?? 0) || null : candidateRun?.run_attempt ?? null,
      runs: evaluation.ready.map(({ workflowPath, run: workflowRun }) => ({
        workflowPath,
        id: workflowRun.id,
        url: workflowRun.html_url,
        attempt: workflowRun.run_attempt,
        headSha: workflowRun.head_sha,
        event: workflowRun.event,
        headBranch: workflowRun.head_branch,
        conclusion: workflowRun.conclusion,
      })),
      ciRunId: ciRun.id,
      candidate,
      tagCreationAllowed: phase === "preflight",
      evidence: {
        combinedSuite: evidence.combined?.suite ?? null,
        combinedSha256: evidence.combinedPath ? sha256File(evidence.combinedPath) : null,
        releaseCommit: evidence.runtime.releaseCommit,
        releaseCodeFingerprint: evidence.runtime.releaseCodeFingerprint,
        summarySha256: evidence.runtime.summarySha256,
        sumsSha256: evidence.runtime.sumsSha256,
        rawFileCount: evidence.runtime.rawFileCount,
      },
      disasterRecovery: evidence.disasterRecovery,
    };
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nciRunId=${ciRun.id}\n`, "utf8");
      if (report.candidateRunId) appendFileSync(process.env.GITHUB_OUTPUT, `candidateRunId=${report.candidateRunId}\ncandidateAttempt=${report.candidateAttempt}\n`, "utf8");
      if (candidate?.image) appendFileSync(process.env.GITHUB_OUTPUT, `candidateRef=${candidate.image.ref}\ncandidateDigest=${candidate.image.digest}\ncandidateRepository=${candidate.image.repository}\n`, "utf8");
      if (phase === "preflight") appendFileSync(process.env.GITHUB_OUTPUT, `tagCreationAllowed=true\n`, "utf8");
    }
    console.log(JSON.stringify({ reportPath, phase, sha, ciRunId: ciRun.id, candidateRunId: report.candidateRunId, workflows: report.runs.length, tagCreationAllowed: report.tagCreationAllowed }, null, 2));
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
