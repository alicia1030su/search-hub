import { describe, expect, it } from "vitest";
import {
  appliedMigrations,
  createDb,
  listMigrations,
  resolveMigrationsDir,
  runMigrations,
} from "@search-hub/db";

/**
 * `runMigrations` must fail closed when `_migrations` records a file this build
 * does not ship: that database was written by a newer release, and reading it
 * with older code would silently misinterpret the schema.
 */
describe("migration version guard", () => {
  const directory = resolveMigrationsDir();
  const files = listMigrations(directory);

  it("applies every shipped migration and records user_version", () => {
    const handle = createDb({ file: ":memory:" });
    try {
      const first = runMigrations(handle.sqlite, directory);
      expect(first.applied).toEqual(files);
      expect(first.unknownToBuild).toEqual([]);
      expect(appliedMigrations(handle.sqlite)).toEqual(files);
      expect(handle.sqlite.pragma("user_version", { simple: true })).toBe(files.length);

      const second = runMigrations(handle.sqlite, directory);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(files);
    } finally {
      handle.close();
    }
  });

  it("refuses to run when the database has a migration this build does not know", () => {
    const handle = createDb({ file: ":memory:" });
    try {
      runMigrations(handle.sqlite, directory);
      handle.sqlite
        .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
        .run("9999_future.sql", new Date().toISOString());

      let thrown: unknown;
      try {
        runMigrations(handle.sqlite, directory);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error & { code?: string; details?: { unknownToBuild?: string[] } };
      expect(error.message).toMatch(/schema is newer than this build/i);
      expect(error.message).toContain("9999_future.sql");
      expect(error.code).toBe("internal_error");
      expect(error.details?.unknownToBuild).toEqual(["9999_future.sql"]);
    } finally {
      handle.close();
    }
  });

  it("does not partially apply pending migrations before failing", () => {
    const handle = createDb({ file: ":memory:" });
    try {
      handle.sqlite.exec(
        "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      handle.sqlite
        .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
        .run("0000_from_the_future.sql", new Date().toISOString());

      expect(() => runMigrations(handle.sqlite, directory)).toThrow(/newer than this build/i);
      // The guard runs before any DDL, so the shipped tables must not exist.
      const tables = handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_users'")
        .get();
      expect(tables).toBeUndefined();
    } finally {
      handle.close();
    }
  });
});
