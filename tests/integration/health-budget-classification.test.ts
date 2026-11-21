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
import { ProbeBudget, type BudgetOptions } from "../../apps/api/src/services/health-budget.js";

const DAY = "2026-11-20";
const TODAY = `${DAY}T12:00:00.000Z`;
const YESTERDAY = "2026-11-19";
const handles: DbHandle[] = [];
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function track(handle: DbHandle): DbHandle {
  handles.push(handle);
  return handle;
}

function previousReleaseDir(): string {
  const directory = resolveMigrationsDir();
  const dir = tempDir("search-hub-v0110-billing-");
  for (const file of listMigrations(directory).filter((name) => name < "0009")) {
    copyFileSync(join(directory, file), join(dir, file));
  }
  return dir;
}

function addProvider(handle: DbHandle, id: string, type: string): void {
  handle.sqlite
    .prepare(
      "INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?,?,?,?,?)",
    )
    .run(id, id, type, TODAY, TODAY);
}

function addCheck(
  handle: DbHandle,
  id: string,
  providerId: string,
  kind: "connect" | "search",
  checkedAt: string,
  keyId: string | null = null,
): void {
  handle.sqlite
    .prepare(
      "INSERT INTO provider_health_checks (id, provider_id, key_id, kind, status, health_score, detail_json, trigger, checked_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(id, providerId, keyId, kind, "healthy", 100, '{"cause":"ok","message":"kept"}', "manual", checkedAt);
}

function billingRows(handle: DbHandle): Array<Record<string, unknown>> {
  return handle.sqlite
    .prepare(
      "SELECT health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent, created_at FROM provider_health_billing ORDER BY health_check_id",
    )
    .all() as Array<Record<string, unknown>>;
}

function budgetOptions(): BudgetOptions {
  return {
    paidProbesEnabled: true,
    maxPerRun: 3,
    maxPerDay: 20,
    anonymousMaxPerRun: 3,
    anonymousMaxPerDay: 20,
  };
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

describe("v0.1.10 to v0.1.11 health billing upgrade", () => {
  it("H60 preserves mixed history, charges legacy searches conservatively, and counts only exact anonymous rows", () => {
    const dir = tempDir("search-hub-v0110-upgrade-");
    const file = join(dir, "search-hub.db");
    const old = track(createDb({ file }));
    runMigrations(old.sqlite, previousReleaseDir());
    addProvider(old, "paid-provider", "brave");
    addProvider(old, "anonymous-provider", "hackernews");
    addCheck(old, "old-paid", "paid-provider", "search", TODAY);
    // A key id is not proof of billing class: the anonymous source has a
    // historical key id while the paid source has none, and both must remain
    // conservatively paid until an exact classification says otherwise.
    addCheck(old, "old-anonymous", "anonymous-provider", "search", TODAY, "legacy-key-id");
    addCheck(old, "old-connect", "anonymous-provider", "connect", TODAY);
    addCheck(old, "yesterday-paid", "paid-provider", "search", `${YESTERDAY}T12:00:00.000Z`);
    addCheck(old, "yesterday-connect", "anonymous-provider", "connect", `${YESTERDAY}T12:00:00.000Z`);
    old.sqlite
      .prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?)")
      .run(YESTERDAY, "search", 7, `${YESTERDAY}T23:00:00.000Z`);
    old.sqlite
      .prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?)")
      .run(YESTERDAY, "search_anonymous", 9, `${YESTERDAY}T23:00:00.000Z`);
    old.sqlite
      .prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?)")
      .run(YESTERDAY, "connect", 0, `${YESTERDAY}T23:00:00.000Z`);
    const historyBefore = old.sqlite.prepare("SELECT * FROM provider_health_checks ORDER BY id").all();
    const budgetBefore = old.sqlite.prepare("SELECT * FROM health_probe_budget ORDER BY day, kind").all();
    old.close();

    const upgraded = track(createDb({ file }));
    const migration = runMigrations(upgraded.sqlite);
    expect(migration.applied).toContain("0009_provider_health_billing.sql");
    expect(upgraded.sqlite.prepare("SELECT * FROM provider_health_checks ORDER BY id").all()).toEqual(historyBefore);
    expect(upgraded.sqlite.prepare("SELECT * FROM health_probe_budget_legacy ORDER BY day, kind").all()).toEqual(budgetBefore);
    expect(
      upgraded.sqlite.prepare("SELECT * FROM health_probe_budget WHERE day=? ORDER BY kind").all(YESTERDAY),
    ).toEqual([
      { day: YESTERDAY, kind: "connect", used: 1, updated_at: expect.any(String) },
      { day: YESTERDAY, kind: "search", used: 7, updated_at: expect.any(String) },
      { day: YESTERDAY, kind: "search_anonymous", used: 0, updated_at: expect.any(String) },
    ]);
    expect(billingRows(upgraded)).toEqual([
      {
        health_check_id: "old-anonymous",
        budget_kind: "search",
        budget_day: DAY,
        classification: "legacy_conservative",
        provider_type_snapshot: null,
        credential_used: 0,
        spent: 1,
        created_at: TODAY,
      },
      {
        health_check_id: "old-connect",
        budget_kind: "connect",
        budget_day: DAY,
        classification: "exact",
        provider_type_snapshot: null,
        credential_used: 0,
        spent: 1,
        created_at: TODAY,
      },
      {
        health_check_id: "old-paid",
        budget_kind: "search",
        budget_day: DAY,
        classification: "legacy_conservative",
        provider_type_snapshot: null,
        credential_used: 0,
        spent: 1,
        created_at: TODAY,
      },
      {
        health_check_id: "yesterday-connect",
        budget_kind: "connect",
        budget_day: YESTERDAY,
        classification: "exact",
        provider_type_snapshot: null,
        credential_used: 0,
        spent: 1,
        created_at: `${YESTERDAY}T12:00:00.000Z`,
      },
      {
        health_check_id: "yesterday-paid",
        budget_kind: "search",
        budget_day: YESTERDAY,
        classification: "legacy_conservative",
        provider_type_snapshot: null,
        credential_used: 0,
        spent: 1,
        created_at: `${YESTERDAY}T12:00:00.000Z`,
      },
    ]);

    const ledger = new ProbeBudget(upgraded.db, () => Date.parse(TODAY));
    const options = budgetOptions();
    expect(ledger.snapshot(options)).toMatchObject({
      day: DAY,
      searchUsedToday: 2,
      anonymousSearchUsedToday: 0,
      connectUsedToday: 1,
      remainingToday: 18,
      anonymousRemainingToday: 20,
    });

    // New rows carry an exact class. The reservation is the spend; recordBilling
    // is the durable explanation attached after the health row is inserted.
    expect(ledger.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    addCheck(upgraded, "new-anonymous", "anonymous-provider", "search", TODAY);
    ledger.recordBilling({
      healthCheckId: "new-anonymous",
      kind: "search_anonymous",
      budgetDay: DAY,
      classification: "exact",
      providerType: "hackernews",
      credentialUsed: false,
      spent: true,
    });
    expect(ledger.snapshot(options)).toMatchObject({
      searchUsedToday: 2,
      anonymousSearchUsedToday: 1,
      anonymousRemainingToday: 19,
    });

    // Re-executing the SQL itself is idempotent and cannot downgrade an exact
    // classification to the legacy fallback.
    const sql = readFileSync(join(resolveMigrationsDir(), "0009_provider_health_billing.sql"), "utf8");
    upgraded.sqlite.exec(sql);
    upgraded.sqlite.exec(sql);
    expect(billingRows(upgraded).find((row) => row["health_check_id"] === "new-anonymous")).toMatchObject({
      budget_kind: "search_anonymous",
      classification: "exact",
      provider_type_snapshot: "hackernews",
    });
    const afterRepeat = billingRows(upgraded);
    const secondRun = runMigrations(upgraded.sqlite);
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped).toContain("0009_provider_health_billing.sql");
    expect(billingRows(upgraded)).toEqual(afterRepeat);
    expect(upgraded.sqlite.prepare("SELECT * FROM health_probe_budget_legacy ORDER BY day, kind").all()).toEqual(budgetBefore);
    expect(
      upgraded.sqlite.prepare("SELECT used FROM health_probe_budget WHERE day=? AND kind=?").get(YESTERDAY, "search_anonymous"),
    ).toEqual({ used: 0 });
  });

  it("H62 one-shot recompute counts only billing rows that actually spent", () => {
    const dir = tempDir("search-hub-v0110-zero-spend-");
    const file = join(dir, "search-hub.db");
    const old = track(createDb({ file }));
    runMigrations(old.sqlite, previousReleaseDir());
    addProvider(old, "zero-provider", "generic-http");
    old.close();

    const upgraded = track(createDb({ file }));
    runMigrations(upgraded.sqlite);
    addCheck(upgraded, "zero-request", "zero-provider", "search", TODAY);
    addCheck(upgraded, "real-request", "zero-provider", "search", TODAY);
    upgraded.sqlite
      .prepare(
        "INSERT INTO provider_health_billing (health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("zero-request", "search_anonymous", DAY, "exact", "generic-http", 0, 0, TODAY);
    upgraded.sqlite
      .prepare(
        "INSERT INTO provider_health_billing (health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("real-request", "search_anonymous", DAY, "exact", "generic-http", 0, 1, TODAY);
    upgraded.sqlite
      .prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?)")
      .run(DAY, "search_anonymous", 9, TODAY);

    // Re-run the one-shot SQL against a database containing both classes. The
    // marker is removed only to exercise the CTE itself, not normal migration.
    upgraded.sqlite.prepare("DELETE FROM provider_health_billing_migration").run();
    const sql = readFileSync(join(resolveMigrationsDir(), "0009_provider_health_billing.sql"), "utf8");
    upgraded.sqlite.exec(sql);
    expect(
      upgraded.sqlite.prepare("SELECT used FROM health_probe_budget WHERE day=? AND kind=?").get(DAY, "search_anonymous"),
    ).toEqual({ used: 1 });
  });

  it("archives polluted legacy buckets, recomputes anonymous exactly, and never lowers paid spend", () => {
    const dir = tempDir("search-hub-v0110-ledger-upgrade-");
    const file = join(dir, "search-hub.db");
    const old = track(createDb({ file }));
    runMigrations(old.sqlite, previousReleaseDir());
    addProvider(old, "legacy-provider", "brave");
    addCheck(old, "legacy-search", "legacy-provider", "search", TODAY);
    addCheck(old, "legacy-connect", "legacy-provider", "connect", TODAY);
    for (const [kind, used] of [["search", 6], ["search_anonymous", 11], ["connect", 2]] as const) {
      old.sqlite
        .prepare("INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?,?,?,?)")
        .run(DAY, kind, used, TODAY);
    }
    const before = old.sqlite.prepare("SELECT * FROM health_probe_budget ORDER BY kind").all();
    old.close();

    const upgraded = track(createDb({ file }));
    runMigrations(upgraded.sqlite);
    expect(upgraded.sqlite.prepare("SELECT * FROM health_probe_budget_legacy ORDER BY kind").all()).toEqual(before);
    expect(upgraded.sqlite.prepare("SELECT id FROM provider_health_billing_migration").all()).toEqual([{ id: 1 }]);
    const ledger = new ProbeBudget(upgraded.db, () => Date.parse(TODAY));
    const options = budgetOptions();
    expect(ledger.snapshot(options)).toMatchObject({
      searchUsedToday: 6,
      anonymousSearchUsedToday: 0,
      connectUsedToday: 2,
    });

    // A reservation made after the migration must survive repeated SQL.
    expect(ledger.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    const sql = readFileSync(join(resolveMigrationsDir(), "0009_provider_health_billing.sql"), "utf8");
    upgraded.sqlite.exec(sql);
    upgraded.sqlite.exec(sql);
    expect(ledger.snapshot(options)).toMatchObject({
      searchUsedToday: 6,
      anonymousSearchUsedToday: 1,
      connectUsedToday: 2,
    });
    expect(upgraded.sqlite.prepare("SELECT * FROM health_probe_budget_legacy ORDER BY kind").all()).toEqual(before);
  });
});
