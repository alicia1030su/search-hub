import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies ordered .sql migrations exactly once. Each migration runs inside a
 * transaction so a failure leaves the schema untouched.
 */
export function runMigrations(
  sqlite: Database.Database,
  directory: string = MIGRATIONS_DIR,
): MigrationResult {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  const appliedRows = sqlite
    .prepare("SELECT name FROM _migrations ORDER BY name")
    .all() as Array<{ name: string }>;
  const appliedSet = new Set(appliedRows.map((row) => row.name));

  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(directory, file), "utf8");
    const insert = sqlite.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(sql);
      insert.run(file, new Date().toISOString());
      sqlite.exec("COMMIT");
      applied.push(file);
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  return { applied, skipped };
}

export function listMigrations(directory: string = MIGRATIONS_DIR): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}
