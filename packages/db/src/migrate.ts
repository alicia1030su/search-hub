import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

/**
 * Migrations live next to the source in `packages/db/migrations`.
 *
 * When the API is bundled into `apps/api/dist/server.mjs`, `import.meta.url`
 * points at the bundle, so the source-relative default no longer resolves.
 * We therefore probe a small list of candidates and require an explicit
 * `SEARCH_HUB_MIGRATIONS_DIR` when none match (the Docker image sets it).
 */
function defaultCandidates(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [
    fileURLToPath(new URL("../migrations", import.meta.url)),
    join(here, "../migrations"),
    join(process.cwd(), "packages", "db", "migrations"),
    join(process.cwd(), "../packages/db/migrations"),
    join(process.cwd(), "../../packages/db/migrations"),
    "/app/packages/db/migrations",
  ];
}

export function resolveMigrationsDir(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(
        `Migrations directory not found: ${explicit}. Set SEARCH_HUB_MIGRATIONS_DIR to the directory containing *.sql migrations.`,
      );
    }
    return explicit;
  }
  for (const candidate of defaultCandidates()) {
    if (existsSync(candidate) && readdirSync(candidate).some((file) => file.endsWith(".sql"))) {
      return candidate;
    }
  }
  throw new Error(
    "Could not locate the SQL migrations directory. " +
      "Set SEARCH_HUB_MIGRATIONS_DIR to the directory containing *.sql migrations.",
  );
}

const MIGRATIONS_DIR = resolveMigrationsDir(process.env["SEARCH_HUB_MIGRATIONS_DIR"]);

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
