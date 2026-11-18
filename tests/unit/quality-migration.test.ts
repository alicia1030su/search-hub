/**
 * The quality tables arrive as migration `0006`.
 *
 * An installation that has been running since v0.1.7 must keep every row it
 * already had — search history, administrator accounts, provider keys, cache
 * entries — and must be able to apply the new migration twice without error.
 */
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

describe("quality migration 0006", () => {
  const directory = resolveMigrationsDir();
  const files = listMigrations(directory);
  const beforeQuality = files.filter((file) => file < "0006");
  const dirs: string[] = [];
  const handles: DbHandle[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function previousReleaseDir(): string {
    const dir = tempDir("search-hub-pre-quality-");
    for (const file of beforeQuality) copyFileSync(join(directory, file), join(dir, file));
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

  it("preserves existing rows and adds the quality tables", () => {
    // A database as the previous release left it.
    const file = join(tempDir("search-hub-quality-upgrade-"), "upgrade.db");
    const oldHandle = createDb({ file });
    runMigrations(oldHandle.sqlite, previousReleaseDir());
    oldHandle.sqlite
      .prepare("INSERT INTO admin_users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)")
      .run("u1", "admin@example.com", "Admin", "hash", "admin", new Date().toISOString());
    oldHandle.sqlite
      .prepare(
        "INSERT INTO search_tasks (id, query, mode, status, providers_json, request_json, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run("t1", "an earlier query", "basic", "completed", "[]", "{}", new Date().toISOString());
    const before = oldHandle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_tasks").get() as { n: number };
    expect(before.n).toBe(1);
    oldHandle.close();

    // The upgrade.
    const handle = createDb({ file });
    handles.push(handle);
    const result = runMigrations(handle.sqlite, directory);
    expect(result.applied).toContain("0006_search_quality.sql");

    const after = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_tasks").get() as { n: number };
    expect(after.n).toBe(1);
    const admin = handle.sqlite.prepare("SELECT email FROM admin_users").get() as { email: string };
    expect(admin.email).toBe("admin@example.com");

    for (const table of [
      "quality_datasets",
      "quality_queries",
      "quality_judgments",
      "quality_runs",
      "quality_snapshots",
      "quality_run_results",
    ]) {
      const row = handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { name: string } | undefined;
      expect(row?.name, `${table} was not created`).toBe(table);
    }
  });

  it("is idempotent: a second run applies nothing", () => {
    const file = join(tempDir("search-hub-quality-idempotent-"), "upgrade.db");
    const handle = createDb({ file });
    handles.push(handle);
    const first = runMigrations(handle.sqlite, directory);
    expect(first.applied).toContain("0006_search_quality.sql");
    const second = runMigrations(handle.sqlite, directory);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toContain("0006_search_quality.sql");
  });

  it("cascades a dataset delete to its queries and judgments", () => {
    const file = join(tempDir("search-hub-quality-cascade-"), "cascade.db");
    const handle = createDb({ file });
    handles.push(handle);
    runMigrations(handle.sqlite, directory);
    const now = new Date().toISOString();

    handle.sqlite
      .prepare(
        "INSERT INTO quality_datasets (id, name, description, language, version, status, origin, judgments_complete, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("d1", "set", "", "en", 1, "frozen", "manual", 1, now, now);
    handle.sqlite
      .prepare(
        "INSERT INTO quality_queries (id, dataset_id, query, category, language, intent, notes, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("q1", "d1", "query", "general", "en", "", "", now);
    handle.sqlite
      .prepare(
        "INSERT INTO quality_judgments (id, dataset_id, query_id, document_id, relevance, assessor, source, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("j1", "d1", "q1", "https://a.fixture.test/1", 3, "admin", "human", "", now, now);

    handle.sqlite.prepare("DELETE FROM quality_datasets WHERE id = ?").run("d1");

    const queries = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM quality_queries").get() as { n: number };
    const judgments = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM quality_judgments").get() as { n: number };
    expect(queries.n).toBe(0);
    expect(judgments.n).toBe(0);
  });

  it("rejects a second judgment for the same document", () => {
    const file = join(tempDir("search-hub-quality-unique-"), "unique.db");
    const handle = createDb({ file });
    handles.push(handle);
    runMigrations(handle.sqlite, directory);
    const now = new Date().toISOString();
    handle.sqlite
      .prepare(
        "INSERT INTO quality_datasets (id, name, description, language, version, status, origin, judgments_complete, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("d1", "set", "", "en", 1, "draft", "manual", 0, now, now);
    handle.sqlite
      .prepare(
        "INSERT INTO quality_queries (id, dataset_id, query, category, language, intent, notes, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("q1", "d1", "query", "general", "en", "", "", now);
    const insert = handle.sqlite.prepare(
      "INSERT INTO quality_judgments (id, dataset_id, query_id, document_id, relevance, assessor, source, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    insert.run("j1", "d1", "q1", "https://a.fixture.test/1", 3, "admin", "human", "", now, now);
    expect(() =>
      insert.run("j2", "d1", "q1", "https://a.fixture.test/1", 1, "admin", "human", "", now, now),
    ).toThrow();
  });
});
