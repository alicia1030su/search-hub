import { createReadStream, rmSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { SearchHubError } from "@search-hub/shared";
import { listMigrations, openDatabaseFile } from "@search-hub/db";
import type { AppContext } from "../context.js";

/**
 * Database snapshots.
 *
 * Why not `fs.readFileSync(dbPath)`?
 *   A SQLite database in WAL mode is only complete when the main file and the
 *   `-wal`/`-shm` sidecars are consistent with each other. A plain file read
 *   can land between a WAL write and its checkpoint, so a checkpoint followed
 *   by `readFile` still races concurrent writers and can produce a database
 *   that opens but silently loses the last transactions (or is torn).
 *
 * What we do instead:
 *   1. `db.backup()` → SQLite Online Backup API. It copies pages inside the
 *      source connection's read transactions, so the destination is a
 *      transactionally consistent database at all times. Writes issued on the
 *      same connection are propagated into the copy; writes from other
 *      connections restart the copy instead of corrupting it. Either way there
 *      is never a half-written page set in the result.
 *   2. Normalise the copy to `journal_mode = DELETE` so the delivered `.db` is
 *      a single self-contained file with no `-wal`/`-shm` sidecars.
 *   3. `PRAGMA integrity_check` on a read-only handle; the snapshot is only
 *      published (atomic rename) after the check returns `ok`.
 *   4. Stamp `PRAGMA user_version` with the number of applied migrations so a
 *      restore can be validated without reading `_migrations`.
 *
 * When `db.backup()` is unavailable (older native builds) we fall back to
 * `VACUUM INTO`, which also reads from a single consistent snapshot, and which
 * requires SQLite ≥ 3.27.0 (2019). Both paths produce the same normalised file.
 */

export type SnapshotMethod = "sqlite_backup_api" | "vacuum_into";

export interface SchemaState {
  /** Applied migration file names, ascending. */
  migrations: string[];
  /** Newest applied migration name, or null for an empty database. */
  schemaVersion: string | null;
  /** `PRAGMA user_version`; `migrations.length` for snapshots we produce. */
  userVersion: number;
}

export interface SnapshotInfo extends SchemaState {
  path: string;
  bytes: number;
  takenAt: string;
  /** Always "ok": a snapshot that fails the check is deleted, never returned. */
  integrity: "ok";
  method: SnapshotMethod;
}

export interface CompatibilityReport {
  compatible: boolean;
  reason?: string;
  /** Migrations recorded in the file but unknown to this build (newer DB). */
  unknownToBuild: string[];
  /** Known migrations that the file does not contain (older backup). */
  pendingMigrations: string[];
}

export interface BackupVerification {
  ok: boolean;
  compatible: boolean;
  reason?: string;
  /** Detail of `PRAGMA integrity_check`, or the page-level failure reason. */
  integrity: string;
  /** SQLite file header check (a random file opens as an empty database). */
  isSqliteFile: boolean;
  /** False when the file has no `_migrations` table (not a Search Hub database). */
  isSearchHubDatabase: boolean;
  schemaVersion: string | null;
  userVersion: number;
  migrations: string[];
  knownMigrations: string[];
  pendingMigrations: string[];
  tables: string[];
  rowCounts: Record<string, number>;
  bytes: number;
  checkedAt: string;
  appVersion: string;
}

export interface UploadedSnapshot {
  /** Unpredictable temp path outside the data directory. */
  filePath: string;
  bytes: number;
  dispose: () => Promise<void>;
}

/** Tables reported by `POST /api/admin/backup/verify`. Allowlist only. */
const COUNTED_TABLES = [
  "admin_users",
  "provider_instances",
  "api_keys",
  "model_configs",
  "search_groups",
  "search_tasks",
  "search_events",
  "access_tokens",
  "settings",
  "audit_logs",
] as const;

type SqliteHandle = AppContext["sqlite"];

/** Snapshots live under `<dataDir>/snapshots` and are deleted after download. */
export function snapshotDirectory(ctx: AppContext): string {
  return join(ctx.config.dataDir, "snapshots");
}

/**
 * Timestamped name plus a random suffix: two concurrent backup requests can
 * land in the same millisecond, and a name collision would let the second
 * rename replace the file the first response is still streaming.
 */
export function snapshotFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `search-hub-${stamp}-${randomBytes(4).toString("hex")}.db`;
}

/**
 * Removes snapshots left behind by a crash or a killed download. Only files
 * older than `maxAgeMs` are touched, so an in-flight response is never affected.
 */
export async function pruneStaleSnapshots(
  ctx: AppContext,
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const directory = snapshotDirectory(ctx);
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    // `.db` = published snapshot; `.tmp*` = interrupted copy plus its journal.
    if (!name.endsWith(".db") && !name.includes(".tmp")) continue;
    const file = join(directory, name);
    try {
      const info = await stat(file);
      if (info.mtimeMs >= cutoff) continue;
      await removeSnapshotArtifacts(file);
      removed += 1;
    } catch {
      // A racing request may have deleted it already.
    }
  }
  if (removed > 0) ctx.logger.info({ removed }, "removed stale database snapshots");
  return removed;
}

export function sqliteVersion(sqlite: SqliteHandle): string {
  const row = sqlite.prepare("SELECT sqlite_version() AS version").get() as
    | { version?: string }
    | undefined;
  return row?.version ?? "0.0.0";
}

/** `VACUUM INTO` was added in SQLite 3.27.0 (2019-02-07). */
export function supportsVacuumInto(sqlite: SqliteHandle): boolean {
  const [major, minor] = sqliteVersion(sqlite)
    .split(".")
    .map((part) => Number(part));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return (major ?? 0) > 3 || ((major ?? 0) === 3 && (minor ?? 0) >= 27);
}

/** `db.backup()` exists on every better-sqlite3 build that ships the C API. */
export function supportsOnlineBackup(sqlite: SqliteHandle): boolean {
  return typeof (sqlite as { backup?: unknown }).backup === "function";
}

async function removeSnapshotArtifacts(path: string): Promise<void> {
  // `maxRetries` covers Windows, where deleting a file whose read stream was
  // just destroyed can transiently fail with EBUSY/EPERM.
  await Promise.all(
    [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].map((file) =>
      rm(file, { force: true, maxRetries: 10, retryDelay: 20 }).catch(() => undefined),
    ),
  );
}

function readSchemaState(db: ReturnType<typeof openDatabaseFile>): SchemaState {
  const hasMigrations = Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
      .get(),
  );
  const migrations = hasMigrations
    ? (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as Array<{ name: string }>).map(
        (row) => row.name,
      )
    : [];
  const userVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  return {
    migrations,
    schemaVersion: migrations.length > 0 ? (migrations[migrations.length - 1] as string) : null,
    userVersion: Number.isFinite(userVersion) ? userVersion : 0,
  };
}

/** Runs `PRAGMA integrity_check` on a read-only handle (never mutates the file). */
export function checkIntegrity(file: string): { ok: boolean; detail: string } {
  let db: ReturnType<typeof openDatabaseFile> | null = null;
  try {
    db = openDatabaseFile(file, { readonly: true });
    const rows = db.pragma("integrity_check") as Array<{ integrity_check?: string }>;
    const messages = rows.map((row) => String(row.integrity_check ?? "")).filter(Boolean);
    const ok = messages.length === 1 && messages[0] === "ok";
    return { ok, detail: ok ? "ok" : messages.slice(0, 5).join("; ") || "integrity_check: no result" };
  } catch (error) {
    return { ok: false, detail: `integrity_check failed: ${(error as Error).message}` };
  } finally {
    db?.close();
  }
}

/**
 * Checks the 16-byte SQLite file header.
 *
 * SQLite happily *opens* a random file and reports it as an empty database,
 * and `PRAGMA integrity_check` then returns `ok` — so a text file would pass
 * a naive verification. The header check is what separates "a database" from
 * "a file SQLite refused to complain about".
 */
export async function checkSqliteHeader(file: string): Promise<{ ok: boolean; detail: string }> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, 16, 0);
    const header = buffer.subarray(0, bytesRead).toString("latin1");
    if (bytesRead < 16 || !header.startsWith("SQLite format 3")) {
      return { ok: false, detail: "not a SQLite database file (missing the 'SQLite format 3' header)" };
    }
    return { ok: true, detail: "ok" };
  } catch (error) {
    return { ok: false, detail: `cannot read the file header: ${(error as Error).message}` };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Compares the migrations recorded in a database file with the migration files
 * this build knows. A database that contains migrations we do not ship was
 * written by a newer release and must not be opened by this build.
 */
export function schemaCompatibility(applied: string[], known: string[]): CompatibilityReport {
  const knownSet = new Set(known);
  const appliedSet = new Set(applied);
  const unknownToBuild = applied.filter((name) => !knownSet.has(name));
  const pendingMigrations = known.filter((name) => !appliedSet.has(name));
  if (unknownToBuild.length > 0) {
    return {
      compatible: false,
      // Stable, machine-readable reason. The offending names are in
      // `unknownToBuild` / `migrations`, not concatenated into this string.
      reason: "backup was created by a newer version",
      unknownToBuild,
      pendingMigrations,
    };
  }
  return { compatible: true, unknownToBuild: [], pendingMigrations };
}

function safeListMigrations(directory: string): string[] {
  try {
    return listMigrations(directory);
  } catch {
    return [];
  }
}

function countRows(db: ReturnType<typeof openDatabaseFile>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as
        | { count?: number | bigint }
        | undefined;
      counts[table] = Number(row?.count ?? 0);
    } catch {
      // Table missing: an older backup legitimately lacks newer tables.
    }
  }
  return counts;
}

/**
 * Reads integrity, schema version, tables and row counts from a database file.
 * Never throws for a corrupt file: the failure is reported in `ok`/`reason`.
 */
export async function inspectDatabaseFile(
  file: string,
  options: { migrationsDir: string; appVersion: string; bytes?: number },
): Promise<BackupVerification> {
  const knownMigrations = safeListMigrations(options.migrationsDir);
  const header = await checkSqliteHeader(file);
  const integrity = header.ok
    ? checkIntegrity(file)
    : { ok: false, detail: header.detail };

  let state: SchemaState = { migrations: [], schemaVersion: null, userVersion: 0 };
  let tables: string[] = [];
  let rowCounts: Record<string, number> = {};

  if (integrity.ok) {
    let db: ReturnType<typeof openDatabaseFile> | null = null;
    try {
      db = openDatabaseFile(file, { readonly: true });
      state = readSchemaState(db);
      tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      rowCounts = countRows(db);
    } catch (error) {
      return {
        ok: false,
        compatible: false,
        reason: `could not read the database: ${(error as Error).message}`,
        integrity: integrity.detail,
        isSqliteFile: header.ok,
        isSearchHubDatabase: false,
        schemaVersion: null,
        userVersion: 0,
        migrations: [],
        knownMigrations,
        pendingMigrations: [],
        tables: [],
        rowCounts: {},
        bytes: options.bytes ?? 0,
        checkedAt: new Date().toISOString(),
        appVersion: options.appVersion,
      };
    } finally {
      db?.close();
    }
  }

  const compatibility = schemaCompatibility(state.migrations, knownMigrations);
  // A file we cannot read cannot be declared compatible either: `compatible`
  // means "this build can open it", so header/integrity failures make it false.
  const readable = header.ok && integrity.ok;
  // No `_migrations` table = a valid SQLite file that is not a Search Hub
  // database (someone uploaded an unrelated .db). Reported, not silently ok.
  const isSearchHubDatabase = readable && tables.includes("_migrations");
  const compatible = readable && isSearchHubDatabase && compatibility.compatible;

  return {
    ok: compatible,
    compatible,
    ...(integrity.ok ? {} : { reason: integrity.detail }),
    ...(compatibility.reason ? { reason: compatibility.reason } : {}),
    ...(readable && !isSearchHubDatabase
      ? { reason: "not a Search Hub database (no _migrations table)" }
      : {}),
    integrity: integrity.detail,
    isSqliteFile: header.ok,
    isSearchHubDatabase,
    schemaVersion: state.schemaVersion,
    userVersion: state.userVersion,
    migrations: state.migrations,
    knownMigrations,
    pendingMigrations: compatibility.pendingMigrations,
    tables,
    rowCounts,
    bytes: options.bytes ?? 0,
    checkedAt: new Date().toISOString(),
    appVersion: options.appVersion,
  };
}

async function writeSnapshot(
  ctx: AppContext,
  tmpPath: string,
): Promise<SnapshotMethod> {
  if (supportsOnlineBackup(ctx.sqlite)) {
    try {
      const result = await ctx.sqlite.backup(tmpPath);
      if (result.remainingPages > 0) {
        throw new Error(`backup stopped with ${result.remainingPages} pages remaining`);
      }
      return "sqlite_backup_api";
    } catch (error) {
      await removeSnapshotArtifacts(tmpPath);
      if (!supportsVacuumInto(ctx.sqlite)) {
        throw new SearchHubError("internal_error", "SQLite online backup failed", {
          cause: error,
          details: { sqliteVersion: sqliteVersion(ctx.sqlite) },
        });
      }
      ctx.logger.warn(
        { err: error, sqliteVersion: sqliteVersion(ctx.sqlite) },
        "sqlite online backup failed, falling back to VACUUM INTO",
      );
    }
  }

  if (!supportsVacuumInto(ctx.sqlite)) {
    throw new SearchHubError(
      "internal_error",
      "This SQLite build supports neither the online backup API nor VACUUM INTO; a consistent snapshot cannot be taken",
      { details: { sqliteVersion: sqliteVersion(ctx.sqlite) } },
    );
  }
  ctx.sqlite.prepare("VACUUM INTO ?").run(tmpPath);
  return "vacuum_into";
}

/**
 * Makes the copy a single self-contained file and stamps the schema marker.
 * `journal_mode = DELETE` checkpoints any WAL pages into the main file, so the
 * delivered file can be opened without `-wal`/`-shm` sidecars.
 */
function sealSnapshot(tmpPath: string): SchemaState {
  const db = openDatabaseFile(tmpPath);
  try {
    db.pragma("journal_mode = DELETE");
    const state = readSchemaState(db);
    db.pragma(`user_version = ${state.migrations.length}`);
    return { ...state, userVersion: state.migrations.length };
  } finally {
    db.close();
  }
}

/**
 * Writes a consistent, verified snapshot to `destinationPath`.
 *
 * The file is built at `<destination>.<random>.tmp`, verified, then renamed —
 * so a crash or a failed check never leaves something that looks like a usable
 * backup under the final name.
 */
export async function createDatabaseSnapshot(
  ctx: AppContext,
  destinationPath: string,
): Promise<SnapshotInfo> {
  const directory = dirname(destinationPath);
  const tmpPath = `${destinationPath}.${randomBytes(6).toString("hex")}.tmp`;
  const takenAt = new Date().toISOString();

  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new SearchHubError(
      "internal_error",
      `Cannot create the snapshot directory ${directory}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let published = false;
  try {
    const method = await writeSnapshot(ctx, tmpPath);
    const sealed = sealSnapshot(tmpPath);
    const integrity = checkIntegrity(tmpPath);
    if (!integrity.ok) {
      throw new SearchHubError(
        "internal_error",
        `Snapshot failed PRAGMA integrity_check: ${integrity.detail}`,
        { details: { integrity: integrity.detail } },
      );
    }
    await rename(tmpPath, destinationPath);
    published = true;
    const info = await stat(destinationPath);
    ctx.logger.info(
      { bytes: info.size, schemaVersion: sealed.schemaVersion, method, integrity: "ok" },
      "database snapshot written",
    );
    return {
      path: destinationPath,
      bytes: info.size,
      takenAt,
      integrity: "ok",
      method,
      migrations: sealed.migrations,
      schemaVersion: sealed.schemaVersion,
      userVersion: sealed.userVersion,
    };
  } catch (error) {
    await removeSnapshotArtifacts(tmpPath);
    if (published) await removeSnapshotArtifacts(destinationPath);
    if (error instanceof SearchHubError) throw error;
    throw new SearchHubError("internal_error", `Failed to snapshot the database: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** Removes a snapshot (and any leftover sidecars) after it has been streamed. */
export async function disposeSnapshot(path: string): Promise<void> {
  await removeSnapshotArtifacts(path);
}

/**
 * Synchronous variant used after the response has been flushed: unlinking a
 * few files is metadata-only, and doing it here guarantees that a finished
 * download never leaves a snapshot behind (no pending promise to lose on exit).
 */
export function disposeSnapshotSync(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      rmSync(file, { force: true, maxRetries: 10, retryDelay: 20 });
    } catch {
      // The OS still holds the handle (Windows); the next boot's cleanup or a
      // later request will remove it. Never fail a finished response for this.
    }
  }
}

export function snapshotReadStream(path: string): ReturnType<typeof createReadStream> {
  return createReadStream(path);
}

/**
 * Streams the raw request body of `POST /api/admin/backup/verify` to an
 * unpredictable temp file while enforcing a hard byte limit.
 *
 * Fastify's per-route `bodyLimit` is not applied to custom stream parsers, so
 * the limit is enforced here, before anything touches the filesystem beyond
 * the private temp directory. The parser is scoped to that one path: a binary
 * body sent anywhere else is rejected with 415 instead of being buffered.
 */
export const BACKUP_VERIFY_PATH = "/api/admin/backup/verify";

export function registerBackupUploadParser(app: FastifyInstance, ctx: AppContext): void {
  app.addContentTypeParser(
    ["application/octet-stream", "application/vnd.sqlite3", "application/x-sqlite3"],
    (request, payload, done) => {
      const pathname = request.url.split("?")[0] ?? "";
      if (pathname !== BACKUP_VERIFY_PATH) {
        done(
          new SearchHubError(
            "validation_error",
            `Raw binary bodies are only accepted on ${BACKUP_VERIFY_PATH}`,
            { status: 415 },
          ),
        );
        return;
      }
      void receiveSnapshotUpload(payload, ctx.config.maxBackupUploadBytes).then(
        (upload) => done(null, upload),
        (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
      );
    },
  );
}

async function receiveSnapshotUpload(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
): Promise<UploadedSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "search-hub-upload-"));
  const filePath = join(directory, `${randomUUID()}.db`);
  const dispose = () => rm(directory, { recursive: true, force: true }).catch(() => undefined);
  let bytes = 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(filePath, "wx", 0o600);
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > limitBytes) {
        throw new SearchHubError(
          "validation_error",
          `Backup upload exceeds the ${Math.round(limitBytes / (1024 * 1024))} MB limit`,
          { status: 413 },
        );
      }
      await handle.write(buffer);
    }
    if (bytes === 0) {
      throw new SearchHubError(
        "validation_error",
        "Empty request body. Send the .db file as the raw body with content-type: application/octet-stream",
      );
    }
    return { filePath, bytes, dispose };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = null;
    await dispose();
    if (error instanceof SearchHubError) throw error;
    throw new SearchHubError("validation_error", `Could not read the uploaded backup: ${(error as Error).message}`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
