#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeFingerprint } from "../scripts/lib/resource-evidence.mjs";
import { verifyDisasterRecoveryEvidence } from "./verify-disaster-recovery-evidence.mjs";
import { verifyEvidence } from "./verify-resource-evidence.mjs";
import {
  candidateEvidenceArtifact, readReleaseVersion, releaseEvidenceArtifact,
  resourceRuntimeArtifact, versionTag,
} from "../scripts/lib/release-version.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CURRENT_RELEASE_VERSION = readReleaseVersion(REPO_ROOT);
export const RELEASE_EVIDENCE_VERSION = versionTag(CURRENT_RELEASE_VERSION);
// The cache benchmark is intentionally frozen to the reviewed v0.1.14 baseline.
export const RESOURCE_EVIDENCE_VERSION = "v0.1.14";
export const RESOURCE_RUNTIME_ARTIFACT = resourceRuntimeArtifact(CURRENT_RELEASE_VERSION);
export const CI_RELEASE_EVIDENCE_ARTIFACT = releaseEvidenceArtifact(CURRENT_RELEASE_VERSION);

export const CANDIDATE_WORKFLOW = "release-candidate.yml";
export const CANDIDATE_EVIDENCE_ARTIFACT = candidateEvidenceArtifact(CURRENT_RELEASE_VERSION);
export const MAIN_PUSH_WORKFLOWS = Object.freeze(["ci.yml", "cli.yml", "docker.yml", "systemd.yml", "upgrade.yml"]);
export const PACKAGE_ARTIFACTS = Object.freeze([
  "windows-x64",
  "linux-x64",
  "linux-arm64",
  "cli-windows-x64",
  "cli-linux-x64",
  "cli-linux-arm64",
  "cli-node22",
]);

export function expectedReleaseAssets(version) {
  return [
    `search-hub-v${version}-windows-x64.zip`,
    `search-hub-v${version}-linux-x64.tar.gz`,
    `search-hub-v${version}-linux-arm64.tar.gz`,
    `shub-v${version}-windows-x64.zip`,
    `shub-v${version}-linux-x64.tar.gz`,
    `shub-v${version}-linux-arm64.tar.gz`,
    `shub-v${version}-node22.tar.gz`,
    "resource-evidence.json",
  ].sort();
}

export function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function parseSha256Sums(text) {
  const entries = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})  ([^/\n]+)$/.exec(line);
    if (!match) throw new Error(`invalid_sha256_line:${line}`);
    const [, digest, name] = match;
    if (name.includes("..") || name.includes("\\") || entries.has(name)) throw new Error(`unsafe_or_duplicate_sum:${name}`);
    entries.set(name, digest);
  }
  return entries;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function verifyMainPushRuns(runs, sourceSha) {
  requireCondition(Array.isArray(runs) && runs.length === MAIN_PUSH_WORKFLOWS.length, "candidate_main_gates_missing");
  requireCondition(JSON.stringify(runs.map((gate) => gate.workflowPath).sort()) === JSON.stringify([...MAIN_PUSH_WORKFLOWS].sort()), "candidate_main_gate_set_mismatch");
  for (const gate of runs) {
    requireCondition(gate.headSha === sourceSha && gate.conclusion === "success", `candidate_gate_not_green:${gate.workflowPath}`);
    requireCondition(gate.event === "push" && gate.headBranch === "main", `candidate_gate_not_main_push:${gate.workflowPath}`);
  }
}

export function verifyReleaseAssets(directory, { version, sourceSha, manifest }) {
  requireCondition(/^\d+\.\d+\.\d+$/.test(version ?? ""), "invalid_release_version");
  requireCondition(/^[0-9a-f]{40}$/.test(sourceSha ?? ""), "invalid_source_sha");
  requireCondition(manifest?.schemaVersion === 1, "unsupported_candidate_manifest");
  requireCondition(manifest.version === version, "candidate_version_mismatch");
  requireCondition(manifest.sourceSha === sourceSha, "candidate_source_sha_mismatch");
  requireCondition(manifest.workflowPath === `.github/workflows/${CANDIDATE_WORKFLOW}`, "candidate_workflow_mismatch");
  requireCondition(manifest.event === "workflow_dispatch", "candidate_event_mismatch");
  requireCondition(Number.isSafeInteger(manifest.runId) && manifest.runId > 0, "candidate_run_id_invalid");
  requireCondition(Number.isSafeInteger(manifest.attempt) && manifest.attempt > 0, "candidate_attempt_invalid");
  verifyMainPushRuns(manifest.requiredWorkflowRuns, sourceSha);

  const packages = expectedReleaseAssets(version);
  const sumsName = "SHA256SUMS";
  const expectedNames = [...packages, sumsName].sort();
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error("release_asset_non_file_entry");
  const actualNames = entries.map((entry) => entry.name).sort();
  requireCondition(JSON.stringify(actualNames) === JSON.stringify(expectedNames), `release_asset_set_mismatch:${actualNames.join(",")}`);

  const evidence = readJson(path.join(directory, "resource-evidence.json"));
  requireCondition(evidence.schemaVersion === 2 && evidence.suite === `search-hub-release-evidence-${RELEASE_EVIDENCE_VERSION}`, "release_evidence_suite_mismatch");
  requireCondition(evidence.releaseCommit === sourceSha, "resource_evidence_commit_mismatch");
  requireCondition(evidence.resource?.suite === `search-hub-resource-${RESOURCE_EVIDENCE_VERSION}` && evidence.resource.releaseCommit === sourceSha, "resource_runtime_suite_or_commit_mismatch");
  requireCondition(evidence.releaseCodeFingerprint === codeFingerprint(REPO_ROOT, sourceSha) && evidence.releaseCodeFingerprint === evidence.resource.releaseCodeFingerprint && evidence.releaseCodeFingerprint === evidence.disasterRecovery?.releaseCodeFingerprint, "release_evidence_fingerprint_mismatch");
  requireCondition(evidence.disasterRecovery?.verdict === "PASS" && evidence.disasterRecovery.requirementCount === 50, "disaster_recovery_gate_not_pass");
  requireCondition(manifest.resourceEvidence?.sha256 === sha256File(path.join(directory, "resource-evidence.json")), "resource_evidence_manifest_mismatch");
  requireCondition(manifest.disasterRecovery?.verdict === "PASS" && manifest.disasterRecovery.requirementCount === 50, "disaster_recovery_manifest_mismatch");
  requireCondition(manifest.resourceEvidence.summarySha256 === evidence.resource.summarySha256 && manifest.resourceEvidence.sumsSha256 === evidence.resource.sumsSha256 && manifest.resourceEvidence.rawFileCount === evidence.resource.rawFileCount, "resource_runtime_manifest_mismatch");
  requireCondition(manifest.disasterRecovery.gateSha256 === evidence.disasterRecovery.gateSha256 && manifest.disasterRecovery.sumsSha256 === evidence.disasterRecovery.sumsSha256, "disaster_recovery_evidence_manifest_mismatch");

  const sums = parseSha256Sums(readFileSync(path.join(directory, sumsName), "utf8"));
  requireCondition(JSON.stringify([...sums.keys()].sort()) === JSON.stringify(packages), "sha256sums_asset_set_mismatch");
  for (const name of packages) {
    requireCondition(sha256File(path.join(directory, name)) === sums.get(name), `asset_sha256_mismatch:${name}`);
  }

  const descriptors = new Map((manifest.assets ?? []).map((asset) => [asset.name, asset]));
  requireCondition(descriptors.size === expectedNames.length, "candidate_manifest_asset_count_mismatch");
  for (const name of expectedNames) {
    const actualDigest = sha256File(path.join(directory, name));
    const descriptor = descriptors.get(name);
    requireCondition(descriptor?.sha256 === actualDigest, `manifest_asset_sha256_mismatch:${name}`);
    requireCondition(descriptor?.bytes === statSync(path.join(directory, name)).size, `manifest_asset_size_mismatch:${name}`);
  }
  requireCondition(manifest.sha256sumsSha256 === sha256File(path.join(directory, sumsName)), "sha256sums_manifest_mismatch");
  return { ok: true, assets: expectedNames, sha256sumsSha256: manifest.sha256sumsSha256 };
}

export function verifyCandidateManifest(manifest, { version, sourceSha, runId, attempt }) {
  requireCondition(manifest?.schemaVersion === 1, "unsupported_candidate_manifest");
  requireCondition(manifest.version === version, "candidate_version_mismatch");
  requireCondition(manifest.sourceSha === sourceSha, "candidate_source_sha_mismatch");
  requireCondition(manifest.runId === runId && manifest.attempt === attempt, "candidate_run_mismatch");
  requireCondition(Number.isSafeInteger(manifest.ciRunId) && manifest.ciRunId > 0, "candidate_ci_run_invalid");
  requireCondition(manifest.workflowPath === `.github/workflows/${CANDIDATE_WORKFLOW}` && manifest.event === "workflow_dispatch", "candidate_workflow_mismatch");
  verifyMainPushRuns(manifest.requiredWorkflowRuns, sourceSha);
  requireCondition(Array.isArray(manifest.packageArtifacts) && JSON.stringify([...manifest.packageArtifacts].sort()) === JSON.stringify([...PACKAGE_ARTIFACTS].sort()), "candidate_package_artifacts_mismatch");
  requireCondition(manifest.evidenceArtifact === CANDIDATE_EVIDENCE_ARTIFACT, "candidate_evidence_artifact_mismatch");
  requireCondition(manifest.ciEvidenceArtifact === CI_RELEASE_EVIDENCE_ARTIFACT, "candidate_ci_evidence_artifact_mismatch");
  requireCondition(manifest.resourceEvidence?.releaseCommit === sourceSha && manifest.resourceEvidence.suite === `search-hub-resource-${RESOURCE_EVIDENCE_VERSION}` && manifest.resourceEvidence.runtimeArtifact === RESOURCE_RUNTIME_ARTIFACT, "candidate_resource_evidence_mismatch");
  requireCondition(manifest.disasterRecovery?.artifact === CI_RELEASE_EVIDENCE_ARTIFACT && manifest.disasterRecovery.gate === "disaster-recovery/gate.json" && manifest.disasterRecovery.verdict === "PASS" && manifest.disasterRecovery.requirementCount === 50, "candidate_disaster_recovery_mismatch");
  requireCondition(Array.isArray(manifest.assets) && manifest.assets.length === 9 && /^[0-9a-f]{64}$/.test(manifest.sha256sumsSha256 ?? ""), "candidate_asset_manifest_mismatch");
  verifyGhcrImage(manifest.image);
  requireCondition(manifest.image.ref.endsWith(`:candidate-${sourceSha}-${runId}-${attempt}`), "candidate_image_ref_binding_mismatch");
  requireCondition(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].includes(manifest.image.manifestMediaType), "candidate_image_media_type_mismatch");
  requireCondition(/^sha256:[0-9a-f]{64}$/.test(manifest.image.configDigest ?? ""), "candidate_image_config_digest_invalid");
  requireCondition(["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"].includes(manifest.image.configMediaType), "candidate_image_config_media_type_mismatch");
  return { ok: true, image: manifest.image };
}

export function verifyGhcrImage(image) {
  requireCondition(/^sha256:[0-9a-f]{64}$/.test(image?.digest ?? ""), "ghcr_digest_invalid");
  requireCondition(image?.platform?.os === "linux" && image?.platform?.architecture === "amd64", "ghcr_platform_mismatch");
  requireCondition(typeof image.repository === "string" && /^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(image.repository), "ghcr_repository_invalid");
  requireCondition(image.reference === `${image.repository}@${image.digest}`, "ghcr_reference_mismatch");
  requireCondition(typeof image.ref === "string" && image.ref.startsWith(`${image.repository}:candidate-`), "ghcr_candidate_ref_invalid");
  return { ok: true, digest: image.digest, platform: image.platform };
}

export function normalizeGhcrInspection(formatted, rawManifestBytes, expectedDigest) {
  requireCondition(/^sha256:[0-9a-f]{64}$/.test(expectedDigest ?? ""), "ghcr_expected_digest_invalid");
  requireCondition(Buffer.isBuffer(rawManifestBytes), "ghcr_raw_manifest_bytes_invalid");
  const manifest = formatted?.Manifest ?? formatted?.manifest;
  const image = formatted?.Image ?? formatted?.image;
  requireCondition((manifest?.Digest ?? manifest?.digest) === expectedDigest, "ghcr_manifest_digest_mismatch");
  const mediaType = manifest?.MediaType ?? manifest?.mediaType ?? manifest?.Descriptor?.mediaType ?? manifest?.descriptor?.mediaType;
  requireCondition(Boolean(mediaType), "ghcr_media_type_mismatch");
  const rawSha256 = createHash("sha256").update(rawManifestBytes).digest("hex");
  requireCondition(`sha256:${rawSha256}` === expectedDigest, "ghcr_raw_manifest_digest_mismatch");
  let raw;
  try {
    raw = JSON.parse(rawManifestBytes.toString("utf8"));
  } catch {
    throw new Error("ghcr_raw_manifest_invalid");
  }
  requireCondition(raw?.schemaVersion === 2, "ghcr_raw_manifest_schema_mismatch");
  requireCondition(raw?.mediaType === mediaType, "ghcr_raw_manifest_media_type_mismatch");
  const normalized = {
    Manifest: { Digest: expectedDigest, MediaType: mediaType, Config: raw?.config },
    Image: { os: image?.os, architecture: image?.architecture },
    RawManifest: { sha256: expectedDigest, bytes: rawManifestBytes.length },
  };
  verifyGhcrInspection(normalized, expectedDigest);
  return normalized;
}

export function verifyGhcrInspection(inspection, expectedDigest, image = null) {
  requireCondition(/^sha256:[0-9a-f]{64}$/.test(expectedDigest ?? ""), "ghcr_expected_digest_invalid");
  if (inspection?.RawManifest) {
    requireCondition(inspection.RawManifest.sha256 === expectedDigest && Number.isSafeInteger(inspection.RawManifest.bytes) && inspection.RawManifest.bytes > 0, "ghcr_raw_manifest_metadata_mismatch");
  }
  const manifest = inspection?.Manifest ?? inspection?.manifest;
  const imageInspection = inspection?.Image ?? inspection?.image;
  const config = manifest?.Config ?? manifest?.config;
  requireCondition((manifest?.Digest ?? manifest?.digest) === expectedDigest, "ghcr_manifest_digest_mismatch");
  const mediaType = manifest?.MediaType ?? manifest?.mediaType ?? manifest?.Descriptor?.mediaType ?? manifest?.descriptor?.mediaType;
  requireCondition(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].includes(mediaType), "ghcr_media_type_mismatch");
  requireCondition(/^sha256:[0-9a-f]{64}$/.test(config?.digest ?? ""), "ghcr_config_digest_invalid");
  requireCondition(["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"].includes(config?.mediaType), "ghcr_config_media_type_mismatch");
  requireCondition(imageInspection?.os === "linux" && imageInspection?.architecture === "amd64", "ghcr_image_platform_mismatch");
  const result = { ok: true, digest: expectedDigest, mediaType, configDigest: config.digest, configMediaType: config.mediaType, platform: { os: imageInspection.os, architecture: imageInspection.architecture } };
  if (image) verifyImageDescriptorBinding(image, result);
  return result;
}

function verifyImageDescriptorBinding(image, inspected) {
  requireCondition(image.manifestMediaType === inspected.mediaType, "candidate_image_manifest_media_type_mismatch");
  requireCondition(image.configDigest === inspected.configDigest, "candidate_image_config_digest_mismatch");
  requireCondition(image.configMediaType === inspected.configMediaType, "candidate_image_config_media_type_mismatch");
  requireCondition(image.platform?.os === inspected.platform.os && image.platform?.architecture === inspected.platform.architecture, "candidate_image_platform_mismatch");
}

function attestationReference(repo, sourceSha, digest, prefix = "") {
  return {
    bundle: `${prefix}sha256-${digest}.jsonl`,
    signerWorkflow: `${repo}/.github/workflows/release-candidate.yml`,
    sourceSha,
    predicateType: "https://slsa.dev/provenance/v1",
  };
}

export function verifyCandidateAttestationFiles(manifest, attestationDirectory, manifestDigest = null) {
  requireCondition(Array.isArray(manifest.assets) && manifest.assets.length === 9, "candidate_attestation_assets_missing");
  requireCondition(manifest.attestationPolicy?.sourceSha === manifest.sourceSha, "candidate_attestation_policy_source_mismatch");
  requireCondition(manifest.attestationPolicy?.predicateType === "https://slsa.dev/provenance/v1", "candidate_attestation_predicate_mismatch");
  for (const asset of manifest.assets) {
    const expected = attestationReference(manifest.attestationPolicy.repository, manifest.sourceSha, asset.sha256);
    requireCondition(JSON.stringify(asset.attestation) === JSON.stringify(expected), `attestation_reference_mismatch:${asset.name}`);
    const bundle = path.join(attestationDirectory, asset.attestation.bundle);
    requireCondition(existsSync(bundle) && statSync(bundle).size > 0, `attestation_bundle_missing:${asset.name}`);
  }
  const manifestBundles = readdirSync(attestationDirectory).filter((name) => /^sha256-[0-9a-f]{64}\.jsonl$/.test(name));
  const assetBundles = new Set(manifest.assets.map((asset) => asset.attestation.bundle));
  const manifestBundle = manifestDigest ? `sha256-${manifestDigest}.jsonl` : manifestBundles.find((name) => !assetBundles.has(name));
  requireCondition(Boolean(manifestBundle) && manifestBundles.includes(manifestBundle) && statSync(path.join(attestationDirectory, manifestBundle)).size > 0, "manifest_attestation_bundle_missing");
  const imageBundle = path.join(attestationDirectory, manifest.image.attestation?.bundle ?? "");
  const expectedImageAttestation = attestationReference(manifest.attestationPolicy.repository, manifest.sourceSha, manifest.image.digest.slice(7), "image-");
  requireCondition(JSON.stringify(manifest.image.attestation) === JSON.stringify(expectedImageAttestation), "image_attestation_reference_mismatch");
  requireCondition(existsSync(imageBundle) && statSync(imageBundle).size > 0, "image_attestation_bundle_missing");
  return { ok: true, count: manifest.assets.length + 2 };
}

export function createCandidateManifest({ directory, output, version, sourceSha, runId, attempt, ciRunId, image, imageInspection, candidateGate, repo, disasterRecoveryDir }) {
  const inspected = verifyGhcrInspection(imageInspection, image.digest);
  verifyGhcrImage(image);
  requireCondition(typeof repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), "candidate_repository_invalid");
  const disasterRecovery = verifyDisasterRecoveryEvidence({ repoRoot: REPO_ROOT, commit: sourceSha, evidenceDir: disasterRecoveryDir });
  const combinedEvidence = readJson(path.join(directory, "resource-evidence.json"));
  requireCondition(combinedEvidence.disasterRecovery?.gateSha256 === disasterRecovery.gateSha256, "combined_dr_gate_hash_mismatch");
  requireCondition(combinedEvidence.disasterRecovery?.sumsSha256 === disasterRecovery.sumsSha256, "combined_dr_sums_hash_mismatch");
  const assets = expectedReleaseAssets(version).map((name) => {
    const digest = sha256File(path.join(directory, name));
    return {
      name,
      bytes: statSync(path.join(directory, name)).size,
      sha256: digest,
      attestation: attestationReference(repo, sourceSha, digest),
    };
  });
  const sha256sumsSha256 = sha256File(path.join(directory, "SHA256SUMS"));
  assets.push({ name: "SHA256SUMS", bytes: statSync(path.join(directory, "SHA256SUMS")).size, sha256: sha256sumsSha256, attestation: attestationReference(repo, sourceSha, sha256sumsSha256) });
  assets.sort((a, b) => a.name.localeCompare(b.name));
  const gate = readJson(candidateGate);
  requireCondition(gate.candidateRunId === runId && gate.sha === sourceSha, "candidate_gate_binding_mismatch");
  requireCondition(gate.ciRunId === ciRunId, "candidate_ci_run_binding_mismatch");
  verifyMainPushRuns(gate.runs, sourceSha);
  const manifest = {
    schemaVersion: 1,
    version,
    sourceSha,
    runId,
    attempt,
    ciRunId,
    workflowPath: `.github/workflows/${CANDIDATE_WORKFLOW}`,
    event: "workflow_dispatch",
    packageArtifacts: [...PACKAGE_ARTIFACTS],
    evidenceArtifact: CANDIDATE_EVIDENCE_ARTIFACT,
    ciEvidenceArtifact: CI_RELEASE_EVIDENCE_ARTIFACT,
    attestationPolicy: {
      repository: repo,
      signerWorkflow: `${repo}/.github/workflows/release-candidate.yml`,
      sourceSha,
      predicateType: "https://slsa.dev/provenance/v1",
      manifestBundlePattern: "sha256-<manifest-file-sha256>.jsonl",
    },
    requiredWorkflowRuns: gate.runs,
    resourceEvidence: {
      releaseCommit: sourceSha,
      suite: `search-hub-resource-${RESOURCE_EVIDENCE_VERSION}`,
      runtimeArtifact: RESOURCE_RUNTIME_ARTIFACT,
      sha256: assets.find((asset) => asset.name === "resource-evidence.json").sha256,
      summarySha256: combinedEvidence.resource.summarySha256,
      sumsSha256: combinedEvidence.resource.sumsSha256,
      rawFileCount: combinedEvidence.resource.rawFileCount,
    },
    disasterRecovery: {
      artifact: CI_RELEASE_EVIDENCE_ARTIFACT,
      gate: "disaster-recovery/gate.json",
      gateSha256: disasterRecovery.gateSha256,
      sumsSha256: disasterRecovery.sumsSha256,
      requirementCount: disasterRecovery.requirementCount,
      evidenceFileCount: disasterRecovery.evidenceFileCount,
      verdict: disasterRecovery.verdict,
    },
    image: {
      ...image,
      manifestMediaType: inspected.mediaType,
      configDigest: inspected.configDigest,
      configMediaType: imageInspection.Manifest.Config.mediaType,
      attestation: attestationReference(repo, sourceSha, image.digest.slice(7), "image-"),
    },
    sha256sumsSha256,
    assets,
  };
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function combineReleaseEvidence({ resourcePath, disasterRecoveryDir, output, repoRoot = REPO_ROOT, commit }) {
  const resource = readJson(resourcePath);
  requireCondition(resource.schemaVersion === 1 && resource.suite === `search-hub-resource-${RESOURCE_EVIDENCE_VERSION}`, "resource_runtime_suite_mismatch");
  requireCondition(resource.releaseCommit === commit, "resource_runtime_commit_mismatch");
  requireCondition(resource.releaseCodeFingerprint === codeFingerprint(repoRoot, commit), "resource_runtime_code_fingerprint_mismatch");
  const disasterRecovery = verifyDisasterRecoveryEvidence({ repoRoot, commit, evidenceDir: disasterRecoveryDir });
  const combined = {
    schemaVersion: 2,
    suite: `search-hub-release-evidence-${RELEASE_EVIDENCE_VERSION}`,
    releaseCommit: commit,
    releaseCodeFingerprint: resource.releaseCodeFingerprint,
    resource,
    disasterRecovery: { ...disasterRecovery, gate: "disaster-recovery/gate.json" },
  };
  writeFileSync(output, `${JSON.stringify(combined, null, 2)}\n`, "utf8");
  return combined;
}

export function verifyCombinedReleaseEvidence({ combinedPath, disasterRecoveryDir, repoRoot = REPO_ROOT, commit }) {
  const combined = readJson(combinedPath);
  const evidenceDir = path.dirname(combinedPath);
  requireCondition(combined.schemaVersion === 2 && combined.suite === `search-hub-release-evidence-${RELEASE_EVIDENCE_VERSION}` && combined.releaseCommit === commit, "combined_release_evidence_mismatch");
  const runtime = readJson(path.join(evidenceDir, RESOURCE_RUNTIME_ARTIFACT));
  requireCondition(combined.resource?.suite === `search-hub-resource-${RESOURCE_EVIDENCE_VERSION}` && combined.resource.releaseCommit === commit, "resource_runtime_suite_or_commit_mismatch");
  requireCondition(runtime.schemaVersion === 1 && runtime.suite === combined.resource.suite && runtime.releaseCommit === commit, "resource_runtime_suite_or_commit_mismatch");
  requireCondition(JSON.stringify(combined.resource) === JSON.stringify(runtime), "combined_resource_runtime_mismatch");
  requireCondition(runtime.summarySha256 === sha256File(path.join(evidenceDir, "cache-benchmark-summary.json")) && runtime.sumsSha256 === sha256File(path.join(evidenceDir, "SHA256SUMS")) && runtime.rawFileCount === 8, "resource_runtime_digest_mismatch");
  const resource = verifyEvidence({
    repoRoot,
    commit,
    summaryPath: path.join(evidenceDir, "cache-benchmark-summary.json"),
    sumsPath: path.join(evidenceDir, "SHA256SUMS"),
    evidenceDir,
  });
  const disasterRecovery = verifyDisasterRecoveryEvidence({ repoRoot, commit, evidenceDir: disasterRecoveryDir });
  requireCondition(combined.releaseCodeFingerprint === resource.releaseCodeFingerprint && combined.releaseCodeFingerprint === disasterRecovery.releaseCodeFingerprint, "combined_release_fingerprint_mismatch");
  requireCondition(combined.disasterRecovery?.gateSha256 === disasterRecovery.gateSha256 && combined.disasterRecovery.sumsSha256 === disasterRecovery.sumsSha256 && combined.disasterRecovery.verdict === "PASS" && combined.disasterRecovery.requirementCount === 50, "combined_disaster_recovery_mismatch");
  return { ok: true, releaseCommit: commit, releaseCodeFingerprint: resource.releaseCodeFingerprint, requirementCount: 50 };
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const mode = process.argv[2];
  if (mode === "create") {
    const manifest = createCandidateManifest({
      directory: path.resolve(arg("dir")),
      output: path.resolve(arg("output")),
      version: arg("version"),
      sourceSha: arg("source-sha"),
      runId: Number(arg("run-id")),
      attempt: Number(arg("attempt")),
      ciRunId: Number(arg("ci-run-id")),
      image: readJson(path.resolve(arg("image"))),
      imageInspection: readJson(path.resolve(arg("image-inspection"))),
      candidateGate: path.resolve(arg("candidate-gate")),
      repo: arg("repo", process.env.GITHUB_REPOSITORY),
      disasterRecoveryDir: path.resolve(arg("dr-dir", arg("disaster-recovery-dir"))),
    });
    console.log(JSON.stringify({ ok: true, assets: manifest.assets.length }, null, 2));
    return;
  }
  if (mode === "verify") {
    const manifestPath = path.resolve(arg("manifest"));
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const expected = {
      version: arg("version"),
      sourceSha: arg("source-sha"),
      runId: Number(arg("run-id")),
      attempt: Number(arg("attempt")),
    };
    verifyCandidateManifest(manifest, expected);
    const result = verifyReleaseAssets(path.resolve(arg("dir")), { ...expected, manifest });
    verifyGhcrInspection(readJson(path.resolve(arg("image-inspection"))), manifest.image.digest, manifest.image);
    verifyCandidateAttestationFiles(manifest, path.resolve(arg("attestations")), createHash("sha256").update(manifestBytes).digest("hex"));
    console.log(JSON.stringify({ ...result, image: manifest.image, runId: manifest.runId }, null, 2));
    return;
  }
  if (mode === "normalize-inspection") {
    const formatted = readJson(path.resolve(arg("formatted")));
    const rawManifestBytes = readFileSync(path.resolve(arg("raw")));
    const normalized = normalizeGhcrInspection(formatted, rawManifestBytes, arg("digest"));
    const output = path.resolve(arg("output"));
    writeFileSync(output, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, output, rawManifest: normalized.RawManifest }, null, 2));
    return;
  }
  if (mode === "image") {
    const result = verifyGhcrInspection(readJson(path.resolve(arg("inspection"))), arg("digest"), arg("image") ? readJson(path.resolve(arg("image"))) : null);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (mode === "combine") {
    const combined = combineReleaseEvidence({
      resourcePath: path.resolve(arg("resource")),
      disasterRecoveryDir: path.resolve(arg("dr-dir", arg("disaster-recovery-dir"))),
      output: path.resolve(arg("output")),
      commit: arg("source-sha"),
    });
    console.log(JSON.stringify({ ok: true, suite: combined.suite, requirementCount: combined.disasterRecovery.requirementCount }, null, 2));
    return;
  }
  if (mode === "verify-combined") {
    const result = verifyCombinedReleaseEvidence({
      combinedPath: path.resolve(arg("file")),
      disasterRecoveryDir: path.resolve(arg("dr-dir", arg("disaster-recovery-dir"))),
      commit: arg("source-sha"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (mode === "sums") {
    const directory = path.resolve(arg("dir"));
    const names = expectedReleaseAssets(arg("version"));
    const lines = names.map((name) => `${sha256File(path.join(directory, name))}  ${name}`).sort();
    writeFileSync(path.join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
    console.log(`wrote SHA256SUMS (${lines.length} entries)`);
    return;
  }
  throw new Error("usage: release-evidence.mjs create|combine|verify-combined|verify|normalize-inspection|image|sums");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`release evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
