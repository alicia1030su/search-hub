import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchResponse } from "@search-hub/shared";
import { createDb, openDatabaseFile, resolveMigrationsDir, runMigrations, type DbHandle } from "@search-hub/db";
import { createBackupPackage, openBuiltInSqlite, restoreBackupPackage, restrictWindowsAcl, sealSnapshotDatabase } from "../../packages/backup/src/index.js";
import { CacheService } from "../../apps/api/src/services/cache.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const repoRoot = resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const handles: DbHandle[] = [];
const passphrase = "isolated restore acceptance passphrase 灾备";
const now = Date.parse("2026-02-03T04:05:06.000Z");

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function response(label: string): SearchResponse {
  return {
    taskId: `task-${label}`,
    query: label,
    mode: "basic",
    status: "completed",
    results: [{
      id: label,
      title: label,
      url: `https://example.com/${label}`,
      snippet: `cached ${label}`,
      source: "mock",
      provider: "mock",
      providerType: "mock",
      providerName: "Mock",
      retrievedAt: new Date(now).toISOString(),
      score: 1,
      sources: [{ providerId: "mock", providerName: "Mock", providerType: "mock", url: `https://example.com/${label}`, rank: 1 }],
    }],
    stats: {
      rawCount: 1,
      dedupedCount: 1,
      fusedCount: 1,
      providers: [{ providerId: "mock", providerName: "Mock", providerType: "mock", ok: true, attempts: 1, resultCount: 1, latencyMs: 1 }],
      rerankApplied: false,
      embeddingApplied: false,
      summaryApplied: false,
      partial: false,
      timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 },
    },
    errors: [],
    failedSources: [],
    debug: { rewrittenQueries: [] },
  };
}

function rows(path: string, table: string): unknown[] {
  const db = openDatabaseFile(path, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

describe("isolated complete-package restore", () => {
  it("R15/R16 preserves health/billing/budget and valid/expired cache state, metrics and totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-hub-restore-isolated-"));
    directories.push(root);
    const sourceDataDir = join(root, "source-data");
    const installDir = join(root, "install");
    mkdirSync(sourceDataDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    const sourceDbPath = join(sourceDataDir, "search-hub.db");
    const source = createDb({ file: sourceDbPath });
    handles.push(source);
    runMigrations(source.sqlite, resolveMigrationsDir());
    const timestamp = new Date(now).toISOString();
    const day = timestamp.slice(0, 10);
    source.sqlite.prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("prv_restore", "Restore fixture", "mock", timestamp, timestamp);
    source.sqlite.prepare(`INSERT INTO provider_health_checks
      (id, provider_id, key_id, kind, status, error_code, latency_ms, result_count, health_score, detail_json, trigger, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "health-restore", "prv_restore", null, "search", "ok", null, 17, 3, 91,
      JSON.stringify({ fixture: true }), "manual", timestamp,
    );
    source.sqlite.prepare(`INSERT INTO provider_health_billing
      (health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "health-restore", "search", day, "exact", "mock", 0, 1, timestamp,
    );
    source.sqlite.prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?, ?, ?, ?)")
      .run(day, "search", 7, timestamp);

    const cache = new CacheService({ db: source.db, logger, now: () => now, dbPath: sourceDbPath });
    expect(cache.put("valid", response("valid"), 3600, "basic").stored).toBe(true);
    expect(cache.put("expired", response("expired"), -1, "basic").stored).toBe(true);
    const metricsBefore = rows(sourceDbPath, "search_cache_metrics");
    const stateBefore = rows(sourceDbPath, "search_cache_state");
    const healthBefore = rows(sourceDbPath, "provider_health_checks");
    const billingBefore = rows(sourceDbPath, "provider_health_billing");
    const budgetBefore = rows(sourceDbPath, "health_probe_budget");
    const knownMigrations = source.sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all().map((row) => String((row as { name: string }).name));
    source.close();
    handles.splice(handles.indexOf(source), 1);
    sealSnapshotDatabase(sourceDbPath, openBuiltInSqlite);
    if (process.platform === "win32") await restrictWindowsAcl(sourceDbPath, false);
    else chmodSync(sourceDbPath, 0o600);

    const packagePath = join(root, "restore-fixture.shbackup");
    const appVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;
    await createBackupPackage({
      snapshotPath: sourceDbPath,
      masterKeyValue: randomBytes(32),
      outputPath: packagePath,
      passphrase,
      appVersion,
      migrations: knownMigrations,
      keySource: "file",
      creator: "cli",
      dataDir: sourceDataDir,
      installDir,
      openDatabase: openBuiltInSqlite,
    });

    const targetDir = join(root, "restored");
    const restored = await restoreBackupPackage({
      path: packagePath,
      targetDir,
      sourceDataDir,
      sourceInstallDir: installDir,
      passphrase,
      apply: true,
      openDatabase: openBuiltInSqlite,
    });
    expect(restored.applied).toBe(true);
    expect(restored.report.restoreReadiness).toBe(true);
    const restoredDbPath = join(targetDir, "search-hub.db");
    expect(rows(restoredDbPath, "provider_health_checks")).toEqual(healthBefore);
    expect(rows(restoredDbPath, "provider_health_billing")).toEqual(billingBefore);
    expect(rows(restoredDbPath, "health_probe_budget")).toEqual(budgetBefore);
    expect(rows(restoredDbPath, "search_cache_metrics")).toEqual(metricsBefore);
    expect(rows(restoredDbPath, "search_cache_state")).toEqual(stateBefore);

    const restoredHandle = createDb({ file: restoredDbPath });
    handles.push(restoredHandle);
    const restoredCache = new CacheService({ db: restoredHandle.db, logger, now: () => now, dbPath: restoredDbPath });
    expect(restoredCache.get("valid")?.response.query).toBe("valid");
    expect(restoredCache.get("expired")).toBeNull();
    const metricsAfter = rows(restoredDbPath, "search_cache_metrics") as Array<Record<string, unknown>>;
    const stateAfter = rows(restoredDbPath, "search_cache_state") as Array<Record<string, unknown>>;
    expect(metricsAfter.reduce((sum, row) => sum + Number(row.hits), 0)).toBeGreaterThan(0);
    expect(metricsAfter.reduce((sum, row) => sum + Number(row.misses), 0)).toBeGreaterThan(0);
    expect(rows(restoredDbPath, "search_cache").some((row) => (row as { cache_key: string }).cache_key === "expired")).toBe(false);
    const totals = stateAfter.find((row) => row.key === "cache:totals");
    expect(JSON.parse(String(totals?.value))).toMatchObject({ entries: 1 });
    expect(existsSync(join(targetDir, "master.key"))).toBe(true);
  });
});
