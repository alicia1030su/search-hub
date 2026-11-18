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

/**
 * Migration `0007` is additive: it must keep every row a v0.1.9 installation
 * already had, read the new columns as "not recorded" (not as a default value
 * that would look like evidence), and apply cleanly twice.
 */
describe("quality migration 0007", () => {
  const directory = resolveMigrationsDir();
  const files = listMigrations(directory);
  const beforeProvenance = files.filter((file) => file < "0007");
  const dirs: string[] = [];
  const handles: DbHandle[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function previousReleaseDir(): string {
    const dir = tempDir("search-hub-pre-provenance-");
    for (const file of beforeProvenance) copyFileSync(join(directory, file), join(dir, file));
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

  function columnNames(sqlite: DbHandle["sqlite"], table: string): string[] {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  it("keeps v0.1.9 rows and leaves the provenance columns unrecorded", () => {
    const file = join(tempDir("search-hub-provenance-upgrade-"), "upgrade.db");
    const oldHandle = createDb({ file });
    runMigrations(oldHandle.sqlite, previousReleaseDir());
    const now = new Date().toISOString();
    oldHandle.sqlite
      .prepare(
        "INSERT INTO quality_datasets (id, name, description, language, version, status, origin, judgments_complete, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("d1", "set", "", "en", 1, "frozen", "manual", 1, now, now);
    oldHandle.sqlite
      .prepare(
        "INSERT INTO quality_queries (id, dataset_id, query, category, language, intent, notes, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("q1", "d1", "query", "code", "en", "", "", now);
    oldHandle.sqlite
      .prepare(
        "INSERT INTO quality_runs (id, dataset_id, dataset_version, dataset_origin, name, notes, mode, fusion_strategy, fusion_json, limit_value, cutoff_value, engine_version, status, started_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("r1", "d1", 1, "manual", "", "", "offline", "rrf", "{}", 10, 10, "0.1.9", "completed", now, now);
    const queriesBefore = oldHandle.sqlite.prepare("SELECT COUNT(*) AS n FROM quality_queries").get() as { n: number };
    oldHandle.close();
    expect(queriesBefore.n).toBe(1);

    const handle = createDb({ file });
    handles.push(handle);
    const result = runMigrations(handle.sqlite, directory);
    expect(result.applied).toContain("0007_quality_provenance.sql");

    // The old row survived, and its secondary categories defaulted to `[]`
    // while the primary category is untouched.
    const query = handle.sqlite
      .prepare("SELECT category, extra_categories FROM quality_queries WHERE id = ?")
      .get("q1") as { category: string; extra_categories: string };
    expect(query.category).toBe("code");
    expect(query.extra_categories).toBe("[]");

    // The old run survived, and every provenance column reads as NOT recorded.
    const run = handle.sqlite
      .prepare(
        "SELECT provider_ids_json, provider_fingerprint, model_fingerprint, qrels_fingerprint, " +
          "per_provider_limit, request_timeout_ms, failure_reason, persisted_query_count, partial, status " +
          "FROM quality_runs WHERE id = ?",
      )
      .get("r1") as Record<string, unknown>;
    expect(run["status"]).toBe("completed");
    expect(run["provider_ids_json"]).toBeNull();
    expect(run["provider_fingerprint"]).toBeNull();
    expect(run["model_fingerprint"]).toBeNull();
    expect(run["qrels_fingerprint"]).toBeNull();
    expect(run["per_provider_limit"]).toBeNull();
    expect(run["request_timeout_ms"]).toBeNull();
    expect(run["failure_reason"]).toBeNull();
    // The two NOT NULL columns carry a real default rather than NULL.
    expect(run["persisted_query_count"]).toBe(0);
    expect(run["partial"]).toBe(0);
  });

  it("adds exactly the columns the service reads", () => {
    const file = join(tempDir("search-hub-provenance-columns-"), "columns.db");
    const handle = createDb({ file });
    handles.push(handle);
    runMigrations(handle.sqlite, directory);

    const queryColumns = columnNames(handle.sqlite, "quality_queries");
    expect(queryColumns).toContain("extra_categories");
    expect(queryColumns).toContain("category");

    const runColumns = columnNames(handle.sqlite, "quality_runs");
    for (const column of [
      "provider_ids_json",
      "provider_fingerprint",
      "model_fingerprint",
      "qrels_fingerprint",
      "per_provider_limit",
      "request_timeout_ms",
      "failure_reason",
      "persisted_query_count",
      "partial",
    ]) {
      expect(runColumns, `missing column ${column}`).toContain(column);
    }
  });

  it("is idempotent: a second run applies nothing and keeps the 0007 rows", () => {
    const file = join(tempDir("search-hub-provenance-idempotent-"), "idempotent.db");
    const handle = createDb({ file });
    handles.push(handle);
    const first = runMigrations(handle.sqlite, directory);
    expect(first.applied).toContain("0007_quality_provenance.sql");

    const now = new Date().toISOString();
    handle.sqlite
      .prepare(
        "INSERT INTO quality_datasets (id, name, description, language, version, status, origin, judgments_complete, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run("d1", "set", "", "en", 1, "frozen", "manual", 1, now, now);
    handle.sqlite
      .prepare(
        "INSERT INTO quality_queries (id, dataset_id, query, category, extra_categories, language, intent, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run("q1", "d1", "query", "general", '["code","english"]', "en", "", "", now);

    const second = runMigrations(handle.sqlite, directory);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toContain("0007_quality_provenance.sql");

    const query = handle.sqlite
      .prepare("SELECT extra_categories FROM quality_queries WHERE id = ?")
      .get("q1") as { extra_categories: string };
    expect(query.extra_categories).toBe('["code","english"]');
  });
});
