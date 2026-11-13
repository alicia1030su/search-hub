import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { SearchHubError } from "@search-hub/shared";

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
  /** Migrations recorded in the database that this build does not ship. */
  unknownToBuild: string[];
}

/** Migration names already recorded in `_migrations`, ascending. */
export function appliedMigrations(sqlite: Database.Database): string[] {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  return (
    sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/**
 * Applies ordered .sql migrations exactly once. Each migration runs inside a
 * transaction so a failure leaves the schema untouched.
 *
 * A database whose `_migrations` table records files this build does not ship
 * was written by a *newer* release. Starting the older code against it would
 * half-read a schema it does not understand, so we refuse to boot instead of
 * silently continuing (fail closed, with an operator-actionable message).
 */
export function runMigrations(
  sqlite: Database.Database,
  directory: string = MIGRATIONS_DIR,
): MigrationResult {
  const appliedNames = appliedMigrations(sqlite);
  const appliedSet = new Set(appliedNames);

  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  const knownSet = new Set(files);

  const unknownToBuild = appliedNames.filter((name) => !knownSet.has(name));
  if (unknownToBuild.length > 0) {
    throw new SearchHubError(
      "internal_error",
      "Database schema is newer than this build: " +
        `${unknownToBuild.join(", ")} ${unknownToBuild.length === 1 ? "is" : "are"} applied but ` +
        `not present in ${directory}. This database was written by a newer Search Hub release. ` +
        "Upgrade the application (or restore a backup taken with this version) before starting.",
      { details: { unknownToBuild, applied: appliedNames, known: files } },
    );
  }

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

  // Keep a coarse, cheap-to-read marker in sync so external tools (and our own
  // backup verification) can compare versions without parsing `_migrations`.
  // Only write when it changes: this runs on every boot.
  const expectedUserVersion = files.length;
  const currentUserVersion = Number(sqlite.pragma("user_version", { simple: true }) ?? 0);
  if (currentUserVersion !== expectedUserVersion) {
    sqlite.pragma(`user_version = ${expectedUserVersion}`);
  }

  return { applied, skipped, unknownToBuild: [] };
}

export function listMigrations(directory: string = MIGRATIONS_DIR): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}
