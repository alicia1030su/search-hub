import { chmod, copyFile, cp, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, listMigrations, openDatabaseFile, runMigrations } from "@search-hub/db";
import {
  createBackupPackage, inspectSnapshotDatabase, restoreBackupPackage, restrictWindowsAcl,
  sealSnapshotDatabase, verifyDatabaseBackup,
  type SqliteHandle,
} from "@search-hub/backup";
import { SecretBox } from "../../apps/api/src/security/crypto.js";

const directories: string[] = [];
const passphrase = "snapshot recovery passphrase 恢复";
const migrationsDir = join(process.cwd(), "packages", "db", "migrations");
const migrations = listMigrations(migrationsDir);

function openDatabase(path: string, readonly: boolean): SqliteHandle {
  return openDatabaseFile(path, { readonly }) as unknown as SqliteHandle;
}
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "search-hub-snapshot-test-"));
  directories.push(directory);
  return directory;
}
async function secureFile(path: string): Promise<void> {
  await chmod(path, 0o600);
  if (process.platform === "win32") await restrictWindowsAcl(path, false);
}
async function fixture(migrationDirectory = migrationsDir, withSample = true): Promise<{ root: string; dataDir: string; source: string; snapshot: string; key: Buffer; keyPath: string; applied: string[] }> {
  const root = await workspace();
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const source = join(dataDir, "source.db");
  const snapshot = join(root, "snapshot.db");
  const keyPath = join(dataDir, "master.key");
  const key = Buffer.alloc(32, 0x5a);
  const handle = createDb({ file: source });
  try {
    runMigrations(handle.sqlite, migrationDirectory);
    if (withSample) {
      const encrypted = SecretBox.fromKey(key).encrypt("synthetic-provider-secret");
      const now = new Date().toISOString();
      handle.sqlite.prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("prv_test", "Synthetic", "mock", now, now);
      handle.sqlite.prepare(`INSERT INTO api_keys
        (id, provider_id, label, key_ciphertext, key_iv, key_tag, key_version, key_hint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("key_test", "prv_test", "test", encrypted.ciphertext, encrypted.iv, encrypted.tag, 1, "syn…cret", now, now);
      handle.sqlite.prepare(`INSERT INTO model_configs
        (id, kind, name, provider_type, base_url, api_key_ciphertext, api_key_iv, api_key_tag, model_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("mdl_test", "chat", "Synthetic model", "mock", "https://invalid.example", encrypted.ciphertext, encrypted.iv, encrypted.tag, "model", now, now);
    }
    await handle.sqlite.backup(snapshot);
  } finally { handle.close(); }
  sealSnapshotDatabase(snapshot, openDatabase);
  await secureFile(snapshot);
  await writeFile(keyPath, `${key.toString("hex")}\n`, { mode: 0o600 });
  await secureFile(keyPath);
  return { root, dataDir, source, snapshot, key, keyPath, applied: listMigrations(migrationDirectory) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SQLite snapshot sealing and verification", () => {
  it("verifies schema, fingerprint and real ciphertext samples with six booleans", async () => {
    const { root, dataDir, snapshot, key, keyPath } = await fixture();
    const output = join(root, "backup.shbackup");
    await createBackupPackage({ snapshotPath: snapshot, masterKeyPath: keyPath, outputPath: output, passphrase, appVersion: "0.1.15", migrations, keySource: "file", dataDir, installDir: process.cwd() });
    const report = await verifyDatabaseBackup({ path: output, passphrase, expectedMasterKey: key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(report).toMatchObject({
      formatOk: true, structuralOk: true, schemaCompatible: true, keyFingerprintMatch: true,
      ciphertextSampleDecryptable: true, restoreReadiness: true, keyReadiness: "verified",
      sampleCount: 2, keyProofValid: true, integrity: "ok", foreignKeys: "ok", requiredSchema: "ok",
    });
    const olderBuild = await verifyDatabaseBackup({ path: output, passphrase, expectedMasterKey: key, appVersion: "0.1.14", knownMigrations: migrations, openDatabase });
    expect(olderBuild.schemaCompatible).toBe(false);
    expect(olderBuild.restoreReadiness).toBe(false);
    const wrongKey = await verifyDatabaseBackup({ path: output, passphrase, expectedMasterKey: Buffer.alloc(32, 9), appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(wrongKey.keyFingerprintMatch).toBe(false);
    expect(wrongKey.keyProofValid).toBe(false);
    expect(wrongKey.keyReadiness).toBe("mismatch");
    expect(wrongKey.restoreReadiness).toBe(false);
    await expect(restoreBackupPackage({
      path: output, targetDir: join(root, "different-target"), sourceDataDir: join(root, "wrong-source"),
      sourceInstallDir: process.cwd(), passphrase, expectedMasterKey: key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase,
    })).rejects.toThrow(/origin guard/i);
  }, 180_000);

  it("verifies a real package larger than 64 MiB without whole-file buffering", async () => {
    const root = await workspace();
    const dataDir = join(root, "data"); await mkdir(dataDir);
    const source = join(dataDir, "large-source.db");
    const snapshot = join(root, "large.db");
    const keyPath = join(dataDir, "master.key");
    const output = join(root, "large.shbackup");
    const key = Buffer.alloc(32, 0x44);
    const handle = createDb({ file: source });
    try {
      runMigrations(handle.sqlite, migrationsDir);
      handle.sqlite.exec("CREATE TABLE large_payload (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
      handle.sqlite.prepare("INSERT INTO large_payload (body) VALUES (zeroblob(?))").run(65 * 1024 * 1024);
      await handle.sqlite.backup(snapshot);
    } finally { handle.close(); }
    sealSnapshotDatabase(snapshot, openDatabase); await secureFile(snapshot);
    await writeFile(keyPath, `${key.toString("hex")}\n`, { mode: 0o600 }); await secureFile(keyPath);
    await createBackupPackage({ snapshotPath: snapshot, masterKeyPath: keyPath, outputPath: output, passphrase, appVersion: "0.1.15", migrations, keySource: "file", dataDir, installDir: process.cwd() });
    const report = await verifyDatabaseBackup({ path: output, passphrase, expectedMasterKey: key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(report.dbBytes).toBeGreaterThan(64 * 1024 * 1024);
    expect(report.restoreReadiness).toBe(true);
  }, 180_000);

  it("reports legacy missing, unverified and wrong keys without claiming recoverability", async () => {
    const { snapshot, key } = await fixture();
    const legacy = await verifyDatabaseBackup({ path: snapshot, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(legacy.keyReadiness).toBe("missing");
    expect(legacy.restoreReadiness).toBe(false);
    const wrong = await verifyDatabaseBackup({ path: snapshot, expectedMasterKey: Buffer.alloc(32, 1), appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(wrong.keyReadiness).toBe("mismatch");
    expect(wrong.ciphertextSampleDecryptable).toBe(false);
    const unverified = await verifyDatabaseBackup({ path: snapshot, expectedMasterKey: key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(unverified.keyReadiness).toBe("unverified");
    expect(unverified.ciphertextSampleDecryptable).toBe(true);
    expect(unverified.restoreReadiness).toBe(false);
    const poisoned = join(await workspace(), "future.db");
    await copyFile(snapshot, poisoned); await secureFile(poisoned);
    const db = openDatabaseFile(poisoned);
    try { db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run("9999_future.sql", new Date().toISOString()); } finally { db.close(); }
    const future = await verifyDatabaseBackup({ path: poisoned, expectedMasterKey: key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(future.schemaCompatible).toBe(false);
    expect(future.restoreReadiness).toBe(false);
  });

  it("keeps zero-sample inspection null and legacy key readiness unverified", async () => {
    const { snapshot, key } = await fixture(migrationsDir, false);
    expect(inspectSnapshotDatabase(snapshot, openDatabase, key)).toMatchObject({ sampleCount: 0, ciphertextSampleDecryptable: null });
    const missing = await verifyDatabaseBackup({ path: snapshot, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(missing).toMatchObject({ keyReadiness: "missing", ciphertextSampleDecryptable: false, restoreReadiness: false });
    const supplied = await verifyDatabaseBackup({ path: snapshot, expectedMasterKey: key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(supplied).toMatchObject({ keyReadiness: "unverified", ciphertextSampleDecryptable: false, restoreReadiness: false, sampleCount: 0 });
  });

  it("never rewrites user_version to hide an inconsistent snapshot", async () => {
    const { snapshot } = await fixture();
    const db = openDatabaseFile(snapshot);
    try { db.pragma("user_version = 999"); } finally { db.close(); }
    expect(() => sealSnapshotDatabase(snapshot, openDatabase)).toThrow(/consistent sealed SQLite/);
    const check = openDatabaseFile(snapshot, { readonly: true });
    try { expect(check.pragma("user_version", { simple: true })).toBe(999); } finally { check.close(); }
  });

  it("rejects foreign-key damage and missing required tables before packaging", async () => {
    const { root, source, key, keyPath, dataDir } = await fixture();
    const damaged = join(root, "damaged.db");
    await copyFile(source, damaged); await secureFile(damaged);
    const db = openDatabaseFile(damaged);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("INSERT INTO api_keys (id, provider_id, label, key_ciphertext, key_iv, key_tag, key_version, key_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("orphan", "missing", "bad", "YQ==", "YWI=", "Y2Q=", 1, "hidden", new Date().toISOString(), new Date().toISOString());
    } finally { db.close(); }
    expect(inspectSnapshotDatabase(damaged, openDatabase, key).foreignKeysOk).toBe(false);
    await expect(createBackupPackage({ snapshotPath: damaged, masterKeyPath: keyPath, outputPath: join(root, "bad.shbackup"), passphrase, appVersion: "0.1.15", migrations, keySource: "file", dataDir })).rejects.toThrow(/invalid or inconsistent/);
  });

  it("rejects origin mismatch, path overlap, active source locks and non-empty targets", async () => {
    const { root, dataDir, snapshot, key, keyPath } = await fixture();
    const output = join(root, "guarded.shbackup");
    await createBackupPackage({ snapshotPath: snapshot, masterKeyPath: keyPath, outputPath: output, passphrase, appVersion: "0.1.15", migrations, keySource: "file", dataDir, installDir: process.cwd() });
    const common = { path: output, sourceInstallDir: process.cwd(), passphrase, expectedMasterKey: key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase };
    await expect(restoreBackupPackage({ ...common, targetDir: join(root, "wrong-origin"), sourceDataDir: join(root, "other") })).rejects.toThrow(/origin guard/i);
    await expect(restoreBackupPackage({ ...common, targetDir: dataDir, sourceDataDir: dataDir })).rejects.toThrow(/overlaps/i);
    await expect(restoreBackupPackage({ ...common, targetDir: join(dataDir, "nested"), sourceDataDir: dataDir })).rejects.toThrow(/overlaps/i);
    await expect(restoreBackupPackage({ ...common, targetDir: root, sourceDataDir: dataDir })).rejects.toThrow(/overlaps/i);
    const occupied = join(root, "occupied"); await mkdir(occupied); await writeFile(join(occupied, "keep"), "existing");
    await expect(restoreBackupPackage({ ...common, targetDir: occupied, sourceDataDir: dataDir })).rejects.toThrow(/not empty/i);
    await writeFile(join(dataDir, "launcher.lock"), JSON.stringify({ pid: process.pid }));
    await expect(restoreBackupPackage({ ...common, targetDir: join(root, "locked-source"), sourceDataDir: dataDir })).rejects.toThrow(/active Search Hub lock/i);
  }, 180_000);

  it("restores an old known prefix by applying embedded migrations and re-verifying", async () => {
    const root = await workspace();
    const oldMigrationsDir = join(root, "old-migrations"); await mkdir(oldMigrationsDir);
    const oldNames = migrations.slice(0, 5);
    for (const name of oldNames) await cp(join(migrationsDir, name), join(oldMigrationsDir, name));
    const old = await fixture(oldMigrationsDir);
    const output = join(root, "old.shbackup");
    const created = await createBackupPackage({ snapshotPath: old.snapshot, masterKeyPath: old.keyPath, outputPath: output, passphrase, appVersion: "0.1.14", migrations: oldNames, keySource: "file", dataDir: old.dataDir, installDir: process.cwd() });
    expect(created.manifest.schemaContract.requiredTables).toHaveProperty("provider_test_batches");
    const oldReport = await verifyDatabaseBackup({ path: output, passphrase, expectedMasterKey: old.key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase });
    expect(oldReport).toMatchObject({ structuralOk: true, schemaCompatible: true, restoreReadiness: true });
    const target = join(root, "restored-old");
    const restoreOptions = { path: output, targetDir: target, sourceDataDir: old.dataDir, sourceInstallDir: process.cwd(), passphrase, expectedMasterKey: old.key, appVersion: "0.1.15", knownMigrations: migrations, openDatabase };
    const dryRun = await restoreBackupPackage(restoreOptions);
    expect(dryRun.applied).toBe(false);
    expect((await readdir(root)).some((name) => name.startsWith(".shbackup-restore-dry-"))).toBe(false);
    const restored = await restoreBackupPackage({ ...restoreOptions, apply: true });
    expect(restored.applied).toBe(true);
    const db = openDatabaseFile(join(target, "search-hub.db"), { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(migrations.length);
      expect((db.prepare("SELECT COUNT(*) AS count FROM api_keys").get() as { count: number }).count).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS count FROM provider_test_batches").get() as { count: number }).count).toBe(0);
    } finally { db.close(); }
  }, 180_000);
});
