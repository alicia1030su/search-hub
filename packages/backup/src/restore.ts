import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { sha256 } from "./hash.js";
import { withBackupLock } from "./lock.js";
import { assertDisjointRestoreTarget, originGuardMatches } from "./origin.js";
import { resolveVerificationLimits, verifyBackupPackage } from "./package.js";
import {
  assertNoReparseAncestors, assertSecureRegularFile, createPrivateDirectory, fsyncDirectory,
  requireDiskBytes, restrictWindowsAcl,
} from "./private-fs.js";
import {
  BASE_REQUIRED_COLUMNS, inspectSnapshotDatabase, openBuiltInSqlite, schemaMigrationsCompatible,
  type SqliteHandleFactory,
} from "./sqlite.js";
import type { RestoreBackupPackageOptions, RestoreBackupPackageResult, VerificationLease } from "./types.js";

const EXTRA_DISK_BYTES = 32 * 1024 * 1024;

async function assertEmptyTarget(target: string): Promise<void> {
  await assertNoReparseAncestors(target);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Restore target must be a real directory");
    if ((await readdir(target)).length !== 0) throw new Error("Restore target is not empty; refusing to overwrite existing data");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertNoActiveLock(target: string): Promise<void> {
  try {
    const raw = await readFile(join(target, "launcher.lock"), "utf8");
    const lock = JSON.parse(raw) as { pid?: unknown };
    if (typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error("Restore source or target has an invalid active lock");
    try { process.kill(lock.pid, 0); throw new Error("Restore source or target has an active Search Hub lock"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof SyntaxError) throw new Error("Restore source or target has an invalid active lock");
    throw error;
  }
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = dirname(path);
  for (;;) {
    try { await lstat(current); return current; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function migratePending(lease: VerificationLease, ready: string, openDatabase: SqliteHandleFactory): Promise<void> {
  const databasePath = join(ready, "search-hub.db");
  const contract = lease.manifest.schemaContract;
  const before = inspectSnapshotDatabase(databasePath, openDatabase, lease.masterKey, BASE_REQUIRED_COLUMNS);
  if (!before.headerOk || !before.integrityOk || !before.foreignKeysOk || !before.requiredSchemaOk ||
      before.journalMode !== "delete" || !schemaMigrationsCompatible(before.migrations, contract.migrations.map((entry) => entry.name), before.userVersion)) {
    throw new Error("Backup migration prefix is invalid");
  }
  if (before.migrations.length < contract.migrations.length) {
    await requireDiskBytes(ready, lease.manifest.database.bytes * 2 + EXTRA_DISK_BYTES);
    const db = openDatabase(databasePath, false);
    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
      for (const migration of contract.migrations.slice(before.migrations.length)) {
        if (sha256(migration.sql) !== migration.sha256) throw new Error(`Embedded migration checksum mismatch: ${migration.name}`);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(migration.sql.replace(/--> statement-breakpoint/g, ""));
          db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(migration.name, new Date().toISOString());
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
      db.exec(`PRAGMA user_version = ${contract.migrations.length}`);
    } finally { db.close(); }
  }
  const after = inspectSnapshotDatabase(databasePath, openDatabase, lease.masterKey, contract.requiredTables);
  if (!after.headerOk || !after.integrityOk || !after.foreignKeysOk || !after.requiredSchemaOk ||
      after.journalMode !== "delete" || !after.userVersionOk || after.migrations.length !== contract.migrations.length ||
      after.ciphertextSampleDecryptable === false) {
    throw new Error("Restored database failed post-migration verification");
  }
}

async function assertRestoreLocation(target: string, sourceDataDir: string, sourceInstallDir: string): Promise<void> {
  assertDisjointRestoreTarget(target, [sourceDataDir, sourceInstallDir]);
  await assertEmptyTarget(target);
  await assertNoActiveLock(target);
  await assertNoActiveLock(sourceDataDir);
}

/** Restores to a new/empty target only; default mode is strictly dry-run. */
export async function restoreBackupPackage(options: RestoreBackupPackageOptions): Promise<RestoreBackupPackageResult> {
  const target = resolve(options.targetDir);
  const sourceDataDirValue = options.sourceDataDir ?? process.env["SEARCH_HUB_DATA_DIR"];
  const sourceInstallDirValue = options.sourceInstallDir ?? process.env["SEARCH_HUB_INSTALL_DIR"];
  if (!sourceDataDirValue || !sourceInstallDirValue) {
    throw new Error("Original sourceDataDir and sourceInstallDir are required via options or SEARCH_HUB_DATA_DIR/SEARCH_HUB_INSTALL_DIR");
  }
  const sourceDataDir = resolve(sourceDataDirValue);
  const sourceInstallDir = resolve(sourceInstallDirValue);
  const apply = options.apply === true;
  const limits = resolveVerificationLimits(options);
  await assertRestoreLocation(target, sourceDataDir, sourceInstallDir);
  const parent = dirname(target);
  const stagingParent = await nearestExistingParent(target);
  const lockPath = apply ? `${target}.restore.lock` : join(stagingParent, `.${basename(target)}.restore.lock`);
  return withBackupLock(lockPath, async () => {
    await assertRestoreLocation(target, sourceDataDir, sourceInstallDir);
    const packageInfo = await assertSecureRegularFile(options.path, limits.maxArchiveBytes);
    await requireDiskBytes(stagingParent, packageInfo.size + EXTRA_DISK_BYTES);
    if (!apply) {
      const work = await createPrivateDirectory(stagingParent, ".shbackup-restore-dry-");
      try {
        const probe = await verifyBackupPackage({ ...options, stage: true, privateWorkDir: work });
        try {
          if (!probe.report.restoreReadiness) throw new Error("Package is not ready to restore");
          if (!originGuardMatches(probe.manifest.originGuard, sourceDataDir, sourceInstallDir)) throw new Error("Backup origin guard does not match this data/install location");
          const ready = await createPrivateDirectory(work, "ready-");
          await rename(probe.databasePath, join(ready, "search-hub.db"));
          await rename(probe.keyPath, join(ready, "master.key"));
          await migratePending(probe, ready, options.openDatabase ?? openBuiltInSqlite);
          return { report: probe.report, applied: false };
        } finally { await probe.dispose(); }
      } finally { await rm(work, { recursive: true, force: true }).catch(() => undefined); }
    }
    await assertNoReparseAncestors(parent);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await assertNoReparseAncestors(parent);
    const work = await createPrivateDirectory(parent, ".shbackup-restore-work-");
    let ready = "";
    let emptyBackup = "";
    let published = false;
    try {
      await requireDiskBytes(parent, packageInfo.size + EXTRA_DISK_BYTES);
      const lease = await verifyBackupPackage({ ...options, stage: true, privateWorkDir: work });
      try {
        if (!lease.report.restoreReadiness) throw new Error("Package is not ready to restore");
        if (!originGuardMatches(lease.manifest.originGuard, sourceDataDir, sourceInstallDir)) throw new Error("Backup origin guard does not match this data/install location");
        await requireDiskBytes(parent, lease.manifest.database.bytes * 2 + EXTRA_DISK_BYTES);
        ready = await createPrivateDirectory(parent, ".shbackup-restore-ready-");
        await rename(lease.databasePath, join(ready, "search-hub.db"));
        await rename(lease.keyPath, join(ready, "master.key"));
        await migratePending(lease, ready, options.openDatabase ?? openBuiltInSqlite);
        if (process.platform === "win32") await restrictWindowsAcl(ready, true);
        await assertRestoreLocation(target, sourceDataDir, sourceInstallDir);
        if (await pathExists(target)) {
          emptyBackup = join(parent, `.${randomBytes(12).toString("hex")}.empty`);
          await rename(target, emptyBackup);
        }
        try { await rename(ready, target); published = true; }
        catch (error) {
          if (emptyBackup) await rename(emptyBackup, target).catch(() => undefined);
          throw error;
        }
        ready = "";
        try {
          if (process.platform === "win32") await restrictWindowsAcl(target, true);
          else {
            const targetInfo = await lstat(target);
            if (!targetInfo.isDirectory() || (targetInfo.mode & 0o777) !== 0o700) throw new Error("Restore target permission read-back failed");
          }
          await fsyncDirectory(target);
          await fsyncDirectory(parent);
        } catch (error) {
          await rm(target, { recursive: true, force: true }).catch(() => undefined);
          if (emptyBackup) await rename(emptyBackup, target).catch(() => undefined);
          published = false;
          throw error;
        }
        if (emptyBackup) { await rm(emptyBackup, { recursive: true, force: true }); emptyBackup = ""; }
        return { report: lease.report, applied: true, targetDir: target };
      } finally { await lease.dispose(); }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
      if (ready) await rm(ready, { recursive: true, force: true }).catch(() => undefined);
      if (emptyBackup && !published) await rename(emptyBackup, target).catch(() => undefined);
    }
  });
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
