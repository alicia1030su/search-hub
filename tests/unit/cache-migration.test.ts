import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  listMigrations,
  resolveMigrationsDir,
  runMigrations,
  type DbHandle,
} from "@search-hub/db";

/**
 * The cache table arrives as migration `0004`. An installation that has been
 * running since before it must keep every row it already had — an upgrade that
 * loses search history or an administrator account is worse than no cache.
 *
 * The test builds a database with only the *old* migrations applied, writes data
 * through that schema, then runs the full set and compares.
 */
describe("cache migration on an existing database", () => {
  const directory = resolveMigrationsDir();
  const files = listMigrations(directory);
  const oldFiles = files.filter((file) => file < "0004");
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  /**
   * A directory holding only the pre-0004 migrations.
   *
   * `runMigrations` applies everything it finds, so "the previous release's
   * schema" is expressed by giving it the previous release's file set — no
   * escape hatch in the production code just for this test.
   */
  let oldDir: string | null = null;
  function previousReleaseDir(): string {
    if (oldDir) return oldDir;
    const dir = mkdtempSync(join(tmpdir(), "search-hub-old-migrations-"));
    dirs.push(dir);
    for (const file of oldFiles) copyFileSync(join(directory, file), join(dir, file));
    oldDir = dir;
    return dir;
  }

  afterEach(() => {
    for (const handle of handles.splice(0)) {
      try {
        handle.close();
      } catch {
        /* already closed */
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDb(): { handle: DbHandle; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-cache-migrate-"));
    dirs.push(dir);
    const file = join(dir, "upgrade.db");
    const handle = createDb({ file });
    handles.push(handle);
    return { handle, file };
  }

  it("ships the cache migration after the existing ones", () => {
    // Ordering is what makes an upgrade an upgrade; a file that sorts before
    // 0001 would be replayed against a schema it does not expect.
    expect(files).toContain("0004_search_cache.sql");
    const index = files.indexOf("0004_search_cache.sql");
    expect(index).toBe(files.length - 1);
    expect(oldFiles.length).toBe(index);
  });

  it("adds the cache tables to a pre-existing database and keeps its data", () => {
    const { handle } = tempDb();

    // 1. Bring the database up to the *previous* release only.
    const before = runMigrations(handle.sqlite, previousReleaseDir());
    expect(before.applied).toEqual(oldFiles);
    expect(
      handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_cache'")
        .get(),
    ).toBeUndefined();

    // 2. Write data through the old schema: an admin, a task and a setting.
    const now = new Date().toISOString();
    handle.sqlite
      .prepare(
        "INSERT INTO admin_users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run("adm_1", "old@example.com", "Old Admin", "hash", "admin", now);
    handle.sqlite
      .prepare(
        "INSERT INTO search_tasks (id, query, mode, status, providers_json, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run("task_old", "before the cache existed", "basic", "completed", "[]", now);
    handle.sqlite
      .prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)")
      .run("app", '{"instance":{"name":"Carried Over"}}', now);
    const usageBefore = handle.sqlite.pragma("user_version", { simple: true });

    // 3. Upgrade.
    const after = runMigrations(handle.sqlite, directory);
    expect(after.applied).toEqual(["0004_search_cache.sql"]);
    expect(after.unknownToBuild).toEqual([]);

    // 4. The new tables exist and the old rows are untouched.
    for (const table of ["search_cache", "search_cache_metrics", "search_cache_state"]) {
      expect(
        handle.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(table),
        `${table} must be created`,
      ).toBeDefined();
    }
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_users").get()).toEqual({ n: 1 });
    const task = handle.sqlite
      .prepare("SELECT query, status FROM search_tasks WHERE id = ?")
      .get("task_old") as { query: string; status: string };
    expect(task.query).toBe("before the cache existed");
    expect(task.status).toBe("completed");
    const setting = handle.sqlite
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get("app") as { value_json: string };
    expect(JSON.parse(setting.value_json).instance.name).toBe("Carried Over");

    // 5. `user_version` tracks the number of migrations, so the backup verifier
    //    and the updater both see the new schema.
    expect(handle.sqlite.pragma("user_version", { simple: true })).toBe(files.length);
    expect(Number(usageBefore)).toBe(oldFiles.length);
  });

  it("is a no-op on a database that already has it", () => {
    const { handle } = tempDb();
    runMigrations(handle.sqlite, directory);
    const again = runMigrations(handle.sqlite, directory);
    expect(again.applied).toEqual([]);
    // A second run must not drop or recreate: cached entries survive a restart.
    handle.sqlite
      .prepare(
        "INSERT INTO search_cache (cache_key, response_json, status, mode, created_at, expires_at, last_accessed_at, size_bytes) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("k1", "{}", "completed", "basic", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 2);
    runMigrations(handle.sqlite, directory);
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_cache").get()).toEqual({ n: 1 });
  });
});
