import { closeSync, openSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { decryptSample, masterKeyFingerprint, parseMasterKey, type EncryptedSample } from "./master-key.js";
import { manifestCompatible } from "./manifest.js";
import { assertSecureRegularFile } from "./private-fs.js";
import { DEFAULT_TAR_LIMITS } from "./strict-tar.js";
import type { BackupVerificationReport, KeyReadiness, VerifyBackupPackageOptions } from "./types.js";

export interface SqliteStatement { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown }
export interface SqliteHandle { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }
export type SqliteHandleFactory = (path: string, readonly: boolean) => SqliteHandle;
export interface SnapshotAdapter {
  createSnapshot(destinationPath: string): Promise<{ method: "sqlite_backup_api" | "vacuum_into"; walCheckpointed: boolean }>;
  openDatabase: SqliteHandleFactory;
}
export interface DatabaseInspection {
  headerOk: boolean;
  integrityOk: boolean;
  integrityDetail: string;
  foreignKeysOk: boolean;
  requiredSchemaOk: boolean;
  journalMode: string;
  migrations: string[];
  userVersion: number;
  userVersionOk: boolean;
  tables: string[];
  apiKeySamples: number;
  modelSamples: number;
  sampleCount: number;
  ciphertextSampleDecryptable: boolean | null;
}

export const BASE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  _migrations: ["name", "applied_at"],
  admin_users: ["id", "email", "password_hash", "role"],
  sessions: ["id", "user_id", "token_hash", "csrf_token", "expires_at"],
  provider_instances: ["id", "name", "type", "config_json"],
  api_keys: ["id", "provider_id", "key_ciphertext", "key_iv", "key_tag", "key_version"],
  model_configs: ["id", "kind", "api_key_ciphertext", "api_key_iv", "api_key_tag"],
  search_groups: ["id", "name", "provider_ids_json"],
  search_tasks: ["id", "query", "status", "response_json"],
  search_events: ["id", "task_id", "provider_id", "ok"],
  access_tokens: ["id", "token_hash", "scopes_json"],
  settings: ["key", "value_json"],
  audit_logs: ["id", "actor", "action", "detail_json"],
};

const require = createRequire(`${process.cwd()}/package.json`);
let DatabaseConstructor: typeof DatabaseSync | null = null;

function databaseConstructor(): typeof DatabaseSync {
  if (!DatabaseConstructor) {
    DatabaseConstructor = (require("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  }
  return DatabaseConstructor;
}

/** Node's built-in adapter is the fail-closed fallback for core callers. */
export const openBuiltInSqlite: SqliteHandleFactory = (path, readonly) => {
  const database = new (databaseConstructor())(path, { readOnly: readonly });
  if (!readonly) database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return {
    exec: (sql) => { database.exec(sql); },
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        all: (...params) => statement.all(...params as never[]),
        get: (...params) => statement.get(...params as never[]),
        run: (...params) => statement.run(...params as never[]),
      };
    },
    close: () => { database.close(); },
  };
};

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}
function value(row: unknown, key: string): unknown {
  return row !== null && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
}
export function hasSqliteHeader(path: string): boolean {
  let descriptor = -1;
  try {
    descriptor = openSync(path, "r");
    const header = Buffer.alloc(16);
    return readSync(descriptor, header, 0, 16, 0) === 16 && header.toString("latin1") === "SQLite format 3\0";
  } catch { return false; } finally { if (descriptor >= 0) closeSync(descriptor); }
}

/** Opens read-only and validates integrity, schema shape, journal and real key samples. */
export function inspectSnapshotDatabase(
  path: string,
  openDatabase: SqliteHandleFactory,
  key: Buffer | null,
  requiredTables: Readonly<Record<string, readonly string[]>> = BASE_REQUIRED_COLUMNS,
): DatabaseInspection {
  const result: DatabaseInspection = {
    headerOk: false, integrityOk: false, integrityDetail: "not checked", foreignKeysOk: false,
    requiredSchemaOk: false, journalMode: "unknown", migrations: [], userVersion: 0,
    userVersionOk: false, tables: [], apiKeySamples: 0, modelSamples: 0, sampleCount: 0,
    ciphertextSampleDecryptable: null,
  };
  let db: SqliteHandle | null = null;
  try {
    result.headerOk = hasSqliteHeader(path);
    if (!result.headerOk) { result.integrityDetail = "missing SQLite format 3 header"; return result; }
    db = openDatabase(path, true);
    result.journalMode = String(value(db.prepare("PRAGMA journal_mode").get(), "journal_mode") ?? "unknown").toLowerCase();
    const integrity = rows(db.prepare("PRAGMA integrity_check").all()).map((row) => String(value(row, "integrity_check") ?? ""));
    result.integrityOk = integrity.length === 1 && integrity[0] === "ok";
    result.integrityDetail = result.integrityOk ? "ok" : integrity.slice(0, 5).join("; ") || "no result";
    result.foreignKeysOk = db.prepare("PRAGMA foreign_key_check").all().length === 0;
    result.tables = rows(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
      .map((row) => String(value(row, "name") ?? "")).filter(Boolean).sort();
    const tableSet = new Set(result.tables);
    result.requiredSchemaOk = Object.entries(requiredTables).every(([table, required]) => {
      if (!tableSet.has(table)) return false;
      const columns = new Set(rows(db?.prepare(`PRAGMA table_info("${table}")`).all()).map((row) => String(value(row, "name") ?? "")));
      return required.every((column) => columns.has(column));
    });
    result.migrations = tableSet.has("_migrations")
      ? rows(db.prepare("SELECT name FROM _migrations ORDER BY name").all()).map((row) => String(value(row, "name") ?? ""))
      : [];
    result.userVersion = Number(value(db.prepare("PRAGMA user_version").get(), "user_version") ?? 0);
    result.userVersionOk = Number.isSafeInteger(result.userVersion) && result.userVersion >= 0 && result.userVersion === result.migrations.length;
    if (tableSet.has("api_keys") && tableSet.has("model_configs")) {
      const apiRows = rows(db.prepare("SELECT key_ciphertext, key_iv, key_tag, key_version FROM api_keys ORDER BY id LIMIT 16").all());
      const modelRows = rows(db.prepare("SELECT api_key_ciphertext, api_key_iv, api_key_tag FROM model_configs WHERE api_key_ciphertext IS NOT NULL ORDER BY id LIMIT 16").all());
      result.apiKeySamples = apiRows.length; result.modelSamples = modelRows.length;
      result.sampleCount = apiRows.length + modelRows.length;
      if (key) {
        const samples: EncryptedSample[] = apiRows.map((row) => ({
          ciphertext: String(value(row, "key_ciphertext") ?? ""), iv: String(value(row, "key_iv") ?? ""),
          tag: String(value(row, "key_tag") ?? ""), version: Number(value(row, "key_version") ?? 1),
        })).concat(modelRows.map((row) => ({
          ciphertext: String(value(row, "api_key_ciphertext") ?? ""), iv: String(value(row, "api_key_iv") ?? ""),
          tag: String(value(row, "api_key_tag") ?? ""), version: 1,
        })));
        result.ciphertextSampleDecryptable = samples.length === 0 ? null : samples.every((sample) => decryptSample(key, sample));
      }
    }
  } catch (error) {
    result.integrityDetail = `database inspection failed: ${(error as Error).message}`;
  } finally { db?.close(); }
  return result;
}

/** Applied migrations must be a known, ordered prefix; newer pending migrations are allowed. */
export function schemaMigrationsCompatible(applied: readonly string[], known: readonly string[], userVersion: number): boolean {
  return userVersion === applied.length && applied.length <= known.length && applied.every((name, index) => name === known[index]);
}

/** Derives the complete table/column contract by replaying trusted embedded SQL in memory. */
export function schemaColumnsFromMigrations(migrations: readonly { sql: string }[]): Record<string, string[]> {
  const db = openBuiltInSqlite(":memory:", false);
  try {
    for (const migration of migrations) db.exec(migration.sql.replace(/--> statement-breakpoint/g, ""));
    const tables = rows(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      .map((row) => String(value(row, "name") ?? "")).filter(Boolean);
    return {
      _migrations: ["name", "applied_at"],
      ...Object.fromEntries(tables.map((table) => [
        table,
        rows(db.prepare(`PRAGMA table_info("${table}")`).all()).map((row) => String(value(row, "name") ?? "")).filter(Boolean),
      ])),
    };
  } finally { db.close(); }
}

export function emptyReport(bytes: number): BackupVerificationReport {
  return {
    format: "legacy-db", formatOk: false, structuralOk: false, schemaCompatible: false,
    keyFingerprintMatch: false, ciphertextSampleDecryptable: false, restoreReadiness: false,
    keyReadiness: "missing", sampleCount: 0, keyProofValid: null, sha256Match: false,
    bytes, dbBytes: 0, dbSha256: null, schemaVersion: null, userVersion: 0, migrations: [],
    headerOk: false, integrity: "failed", foreignKeys: "failed", requiredSchema: "failed",
    journalMode: "unknown", checkedAt: new Date().toISOString(),
  };
}

/** Seals only by validating an already-consistent snapshot; never rewrites user_version. */
export function sealSnapshotDatabase(path: string, openDatabase: SqliteHandleFactory): { migrations: string[]; userVersion: number } {
  const db = openDatabase(path, false);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;");
  } finally { db.close(); }
  const inspection = inspectSnapshotDatabase(path, openDatabase, null);
  if (!inspection.headerOk || !inspection.integrityOk || !inspection.foreignKeysOk || !inspection.requiredSchemaOk ||
      inspection.journalMode !== "delete" || !inspection.userVersionOk) {
    throw new Error(`Snapshot is not a consistent sealed SQLite database: ${inspection.integrityDetail}`);
  }
  return { migrations: inspection.migrations, userVersion: inspection.userVersion };
}

export interface VerifyDatabaseBackupOptions extends VerifyBackupPackageOptions {
  openDatabase: SqliteHandleFactory;
  appVersion: string;
  knownMigrations: string[];
}

/** Legacy inspection reports unverified/missing honestly instead of claiming readiness. */
export async function verifyLegacyDatabase(options: VerifyDatabaseBackupOptions): Promise<BackupVerificationReport> {
  const info = await assertSecureRegularFile(options.path, options.maxDatabaseBytes ?? DEFAULT_TAR_LIMITS.maxDatabaseBytes);
  const report = emptyReport(info.size);
  const key = options.expectedMasterKey === undefined ? null : parseMasterKey(options.expectedMasterKey);
  const inspection = inspectSnapshotDatabase(options.path, options.openDatabase, key);
  report.formatOk = inspection.headerOk;
  report.headerOk = inspection.headerOk;
  report.structuralOk = inspection.headerOk && inspection.integrityOk && inspection.foreignKeysOk && inspection.requiredSchemaOk && inspection.journalMode === "delete" && inspection.userVersionOk;
  report.schemaCompatible = inspection.headerOk && inspection.requiredSchemaOk && schemaMigrationsCompatible(inspection.migrations, options.knownMigrations, inspection.userVersion);
  report.keyFingerprintMatch = false;
  report.ciphertextSampleDecryptable = inspection.ciphertextSampleDecryptable === true;
  report.sampleCount = inspection.sampleCount;
  report.keyReadiness = key === null ? "missing" : inspection.sampleCount === 0 || inspection.ciphertextSampleDecryptable === true ? "unverified" : "mismatch";
  report.restoreReadiness = false;
  report.sha256Match = true; report.dbBytes = info.size; report.userVersion = inspection.userVersion;
  report.migrations = inspection.migrations; report.schemaVersion = inspection.migrations.at(-1) ?? null;
  report.integrity = inspection.integrityOk ? "ok" : "failed"; report.foreignKeys = inspection.foreignKeysOk ? "ok" : "failed";
  report.requiredSchema = inspection.requiredSchemaOk ? "ok" : "failed"; report.journalMode = inspection.journalMode;
  if (!report.schemaCompatible) report.reason = "legacy database schema is unknown, out of order or newer than this build";
  return report;
}

export function fingerprintKey(key: Buffer | null): string | null { return key ? masterKeyFingerprint(key) : null; }
export function packageManifestCompatible(manifest: Parameters<typeof manifestCompatible>[0], appVersion: string): boolean { return manifestCompatible(manifest, appVersion); }
export type { KeyReadiness };
