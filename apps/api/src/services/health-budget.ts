import { and, eq, sql } from "drizzle-orm";
import type { SearchHubDb } from "@search-hub/db";
import { healthProbeBudget, providerHealthBilling } from "@search-hub/db";
import { decideBudget, type HealthProbeKind } from "./health-classify.js";

/**
 * Durable probe budget.
 *
 * The requirement is not "count probes" but "never let a background timer spend
 * more than the operator allowed, under any concurrency, across restarts". That
 * rules out a read-then-act counter the previous implementation used: two
 * concurrent paid probes both read `used=19`, both pass, both spend.
 *
 * The ledger is one row per UTC day per kind, mutated by a conditional UPDATE:
 *
 *     UPDATE ... SET used = used + 1 WHERE used < max
 *
 * A zero row-count means the reservation lost the race (or the day is full) and
 * nothing was spent. Free `connect` probes are counted in their own row so the
 * two kinds can be reported separately, but they are not capped by the paid
 * budget — capping connectivity checks would make the page unable to explain
 * why a source looks dead.
 */

/**
 * Ledger buckets.
 *
 * `search` is a real search made *with a credential*, so it can consume the
 * operator's account quota. `search_anonymous` is a real search against a
 * keyless public API: no credential is sent, so no account quota can be spent —
 * but it is still a request to a third party and has its own independent cap.
 */
export type LedgerKind = HealthProbeKind | "search_anonymous";

export interface BudgetOptions {
  paidProbesEnabled: boolean;
  maxPerRun: number;
  maxPerDay: number;
  /** Independent anonymous limits; omitted values inherit the paid limits. */
  anonymousMaxPerRun?: number;
  anonymousMaxPerDay?: number;
}

export interface BudgetSnapshot {
  /** UTC day the counters belong to. */
  day: string;
  /** Paid searches allowed in one run. */
  maxPerRun: number;
  /** Paid searches allowed per UTC day. */
  maxPerDay: number;
  /** Anonymous searches allowed in one run. */
  anonymousMaxPerRun: number;
  /** Anonymous searches allowed per UTC day. */
  anonymousMaxPerDay: number;
  /** Paid searches already reserved today. */
  searchUsedToday: number;
  /** Free connectivity probes reserved today (counted, not capped). */
  connectUsedToday: number;
  /** Real searches against keyless sources today. */
  anonymousSearchUsedToday: number;
  remainingToday: number;
  anonymousRemainingToday: number;
  paidProbesEnabled: boolean;
}

export interface Reservation {
  ok: boolean;
  reason?: "run_limit" | "day_limit" | "paid_disabled" | "ledger_unavailable";
  snapshot: BudgetSnapshot;
}

export interface RecordBillingInput {
  healthCheckId: string;
  kind: LedgerKind;
  /** UTC day on which the budget slot was reserved. */
  budgetDay: string;
  classification: "exact";
  providerType: string;
  credentialUsed: boolean;
  /** True only when at least one physical upstream request was attempted. */
  spent: boolean;
}

export class ProbeBudget {
  constructor(
    private readonly db: SearchHubDb,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** UTC date, deliberately not local: a "day" must not shift with the host TZ. */
  static utcDay(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  private raw(kind: LedgerKind, day: string): number {
    const row = this.db
      .select()
      .from(healthProbeBudget)
      .where(and(eq(healthProbeBudget.day, day), eq(healthProbeBudget.kind, kind)))
      .get();
    return row?.used ?? 0;
  }

  /**
   * Seeds today's ledger from the billing side table.
   *
   * An installation that upgrades mid-day already spent part of its budget, and
   * the rows are in `provider_health_checks`. Without this seeding, applying the
   * migration would hand out a second full day of paid probes.
   *
   * Legacy searches count as paid because their credential use was not recorded.
   * Only an exact `search_anonymous` classification may seed the anonymous bucket;
   * joining today's provider type or guessing from `key_id` would rewrite history.
   */
  private ensureSeed(kind: LedgerKind, day: string, nowMs: number): void {
    const existing = this.db
      .select({ used: healthProbeBudget.used })
      .from(healthProbeBudget)
      .where(and(eq(healthProbeBudget.day, day), eq(healthProbeBudget.kind, kind)))
      .get();
    if (existing) return;

    const filters = [
      eq(providerHealthBilling.budgetKind, kind),
      eq(providerHealthBilling.budgetDay, day),
      eq(providerHealthBilling.spent, true),
    ];
    if (kind === "search_anonymous") {
      filters.push(eq(providerHealthBilling.classification, "exact"));
    }
    const rows = this.db
      .select({ id: providerHealthBilling.healthCheckId })
      .from(providerHealthBilling)
      .where(and(...filters))
      .all();

    this.db
      .insert(healthProbeBudget)
      .values({
        day,
        kind,
        used: rows.length,
        updatedAt: new Date(nowMs).toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  private snapshotAt(options: BudgetOptions, nowMs: number): BudgetSnapshot {
    const day = ProbeBudget.utcDay(nowMs);
    this.ensureSeed("search", day, nowMs);
    this.ensureSeed("connect", day, nowMs);
    this.ensureSeed("search_anonymous", day, nowMs);
    const searchUsed = this.raw("search", day);
    const anonymousUsed = this.raw("search_anonymous", day);
    const anonymousMaxPerRun = options.anonymousMaxPerRun ?? options.maxPerRun;
    const anonymousMaxPerDay = options.anonymousMaxPerDay ?? options.maxPerDay;
    return {
      day,
      maxPerRun: options.maxPerRun,
      maxPerDay: options.maxPerDay,
      anonymousMaxPerRun,
      anonymousMaxPerDay,
      searchUsedToday: searchUsed,
      connectUsedToday: this.raw("connect", day),
      anonymousSearchUsedToday: anonymousUsed,
      remainingToday: Math.max(0, options.maxPerDay - searchUsed),
      anonymousRemainingToday: Math.max(0, anonymousMaxPerDay - anonymousUsed),
      paidProbesEnabled: options.paidProbesEnabled,
    };
  }

  snapshot(options: BudgetOptions): BudgetSnapshot {
    return this.snapshotAt(options, this.clock());
  }

  /**
   * Records the exact billing class after the caller inserts the health row.
   * Idempotent per health check: a retry cannot change an already recorded fact.
   */
  recordBilling(input: RecordBillingInput): void {
    this.db
      .insert(providerHealthBilling)
      .values({
        healthCheckId: input.healthCheckId,
        budgetKind: input.kind,
        budgetDay: input.budgetDay,
        classification: input.classification,
        providerTypeSnapshot: input.providerType,
        credentialUsed: input.credentialUsed,
        spent: input.spent,
        createdAt: new Date(this.clock()).toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Reserves one probe.
   *
   * `paid` is the caller's intent, not a hint: a paid reservation that cannot be
   * written must fail closed (the caller then refuses the request) because
   * proceeding would spend money the ledger has no record of. Anonymous searches
   * have their own daily cap and do not require the paid switch.
   */
  reserve(input: BudgetOptions & { kind: LedgerKind }): Reservation {
    const nowMs = this.clock();
    const snapshot = this.snapshotAt(input, nowMs);
    const day = snapshot.day;

    if (input.kind !== "connect") {
      if (input.kind === "search" && !input.paidProbesEnabled) {
        return { ok: false, reason: "paid_disabled", snapshot };
      }
      const maxPerRun = input.kind === "search" ? input.maxPerRun : (input.anonymousMaxPerRun ?? input.maxPerRun);
      const maxPerDay = input.kind === "search" ? input.maxPerDay : (input.anonymousMaxPerDay ?? input.maxPerDay);
      const usedToday = input.kind === "search" ? snapshot.searchUsedToday : snapshot.anonymousSearchUsedToday;
      const decision = decideBudget({ maxPerRun, maxPerDay, usedToday }, 1);
      if (!decision.allowed) {
        return { ok: false, reason: decision.reason ?? "day_limit", snapshot };
      }
    }

    this.ensureSeed(input.kind, day, nowMs);
    const cap =
      input.kind === "connect"
        ? Number.MAX_SAFE_INTEGER
        : input.kind === "search"
          ? input.maxPerDay
          : (input.anonymousMaxPerDay ?? input.maxPerDay);

    // The conditional UPDATE is the whole concurrency story: a row is written
    // only if this probe still fits, so simultaneous callers cannot all pass a
    // check that was true for each of them individually.
    const updated = this.db
      .update(healthProbeBudget)
      .set({ used: sql`${healthProbeBudget.used} + 1`, updatedAt: new Date(nowMs).toISOString() })
      .where(
        and(
          eq(healthProbeBudget.day, day),
          eq(healthProbeBudget.kind, input.kind),
          sql`${healthProbeBudget.used} < ${cap}`,
        ),
      )
      .run();

    if (Number(updated.changes ?? 0) === 0) {
      // The cap moved between the snapshot and the update (another writer), or
      // the row disappeared. Either way nothing was spent.
      return {
        ok: false,
        reason: input.kind === "connect" ? "ledger_unavailable" : "day_limit",
        snapshot: this.snapshotAt(input, nowMs),
      };
    }

    return { ok: true, snapshot: this.snapshotAt(input, nowMs) };
  }

  /**
   * Gives a reservation back when the probe never left the machine.
   *
   * `day` is the reservation's UTC day, not the day the caller happens to notice
   * the refusal. A probe may cross midnight; refunding into the new day would
   * leak the old day's slot and understate the new day's spend.
   */
  release(kind: LedgerKind, day: string): void {
    const nowMs = this.clock();
    this.db
      .update(healthProbeBudget)
      .set({ used: sql`max(0, ${healthProbeBudget.used} - 1)`, updatedAt: new Date(nowMs).toISOString() })
      .where(and(eq(healthProbeBudget.day, day), eq(healthProbeBudget.kind, kind)))
      .run();
  }
}
