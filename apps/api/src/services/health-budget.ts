import { and, eq, sql } from "drizzle-orm";
import type { SearchHubDb } from "@search-hub/db";
import { healthProbeBudget, providerHealthChecks } from "@search-hub/db";
import { decideBudget, type HealthProbeKind } from "./health-classify.js";

/**
 * Durable probe budget.
 *
 * The requirement is not "count probes" but "never let a background timer spend
 * more than the operator allowed, under any concurrency, across restarts". That
 * rules out the read-then-act counter the previous implementation used: two
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
 * but it is still a request to a third party and is counted separately rather
 * than being called "free", because whether a vendor meters by IP is not
 * something this code can know.
 */
export type LedgerKind = HealthProbeKind | "search_anonymous";

export interface BudgetSnapshot {
  /** UTC day the counters belong to. */
  day: string;
  /** Paid searches allowed in one run. */
  maxPerRun: number;
  /** Paid searches allowed per UTC day. */
  maxPerDay: number;
  /** Paid searches already reserved today. */
  searchUsedToday: number;
  /** Free connectivity probes reserved today (counted, not capped). */
  connectUsedToday: number;
  /** Real searches against keyless sources today (counted, not capped). */
  anonymousSearchUsedToday: number;
  remainingToday: number;
  paidProbesEnabled: boolean;
}

export interface Reservation {
  ok: boolean;
  reason?: "run_limit" | "day_limit" | "paid_disabled" | "ledger_unavailable";
  snapshot: BudgetSnapshot;
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

  private raw(kind: LedgerKind): number {
    const day = ProbeBudget.utcDay(this.clock());
    const row = this.db
      .select()
      .from(healthProbeBudget)
      .where(and(eq(healthProbeBudget.day, day), eq(healthProbeBudget.kind, kind)))
      .get();
    return row?.used ?? 0;
  }

  /**
   * Seeds today's ledger from the probe log.
   *
   * An installation that upgrades mid-day already spent part of its budget, and
   * the rows are in `provider_health_checks`. Without this seeding, applying the
   * migration would hand out a second full day of paid probes.
   */
  private ensureSeed(kind: LedgerKind): void {
    const day = ProbeBudget.utcDay(this.clock());
    const existing = this.db
      .select({ used: healthProbeBudget.used })
      .from(healthProbeBudget)
      .where(and(eq(healthProbeBudget.day, day), eq(healthProbeBudget.kind, kind)))
      .get();
    if (existing) return;

    const since = `${day}T00:00:00.000Z`;
    const rows = this.db
      .select({ id: providerHealthChecks.id })
      .from(providerHealthChecks)
      .where(
        and(
          // Anonymous searches are recorded in the probe log as `search`; the
          // ledger only splits them because their billing class differs.
          eq(providerHealthChecks.kind, kind === "search_anonymous" ? "search" : kind),
          sql`${providerHealthChecks.checkedAt} >= ${since}`,
        ),
      )
      .all();

    this.db
      .insert(healthProbeBudget)
      .values({
        day,
        kind,
        used: rows.length,
        updatedAt: new Date(this.clock()).toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  snapshot(options: { paidProbesEnabled: boolean; maxPerRun: number; maxPerDay: number }): BudgetSnapshot {
    this.ensureSeed("search");
    this.ensureSeed("connect");
    this.ensureSeed("search_anonymous");
    const day = ProbeBudget.utcDay(this.clock());
    const searchUsed = this.raw("search");
    return {
      day,
      maxPerRun: options.maxPerRun,
      maxPerDay: options.maxPerDay,
      searchUsedToday: searchUsed,
      connectUsedToday: this.raw("connect"),
      anonymousSearchUsedToday: this.raw("search_anonymous"),
      remainingToday: Math.max(0, options.maxPerDay - searchUsed),
      paidProbesEnabled: options.paidProbesEnabled,
    };
  }

  /**
   * Reserves one probe.
   *
   * `paid` is the caller's intent, not a hint: a paid reservation that cannot be
   * written must fail closed (the caller then refuses the request) because
   * proceeding would spend money the ledger has no record of.
   */
  reserve(input: {
    /** `search` is only passed for credential-backed searches. */
    kind: LedgerKind;
    paidProbesEnabled: boolean;
    maxPerRun: number;
    maxPerDay: number;
  }): Reservation {
    const snapshot = this.snapshot(input);

    if (input.kind === "search") {
      if (!input.paidProbesEnabled) {
        return { ok: false, reason: "paid_disabled", snapshot };
      }
      const decision = decideBudget(
        {
          maxPerRun: input.maxPerRun,
          maxPerDay: input.maxPerDay,
          usedToday: snapshot.searchUsedToday,
        },
        1,
      );
      if (!decision.allowed) {
        return { ok: false, reason: decision.reason ?? "day_limit", snapshot };
      }
    }

    const day = ProbeBudget.utcDay(this.clock());
    this.ensureSeed(input.kind);
    const cap = input.kind === "search" ? input.maxPerDay : Number.MAX_SAFE_INTEGER;

    // The conditional UPDATE is the whole concurrency story: a row is written
    // only if this probe still fits, so simultaneous callers cannot all pass a
    // check that was true for each of them individually.
    const updated = this.db
      .update(healthProbeBudget)
      .set({ used: sql`${healthProbeBudget.used} + 1`, updatedAt: new Date(this.clock()).toISOString() })
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
        reason: input.kind === "search" ? "day_limit" : "ledger_unavailable",
        snapshot: this.snapshot(input),
      };
    }

    return { ok: true, snapshot: this.snapshot(input) };
  }

  /** Gives a reservation back when the probe never left the machine. */
  release(kind: LedgerKind): void {
    const day = ProbeBudget.utcDay(this.clock());
    this.db
      .update(healthProbeBudget)
      .set({ used: sql`max(0, ${healthProbeBudget.used} - 1)`, updatedAt: new Date(this.clock()).toISOString() })
      .where(and(eq(healthProbeBudget.day, day), eq(healthProbeBudget.kind, kind)))
      .run();
  }
}
