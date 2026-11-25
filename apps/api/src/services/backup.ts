import { createReadStream, rmSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SearchHubError } from "@search-hub/shared";
import { listMigrations, openDatabaseFile } from "@search-hub/db";
import type { AppContext } from "../context.js";
import { authenticate, requireAdmin } from "../auth.js";
import { createPrivateDirectory, isProcessAlive, openPrivateFile, readProcessStartTime } from "@search-hub/backup";

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
  release: () => void;
}

export interface UploadedBackupPackage extends UploadedSnapshot {
  passphrase: string;
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
export const BACKUP_PACKAGE_VERIFY_PATH = "/api/admin/backup/package/verify";
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_PASSPHRASE_FIELD_BYTES = 16 * 1024;
const UPLOAD_OWNER_MARKER = ".search-hub-owner.json";
let reservedVerifyBytes = 0;
let activeVerifyUploads = 0;

interface UploadReservation {
  bytes: number;
  release: () => void;
}

interface UploadOwnerMarker {
  schema: 1;
  namespace: string;
  kind: "upload" | "package-verify";
  pid: number;
  processStartedAt: string | null;
  createdAt: string;
}

export function uploadOwnerNamespace(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(dataDir);
  const normalized = platform === "win32" ? resolved.toLowerCase() : resolved;
  return createHash("sha256").update(normalized).digest("hex");
}

export async function writeUploadOwnerMarker(
  directory: string,
  kind: UploadOwnerMarker["kind"],
  dataDir: string,
): Promise<void> {
  const marker: UploadOwnerMarker = {
    schema: 1,
    namespace: uploadOwnerNamespace(dataDir),
    kind,
    pid: process.pid,
    processStartedAt: await readProcessStartTime(process.pid),
    createdAt: new Date().toISOString(),
  };
  const handle = await openPrivateFile(join(directory, UPLOAD_OWNER_MARKER));
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function reserveUpload(request: FastifyRequest, ctx: AppContext, packageUpload: boolean): UploadReservation {
  const rawLength = request.headers["content-length"];
  let declaredBytes: number | undefined;
  if (rawLength !== undefined) {
    if (typeof rawLength !== "string" || !/^\d+$/.test(rawLength)) {
      throw new SearchHubError("validation_error", "Invalid Content-Length");
    }
    declaredBytes = Number(rawLength);
    if (!Number.isSafeInteger(declaredBytes)) throw new SearchHubError("validation_error", "Invalid Content-Length");
  }
  const rawLimit = ctx.config.maxBackupUploadBytes + MULTIPART_OVERHEAD_BYTES;
  if (declaredBytes !== undefined && declaredBytes > rawLimit) {
    throw new SearchHubError("validation_error", "Backup upload exceeds the configured limit", { status: 413 });
  }
  // Package verification also extracts a bounded archive. Reserve the archive
  // ceiling plus the core's staging headroom for the whole lease, even when a
  // small Content-Length is declared. Legacy snapshots reserve their raw body.
  const bytes = packageUpload
    ? ctx.config.maxBackupUploadBytes * 2 + 16 * 1024 * 1024
    : declaredBytes ?? rawLimit;
  if (activeVerifyUploads >= ctx.config.maxBackupVerifyConcurrency ||
    reservedVerifyBytes + bytes > ctx.config.maxBackupVerifyTempBytes) {
    throw new SearchHubError("rate_limited", "Backup verification temporary-disk or concurrency quota exceeded", { status: 429 });
  }
  reservedVerifyBytes += bytes;
  activeVerifyUploads += 1;
  let released = false;
  return {
    bytes,
    release: () => {
      if (released) return;
      released = true;
      reservedVerifyBytes -= bytes;
      activeVerifyUploads -= 1;
    },
  };
}

function heartbeatDirectory(directory: string): () => void {
  const timer = setInterval(() => {
    void utimes(directory, new Date(), new Date()).catch(() => undefined);
  }, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Removes old, owner-marked upload staging left by a killed API process. */
export async function pruneStaleUploads(namespace: string, maxAgeMs = 60 * 60 * 1000): Promise<number> {
  if (!namespace) return 0;
  let names: string[] = [];
  try { names = await readdir(tmpdir()); } catch { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith("search-hub-upload-") && !name.startsWith("search-hub-package-verify-")) continue;
    const path = join(tmpdir(), name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() || info.mtimeMs >= cutoff) continue;
      const markerPath = join(path, UPLOAD_OWNER_MARKER);
      const markerInfo = await lstat(markerPath);
      if (markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.size > 4096) continue;
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Partial<UploadOwnerMarker>;
      const expectedKind = name.startsWith("search-hub-upload-") ? "upload" : "package-verify";
      if (marker.schema !== 1 || marker.namespace !== namespace || marker.kind !== expectedKind ||
          typeof marker.pid !== "number" || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 ||
          typeof marker.createdAt !== "string" || !Number.isFinite(Date.parse(marker.createdAt)) ||
          (marker.processStartedAt !== undefined && marker.processStartedAt !== null && typeof marker.processStartedAt !== "string")) continue;
      let stale = !isProcessAlive(marker.pid);
      if (!stale && typeof marker.processStartedAt === "string" && marker.processStartedAt.length > 0) {
        const actual = await readProcessStartTime(marker.pid);
        stale = actual !== null && actual !== marker.processStartedAt;
      }
      if (!stale) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch { /* unmarked, malformed, foreign, or live-owned directories are preserved */ }
  }
  return removed;
}

function authenticateBackupUpload(request: FastifyRequest, ctx: AppContext): void {
  requireAdmin(authenticate(
    {
      headers: request.headers as Record<string, string | string[] | undefined>,
      cookies: request.cookies as Record<string, string | undefined>,
      ip: request.ip,
    },
    ctx.authDeps,
    { scope: "admin", mutation: true },
  ));
}

function parseUpload(request: FastifyRequest, ctx: AppContext): { pathname: string; reservation: UploadReservation } {
  // @fastify/rate-limit runs in onRequest, before this parser. Authentication
  // and CSRF therefore complete before quota reservation or any filesystem use.
  authenticateBackupUpload(request, ctx);
  const pathname = request.url.split("?")[0] ?? "";
  if (pathname !== BACKUP_VERIFY_PATH && pathname !== BACKUP_PACKAGE_VERIFY_PATH) {
    throw new SearchHubError("validation_error", "Backup uploads are only accepted on the verification endpoints", { status: 415 });
  }
  return { pathname, reservation: reserveUpload(request, ctx, pathname === BACKUP_PACKAGE_VERIFY_PATH) };
}

export function registerBackupUploadParser(app: FastifyInstance, ctx: AppContext): void {
  app.addContentTypeParser(
    ["application/octet-stream", "application/vnd.sqlite3", "application/x-sqlite3"],
    (request, payload, done) => {
      let reservation: UploadReservation | undefined;
      try {
        const parsed = parseUpload(request, ctx);
        reservation = parsed.reservation;
        if (parsed.pathname !== BACKUP_VERIFY_PATH) {
          throw new SearchHubError("validation_error", "Complete .shbackup packages require multipart/form-data", { status: 415 });
        }
      } catch (error) {
        reservation?.release();
        done(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      void receiveSnapshotUpload(payload, ctx.config.maxBackupUploadBytes, reservation, ctx.config.dataDir).then(
        (upload) => done(null, upload),
        (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
      );
    },
  );
  app.addContentTypeParser("multipart/form-data", (request, payload, done) => {
    let reservation: UploadReservation | undefined;
    try {
      const parsed = parseUpload(request, ctx);
      reservation = parsed.reservation;
      const boundary = multipartBoundary(request.headers["content-type"]);
      const packageUpload = parsed.pathname === BACKUP_PACKAGE_VERIFY_PATH;
      void receiveMultipartSnapshot(payload, boundary, ctx.config.maxBackupUploadBytes, reservation, packageUpload, ctx.config.dataDir).then(
        (upload) => done(null, upload),
        (error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
      );
    } catch (error) {
      reservation?.release();
      done(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function multipartBoundary(contentType: string | undefined): string {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70 || /[\r\n\0]/.test(boundary)) {
    throw new SearchHubError("validation_error", "A valid multipart boundary is required");
  }
  return boundary;
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset);
    if (result.bytesWritten <= 0) throw new Error("Could not write uploaded backup");
    offset += result.bytesWritten;
  }
}

/** Streaming multipart for legacy .db files and complete .shbackup packages. */
async function receiveMultipartSnapshot(
  stream: NodeJS.ReadableStream,
  boundary: string,
  limitBytes: number,
  reservation: UploadReservation,
  packageUpload: boolean,
  dataDir: string,
): Promise<UploadedSnapshot | UploadedBackupPackage> {
  let directory = "";
  let stopHeartbeat: (() => void) | undefined;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const dispose = async (): Promise<void> => {
    stopHeartbeat?.();
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    reservation.release();
  };
  try {
    directory = await createPrivateDirectory(tmpdir(), packageUpload ? "search-hub-package-verify-" : "search-hub-upload-");
    await writeUploadOwnerMarker(directory, packageUpload ? "package-verify" : "upload", dataDir);
    stopHeartbeat = heartbeatDirectory(directory);
    const filePath = join(directory, `${randomUUID()}${packageUpload ? ".shbackup" : ".db"}`);
    const marker = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let pending: Buffer = Buffer.alloc(0);
  let started = false;
  let inHeaders = false;
  let isFile = false;
  let isPassphrase = false;
  let fileSeen = false;
  let passphraseSeen = false;
  let passphrase = "";
  let finished = false;
  let bytes = 0;
  let rawBytes = 0;
  const appendPassphrase = (body: Buffer): void => {
    passphraseSeen = true;
    if (Buffer.byteLength(passphrase, "utf8") + body.length > MAX_PASSPHRASE_FIELD_BYTES) {
      throw new SearchHubError("validation_error", "Multipart passphrase field is too large");
    }
    passphrase += body.toString("utf8");
  };
    for await (const raw of stream as AsyncIterable<Buffer | string>) {
      const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
      rawBytes += chunk.length;
      if (rawBytes > limitBytes + 1024 * 1024) throw new SearchHubError("validation_error", "Backup upload exceeds the configured limit", { status: 413 });
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        if (!started) {
          const index = pending.indexOf(marker);
          if (index < 0) {
            pending = pending.subarray(Math.max(0, pending.length - marker.length));
            break;
          }
          pending = pending.subarray(index + marker.length);
          started = true;
          inHeaders = true;
        }
        if (inHeaders) {
          const end = pending.indexOf("\r\n\r\n");
          if (end < 0) {
            if (pending.length > 16 * 1024) throw new SearchHubError("validation_error", "Multipart headers are too large");
            break;
          }
          const headers = pending.subarray(0, end).toString("latin1");
          pending = pending.subarray(end + 4);
          const disposition = /content-disposition:\s*form-data;[^\r\n]*/i.exec(headers)?.[0] ?? "";
          const name = /name="([^"]+)"/i.exec(disposition)?.[1];
          const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
          isFile = name === "file" && filename !== undefined;
          isPassphrase = packageUpload && name === "passphrase" && filename === undefined;
          if (isFile) {
            if (fileSeen) throw new SearchHubError("validation_error", "Multipart upload must contain exactly one file");
            if (packageUpload && !filename?.toLowerCase().endsWith(".shbackup")) {
              throw new SearchHubError("validation_error", "The multipart file field must use the .shbackup extension");
            }
            fileSeen = true;
            handle = await openPrivateFile(filePath);
          } else if (isPassphrase) {
            if (passphraseSeen) throw new SearchHubError("validation_error", "Multipart upload must contain exactly one passphrase field");
          } else {
            throw new SearchHubError("validation_error", "Unsupported multipart field");
          }
          inHeaders = false;
        }
        const index = pending.indexOf(delimiter);
        if (index >= 0) {
          const body = pending.subarray(0, index);
          pending = pending.subarray(index + delimiter.length);
          if (isFile && handle) {
            bytes += body.length;
            if (bytes > limitBytes) throw new SearchHubError("validation_error", "Backup upload exceeds the configured limit", { status: 413 });
            await writeAll(handle, body);
            await handle.sync();
            await handle.close();
            handle = null;
          } else if (isPassphrase) {
            appendPassphrase(body);
          }
          if (pending.subarray(0, 2).toString("ascii") === "--") {
            finished = true;
            pending = Buffer.alloc(0);
            break;
          }
          if (pending.subarray(0, 2).toString("ascii") !== "\r\n") {
            throw new SearchHubError("validation_error", "Malformed multipart boundary");
          }
          pending = pending.subarray(2);
          inHeaders = true;
          continue;
        }
        if (isFile && handle) {
          const keep = Math.max(0, delimiter.length - 1);
          const flush = pending.subarray(0, Math.max(0, pending.length - keep));
          pending = pending.subarray(flush.length);
          bytes += flush.length;
          if (bytes > limitBytes) throw new SearchHubError("validation_error", "Backup upload exceeds the configured limit", { status: 413 });
          if (flush.length > 0) await writeAll(handle, flush);
        } else if (isPassphrase) {
          const keep = Math.max(0, delimiter.length - 1);
          const flush = pending.subarray(0, Math.max(0, pending.length - keep));
          pending = pending.subarray(flush.length);
          appendPassphrase(flush);
        } else {
          pending = pending.subarray(Math.max(0, pending.length - delimiter.length));
        }
        break;
      }
      if (finished) break;
    }
    if (!finished || !fileSeen || bytes === 0 || (packageUpload && !passphraseSeen)) {
      throw new SearchHubError("validation_error", "Multipart upload is incomplete or missing file/passphrase");
    }
    const upload = { filePath, bytes, dispose, release: reservation.release };
    return packageUpload ? { ...upload, passphrase } : upload;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await dispose();
    if (error instanceof SearchHubError) throw error;
    throw new SearchHubError("validation_error", `Could not read multipart backup: ${(error as Error).message}`);
  }
}

async function receiveSnapshotUpload(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
  reservation: UploadReservation,
  dataDir: string,
): Promise<UploadedSnapshot> {
  let directory = "";
  let stopHeartbeat: (() => void) | undefined;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const dispose = async (): Promise<void> => {
    stopHeartbeat?.();
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    reservation.release();
  };
  try {
    directory = await createPrivateDirectory(tmpdir(), "search-hub-upload-");
    await writeUploadOwnerMarker(directory, "upload", dataDir);
    stopHeartbeat = heartbeatDirectory(directory);
    const filePath = join(directory, `${randomUUID()}.db`);
    let bytes = 0;
    handle = await openPrivateFile(filePath);
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
      await writeAll(handle, buffer);
    }
    if (bytes === 0) {
      throw new SearchHubError(
        "validation_error",
        "Empty request body. Send the .db file as the raw body with content-type: application/octet-stream",
      );
    }
    await handle.sync();
    return { filePath, bytes, dispose, release: reservation.release };
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
