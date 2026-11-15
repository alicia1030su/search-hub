/**
 * Account-level quota accounting.
 *
 * A provider account may own several API keys. Rotating across them is correct
 * for spreading load, but it does **not** create extra entitlement: the vendor
 * rate-limits the account. This registry enforces one budget per named account
 * group so N keys in the same group cannot multiply the vendor's limit.
 *
 * Scope: **this process only**. It is deliberately not a distributed limiter —
 * running two replicas gives each replica its own budget, and the UI/docs say
 * so instead of implying cluster-wide coordination.
 */

export interface AccountQuotaLimits {
  /** Requests per rolling minute for the whole account group. 0 = unlimited. */
  rpmLimit: number;
  /** Requests per UTC day for the whole account group. null = unlimited. */
  dailyQuota: number | null;
}

interface GroupState {
  window: number[];
  quotaDate: string;
  quotaUsedToday: number;
  limit: AccountQuotaLimits;
  lastDeniedAt: number | null;
}

export interface AccountQuotaSnapshot {
  group: string;
  rpmUsed: number;
  rpmLimit: number;
  quotaUsedToday: number;
  dailyQuota: number | null;
  lastDeniedAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class AccountQuotaRegistry {
  private readonly groups = new Map<string, GroupState>();

  /**
   * Reserves one slot. Returns false when the group is exhausted, in which case
   * the caller must not consume a key slot either.
   */
  tryConsume(group: string, limits: AccountQuotaLimits, now: number = Date.now()): boolean {
    if (!group) return true;
    const state = this.stateFor(group, limits, now);
    state.limit = limits;
    if (limits.rpmLimit > 0) {
      const cutoff = now - 60_000;
      state.window = state.window.filter((timestamp) => timestamp > cutoff);
      if (state.window.length >= limits.rpmLimit) {
        state.lastDeniedAt = now;
        return false;
      }
    }
    if (limits.dailyQuota !== null && state.quotaUsedToday >= limits.dailyQuota) {
      state.lastDeniedAt = now;
      return false;
    }
    if (limits.rpmLimit > 0) state.window.push(now);
    if (limits.dailyQuota !== null) state.quotaUsedToday += 1;
    return true;
  }

  /** Returns a slot after a request that never reached the vendor. */
  refund(group: string, limits: AccountQuotaLimits, now: number = Date.now()): void {
    if (!group) return;
    const state = this.groups.get(group);
    if (!state) return;
    state.window = state.window.filter((timestamp) => timestamp !== now);
    if (limits.dailyQuota !== null && state.quotaUsedToday > 0) state.quotaUsedToday -= 1;
  }

  snapshot(group: string, now: number = Date.now()): AccountQuotaSnapshot | null {
    const state = this.groups.get(group);
    if (!state) return null;
    const cutoff = now - 60_000;
    return {
      group,
      rpmUsed: state.window.filter((timestamp) => timestamp > cutoff).length,
      rpmLimit: state.limit.rpmLimit,
      quotaUsedToday: state.quotaUsedToday,
      dailyQuota: state.limit.dailyQuota,
      lastDeniedAt: state.lastDeniedAt === null ? null : new Date(state.lastDeniedAt).toISOString(),
    };
  }

  /** Test helper. */
  reset(): void {
    this.groups.clear();
  }

  private stateFor(group: string, limits: AccountQuotaLimits, now: number): GroupState {
    const existing = this.groups.get(group);
    const day = utcDay(now);
    if (existing) {
      if (existing.quotaDate !== day) {
        existing.quotaDate = day;
        existing.quotaUsedToday = 0;
      }
      return existing;
    }
    const created: GroupState = {
      window: [],
      quotaDate: day,
      quotaUsedToday: 0,
      limit: limits,
      lastDeniedAt: null,
    };
    this.groups.set(group, created);
    return created;
  }
}

/** Shared by every provider scheduler in this process. */
export const accountQuotaRegistry = new AccountQuotaRegistry();

export { DAY_MS as ACCOUNT_QUOTA_DAY_MS };
