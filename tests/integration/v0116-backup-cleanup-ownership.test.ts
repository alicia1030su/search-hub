import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, listMigrations, openDatabaseFile, runMigrations } from "@search-hub/db";
import {
  createBackupPackage,
  restrictWindowsAcl,
  restoreBackupPackage,
  sealSnapshotDatabase,
  type SqliteHandle,
} from "@search-hub/backup";
import type { AppContext } from "../../apps/api/src/context.js";
import { BackupPackageService } from "../../apps/api/src/services/backup-package.js";
import { uploadOwnerNamespace } from "../../apps/api/src/services/backup.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const migrationsDir = join(process.cwd(), "packages", "db", "migrations");
const migrations = listMigrations(migrationsDir);

function openDatabase(path: string, readonly: boolean): SqliteHandle {
  return openDatabaseFile(path, { readonly }) as unknown as SqliteHandle;
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "v0116-backup-cleanup-"));
  directories.push(directory);
  return directory;
}

async function currentAppVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    version?: unknown;
  };
  expect(typeof pkg.version).toBe("string");
  return pkg.version as string;
}

function shortLivedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.pid).toBeTypeOf("number");
  return child.pid!;
}

async function pruneUploadsInSubprocess(root: string, namespace: string): Promise<{ directory: string; removed: number }> {
  const script = [
    'import { tmpdir } from "node:os";',
    'import { pruneStaleUploads } from "./apps/api/src/services/backup.ts";',
    `const removed = await pruneStaleUploads(${JSON.stringify(namespace)});`,
    "process.stdout.write(JSON.stringify({ directory: tmpdir(), removed }));",
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
    },
  );
  return JSON.parse(stdout) as { directory: string; removed: number };
}

async function createValidPackage(
  root: string,
  dataDir: string,
  filename: string,
  installDir = join(root, "install"),
): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  if (process.platform === "win32") {
    await restrictWindowsAcl(root, true);
    await restrictWindowsAcl(dataDir, true);
  }
  const source = join(dataDir, "source.db");
  const snapshot = join(root, "snapshot.db");
  const keyPath = join(dataDir, "master.key");
  const key = Buffer.alloc(32, 0x5a);
  const db = createDb({ file: source });
  try {
    runMigrations(db.sqlite, migrationsDir);
    await db.sqlite.backup(snapshot);
  } finally {
    db.close();
  }
  sealSnapshotDatabase(snapshot, openDatabase);
  await chmod(snapshot, 0o600);
  if (process.platform === "win32") await restrictWindowsAcl(snapshot, false);
  await writeFile(keyPath, `${key.toString("hex")}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  if (process.platform === "win32") await restrictWindowsAcl(keyPath, false);
  const created = await createBackupPackage({
    snapshotPath: snapshot,
    masterKeyPath: keyPath,
    outputPath: join(root, filename),
    passphrase: "backup cleanup ownership passphrase 灾备",
    appVersion: await currentAppVersion(),
    migrations,
    keySource: "file",
    dataDir,
    installDir,
  });
  expect(created.report.restoreReadiness).toBe(true);
  return created.path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("backup cleanup ownership", () => {
  it("BACKUP-CLEANUP-01 preserves a foreign stale upload-prefix sentinel", async () => {
    const root = await workspace();
    const foreign = join(root, "search-hub-upload-foreign");
    await mkdir(foreign);
    const sentinel = join(foreign, "keep.txt");
    await writeFile(sentinel, "foreign-owner-data");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(foreign, old, old);

    // Run cleanup in a child process so no other test observes the TEMP override.
    const outcome = await pruneUploadsInSubprocess(root, uploadOwnerNamespace(root));

    expect(outcome.directory).toBe(root);
    expect(outcome.removed).toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("foreign-owner-data");
  });

  it("BACKUP-CLEANUP-03 preserves a valid marker owned by a foreign namespace", async () => {
    const root = await workspace();
    const foreign = join(root, "search-hub-upload-foreign-namespace");
    await mkdir(foreign);
    const sentinel = join(foreign, "keep.txt");
    await writeFile(sentinel, "foreign-namespace-data");
    await writeFile(join(foreign, ".search-hub-owner.json"), JSON.stringify({
      schema: 1,
      namespace: "f".repeat(64),
      kind: "upload",
      pid: shortLivedPid(),
      processStartedAt: null,
      createdAt: new Date().toISOString(),
    }));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(foreign, old, old);

    const outcome = await pruneUploadsInSubprocess(root, uploadOwnerNamespace(root));

    expect(outcome.removed).toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("foreign-namespace-data");
  });

  it("BACKUP-CLEANUP-04 preserves a malformed owner marker", async () => {
    const root = await workspace();
    const malformed = join(root, "search-hub-upload-malformed");
    await mkdir(malformed);
    const sentinel = join(malformed, "keep.txt");
    await writeFile(sentinel, "malformed-marker-data");
    await writeFile(join(malformed, ".search-hub-owner.json"), "{not-json");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(malformed, old, old);

    const outcome = await pruneUploadsInSubprocess(root, uploadOwnerNamespace(root));

    expect(outcome.removed).toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("malformed-marker-data");
  });

  it.skipIf(process.platform === "linux")(
    "BACKUP-CLEANUP-05 preserves a live PID when start time is unavailable",
    async () => {
      const root = await workspace();
      const live = join(root, "search-hub-upload-live");
      await mkdir(live);
      const sentinel = join(live, "keep.txt");
      await writeFile(sentinel, "live-owner-data");
      await writeFile(join(live, ".search-hub-owner.json"), JSON.stringify({
        schema: 1,
        namespace: uploadOwnerNamespace(root),
        kind: "upload",
        pid: process.pid,
        processStartedAt: "0",
        createdAt: new Date().toISOString(),
      }));
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(live, old, old);

      const outcome = await pruneUploadsInSubprocess(root, uploadOwnerNamespace(root));

      expect(outcome.removed).toBe(0);
      expect(await readFile(sentinel, "utf8")).toBe("live-owner-data");
    },
  );

  it("BACKUP-CLEANUP-02 follows the current crash-orphan contract for a sidecar-less package", async () => {
    const root = await workspace();
    const packagePath = await createValidPackage(root, join(root, "data"), "valid.shbackup");
    const backups = join(root, "backups");
    await mkdir(backups);
    const published = join(backups, "legitimate-without-sidecar.shbackup");
    await writeFile(published, await readFile(packagePath));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(published, old, old);
    const service = new BackupPackageService({ config: { dataDir: root } } as unknown as AppContext);

    // Existing contract: publication without its sidecar is treated as a
    // crash-orphan. This is an EXPECTED_BEHAVIOR candidate, not a confirmed
    // data-loss defect; whether legacy sidecar-less packages need a retention
    // exception is a product decision.
    expect(await service.pruneStale()).toBe(1);
    await expect(stat(published)).rejects.toMatchObject({ code: "ENOENT" });
  });

  async function createRestoreFixture() {
    const root = await workspace();
    const sourceDataDir = join(root, "source-data");
    const sourceInstallDir = join(root, "install");
    const targetDir = join(root, "restored");
    const packagePath = await createValidPackage(root, sourceDataDir, "valid.shbackup", sourceInstallDir);
    await mkdir(targetDir);
    return { root, sourceDataDir, sourceInstallDir, targetDir, packagePath };
  }

  async function restoreDryRun(fixture: Awaited<ReturnType<typeof createRestoreFixture>>) {
    const openDatabase = (path: string, readonly: boolean) =>
      openDatabaseFile(path, { readonly }) as unknown as SqliteHandle;
    return restoreBackupPackage({
      path: fixture.packagePath,
      targetDir: fixture.targetDir,
      sourceDataDir: fixture.sourceDataDir,
      sourceInstallDir: fixture.sourceInstallDir,
      passphrase: "backup cleanup ownership passphrase 灾备",
      appVersion: await currentAppVersion(),
      knownMigrations: migrations,
      openDatabase,
    });
  }

  it.skipIf(process.platform !== "linux")("BACKUP-LOCK-01 allows dry-run when PID is reused with a different process start time", async () => {
    const fixture = await createRestoreFixture();
    await writeFile(join(fixture.sourceDataDir, "launcher.lock"), JSON.stringify({
      pid: process.pid,
      role: "server",
      processStartedAt: "0",
    }));

    const result = await restoreDryRun(fixture);

    expect(result.applied).toBe(false);
    expect(result.report.restoreReadiness).toBe(true);
    expect(await readdir(fixture.targetDir)).toEqual([]);
  });

  it.skipIf(process.platform === "linux")(
    "BACKUP-LOCK-01 keeps legacy PID-only locks active on non-Linux platforms",
    async () => {
      const fixture = await createRestoreFixture();
      await writeFile(join(fixture.sourceDataDir, "launcher.lock"), JSON.stringify({ pid: process.pid }));
      await expect(restoreDryRun(fixture)).rejects.toThrow(/active Search Hub lock/i);
      expect(await readdir(fixture.targetDir)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "linux")(
    "BACKUP-LOCK-01 keeps a live PID active when start time cannot be read",
    async () => {
      const fixture = await createRestoreFixture();
      await writeFile(join(fixture.sourceDataDir, "launcher.lock"), JSON.stringify({
        pid: process.pid,
        processStartedAt: "0",
      }));
      await expect(restoreDryRun(fixture)).rejects.toThrow(/active Search Hub lock/i);
      expect(await readdir(fixture.targetDir)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "BACKUP-LOCK-01 still rejects a live process with a matching start time",
    async () => {
      const fixture = await createRestoreFixture();
      const procStat = await readFile(`/proc/${process.pid}/stat`, "utf8");
      const processStartedAt = procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19];
      expect(processStartedAt).toBeTruthy();
      await writeFile(join(fixture.sourceDataDir, "launcher.lock"), JSON.stringify({
        pid: process.pid,
        role: "server",
        processStartedAt,
      }));

      await expect(restoreDryRun(fixture)).rejects.toThrow(/active Search Hub lock/i);
      expect(await readdir(fixture.targetDir)).toEqual([]);
    },
  );
});
