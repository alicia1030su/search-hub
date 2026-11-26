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

const directory = resolveMigrationsDir();
const files = listMigrations(directory);
const beforeConnectBudget = files.filter((file) => file < "0010_connect_request_budget.sql");
const dirs: string[] = [];
const handles: DbHandle[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function previousReleaseDir(): string {
  const dir = tempDir("search-hub-pre-connect-budget-");
  for (const file of beforeConnectBudget) copyFileSync(join(directory, file), join(dir, file));
  return dir;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("connect request budget migration 0010", () => {
  it("recomputes physical hops conservatively, archives the old ledger and preserves keys/history", () => {
    const file = join(tempDir("search-hub-connect-upgrade-"), "upgrade.db");
    const old = createDb({ file });
    handles.push(old);
    runMigrations(old.sqlite, previousReleaseDir());
    const now = "2026-11-21T12:00:00.000Z";
    old.sqlite.prepare(
      "INSERT INTO provider_instances (id, name, type, enabled, timeout_ms, max_concurrency, priority, weight, max_retries, results_per_page, rpm_limit, key_strategy, cooldown_ms, breaker_threshold, breaker_cooldown_ms, config_json, search_config_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("p1", "legacy", "brave", 1, 12000, 4, 100, 100, 1, 10, 60, "round_robin", 30000, 5, 60000, "{}", "{}", now, now);
    old.sqlite.prepare(
      "INSERT INTO api_keys (id, provider_id, label, key_ciphertext, key_iv, key_tag, key_version, key_hint, weight, enabled, status, request_count, success_count, failure_count, consecutive_failures, quota_used_today, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("k1", "p1", "legacy-key", "ciphertext-bytes", "iv-bytes", "tag-bytes", 1, "••••1234", 100, 1, "healthy", 7, 6, 1, 0, 2, now, now);
    const checks = [
      ["hc-3", '{"cause":"ok","requests":3}'],
      ["hc-1", '{"cause":"ok","requests":1}'],
      ["hc-null", '{"cause":"ok","requests":null}'],
      ["hc-negative", '{"cause":"ok","requests":-9}'],
      ["hc-invalid", '{"cause":"ok","requests":"not-a-number"}'],
      ["hc-bad-json", '{broken'],
    ] as const;
    for (const [id, detail] of checks) {
      old.sqlite.prepare(
        "INSERT INTO provider_health_checks (id, provider_id, kind, status, health_score, detail_json, trigger, checked_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, "p1", "connect", "healthy", 100, detail, "manual", now);
      old.sqlite.prepare(
        "INSERT INTO provider_health_billing (health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent, created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, "connect", "2026-11-21", "exact", "brave", 1, 1, now);
    }
    old.sqlite.prepare(
      "INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?)",
    ).run("2026-11-21", "connect", 2, now);
    const keysBefore = old.sqlite.prepare("SELECT * FROM api_keys ORDER BY id").all();
    const historyBefore = old.sqlite.prepare("SELECT * FROM provider_health_checks ORDER BY id").all();
    old.close();

    const upgraded = createDb({ file });
    handles.push(upgraded);
    const result = runMigrations(upgraded.sqlite);
    expect(result.applied).toContain("0010_connect_request_budget.sql");
    expect(result.applied).toContain("0011_diagnostic_redaction_markers.sql");
    expect(result.applied).toContain("0012_api_key_credential_revision.sql");
    expect(upgraded.sqlite.prepare("SELECT used FROM health_probe_budget WHERE day=? AND kind=?").get("2026-11-21", "connect")).toEqual({ used: 8 });
    expect(upgraded.sqlite.prepare("SELECT used FROM health_probe_budget_connect_legacy WHERE day=? AND kind=?").get("2026-11-21", "connect")).toEqual({ used: 2 });
    const keysAfter = upgraded.sqlite.prepare("SELECT * FROM api_keys ORDER BY id").all() as Array<Record<string, unknown>>;
    const historyAfter = upgraded.sqlite.prepare("SELECT * FROM provider_health_checks ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const key of keysAfter) {
      expect(key.last_error_sanitized).toBe(0);
      expect(key.credential_revision).toBe(0);
      delete key.last_error_sanitized;
      delete key.credential_revision;
    }
    for (const check of historyAfter) {
      expect(check.diagnostics_sanitized).toBe(0);
      delete check.diagnostics_sanitized;
    }
    expect(keysAfter).toEqual(keysBefore);
    expect(historyAfter).toEqual(historyBefore);
    expect(upgraded.sqlite.prepare("SELECT diagnostics_sanitized FROM search_tasks LIMIT 1").get()).toBeUndefined();
    for (const table of ["search_tasks", "search_events", "provider_test_batches"]) {
      const column = upgraded.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; dflt_value: string }>;
      expect(column.find((item) => item.name === "diagnostics_sanitized")?.dflt_value).toBe("0");
    }

    // The SQL itself is idempotent: a manual replay cannot lower or inflate it.
    upgraded.sqlite.exec(readFileSync(join(directory, "0010_connect_request_budget.sql"), "utf8"));
    expect(upgraded.sqlite.prepare("SELECT used FROM health_probe_budget WHERE day=? AND kind=?").get("2026-11-21", "connect")).toEqual({ used: 8 });
    expect(upgraded.sqlite.prepare("SELECT used FROM health_probe_budget_connect_legacy WHERE day=? AND kind=?").get("2026-11-21", "connect")).toEqual({ used: 2 });
  });
});
