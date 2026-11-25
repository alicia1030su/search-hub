import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Read the release version from the root package manifest.
 *
 * The root manifest is the only mutable version source. Historical evidence and
 * upgrade-source versions live in their own explicitly named constants.
 *
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function readReleaseVersion(repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !STABLE_VERSION.test(manifest.version)) {
    throw new Error(`invalid_stable_release_version:${String(manifest.version)}`);
  }
  return manifest.version;
}

/** @param {string} version */
export function versionTag(version) {
  if (!STABLE_VERSION.test(version)) throw new Error(`invalid_stable_release_version:${version}`);
  return `v${version}`;
}

/** @param {string} version */
export function versionSlug(version) {
  if (!STABLE_VERSION.test(version)) throw new Error(`invalid_stable_release_version:${version}`);
  return version.replaceAll(".", "");
}

/** @param {string} version */
export function releaseEvidenceArtifact(version) {
  return `release-evidence-${versionTag(version)}`;
}

/** @param {string} version */
export function candidateEvidenceArtifact(version) {
  return `release-candidate-evidence-${versionTag(version)}`;
}

/** @param {string} version */
export function resourceRuntimeArtifact(version) {
  return `resource-evidence-v${versionSlug(version)}.json`;
}

/** @param {string} version */
export function disasterRecoverySuite(version) {
  return `search-hub-disaster-recovery-${versionTag(version)}`;
}
