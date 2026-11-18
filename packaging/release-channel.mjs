#!/usr/bin/env node
/**
 * Classifies a release tag and prints the values the release workflow needs.
 *
 * The workflow used to hardcode `prerelease: true`, so a stable tag would have
 * been published as a beta. The classification now lives here, in one place,
 * and is unit-tested — a shell `case` statement duplicated across three jobs is
 * exactly how the two notions drift apart.
 *
 * Supported forms:
 *   vX.Y.Z              → stable
 *   vX.Y.Z-beta.N       → prerelease
 *   vX.Y.Z-rc.N         → prerelease
 *   vX.Y.Z-alpha.N      → prerelease
 *
 * Anything else is rejected rather than guessed at: publishing an unrecognised
 * tag as "stable" is not something a user can undo.
 *
 * CLI:  node packaging/release-channel.mjs v0.1.8
 *       → key=value lines suitable for $GITHUB_OUTPUT
 */
import { appendFileSync } from "node:fs";

const SCRIPTS = ["beta", "rc", "alpha"];

/** @typedef {{ channel: "stable"|"prerelease", prerelease: boolean, version: string, name: string, major: number, minor: number, patch: number, pre: string|null }} ReleaseChannel */

/**
 * @param {string} rawTag
 * @returns {ReleaseChannel}
 */
export function classifyTag(rawTag) {
  const tag = String(rawTag ?? "").trim();
  if (!tag) throw new Error("a tag is required");

  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(tag);
  if (!match) {
    throw new Error(
      `Unsupported tag "${tag}". Expected vX.Y.Z, vX.Y.Z-beta.N, vX.Y.Z-rc.N or vX.Y.Z-alpha.N.`,
    );
  }
  const [, majorRaw, minorRaw, patchRaw, preName, preNumber] = match;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);

  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    throw new Error(`Tag "${tag}" has a non-numeric version component`);
  }

  if (preName === undefined) {
    return {
      channel: "stable",
      prerelease: false,
      version: `${major}.${minor}.${patch}`,
      name: `Search Hub v${major}.${minor}.${patch}`,
      major,
      minor,
      patch,
      pre: null,
    };
  }

  if (!SCRIPTS.includes(preName)) {
    throw new Error(`Unsupported pre-release channel "${preName}" in "${tag}"`);
  }
  if (Number(preNumber) < 1) {
    throw new Error(`Tag "${tag}" must carry a pre-release number of at least 1`);
  }

  const version = `${major}.${minor}.${patch}-${preName}.${Number(preNumber)}`;
  return {
    channel: "prerelease",
    prerelease: true,
    version,
    name: `Search Hub v${version}`,
    major,
    minor,
    patch,
    pre: `${preName}.${Number(preNumber)}`,
  };
}

/**
 * Parses a plain version (no leading `v`) into comparable parts.
 * Used to decide whether this release should become "Latest".
 */
export function parseVersion(value) {
  const text = String(value ?? "").replace(/^v/, "");
  const [core, pre] = text.split("-");
  const parts = (core ?? "").split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) {
    return null;
  }
  return { major: parts[0], minor: parts[1], patch: parts[2], pre: pre ?? null };
}

/** Numeric comparison for the release ordering; pre-release sorts below its release. */
export function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("release-channel.mjs")) {
  const tag = process.argv[2];
  try {
    const result = classifyTag(tag);
    const output = process.env["GITHUB_OUTPUT"];
    const lines = [
      `channel=${result.channel}`,
      `prerelease=${result.prerelease}`,
      `version=${result.version}`,
      `name=${result.name}`,
    ];
    for (const line of lines) console.log(line);
    if (output) appendFileSync(output, `${lines.join("\n")}\n`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
