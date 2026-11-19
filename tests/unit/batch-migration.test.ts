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
