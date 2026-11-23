#!/usr/bin/env node
/** Create a real sealed SQLite + .shbackup fixture for same-process verifier tests. */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createBackupPackage, openBuiltInSqlite, sealSnapshotDatabase, verifyDatabaseBackup } from "../../packages/backup/src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIB = 1024 * 1024;
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("usage: node --import tsx tests/disaster-recovery/make-memory-fixture.mjs <size-mib> <output-dir>\n");
  process.exit(0);
}
const sizeMiB = Number(args[0]);
const outputDir = resolve(args[1] ?? "");
if (!Number.isSafeInteger(sizeMiB) || sizeMiB < 1 || sizeMiB > 1024 || !args[1]) {
  process.stderr.write("size must be 1..1024 MiB and output-dir is required\n");
  process.exit(2);
}
const dataDir = join(outputDir, "source-data");
const dbPath = join(dataDir, "search-hub.db");
const keyPath = join(dataDir, "master.key");
const packagePath = join(outputDir, "backup.shbackup");
const passphrasePath = join(outputDir, "passphrase");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const key = randomBytes(32);
const passphrase = process.env.SEARCH_HUB_BACKUP_PASSPHRASE ?? `synthetic-memory-${randomBytes(24).toString("hex")}`;
if (Array.from(passphrase.trim()).length < 12) throw new Error("passphrase must have at least 12 trimmed Unicode code points");
const migrationsDir = join(ROOT, "packages", "db", "migrations");
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const database = new DatabaseSync(dbPath);
try {
  database.exec("PRAGMA page_size = 4096");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA wal_autocheckpoint = 0");
  database.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const name of migrations) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(join(migrationsDir, name), "utf8"));
      database.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.exec(`PRAGMA user_version = ${migrations.length}`);
  const now = new Date().toISOString();
  database.prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("prv_memory", "Memory fixture", "mock", now, now);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("synthetic-memory-secret", "utf8"), cipher.final()]);
  database.prepare(`INSERT INTO api_keys
    (id, provider_id, label, key_ciphertext, key_iv, key_tag, key_version, key_hint, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "key_memory", "prv_memory", "fixture", ciphertext.toString("base64"), iv.toString("base64"),
    cipher.getAuthTag().toString("base64"), 1, "syn…cret", now, now,
  );
  database.exec("CREATE TABLE _dr_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
  const target = sizeMiB * MIB;
  let inserted = 0;
  while (statSync(dbPath).size < target) {
    const remaining = target - statSync(dbPath).size;
    database.prepare("INSERT INTO _dr_payload (payload) VALUES (?)").run(randomBytes(Math.min(MIB, Math.max(64 * 1024, remaining + 64 * 1024))));
    inserted += 1;
    if (inserted % 16 === 0) database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    if (inserted > sizeMiB * 4 + 64) throw new Error("fixture did not reach target size");
  }
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.exec("PRAGMA journal_mode = DELETE");
} finally {
  database.close();
}
sealSnapshotDatabase(dbPath, openBuiltInSqlite);
const keyDescriptor = openSync(keyPath, "wx", 0o600);
try { writeFileSync(keyDescriptor, `${key.toString("hex")}\n`, "utf8"); fsyncSync(keyDescriptor); } finally { closeSync(keyDescriptor); }
const passphraseDescriptor = openSync(passphrasePath, "wx", 0o600);
try { writeFileSync(passphraseDescriptor, `${passphrase}\n`, "utf8"); fsyncSync(passphraseDescriptor); } finally { closeSync(passphraseDescriptor); }
const appVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const created = await createBackupPackage({
  snapshotPath: dbPath,
  masterKeyValue: key,
  outputPath: packagePath,
  passphrase,
  appVersion,
  migrations,
  keySource: "file",
  creator: "cli",
  dataDir,
  openDatabase: openBuiltInSqlite,
});
mkdirSync(join(outputDir, "verify-work"), { recursive: true, mode: 0o700 });
const report = await verifyDatabaseBackup({
  path: packagePath,
  passphrase,
  privateWorkDir: join(outputDir, "verify-work"),
  openDatabase: openBuiltInSqlite,
  appVersion,
  knownMigrations: migrations,
});
if (!report.restoreReadiness) throw new Error(`fixture package is not ready: ${report.reason ?? "verification failed"}`);
const fingerprint = createHash("sha256").update(Buffer.concat([Buffer.from("search-hub-master-key-fingerprint-v1\0"), key])).digest("hex");
const result = {
  sizeMiB,
  sourceDb: dbPath,
  packagePath,
  passphrasePath,
  keyFingerprint: fingerprint,
  sourceBytes: statSync(dbPath).size,
  packageBytes: statSync(packagePath).size,
  packageSha256: created.sha256,
  migrations,
  restoreReadiness: report.restoreReadiness,
};
writeFileSync(join(outputDir, "fixture.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
