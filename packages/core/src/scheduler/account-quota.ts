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

/** 一次预留的凭据，notSent 回滚必须退回到这一笔，而不是按时间戳猜。 */
export interface AccountQuotaReservation {
  readonly group: string;
  readonly limits: AccountQuotaLimits;
  readonly at: number;
  readonly rpm: boolean;
  readonly daily: boolean;
  refunded: boolean;
}

interface GroupState {
  window: AccountQuotaReservation[];
  quotaDate: string;
  quotaUsedToday: number;
  limit: AccountQuotaLimits;
  lastDeniedAt: number | null;
  parkedUntil: number | null;
}

export interface AccountQuotaSnapshot {
  group: string;
  rpmUsed: number;
  rpmLimit: number;
  quotaUsedToday: number;
  dailyQuota: number | null;
  lastDeniedAt: string | null;
  parkedUntil?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class AccountQuotaRegistry {
  private readonly groups = new Map<string, GroupState>();

  /** 原子预留一个账户组槽位；账户组被 park 或数值配额耗尽时返回 null。 */
  reserve(
    group: string,
    limits: AccountQuotaLimits,
    now: number = Date.now(),
    options: { ignorePark?: boolean } = {},
  ): AccountQuotaReservation | null {
    if (!group) {
      return { group, limits, at: now, rpm: false, daily: false, refunded: false };
    }
    const state = this.stateFor(group, limits, now);
    state.limit = limits;
    this.expirePark(state, now);
    if (state.parkedUntil !== null && !options.ignorePark) {
      state.lastDeniedAt = now;
      return null;
    }
    if (limits.rpmLimit > 0) {
      const cutoff = now - 60_000;
      state.window = state.window.filter((reservation) => reservation.at > cutoff);
      if (state.window.length >= limits.rpmLimit) {
        state.lastDeniedAt = now;
        return null;
      }
    }
    if (limits.dailyQuota !== null && state.quotaUsedToday >= limits.dailyQuota) {
      state.lastDeniedAt = now;
      return null;
    }
    const reservation: AccountQuotaReservation = {
      group,
      limits,
      at: now,
      rpm: limits.rpmLimit > 0,
      daily: limits.dailyQuota !== null,
      refunded: false,
    };
    if (reservation.rpm) state.window.push(reservation);
    if (reservation.daily) state.quotaUsedToday += 1;
    return reservation;
  }

  /** Reserves one slot. Returns false when the group is exhausted. */
  tryConsume(group: string, limits: AccountQuotaLimits, now: number = Date.now()): boolean {
    return this.reserve(group, limits, now) !== null;
  }

  /** 退回一次未发请求的预留；每笔凭据只能退回一次。 */
  refundReservation(reservation: AccountQuotaReservation): void {
    if (reservation.refunded) return;
    reservation.refunded = true;
    const state = this.groups.get(reservation.group);
    if (!state) return;
    if (reservation.rpm) {
      const index = state.window.indexOf(reservation);
      if (index >= 0) state.window.splice(index, 1);
    }
    if (
      reservation.daily &&
      utcDay(reservation.at) === state.quotaDate &&
      state.quotaUsedToday > 0
    ) {
      state.quotaUsedToday -= 1;
    }
  }

  /** 兼容旧调用方；新租约必须使用 refundReservation 以处理同毫秒并发。 */
  refund(group: string, limits: AccountQuotaLimits, now: number = Date.now()): void {
    if (!group) return;
    const state = this.groups.get(group);
    if (!state) return;
    const index = state.window.findLastIndex((reservation) => reservation.at === now);
    if (index >= 0) state.window.splice(index, 1);
    if (limits.dailyQuota !== null && utcDay(now) === state.quotaDate && state.quotaUsedToday > 0) {
      state.quotaUsedToday -= 1;
    }
  }

  /** 账户级失败会 park 同组所有 Key，避免轮换后重复付费失败。 */
  park(group: string, untilMs: number): void {
    if (!group) return;
    const state = this.stateFor(group, { rpmLimit: 0, dailyQuota: null }, untilMs);
    state.parkedUntil = Math.max(state.parkedUntil ?? 0, untilMs);
  }

  /** 真实成功证明账户恢复可用，解除 forbidden/quota 造成的 park。 */
  unpark(group: string): void {
    if (!group) return;
    const state = this.groups.get(group);
    if (state) state.parkedUntil = null;
  }

  parkedUntil(group: string, now: number = Date.now()): number | null {
    if (!group) return null;
    const state = this.groups.get(group);
    if (!state) return null;
    this.expirePark(state, now);
    return state.parkedUntil;
  }

  snapshot(group: string, now: number = Date.now()): AccountQuotaSnapshot | null {
    const state = this.groups.get(group);
    if (!state) return null;
    this.stateFor(group, state.limit, now);
    this.expirePark(state, now);
    const cutoff = now - 60_000;
    return {
      group,
      rpmUsed: state.window.filter((reservation) => reservation.at > cutoff).length,
      rpmLimit: state.limit.rpmLimit,
      quotaUsedToday: state.quotaUsedToday,
      dailyQuota: state.limit.dailyQuota,
      lastDeniedAt: state.lastDeniedAt === null ? null : new Date(state.lastDeniedAt).toISOString(),
      parkedUntil: state.parkedUntil === null ? null : new Date(state.parkedUntil).toISOString(),
    };
  }

  /** Test helper. */
  reset(): void {
    this.groups.clear();
  }

  private expirePark(state: GroupState, now: number): void {
    if (state.parkedUntil !== null && state.parkedUntil <= now) state.parkedUntil = null;
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
      parkedUntil: null,
    };
    this.groups.set(group, created);
    return created;
  }
}

/** Shared by every provider scheduler in this process. */
export const accountQuotaRegistry = new AccountQuotaRegistry();

export { DAY_MS as ACCOUNT_QUOTA_DAY_MS };
