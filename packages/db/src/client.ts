import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type SearchHubDb = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: SearchHubDb;
  sqlite: Database.Database;
  path: string;
  close(): void;
}

export interface CreateDbOptions {
  /** SQLite file path, or ":memory:" for tests. */
  file: string;
  readonly?: boolean;
}

/**
 * SQLite is the default single-node store. WAL + a busy timeout keeps reads
 * from blocking on the short write transactions used by the scheduler stats
 * flush. Network calls never run inside a transaction.
 */
export function createDb(options: CreateDbOptions): DbHandle {
  const sqlite = new Database(options.file, { readonly: options.readonly ?? false });
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  if (options.file !== ":memory:") {
    sqlite.pragma("wal_autocheckpoint = 512");
  }

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    path: options.file,
    close: () => {
      sqlite.close();
    },
  };
}

export function withTransaction<T>(sqlite: Database.Database, fn: () => T): T {
  const run = sqlite.transaction(fn);
  return run();
}

/**
 * Opens an existing SQLite file as-is, without the server pragmas applied by
 * `createDb` (journal mode, busy timeout, ...).
 *
 * Used by snapshot verification: inspecting a backup file must not change the
 * file's journal mode, and `journal_mode = WAL` on a read-only handle fails.
 */
export function openDatabaseFile(
  file: string,
  options: { readonly?: boolean } = {},
): Database.Database {
  return new Database(file, { readonly: options.readonly ?? false, fileMustExist: true });
}
