#!/usr/bin/env node
/** Fail-closed update primitives shared by the updater and its acceptance tests. */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

const ALLOWED_SUFFIX = { win32: ".zip", linux: ".tar.gz" };

function normalizedRealPath(path) {
  const actual = realpathSync(path);
  return process.platform === "win32" ? actual.toLowerCase() : actual;
}

export function assertNoReparsePath(path, label = "path") {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) throw new UpdateError("unsafe_path", `${label} must not be a symlink or junction: ${absolute}`);
  if (existsSync(absolute) && normalizedRealPath(absolute) !== (process.platform === "win32" ? absolute.toLowerCase() : absolute)) {
    throw new UpdateError("unsafe_path", `${label} resolves through a reparse point: ${absolute}`);
  }
  return info;
}

export function assertSafeEntry(entry) {
  if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
    throw new UpdateError("unsafe_archive", "Archive contains an empty or invalid entry name");
  }
  if (entry.includes("\\")) throw new UpdateError("unsafe_archive", `Archive entry uses a backslash: ${entry}`);
  if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry) || entry.startsWith("//")) {
    throw new UpdateError("unsafe_archive", `Archive entry is absolute or drive-qualified: ${entry}`);
  }
  if (Array.from(entry).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f || ':*?"<>|'.includes(character);
  })) {
    throw new UpdateError("unsafe_archive", `Archive entry contains a forbidden path construct: ${entry}`);
  }
  let normalized = entry;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new UpdateError("unsafe_archive", `Archive entry escapes or ambiguously addresses the install root: ${entry}`);
  }
  return normalized;
}

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  if (!match) throw new UpdateError("invalid_version", `Invalid semantic version: ${value}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function comparePrerelease(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] === b[index]) continue;
    const an = /^\d+$/.test(a[index]);
    const bn = /^\d+$/.test(b[index]);
    if (an && bn) return Number(a[index]) - Number(b[index]);
    if (an !== bn) return an ? -1 : 1;
    return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  return comparePrerelease(a.pre, b.pre);
}

export function systemdStateProvesStopped(properties) {
  const mainPid = Number(properties?.MainPID ?? 0);
  const inactiveDead = properties?.ActiveState === "inactive" && properties?.SubState === "dead";
  const failedWithoutProcess = properties?.ActiveState === "failed" && mainPid === 0;
  return mainPid === 0 && (inactiveDead || failedWithoutProcess);
}

export function assertUpgrade(currentVersion, targetVersion) {
  const target = parseSemver(targetVersion);
  const current = parseSemver(currentVersion);
  const comparison = compareVersions(targetVersion, currentVersion);
  if (comparison < 0 || (comparison === 0 && target.pre !== null && current.pre === null)) {
    throw new UpdateError("downgrade_blocked", `Refusing to replace ${currentVersion} with ${targetVersion}: downgrades and prereleases over a stable release are not supported`);
  }
  if (comparison === 0) throw new UpdateError("same_version", `${targetVersion} is already installed`);
}

export function assertArchMatches(assetName, platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform === "linux" ? "linux" : null;
  if (!os) throw new UpdateError("wrong_platform", `Unsupported update platform: ${platform}`);
  const suffix = ALLOWED_SUFFIX[platform];
  const expected = new RegExp(`^search-hub-v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?-${os}-${arch}${suffix.replace(".", "\\.")}$`);
  if (!expected.test(assetName)) {
    throw new UpdateError("wrong_platform", `Asset ${assetName} is not the exact ${os}/${arch} package for this installation`);
  }
}

export function verifyStagedFile(filePath, expectedSha256, expectedSize) {
  if (!existsSync(filePath)) throw new UpdateError("missing_package", `Staged package not found: ${filePath}`);
  assertNoReparsePath(filePath, "staged package");
  const info = statSync(filePath);
  if (!info.isFile()) throw new UpdateError("missing_package", `Staged package is not a regular file: ${filePath}`);
  if (typeof expectedSize === "number" && expectedSize > 0 && info.size !== expectedSize) {
    throw new UpdateError("size_mismatch", `Staged package is ${info.size} bytes, expected ${expectedSize}`);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256 ?? "")) {
    throw new UpdateError("checksum_mismatch", "A valid SHA-256 digest is required");
  }
  const hash = createHash("sha256");
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const bytes = readSync(fd, buffer);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha256.toLowerCase()) {
    throw new UpdateError("checksum_mismatch", `Staged package hashes to ${actual}, release metadata says ${expectedSha256}`);
  }
  return actual;
}

function syncDirectory(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every Windows filesystem. File fsync
    // and atomic rename still provide the documented best available guarantee.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

export function snapshotSqliteDatabase(sourcePath, destinationPath) {
  assertNoReparsePath(sourcePath, "source database");
  if (!statSync(sourcePath).isFile()) throw new UpdateError("invalid_database", "Source database is not a regular file");
  if (existsSync(destinationPath)) throw new UpdateError("invalid_database", "Snapshot destination already exists");
  let source;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    source.prepare("VACUUM INTO ?").run(destinationPath);
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw new UpdateError("snapshot_failed", `Could not create a consistent SQLite snapshot: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    source?.close();
  }
  let destination;
  try {
    destination = new DatabaseSync(destinationPath, { readOnly: true });
    const rows = destination.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(rows.map((row) => String(row.integrity_check ?? "")).join("; ") || "no result");
    }
    return { method: "vacuum_into", userVersion: Number(destination.prepare("PRAGMA user_version").get()?.user_version ?? 0) };
  } catch (error) {
    rmSync(destinationPath, { force: true });
    throw new UpdateError("snapshot_failed", `Snapshot verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    destination?.close();
  }
}

function assertTreeSafe(root) {
  const base = resolve(root);
  const pending = [base];
  while (pending.length > 0) {
    const current = pending.pop();
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new UpdateError("unsafe_path", `Unsafe tree entry: ${current}`);
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(current)) pending.push(join(current, name));
    }
  }
}

/** Creates a consistent, complete pre-update data backup outside dataDir. */
export function backupCurrent({ dataDir, appDir, dbPath = join(dataDir, "search-hub.db"), backupRoot, stamp = new Date().toISOString() }) {
  assertNoReparsePath(dataDir, "data directory");
  if (!lstatSync(dataDir).isDirectory()) throw new UpdateError("invalid_database", "Data directory is not a directory");
  assertTreeSafe(dataDir);
  assertNoReparsePath(dbPath, "database");
  const target = join(backupRoot, stamp.replace(/[:.]/g, "-"));
  if (existsSync(target)) throw new UpdateError("backup_failed", `Backup target already exists: ${target}`);
  const dataBackup = join(target, "data");
  mkdirSync(dataBackup, { recursive: true, mode: 0o700 });
  const dbRelative = relative(dataDir, dbPath);
  const dbInside = dbRelative !== "" && !dbRelative.startsWith(`..${sep}`) && dbRelative !== ".." && !isAbsolute(dbRelative);
  try {
    for (const name of readdirSync(dataDir)) {
      const source = join(dataDir, name);
      if (name === "launcher.lock") continue;
      if (dbInside && (source === dbPath || source === `${dbPath}-wal` || source === `${dbPath}-shm` || source === `${dbPath}-journal`)) continue;
      const info = lstatSync(source);
      if (info.isSymbolicLink()) throw new UpdateError("unsafe_path", `Data directory contains a symlink: ${source}`);
      cpSync(source, join(dataBackup, name), {
        recursive: true,
        dereference: false,
        filter: (candidate) => !dbInside || ![dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].includes(resolve(candidate)),
      });
    }
    const snapshotPath = dbInside ? join(dataBackup, dbRelative) : join(target, "external-db.sqlite");
    mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    const snapshot = snapshotSqliteDatabase(dbPath, snapshotPath);
    const manifest = {
      format: "search-hub-pre-update-v2",
      createdAt: stamp,
      dataDir: resolve(dataDir),
      dbPath: resolve(dbPath),
      dbInsideDataDir: dbInside,
      snapshot: { method: snapshot.method, userVersion: snapshot.userVersion, sha256: hashFile(snapshotPath) },
      files: readdirSync(dataBackup),
    };
    writeJsonAtomic(join(target, "backup.json"), manifest);
    if (appDir && existsSync(appDir)) {
      assertNoReparsePath(appDir, "program directory");
      cpSync(appDir, join(target, "app"), { recursive: true, dereference: false });
    }
    return { path: target, dataPath: dataBackup, manifest };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error instanceof UpdateError ? error : new UpdateError("backup_failed", `Pre-update backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hashFile(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const bytes = readSync(fd, buffer);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function installProgram({ stagingDir, appDir, stamp = Date.now() }) {
  if (!existsSync(stagingDir)) throw new UpdateError("missing_package", `Extracted package not found: ${stagingDir}`);
  assertTreeSafe(stagingDir);
  const staged = join(dirname(appDir), `.${basename(appDir)}.stage-${stamp}-${process.pid}`);
  const previous = `${appDir}.rollback-${stamp}-${process.pid}`;
  if (existsSync(staged) || existsSync(previous)) throw new UpdateError("install_failed", "Install staging or rollback path already exists");
  cpSync(stagingDir, staged, { recursive: true, dereference: false });
  try {
    if (existsSync(appDir)) renameSync(appDir, previous);
    renameSync(staged, appDir);
    return { previous: existsSync(previous) ? previous : null };
  } catch (error) {
    if (existsSync(staged)) rmSync(staged, { recursive: true, force: true });
    if (!existsSync(appDir) && existsSync(previous)) renameSync(previous, appDir);
    throw new UpdateError("install_failed", `Could not atomically install the new program: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function rollbackProgram({ appDir, previous }) {
  if (!previous || !existsSync(previous)) throw new UpdateError("rollback_unavailable", "No previous program directory to restore");
  const failed = `${appDir}.failed-${Date.now()}-${process.pid}`;
  if (existsSync(appDir)) renameSync(appDir, failed);
  try {
    renameSync(previous, appDir);
  } catch (error) {
    if (!existsSync(appDir) && existsSync(failed)) renameSync(failed, appDir);
    throw new UpdateError("rollback_blocked", `Could not restore the previous program: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { restored: true, failed };
}

export function planRollback({ schemaBefore, schemaAfter, hasDataBackup }) {
  if (schemaBefore === null || schemaAfter === null) {
    return { strategy: hasDataBackup ? "restore_backup" : "blocked", safe: Boolean(hasDataBackup), reason: hasDataBackup ? "Schema could not be read; restoring the consistent pre-update data backup." : "Schema could not be read and no pre-update backup exists." };
  }
  if (schemaAfter === schemaBefore) return { strategy: "program_only", safe: true, reason: "No schema change; the failed data tree is still preserved and may be exchanged if needed." };
  if (!hasDataBackup) return { strategy: "blocked", safe: false, reason: `Schema moved ${schemaBefore} → ${schemaAfter} and no pre-update backup exists; refusing an unsafe rollback.` };
  return { strategy: "restore_backup", safe: true, reason: `Schema moved ${schemaBefore} → ${schemaAfter}; exchanging the complete pre-update data directory keeps program and database consistent.` };
}

/** Atomically exchanges the entire data directory; failed data is retained. */
export function restoreData({ backupPath, dataDir, dbPath = join(dataDir, "search-hub.db") }) {
  const manifestPath = join(backupPath, "backup.json");
  if (!existsSync(manifestPath)) throw new UpdateError("rollback_unavailable", `Backup manifest missing at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (resolve(manifest.dataDir) !== resolve(dataDir) || resolve(manifest.dbPath) !== resolve(dbPath)) {
    throw new UpdateError("rollback_unavailable", "Backup paths do not match the active service configuration");
  }
  const source = join(backupPath, "data");
  let failed = null;
  if (existsSync(source)) {
    failed = `${dataDir}.failed-${Date.now()}-${process.pid}`;
    if (existsSync(dataDir)) renameSync(dataDir, failed);
    try {
      renameSync(source, dataDir);
    } catch (error) {
      if (!existsSync(dataDir) && existsSync(failed)) renameSync(failed, dataDir);
      throw new UpdateError("rollback_blocked", `Could not restore the pre-update data directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!existsSync(dataDir)) {
    throw new UpdateError("rollback_unavailable", "Pre-update data snapshot is missing and no restored data directory exists");
  }
  if (!manifest.dbInsideDataDir) {
    const externalSource = join(backupPath, "external-db.sqlite");
    if (!existsSync(externalSource)) throw new UpdateError("rollback_unavailable", "Pre-update external database snapshot is missing");
    const temporary = `${dbPath}.restore-${Date.now()}-${process.pid}`;
    const externalFailed = `${dbPath}.failed-${Date.now()}-${process.pid}`;
    try {
      copyFileSync(externalSource, temporary);
      if (existsSync(dbPath)) renameSync(dbPath, externalFailed);
      renameSync(temporary, dbPath);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (!existsSync(dbPath) && existsSync(externalFailed)) renameSync(externalFailed, dbPath);
      throw new UpdateError("rollback_blocked", `Could not restore the external database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { manifest, failed };
}

export function recoverInterruptedUpdate(journalPath) {
  if (!existsSync(journalPath)) return null;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  if (["complete", "refused", "recovered"].includes(journal.phase)) return journal;
  if (journal.previousApp && existsSync(journal.previousApp)) {
    if (existsSync(journal.appDir)) renameSync(journal.appDir, `${journal.appDir}.crashed-${Date.now()}-${process.pid}`);
    renameSync(journal.previousApp, journal.appDir);
  }
  if (journal.backupPath) {
    restoreData({ backupPath: journal.backupPath, dataDir: journal.dataDir, dbPath: journal.dbPath });
  }
  journal.phase = "recovered";
  journal.recoveredAt = new Date().toISOString();
  writeJsonAtomic(journalPath, journal);
  return journal;
}

export function assertTreeContained(root) {
  assertTreeSafe(root);
  const base = resolve(root);
  for (const entry of walk(base)) {
    const rel = relative(base, entry);
    if (rel.startsWith("..") || rel.includes(`..${sep}`) || isAbsolute(rel)) {
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
  }
  return out;
}

export function readSchemaVersion(dbPath) {
  try {
    assertNoReparsePath(dbPath, "database");
    const fd = openSync(dbPath, "r");
    try {
      const buffer = Buffer.alloc(100);
      const bytes = readSync(fd, buffer, 0, 100, 0);
      if (bytes < 100 || buffer.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") return null;
      return buffer.readUInt32BE(60);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
