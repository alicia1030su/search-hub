import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
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

/** VACUUM INTO is SQLite's consistent local snapshot primitive. */
export async function createNodeSqliteSnapshot(sourcePath: string, destinationPath: string): Promise<void> {
  const source = openNodeSqlite(sourcePath, true);
  try {
    source.prepare("VACUUM INTO ?").run(destinationPath);
  } finally {
    source.close();
  }
  if (process.platform === "win32") await restrictWindowsAcl(destinationPath, false);
  else chmodSync(destinationPath, 0o600);
}
