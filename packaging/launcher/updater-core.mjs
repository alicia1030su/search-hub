#!/usr/bin/env node
/**
 * Search Hub updater — the process that swaps program files.
 *
 * It is deliberately a **separate process** from the server:
 * - on Windows the running `SearchHub.exe` (and the bundled `node.exe`) are locked
 *   and cannot be replaced in place;
 * - on Linux systemd owns the service, so the same flow is driven from outside.
 *
 * Flow:
 *   1. re-verify the staged package (SHA256 + size + archive layout)
 *   2. refuse downgrades, foreign architectures and path traversal
 *   3. back up the data directory (database + master key) and the current program
 *   4. install the new program files
 *   5. start it and wait for a health check
 *   6. on failure, restore the old program **and**, when the database schema moved
 *      forward irreversibly, restore the database from the pre-update backup too
 *
 * Everything that can destroy data is fail-closed: if a check cannot be performed,
 * the update does not proceed.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** Thrown for every refusal; `code` is what the caller reports. */
export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

const ALLOWED_SUFFIX = {
  win32: ".zip",
  linux: ".tar.gz",
};

/**
 * Rejects an archive entry that would write outside the install root.
 *
 * Zip/Tar entries are attacker-influenced: `--prefix` style traversal (`../`),
 * absolute paths and Windows drive-relative names all exist in the wild.
 */
export function assertSafeEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new UpdateError("unsafe_archive", "Archive contains an empty entry name");
  }
  const normalized = entry.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new UpdateError("unsafe_archive", `Archive entry is absolute: ${entry}`);
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new UpdateError("unsafe_archive", `Archive entry is drive-qualified: ${entry}`);
  }
  const parts = normalized.split("/");
  if (parts.includes("..")) {
    throw new UpdateError("unsafe_archive", `Archive entry escapes the install root: ${entry}`);
  }
  return normalized;
}

/** Refuses anything that is not a forward version change. */
export function assertUpgrade(currentVersion, targetVersion) {
  const parse = (value) => {
    const [core, pre] = String(value).replace(/^v/, "").split("-");
    const nums = (core ?? "").split(".").map((part) => Number(part.replace(/\D/g, "")) || 0);
    return { nums, pre: pre ?? null };
  };
  const a = parse(targetVersion);
  const b = parse(currentVersion);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i += 1) {
    const left = a.nums[i] ?? 0;
    const right = b.nums[i] ?? 0;
    if (left > right) return;
    if (left < right) {
      throw new UpdateError(
        "downgrade_blocked",
        `Refusing to install ${targetVersion} over ${currentVersion}: downgrades are not supported`,
      );
    }
  }
  if (a.pre === null && b.pre !== null) return; // release over prerelease is fine
  if (a.pre !== null && b.pre === null) {
    throw new UpdateError(
      "downgrade_blocked",
      `Refusing to replace release ${currentVersion} with prerelease ${targetVersion}`,
    );
  }
  if (a.pre !== null && b.pre !== null && a.pre === b.pre) {
    throw new UpdateError("same_version", `${targetVersion} is already installed`);
  }
}

/** Refuses an asset built for another OS/arch. */
export function assertArchMatches(assetName, platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  if (!assetName.includes(`-${os}-`)) {
    throw new UpdateError("wrong_platform", `Asset ${assetName} is not built for ${os}`);
  }
  if (!assetName.includes(`-${arch}`)) {
    throw new UpdateError("wrong_arch", `Asset ${assetName} is not built for ${arch}`);
  }
  if (!assetName.endsWith(ALLOWED_SUFFIX[platform] ?? ".tar.gz")) {
    throw new UpdateError("wrong_format", `Asset ${assetName} does not match this platform's archive format`);
  }
}

/** Verifies size and digest of a staged file. Returns the computed digest. */
export function verifyStagedFile(filePath, expectedSha256, expectedSize) {
  if (!existsSync(filePath)) {
    throw new UpdateError("missing_package", `Staged package not found: ${filePath}`);
  }
  const bytes = readFileSync(filePath);
  if (typeof expectedSize === "number" && expectedSize > 0 && bytes.byteLength !== expectedSize) {
    throw new UpdateError(
      "size_mismatch",
      `Staged package is ${bytes.byteLength} bytes, expected ${expectedSize}`,
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expectedSha256 || actual !== expectedSha256.toLowerCase()) {
    throw new UpdateError(
      "checksum_mismatch",
      `Staged package hashes to ${actual}, release metadata says ${expectedSha256 ?? "(none)"}`,
    );
  }
  return actual;
}

/**
 * Backs up everything needed to come back: the database, the master key and the
 * program directory.
 *
 * `master.key` is included on purpose: a database backup without it cannot
 * decrypt stored provider credentials, so restoring only the .db would lose every
 * API key.
 */
export function backupCurrent({ dataDir, appDir, backupRoot, stamp = new Date().toISOString() }) {
  const target = join(backupRoot, stamp.replace(/[:.]/g, "-"));
  mkdirSync(target, { recursive: true });

  for (const name of ["search-hub.db", "search-hub.db-wal", "search-hub.db-shm", "master.key"]) {
    const source = join(dataDir, name);
    if (existsSync(source)) copyFileSync(source, join(target, name));
  }
  const manifest = {
    createdAt: stamp,
    dataDir,
    appDir,
    files: readdirSync(target),
    // Recorded so a rollback can tell whether the database moved forward.
    schemaVersion: readSchemaVersion(join(dataDir, "search-hub.db")),
  };
  writeFileSync(join(target, "backup.json"), JSON.stringify(manifest, null, 2), "utf8");

  if (appDir && existsSync(appDir)) {
    const programBackup = join(target, "app");
    cpSync(appDir, programBackup, { recursive: true });
  }
  return { path: target, manifest };
}

/** Reads `PRAGMA user_version` without depending on better-sqlite3 (best effort). */
export function readSchemaVersion(dbPath) {
  try {
    if (!existsSync(dbPath)) return null;
    const buffer = readFileSync(dbPath);
    // Header layout: 100 bytes, user_version is a 4-byte big-endian int at offset 60.
    if (buffer.byteLength < 100) return null;
    if (buffer.subarray(0, 15).toString("utf8") !== "SQLite format 3") return null;
    return buffer.readUInt32BE(60);
  } catch {
    return null;
  }
}

/**
 * Swaps the program directory.
 *
 * The old tree is renamed aside rather than deleted, so a failed health check can
 * put it back without re-downloading anything.
 */
export function installProgram({ stagingDir, appDir, stamp = Date.now() }) {
  const staged = resolve(stagingDir);
  if (!existsSync(staged)) {
    throw new UpdateError("missing_package", `Extracted package not found: ${staged}`);
  }
  const previous = `${appDir}.rollback-${stamp}`;
  if (existsSync(appDir)) renameSync(appDir, previous);
  try {
    cpSync(staged, appDir, { recursive: true });
  } catch (error) {
    // Put the old tree back before surfacing the error: leaving no program at all
    // is the one outcome that is never acceptable.
    if (existsSync(previous)) {
      rmSync(appDir, { recursive: true, force: true });
      renameSync(previous, appDir);
    }
    throw new UpdateError("install_failed", `Could not install the new program: ${String(error)}`);
  }
  return { previous };
}

/** Restores the program directory from a rollback copy. */
export function rollbackProgram({ appDir, previous }) {
  if (!previous || !existsSync(previous)) {
    throw new UpdateError("rollback_unavailable", "No previous program directory to restore");
  }
  rmSync(appDir, { recursive: true, force: true });
  renameSync(previous, appDir);
}

/**
 * Decides whether the database can be rolled back with the program.
 *
 * A forward migration that dropped or rewrote data is not reversible by running
 * the old binary against the new file. When the schema version moved forward, the
 * only consistent rollback is restoring the backup taken before the update —
 * which also loses anything written since. Both options are reported so the
 * operator can choose instead of being silently downgraded.
 */
export function planRollback({ schemaBefore, schemaAfter, hasDataBackup }) {
  if (schemaBefore === null || schemaAfter === null) {
    return {
      strategy: "program_only",
      safe: false,
      reason: "Schema version could not be determined; restoring the program alone may not match the database.",
    };
  }
  if (schemaAfter === schemaBefore) {
    return { strategy: "program_only", safe: true, reason: "No schema change; restoring the program is sufficient." };
  }
  if (!hasDataBackup) {
    return {
      strategy: "blocked",
      safe: false,
      reason: `Schema moved ${schemaBefore} → ${schemaAfter} and no pre-update backup exists; refusing an unsafe rollback.`,
    };
  }
  return {
    strategy: "restore_backup",
    safe: true,
    reason: `Schema moved ${schemaBefore} → ${schemaAfter}; restoring the pre-update backup keeps program and database consistent.`,
  };
}

/** Restores the data directory files from a backup manifest. */
export function restoreData({ backupPath, dataDir }) {
  const manifestPath = join(backupPath, "backup.json");
  if (!existsSync(manifestPath)) {
    throw new UpdateError("rollback_unavailable", `Backup manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const name of manifest.files ?? []) {
    if (name === "backup.json" || name === "app") continue;
    const source = join(backupPath, name);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(dataDir, basename(name)));
  }
  return manifest;
}

/** True when every entry of the extracted tree stays inside `root`. */
export function assertTreeContained(root) {
  const base = resolve(root);
  for (const entry of walk(base)) {
    const rel = relative(base, entry);
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new UpdateError("unsafe_archive", `Extracted entry escapes the install root: ${rel}`);
    }
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    out.push(path);
    if (entry.isDirectory()) out.push(...walk(path));
    else {
      const stats = statSync(path);
      if (stats.size === 0 && entry.isFile()) continue;
    }
  }
  return out;
}
