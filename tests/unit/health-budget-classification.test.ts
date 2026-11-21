import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  healthProbeBudget,
  providerHealthChecks,
  providerInstances,
  runMigrations,
  type DbHandle,
} from "@search-hub/db";
import {
  batchTestCreateSchema,
  batchTestPreviewQuerySchema,
  healthSettingsPatchSchema,
} from "@search-hub/shared";
import { loadConfig } from "../../apps/api/src/config.js";
import { ProbeBudget, type BudgetOptions } from "../../apps/api/src/services/health-budget.js";
import { DEFAULT_SETTINGS, SettingsService } from "../../apps/api/src/services/settings.js";

const DAY = "2026-11-20";
const NOON = `${DAY}T12:00:00.000Z`;
const handles: DbHandle[] = [];
const dirs: string[] = [];

function openDb(file = ":memory:"): DbHandle {
  const handle = createDb({ file });
  handles.push(handle);
  runMigrations(handle.sqlite);
  return handle;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function addProvider(handle: DbHandle, id = "provider-1", type = "generic-http"): void {
  handle.db.insert(providerInstances).values({
    id,
    name: id,
    type,
    createdAt: NOON,
    updatedAt: NOON,
  }).run();
}

function addCheck(
  handle: DbHandle,
  id: string,
  kind: "connect" | "search",
  checkedAt = NOON,
  providerId = "provider-1",
): void {
  handle.db.insert(providerHealthChecks).values({
    id,
    providerId,
    kind,
    status: "healthy",
    detailJson: '{"cause":"ok"}',
    trigger: "manual",
    checkedAt,
  }).run();
}

function limits(patch: Partial<BudgetOptions> = {}): BudgetOptions {
  return {
    paidProbesEnabled: true,
    maxPerRun: 3,
    maxPerDay: 20,
    anonymousMaxPerRun: 2,
    anonymousMaxPerDay: 4,
    ...patch,
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

describe("health budget billing classification", () => {
  it("H55 seeds paid and anonymous buckets from billing class, not the current provider type", () => {
    const handle = openDb();
    addProvider(handle);
    addCheck(handle, "legacy-paid", "search");
    addCheck(handle, "exact-anonymous", "search");
    addCheck(handle, "exact-paid", "search");
    addCheck(handle, "exact-connect", "connect");

    handle.sqlite
      .prepare(
        "INSERT INTO provider_health_billing (health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent, created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("legacy-paid", "search", DAY, "legacy_conservative", null, 0, 1, NOON);

    const ledger = new ProbeBudget(handle.db, () => Date.parse(NOON));
    ledger.recordBilling({
      healthCheckId: "exact-anonymous",
      kind: "search_anonymous",
      budgetDay: DAY,
      classification: "exact",
      providerType: "generic-http",
      credentialUsed: false,
      spent: true,
    });
    ledger.recordBilling({
      healthCheckId: "exact-paid",
      kind: "search",
      budgetDay: DAY,
      classification: "exact",
      providerType: "brave",
      credentialUsed: true,
      spent: true,
    });
    ledger.recordBilling({
      healthCheckId: "exact-connect",
      kind: "connect",
      budgetDay: DAY,
      classification: "exact",
      providerType: "generic-http",
      credentialUsed: false,
      spent: true,
    });

    // Re-typing the source after the probes must not rewrite their billing class.
    handle.db.update(providerInstances).set({ type: "brave" }).run();
    const snapshot = ledger.snapshot(limits());
    expect(snapshot.searchUsedToday).toBe(2);
    expect(snapshot.anonymousSearchUsedToday).toBe(1);
    expect(snapshot.connectUsedToday).toBe(1);
    expect(snapshot.remainingToday).toBe(18);
    expect(snapshot.anonymousRemainingToday).toBe(3);
  });

  it("H56 caps anonymous searches by their own day budget even when paid probes are disabled", () => {
    const handle = openDb();
    const ledger = new ProbeBudget(handle.db, () => Date.parse(NOON));
    const options = limits({ paidProbesEnabled: false, anonymousMaxPerRun: 2, anonymousMaxPerDay: 3 });

    const snapshot = ledger.snapshot(options);
    expect(snapshot.anonymousMaxPerRun).toBe(2);
    expect(snapshot.anonymousMaxPerDay).toBe(3);
    expect(snapshot.anonymousRemainingToday).toBe(3);

    const outcomes = Array.from({ length: 10 }, () => ledger.reserve({ kind: "search_anonymous", ...options }));
    expect(outcomes.filter((item) => item.ok)).toHaveLength(3);
    expect(outcomes.filter((item) => !item.ok && item.reason === "day_limit")).toHaveLength(7);
    expect(ledger.snapshot(options).anonymousSearchUsedToday).toBe(3);
    expect(ledger.snapshot(options).anonymousRemainingToday).toBe(0);
    expect(ledger.snapshot(options).searchUsedToday).toBe(0);
    expect(ledger.reserve({ kind: "search", ...options })).toMatchObject({
      ok: false,
      reason: "paid_disabled",
    });
  });

  it("inherits paid limits when anonymous limits are omitted but keeps the bucket independent", () => {
    const handle = openDb();
    const ledger = new ProbeBudget(handle.db, () => Date.parse(NOON));
    const options: BudgetOptions = { paidProbesEnabled: true, maxPerRun: 2, maxPerDay: 2 };
    expect(ledger.snapshot(options)).toMatchObject({
      anonymousMaxPerRun: 2,
      anonymousMaxPerDay: 2,
      anonymousRemainingToday: 2,
    });
    expect(ledger.reserve({ kind: "search", ...options }).ok).toBe(true);
    expect(ledger.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    expect(ledger.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    expect(ledger.reserve({ kind: "search_anonymous", ...options })).toMatchObject({
      ok: false,
      reason: "day_limit",
    });
    expect(ledger.snapshot(options)).toMatchObject({
      searchUsedToday: 1,
      anonymousSearchUsedToday: 2,
      remainingToday: 1,
      anonymousRemainingToday: 0,
    });
  });

  it("keeps connectivity probes counted but uncapped when both search budgets are exhausted", () => {
    const handle = openDb();
    const ledger = new ProbeBudget(handle.db, () => Date.parse(NOON));
    const options = limits({ maxPerDay: 1, anonymousMaxPerDay: 1 });
    expect(ledger.reserve({ kind: "search", ...options }).ok).toBe(true);
    expect(ledger.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    const outcomes = Array.from({ length: 25 }, () => ledger.reserve({ kind: "connect", ...options }));
    expect(outcomes.every((item) => item.ok)).toBe(true);
    expect(ledger.snapshot(options).connectUsedToday).toBe(25);
  });

  it("H57 concurrent anonymous reservations cannot overshoot their independent cap", () => {
    const handle = openDb();
    const ledger = new ProbeBudget(handle.db, () => Date.parse(NOON));
    const options = limits({ maxPerDay: 50, anonymousMaxPerDay: 4 });
    const outcomes = Array.from({ length: 40 }, () => ledger.reserve({ kind: "search_anonymous", ...options }));

    expect(outcomes.filter((item) => item.ok)).toHaveLength(4);
    expect(ledger.snapshot(options).anonymousSearchUsedToday).toBe(4);
    expect(ledger.snapshot(options).remainingToday).toBe(50);
  });

  it("H58 reopening the database does not reset either search bucket", () => {
    const dir = tempDir("search-hub-budget-restart-");
    const file = join(dir, "budget.db");
    const first = openDb(file);
    const options = limits({ maxPerDay: 5, anonymousMaxPerDay: 2 });
    const beforeRestart = new ProbeBudget(first.db, () => Date.parse(NOON));
    expect(beforeRestart.reserve({ kind: "search", ...options }).ok).toBe(true);
    expect(beforeRestart.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    expect(beforeRestart.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    first.close();

    const reopened = openDb(file);
    const afterRestart = new ProbeBudget(reopened.db, () => Date.parse(NOON));
    expect(afterRestart.snapshot(options)).toMatchObject({
      searchUsedToday: 1,
      anonymousSearchUsedToday: 2,
      remainingToday: 4,
      anonymousRemainingToday: 0,
    });
    expect(afterRestart.reserve({ kind: "search_anonymous", ...options })).toMatchObject({
      ok: false,
      reason: "day_limit",
    });
    expect(afterRestart.reserve({ kind: "search", ...options }).ok).toBe(true);
  });

  it("H59 switches both buckets at UTC midnight, not local midnight", () => {
    const handle = openDb();
    const clock = { now: Date.parse(`${DAY}T23:59:59.999Z`) };
    const ledger = new ProbeBudget(handle.db, () => clock.now);
    const options = limits({ maxPerDay: 5, anonymousMaxPerDay: 2 });
    expect(ledger.reserve({ kind: "search", ...options }).ok).toBe(true);
    expect(ledger.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);

    clock.now += 1;
    expect(ledger.snapshot(options)).toMatchObject({
      day: "2026-11-21",
      searchUsedToday: 0,
      anonymousSearchUsedToday: 0,
      remainingToday: 5,
      anonymousRemainingToday: 2,
    });
    expect(ledger.reserve({ kind: "search", ...options }).ok).toBe(true);
    expect(ledger.reserve({ kind: "search_anonymous", ...options }).ok).toBe(true);
    expect(handle.db.select().from(healthProbeBudget).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ day: DAY, kind: "search", used: 1 }),
        expect.objectContaining({ day: DAY, kind: "search_anonymous", used: 1 }),
        expect.objectContaining({ day: "2026-11-21", kind: "search", used: 1 }),
        expect.objectContaining({ day: "2026-11-21", kind: "search_anonymous", used: 1 }),
      ]),
    );
  });

  it("H63 refunds on the reservation day across midnight and seeds by budgetDay, not checkedAt", () => {
    const handle = openDb();
    addProvider(handle);
    const clock = { now: Date.parse(`${DAY}T23:59:59.999Z`) };
    const ledger = new ProbeBudget(handle.db, () => clock.now);
    const options = limits();
    expect(ledger.reserve({ kind: "search", ...options }).ok).toBe(true);

    clock.now = Date.parse("2026-11-21T00:00:01.000Z");
    ledger.release("search", DAY);
    expect(
      handle.sqlite.prepare("SELECT used FROM health_probe_budget WHERE day=? AND kind=?").get(DAY, "search"),
    ).toEqual({ used: 0 });
    expect(
      handle.sqlite.prepare("SELECT used FROM health_probe_budget WHERE day=? AND kind=?").get("2026-11-21", "search"),
    ).toBeUndefined();

    // The health row finished on the new day, but the budget belongs to the day
    // the slot was reserved. Simulate a missing ledger row so restart seeding
    // must use the persisted budgetDay rather than checkedAt.
    handle.sqlite.prepare("DELETE FROM health_probe_budget WHERE day=? AND kind=?").run(DAY, "search");
    addCheck(handle, "cross-midnight", "search", "2026-11-21T00:00:01.000Z");
    ledger.recordBilling({
      healthCheckId: "cross-midnight",
      kind: "search",
      budgetDay: DAY,
      classification: "exact",
      providerType: "brave",
      credentialUsed: true,
      spent: true,
    });
    clock.now = Date.parse(NOON);
    expect(ledger.snapshot(options).searchUsedToday).toBe(1);
    clock.now = Date.parse("2026-11-21T00:00:01.000Z");
    expect(ledger.snapshot(options).searchUsedToday).toBe(0);
  });

  it("H61 excludes non-spending observations from both buckets, including after a restart", () => {
    const dir = tempDir("search-hub-billing-zero-");
    const file = join(dir, "budget.db");
    const first = openDb(file);
    addProvider(first);
    for (const id of ["zero-anonymous", "spent-anonymous", "zero-paid", "spent-paid"]) {
      addCheck(first, id, "search");
    }
    const beforeRestart = new ProbeBudget(first.db, () => Date.parse(NOON));
    beforeRestart.recordBilling({
      healthCheckId: "zero-anonymous",
      kind: "search_anonymous",
      budgetDay: DAY,
      classification: "exact",
      providerType: "generic-http",
      credentialUsed: false,
      spent: false,
    });
    beforeRestart.recordBilling({
      healthCheckId: "spent-anonymous",
      kind: "search_anonymous",
      budgetDay: DAY,
      classification: "exact",
      providerType: "generic-http",
      credentialUsed: false,
      spent: true,
    });
    beforeRestart.recordBilling({
      healthCheckId: "zero-paid",
      kind: "search",
      budgetDay: DAY,
      classification: "exact",
      providerType: "brave",
      credentialUsed: true,
      spent: false,
    });
    beforeRestart.recordBilling({
      healthCheckId: "spent-paid",
      kind: "search",
      budgetDay: DAY,
      classification: "exact",
      providerType: "brave",
      credentialUsed: true,
      spent: true,
    });
    expect(beforeRestart.snapshot(limits())).toMatchObject({
      searchUsedToday: 1,
      anonymousSearchUsedToday: 1,
      connectUsedToday: 0,
    });
    first.close();

    const reopened = openDb(file);
    const afterRestart = new ProbeBudget(reopened.db, () => Date.parse(NOON));
    expect(afterRestart.snapshot(limits())).toMatchObject({
      searchUsedToday: 1,
      anonymousSearchUsedToday: 1,
      remainingToday: 19,
      anonymousRemainingToday: 3,
    });
    expect(
      reopened.sqlite.prepare("SELECT health_check_id, spent FROM provider_health_billing ORDER BY health_check_id").all(),
    ).toEqual([
      { health_check_id: "spent-anonymous", spent: 1 },
      { health_check_id: "spent-paid", spent: 1 },
      { health_check_id: "zero-anonymous", spent: 0 },
      { health_check_id: "zero-paid", spent: 0 },
    ]);
  });

  it("recordBilling persists exact generic-http classification and is idempotent per health check", () => {
    const handle = openDb();
    addProvider(handle);
    addCheck(handle, "generic-anonymous", "search");
    addCheck(handle, "generic-paid", "search");
    const ledger = new ProbeBudget(handle.db, () => Date.parse(NOON));

    ledger.recordBilling({
      healthCheckId: "generic-anonymous",
      kind: "search_anonymous",
      budgetDay: DAY,
      classification: "exact",
      providerType: "generic-http",
      credentialUsed: false,
      spent: true,
    });
    ledger.recordBilling({
      healthCheckId: "generic-anonymous",
      kind: "search",
      budgetDay: DAY,
      classification: "exact",
      providerType: "changed-after-the-fact",
      credentialUsed: true,
      spent: true,
    });
    ledger.recordBilling({
      healthCheckId: "generic-paid",
      kind: "search",
      budgetDay: DAY,
      classification: "exact",
      providerType: "generic-http",
      credentialUsed: true,
      spent: true,
    });

    const rows = handle.sqlite
      .prepare("SELECT health_check_id, budget_kind, budget_day, classification, provider_type_snapshot, credential_used, spent, created_at FROM provider_health_billing ORDER BY health_check_id")
      .all();
    expect(rows).toEqual([
      {
        health_check_id: "generic-anonymous",
        budget_kind: "search_anonymous",
        budget_day: DAY,
        classification: "exact",
        provider_type_snapshot: "generic-http",
        credential_used: 0,
        spent: 1,
        created_at: NOON,
      },
      {
        health_check_id: "generic-paid",
        budget_kind: "search",
        budget_day: DAY,
        classification: "exact",
        provider_type_snapshot: "generic-http",
        credential_used: 1,
        spent: 1,
        created_at: NOON,
      },
    ]);
    expect(ledger.snapshot(limits())).toMatchObject({
      searchUsedToday: 1,
      anonymousSearchUsedToday: 1,
    });
  });
});

describe("batch keyless policy schema", () => {
  it("defaults includeKeyless to false for create and preview requests", () => {
    expect(batchTestCreateSchema.parse({})).toMatchObject({ kind: "search", includeKeyless: false });
    expect(batchTestCreateSchema.parse({ includeKeyless: true })).toMatchObject({ includeKeyless: true });
    expect(batchTestPreviewQuerySchema.parse({})).toMatchObject({ kind: "search", includeKeyless: false });
  });

  it("parses preview true/false strings and rejects other values", () => {
    expect(batchTestPreviewQuerySchema.parse({ includeKeyless: "true" })).toMatchObject({ includeKeyless: true });
    expect(batchTestPreviewQuerySchema.parse({ includeKeyless: "false" })).toMatchObject({ includeKeyless: false });
    expect(batchTestPreviewQuerySchema.safeParse({ includeKeyless: "yes" }).success).toBe(false);
  });
});

describe("health budget settings", () => {
  it("defaults includeUnverified off and gives anonymous probes an independent 3/20 budget", () => {
    expect(DEFAULT_SETTINGS.health.includeUnverified).toBe(false);
    expect(DEFAULT_SETTINGS.health.anonymousMaxRequestsPerRun).toBe(3);
    expect(DEFAULT_SETTINGS.health.anonymousMaxRequestsPerDay).toBe(20);
  });

  it("validates anonymous limits and keeps both per-run limits at or below their day limits", () => {
    expect(healthSettingsPatchSchema.safeParse({ anonymousMaxRequestsPerRun: 0 }).success).toBe(false);
    expect(healthSettingsPatchSchema.safeParse({ anonymousMaxRequestsPerRun: 201 }).success).toBe(false);
    expect(healthSettingsPatchSchema.safeParse({ anonymousMaxRequestsPerDay: 0 }).success).toBe(false);
    expect(healthSettingsPatchSchema.safeParse({ anonymousMaxRequestsPerDay: 2001 }).success).toBe(false);

    const handle = openDb();
    const settings = new SettingsService(handle.db, loadConfig());
    const anonymous = settings.update({ health: { anonymousMaxRequestsPerRun: 10, anonymousMaxRequestsPerDay: 5 } });
    expect(anonymous.health.anonymousMaxRequestsPerRun).toBe(5);
    expect(anonymous.health.anonymousMaxRequestsPerDay).toBe(5);

    const paid = settings.update({ health: { maxRequestsPerRun: 10, maxRequestsPerDay: 4 } });
    expect(paid.health.maxRequestsPerRun).toBe(4);
    expect(paid.health.maxRequestsPerDay).toBe(4);
  });
});
