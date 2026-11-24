import { chmodSync, existsSync, lstatSync, rmSync, type Stats } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { restrictWindowsAcl, type SqliteHandle, type SqliteStatement } from "@search-hub/backup";

const require = createRequire(join(process.cwd(), "package.json"));
let DatabaseConstructor: typeof DatabaseSync | null = null;

/** Loads node:sqlite only for local maintenance, keeping remote stdout/stderr clean. */
function databaseConstructor(): typeof DatabaseSync {
  if (!DatabaseConstructor) {
    DatabaseConstructor = (require("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  }
  return DatabaseConstructor;
}

/** Adapts node:sqlite's synchronous API to the backup package's small contract. */
export function openNodeSqlite(path: string, readonly: boolean): SqliteHandle {
  if (!existsSync(path)) throw new Error(`SQLite database does not exist: ${path}`);
  const database = new (databaseConstructor())(path, { readOnly: readonly });
  if (!readonly) database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return {
    exec: (sql: string): void => { database.exec(sql); },
    prepare: (sql: string): SqliteStatement => {
      const statement = database.prepare(sql);
      return {
        all: (...params: unknown[]): unknown[] => statement.all(...params as never[]),
        get: (...params: unknown[]): unknown => statement.get(...params as never[]),
        run: (...params: unknown[]): unknown => statement.run(...params as never[]),
      };
    },
    close: (): void => database.close(),
  };
}

interface SourceStat {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  mode: number;
  dev: number;
  ino: number;
  nlink: number;
  uid: number;
  gid: number;
}

interface SourceState {
  database: SourceStat;
  wal: SourceStat | null;
  shm: SourceStat | null;
  journal: SourceStat | null;
}

function captureStat(path: string): Stats {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error(`SQLite snapshot input must be a regular file: ${path}`);
  return info;
}

function stableStat(info: Stats): SourceStat {
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
    mode: info.mode,
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    uid: info.uid,
    gid: info.gid,
  };
}

function optionalStat(path: string): SourceStat | null {
  try { return stableStat(captureStat(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function captureSourceState(sourcePath: string): SourceState {
  return {
    database: stableStat(captureStat(sourcePath)),
    wal: optionalStat(`${sourcePath}-wal`),
    shm: optionalStat(`${sourcePath}-shm`),
    journal: optionalStat(`${sourcePath}-journal`),
  };
}

function sameStat(left: SourceStat | null, right: SourceStat | null): boolean {
  if (left === null || right === null) return left === right;
  return Object.keys(left).every((key) => left[key as keyof SourceStat] === right[key as keyof SourceStat]);
}

function assertSourceUnchanged(sourcePath: string, before: SourceState): void {
  const after = captureSourceState(sourcePath);
  if (!sameStat(before.database, after.database) || !sameStat(before.wal, after.wal) ||
      !sameStat(before.shm, after.shm) || !sameStat(before.journal, after.journal)) {
    throw new Error("SQLite source database or WAL/SHM/journal metadata changed during snapshot; refusing to publish the backup");
  }
}

/**
 * Creates an immutable read-only VACUUM INTO snapshot without opening the source
 * in WAL mode. A live/non-empty WAL or rollback journal is rejected instead of
 * copied, checkpointed or deleted.
 */
export async function createNodeSqliteSnapshot(sourcePath: string, destinationPath: string): Promise<void> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination || destination === `${source}-wal` || destination === `${source}-shm` || destination === `${source}-journal`) {
    throw new Error("SQLite snapshot destination must be distinct from the source database and its sidecars");
  }
  const before = captureSourceState(source);
  if ((before.wal !== null && before.wal.size > 0) || (before.journal !== null && before.journal.size > 0)) {
    throw new Error("SQLite source has a non-empty WAL or rollback journal; stop Search Hub or checkpoint the database before creating a backup");
  }

  let destinationExisted = true;
  try { lstatSync(destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    destinationExisted = false;
  }
  const ownsDestination = !destinationExisted;
  try {
    const database = new (databaseConstructor())(`${pathToFileURL(source).href}?immutable=1`, { readOnly: true });
    try {
      database.prepare("VACUUM INTO ?").run(destination);
    } finally {
      database.close();
    }
    assertSourceUnchanged(source, before);
    if (process.platform === "win32") await restrictWindowsAcl(destination, false);
    else chmodSync(destination, 0o600);
  } catch (error) {
    if (ownsDestination) rmSync(destination, { force: true });
    throw error;
  }
}
