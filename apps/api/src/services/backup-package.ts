import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createBackupPackage,
  createPrivateDirectory,
  fsyncDirectory,
  openPrivateFile,
  publishNoOverwrite,
  restrictWindowsAcl,
  validateBackupPassphrase,
  type BackupVerificationReport,
  type SnapshotAdapter,
  type SqliteHandle,
} from "@search-hub/backup";
import { listMigrations, openDatabaseFile } from "@search-hub/db";
import type { AppContext } from "../context.js";
import { REPO_ROOT } from "../config.js";

const PACKAGE_EXTENSION = ".shbackup";
const WORK_PREFIX = ".shbackup-work-";

interface BackupSidecar {
  time: string;
  bytes: number;
  sha256: string;
  file: string;
  verified: boolean;
  restoreReadiness: boolean;
  keyFingerprint: string;
  report: BackupVerificationReport;
}

interface LatestSidecar {
  sidecar: BackupSidecar;
  packageIntact: boolean;
}

export interface BackupStatus {
  dbBytes: number;
  schema: string | null;
  keySource: "env" | "file";
  walBytes: number;
  latestBackup: {
    time: string;
    bytes: number;
    file: string;
    sha256: string;
    keyFingerprint: string;
    verified: boolean;
    report: BackupVerificationReport;
  } | null;
  backupDirWritable: boolean;
  restoreReadiness: boolean;
  keyReadiness: "verified" | "unverified" | "missing" | "mismatch";
}

function openSqlite(path: string, readonly: boolean): SqliteHandle {
  return openDatabaseFile(path, { readonly }) as unknown as SqliteHandle;
}

/** better-sqlite3 Online Backup with VACUUM INTO fallback; never copies live files. */
function snapshotAdapter(ctx: AppContext): SnapshotAdapter {
  return {
    openDatabase: openSqlite,
    createSnapshot: async (destinationPath: string) => {
      let method: "sqlite_backup_api" | "vacuum_into" = "sqlite_backup_api";
      if (typeof ctx.sqlite.backup === "function") {
        const result = await ctx.sqlite.backup(destinationPath);
        if (result.remainingPages > 0) throw new Error("SQLite online backup stopped before completion");
      } else {
        ctx.sqlite.prepare("VACUUM INTO ?").run(destinationPath);
        method = "vacuum_into";
      }
      if (process.platform === "win32") await restrictWindowsAcl(destinationPath, false);
      else await chmod(destinationPath, 0o600);
      return { method, walCheckpointed: true };
    },
  };
}

function reportRestoreReady(report: BackupVerificationReport): boolean {
  return report.restoreReadiness === true;
}

function isVerificationReport(value: unknown): value is BackupVerificationReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return report["format"] === "shbackup-v1" &&
    ["formatOk", "structuralOk", "schemaCompatible", "keyFingerprintMatch", "ciphertextSampleDecryptable", "restoreReadiness"]
    .every((key) => typeof report[key] === "boolean") &&
    ["verified", "unverified", "missing", "mismatch"].includes(String(report["keyReadiness"])) &&
    typeof report["sampleCount"] === "number" &&
    (typeof report["keyProofValid"] === "boolean" || report["keyProofValid"] === null);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await restrictWindowsAcl(path, true);
  else await chmod(path, 0o700);
}

async function probeWritableDirectory(path: string): Promise<boolean> {
  const probe = join(path, `.write-probe-${randomBytes(12).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await openPrivateFile(probe);
    await handle.write(Buffer.from("search-hub-write-probe\n"));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

/** API-backed complete package creation with one-writer and temp-disk bounds. */
export class BackupPackageService {
  readonly directory: string;
  private busy = false;
  private reservedTempBytes = 0;
  private readonly maxTempBytes: number;

  constructor(private readonly ctx: AppContext) {
    this.directory = join(ctx.config.dataDir, "backups");
    const configured = Number(process.env["SEARCH_HUB_BACKUP_MAX_TEMP_BYTES"] ?? 512 * 1024 * 1024);
    this.maxTempBytes = Number.isSafeInteger(configured) && configured >= 64 * 1024 * 1024
      ? configured
      : 512 * 1024 * 1024;
  }

  async initialize(): Promise<void> {
    await secureDirectory(this.directory);
    await this.pruneStale();
  }

  /** Cleans only owned, stale work directories; never touches published backups with sidecars. */
  async pruneStale(maxAgeMs = 60 * 60 * 1000): Promise<number> {
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of names) {
      const path = join(this.directory, name);
      try {
        const info = await lstat(path);
        if (info.mtimeMs >= cutoff || info.isSymbolicLink()) continue;
        if ((name.startsWith(WORK_PREFIX) || name.startsWith(".shbak-work-")) && info.isDirectory()) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        } else if ((name.endsWith(PACKAGE_EXTENSION) || name.endsWith(".shbak")) && info.isFile() && !names.includes(`${name}.json`)) {
          // A crash between package publication and sidecar publication must
          // not leave an unverifiable orphan consuming backup disk forever.
          await rm(path, { force: true });
          removed += 1;
        }
      } catch {
        // A live request owns a fresh directory; stale cleanup is best effort.
      }
    }
    return removed;
  }

  async status(): Promise<BackupStatus> {
    await secureDirectory(this.directory);
    const dbInfo = await stat(this.ctx.config.dbPath).catch(() => ({ size: 0 }));
    const walInfo = await stat(`${this.ctx.config.dbPath}-wal`).catch(() => ({ size: 0 }));
    let migrationRow: { name?: string } | undefined;
    try {
      migrationRow = this.ctx.sqlite.prepare("SELECT name FROM _migrations ORDER BY name DESC LIMIT 1").get() as { name?: string } | undefined;
    } catch {
      migrationRow = undefined;
    }
    const writable = await probeWritableDirectory(this.directory);
    const latest = await this.latestSidecar();
    const currentFingerprint = this.ctx.secrets.fingerprint();
    const keyMatches = Boolean(latest &&
      latest.sidecar.keyFingerprint === currentFingerprint &&
      latest.sidecar.report.keyFingerprintMatch === true &&
      latest.sidecar.report.keyReadiness === "verified" &&
      latest.sidecar.report.keyProofValid !== false);
    const restoreReadiness = Boolean(latest && latest.packageIntact && keyMatches &&
      latest.sidecar.report.schemaCompatible && latest.sidecar.verified && reportRestoreReady(latest.sidecar.report));
    const keyReadiness: BackupStatus["keyReadiness"] = !latest
      ? "missing"
      : !keyMatches
        ? "mismatch"
        : latest.sidecar.report.keyReadiness;
    return {
      dbBytes: dbInfo.size,
      schema: migrationRow?.name ?? null,
      keySource: this.ctx.secrets.source,
      walBytes: walInfo.size,
      latestBackup: latest ? {
        time: latest.sidecar.time,
        bytes: latest.sidecar.bytes,
        file: latest.sidecar.file,
        sha256: latest.sidecar.sha256,
        keyFingerprint: latest.sidecar.keyFingerprint,
        verified: restoreReadiness,
        report: latest.sidecar.report,
      } : null,
      backupDirWritable: writable,
      restoreReadiness,
      keyReadiness,
    };
  }

  async create(passphraseInput: string): Promise<{ path: string; name: string; bytes: number; sha256: string; report: BackupVerificationReport }> {
    const passphrase = validateBackupPassphrase(passphraseInput);
    if (this.busy) throw new Error("A backup package is already being generated");
    // Acquire before the first await: otherwise two concurrent requests can
    // both observe an idle generator and bypass the single-writer guarantee.
    this.busy = true;
    let reservation = 0;
    let work = "";
    let finalPath = "";
    let sidecarWritten = false;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const dbBytes = (await stat(this.ctx.config.dbPath)).size;
      reservation = Math.max(64 * 1024 * 1024, dbBytes * 3 + 32 * 1024 * 1024);
      if (this.reservedTempBytes + reservation > this.maxTempBytes) {
        throw new Error("Backup temporary-disk quota exceeded");
      }
      this.reservedTempBytes += reservation;
      await this.initialize();
      work = await createPrivateDirectory(this.directory, WORK_PREFIX);
      heartbeat = setInterval(() => {
        void utimes(work, new Date(), new Date()).catch(() => undefined);
      }, 30_000);
      heartbeat.unref();
      const migrations = listMigrations(this.ctx.config.migrationsDir);
      const expectedKey = this.ctx.secrets.recoveryKey();
      const temporaryPackage = join(work, `backup${PACKAGE_EXTENSION}`);
      let created: Awaited<ReturnType<typeof createBackupPackage>>;
      try {
        created = await createBackupPackage({
          snapshotAdapter: snapshotAdapter(this.ctx),
          masterKeyValue: expectedKey,
          outputPath: temporaryPackage,
          passphrase,
          appVersion: this.ctx.config.version,
          commit: this.ctx.config.commit ?? "unknown",
          migrations,
          keySource: this.ctx.secrets.source,
          creator: "api",
          dataDir: this.ctx.config.dataDir,
          installDir: REPO_ROOT,
          limits: {
            maxArchiveBytes: this.ctx.config.maxBackupUploadBytes,
            maxDatabaseBytes: this.ctx.config.maxBackupUploadBytes,
          },
        });
      } finally {
        expectedKey.fill(0);
      }
      const report = created.report;
      if (!reportRestoreReady(report)) {
        throw new Error(`Generated backup failed verification: ${report.reason ?? "restoreReadiness=false"}`);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `search-hub-${stamp}-${randomBytes(8).toString("hex")}${PACKAGE_EXTENSION}`;
      finalPath = join(this.directory, name);
      await publishNoOverwrite(temporaryPackage, finalPath);
      const sidecar: BackupSidecar = {
        time: new Date().toISOString(),
        bytes: created.bytes,
        sha256: created.sha256,
        file: name,
        verified: true,
        restoreReadiness: report.restoreReadiness,
        keyFingerprint: this.ctx.secrets.fingerprint(),
        report,
      };
      await this.writeSidecar(finalPath, sidecar);
      sidecarWritten = true;
      return { path: finalPath, name, bytes: created.bytes, sha256: created.sha256, report };
    } catch (error) {
      if (finalPath && !sidecarWritten) {
        await rm(finalPath, { force: true }).catch(() => undefined);
        await rm(`${finalPath}.json`, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
      this.reservedTempBytes -= reservation;
      this.busy = false;
    }
  }

  private async writeSidecar(path: string, sidecar: BackupSidecar): Promise<void> {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await openPrivateFile(temporary);
    try {
      await handle.writeFile(`${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, `${path}.json`);
      await fsyncDirectory(this.directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async latestSidecar(): Promise<LatestSidecar | null> {
    let names: string[] = [];
    try {
      names = await readdir(this.directory);
    } catch {
      return null;
    }
    const candidates = names.filter((name) => name.endsWith(`${PACKAGE_EXTENSION}.json`)).sort().reverse();
    for (const name of candidates) {
      try {
        const sidecarPath = join(this.directory, name);
        const sidecarInfo = await lstat(sidecarPath);
        if (sidecarInfo.isSymbolicLink() || !sidecarInfo.isFile() || sidecarInfo.size > 1024 * 1024) continue;
        const value = JSON.parse(await readFile(sidecarPath, "utf8")) as BackupSidecar;
        if (typeof value.time !== "string" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
          typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
          typeof value.verified !== "boolean" || typeof value.restoreReadiness !== "boolean" ||
          typeof value.keyFingerprint !== "string" || !isVerificationReport(value.report) ||
          typeof value.file !== "string" || basename(value.file) !== value.file ||
          !value.file.endsWith(PACKAGE_EXTENSION) || name !== `${value.file}.json`) continue;
        const packagePath = join(this.directory, value.file);
        const packageInfo = await lstat(packagePath).catch(() => null);
        const packageIntact = Boolean(packageInfo && !packageInfo.isSymbolicLink() && packageInfo.isFile() &&
          packageInfo.size === value.bytes && await hashFile(packagePath) === value.sha256);
        return { sidecar: value, packageIntact };
      } catch {
        // Ignore a partially written/corrupt sidecar and try the previous one.
      }
    }
    return null;
  }
}

export function backupDownloadName(path: string): string {
  return basename(path);
}
