/**
 * Migration `0008` introduces the bulk-test ledger.
 *
 * Three properties matter and are asserted here rather than through the API:
 *
 *  1. **Additive.** A v0.1.9 installation keeps every existing health row; the
 *     new `batch_id` column reads as `NULL` on those rows, which means "this
 *     probe was not part of a bulk run" — not "unknown run".
 *  2. **Idempotent.** Applying 0008 twice is a no-op.
 *  3. **Complete.** Every column the service writes exists with the declared
 *     default, so a runner can insert a row without naming all of them.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("provider test batch migration 0008", () => {
  const directory = resolveMigrationsDir();
  const files = listMigrations(directory);
  const beforeBatches = files.filter((file) => file < "0008");
  const dirs: string[] = [];
  const handles: DbHandle[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function previousReleaseDir(): string {
    const dir = tempDir("search-hub-pre-batches-");
    for (const file of beforeBatches) copyFileSync(join(directory, file), join(dir, file));
    return dir;
  }

  function columnNames(sqlite: DbHandle["sqlite"], table: string): Array<{ name: string; notnull: number }> {
    return sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
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

  it("keeps v0.1.9 health rows and leaves batch_id NULL on them", () => {
    const file = join(tempDir("search-hub-batch-upgrade-"), "upgrade.db");
    const oldHandle = createDb({ file });
    handles.push(oldHandle);
    runMigrations(oldHandle.sqlite, previousReleaseDir());
    const now = new Date().toISOString();
    // `provider_health_checks.provider_id` is a foreign key, so the provider
    // must exist before a historical probe row can be written.
    oldHandle.sqlite
      .prepare(
        "INSERT INTO provider_instances (id, name, type, enabled, timeout_ms, max_concurrency, priority, weight, max_retries, results_per_page, rpm_limit, key_strategy, cooldown_ms, breaker_threshold, breaker_cooldown_ms, config_json, search_config_json, created_at, updated_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("p1", "legacy-brave", "brave", 1, 12000, 4, 100, 100, 1, 10, 60, "round_robin", 30000, 5, 60000, "{}", "{}", now, now);
    oldHandle.sqlite
      .prepare(
        "INSERT INTO provider_health_checks (id, provider_id, key_id, kind, status, error_code, latency_ms, result_count, health_score, detail_json, trigger, checked_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("hc1", "p1", null, "search", "healthy", null, 120, 3, 100, '{"cause":"ok"}', "manual", now);
    const before = oldHandle.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_checks").get() as { n: number };
    expect(before.n).toBe(1);
    oldHandle.close();

    const handle = createDb({ file });
    handles.push(handle);
    const result = runMigrations(handle.sqlite, directory);
    expect(result.applied).toContain("0008_provider_test_batches.sql");

    const after = handle.sqlite
      .prepare("SELECT id, status, batch_id, detail_json FROM provider_health_checks")
      .get() as { id: string; status: string; batch_id: string | null; detail_json: string };
    expect(after.id).toBe("hc1");
    expect(after.status).toBe("healthy");
    // Not part of any bulk run — an empty value, not an invented run id.
    expect(after.batch_id).toBeNull();
    expect(after.detail_json).toBe('{"cause":"ok"}');
  });

  it("creates the batch ledger with the defaults the runner relies on", () => {
    const file = join(tempDir("search-hub-batch-defaults-"), "defaults.db");
    const handle = createDb({ file });
    handles.push(handle);
    runMigrations(handle.sqlite, directory);

    const columns = columnNames(handle.sqlite, "provider_test_batches").map((row) => row.name);
    for (const column of [
      "id",
      "kind",
      "status",
      "total",
      "done",
      "ok_count",
      "failed_count",
      "pending_count",
      "skipped_count",
      "concurrency",
      "options_json",
      "items_json",
      "budget_json",
      "created_by",
      "created_at",
      "started_at",
      "finished_at",
    ]) {
      expect(columns, `missing column ${column}`).toContain(column);
    }

    // A row inserted with only the required fields must read back as "empty run",
    // so a half-written runner cannot produce NULL counters.
    handle.sqlite
      .prepare("INSERT INTO provider_test_batches (id, created_at) VALUES (?, ?)")
      .run("b1", new Date().toISOString());
    const row = handle.sqlite
      .prepare("SELECT * FROM provider_test_batches WHERE id = ?")
      .get("b1") as Record<string, unknown>;
    expect(row["kind"]).toBe("search");
    expect(row["status"]).toBe("running");
    expect(row["total"]).toBe(0);
    expect(row["done"]).toBe(0);
    expect(row["concurrency"]).toBe(2);
    expect(row["items_json"]).toBe("[]");
    expect(row["budget_json"]).toBe("{}");
    expect(row["finished_at"]).toBeNull();
  });

  it("indexes batch_id so a per-run read does not scan the probe log", () => {
    const file = join(tempDir("search-hub-batch-index-"), "index.db");
    const handle = createDb({ file });
    handles.push(handle);
    runMigrations(handle.sqlite, directory);
    const indexes = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all("provider_health_checks") as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("idx_health_batch");

    const batchIndexes = handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all("provider_test_batches") as Array<{ name: string }>;
    expect(batchIndexes.map((row) => row.name)).toContain("idx_test_batches_status");
  });

  it("is idempotent: a second run applies nothing", () => {
    const file = join(tempDir("search-hub-batch-idempotent-"), "idempotent.db");
    const handle = createDb({ file });
    handles.push(handle);
    const first = runMigrations(handle.sqlite, directory);
    expect(first.applied).toContain("0008_provider_test_batches.sql");
    const second = runMigrations(handle.sqlite, directory);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toContain("0008_provider_test_batches.sql");
  });
});

describe("provider health billing migration 0009", () => {
  const directory = resolveMigrationsDir();
  const handles: DbHandle[] = [];
  const dirs: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
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

  it("archives legacy buckets, recomputes once, and preserves reservations made after migration", () => {
    const file = join(tempDir("search-hub-billing-migration-"), "billing.db");
    const handle = createDb({ file });
    handles.push(handle);
    runMigrations(handle.sqlite, directory);
    const now = "2026-11-20T12:00:00.000Z";
    handle.sqlite
      .prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run("p1", "legacy", "brave", now, now);
    const insertCheck = handle.sqlite.prepare(
      "INSERT INTO provider_health_checks (id, provider_id, kind, status, health_score, detail_json, trigger, checked_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insertCheck.run("hc-legacy", "p1", "search", "healthy", 100, "{}", "manual", now);
    insertCheck.run("hc-exact", "p1", "search", "healthy", 100, "{}", "manual", now);
    const insertBudget = handle.sqlite.prepare(
      "INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?)",
    );
    insertBudget.run("2026-11-20", "search", 4, now);
    insertBudget.run("2026-11-20", "search_anonymous", 9, now);
    insertBudget.run("2026-11-20", "connect", 2, now);
    const legacyRows = handle.sqlite.prepare("SELECT * FROM health_probe_budget ORDER BY kind").all();

    const columns = (handle.sqlite.prepare("PRAGMA table_info(provider_health_billing)").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(columns).toEqual([
      "health_check_id",
      "budget_kind",
      "budget_day",
      "classification",
      "provider_type_snapshot",
      "credential_used",
      "spent",
      "created_at",
    ]);

    const sql = readFileSync(join(directory, "0009_provider_health_billing.sql"), "utf8");
    // Simulate the first migration before its one-shot marker is written.
    handle.sqlite.prepare("DELETE FROM provider_health_billing_migration WHERE id=1").run();
    handle.sqlite.exec(sql);
    handle.sqlite.exec(sql);
    expect(handle.sqlite.prepare("SELECT * FROM health_probe_budget_legacy ORDER BY kind").all()).toEqual(legacyRows);
    expect(handle.sqlite.prepare("SELECT id FROM provider_health_billing_migration").all()).toEqual([{ id: 1 }]);
    expect(handle.sqlite.prepare("SELECT kind, used FROM health_probe_budget ORDER BY kind").all()).toEqual([
      { kind: "connect", used: 2 },
      { kind: "search", used: 4 },
      { kind: "search_anonymous", used: 0 },
    ]);
    let rows = handle.sqlite
      .prepare("SELECT health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent FROM provider_health_billing ORDER BY health_check_id")
      .all();
    expect(rows).toEqual([
      { health_check_id: "hc-exact", budget_kind: "search", budget_day: "2026-11-20", classification: "legacy_conservative", provider_type_snapshot: null, credential_used: 0, spent: 1 },
      { health_check_id: "hc-legacy", budget_kind: "search", budget_day: "2026-11-20", classification: "legacy_conservative", provider_type_snapshot: null, credential_used: 0, spent: 1 },
    ]);

    // A partially migrated database may already know an exact anonymous row.
    // With no marker, the one-shot recompute must use it instead of the polluted
    // legacy anonymous counter, while preserving the larger paid counter.
    handle.sqlite
      .prepare("UPDATE provider_health_billing SET budget_kind=?, classification=?, provider_type_snapshot=?, credential_used=? WHERE health_check_id=?")
      .run("search_anonymous", "exact", "generic-http", 0, "hc-exact");
    handle.sqlite.prepare("DELETE FROM provider_health_billing_migration WHERE id=1").run();
    handle.sqlite.exec(sql);
    expect(handle.sqlite.prepare("SELECT kind, used FROM health_probe_budget ORDER BY kind").all()).toEqual([
      { kind: "connect", used: 2 },
      { kind: "search", used: 4 },
      { kind: "search_anonymous", used: 1 },
    ]);
    expect(handle.sqlite.prepare("SELECT * FROM health_probe_budget_legacy ORDER BY kind").all()).toEqual(legacyRows);

    // Once marked, later reservations are authoritative and repeated SQL cannot
    // clear or replace them.
    handle.sqlite.prepare("UPDATE health_probe_budget SET used=2 WHERE kind='search_anonymous'").run();
    handle.sqlite.exec(sql);
    rows = handle.sqlite
      .prepare("SELECT health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent FROM provider_health_billing ORDER BY health_check_id")
      .all();
    expect(rows).toEqual([
      { health_check_id: "hc-exact", budget_kind: "search_anonymous", budget_day: "2026-11-20", classification: "exact", provider_type_snapshot: "generic-http", credential_used: 0, spent: 1 },
      { health_check_id: "hc-legacy", budget_kind: "search", budget_day: "2026-11-20", classification: "legacy_conservative", provider_type_snapshot: null, credential_used: 0, spent: 1 },
    ]);
    expect(handle.sqlite.prepare("SELECT used FROM health_probe_budget WHERE kind='search_anonymous'").get()).toEqual({ used: 2 });
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_checks").get()).toEqual({ n: 2 });
    expect(handle.sqlite.prepare("SELECT * FROM health_probe_budget_legacy ORDER BY kind").all()).toEqual(legacyRows);
  });
});
