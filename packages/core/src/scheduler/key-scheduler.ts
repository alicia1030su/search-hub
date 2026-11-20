import type { KeyStatus, KeyStrategy } from "@search-hub/shared";
import {
  AccountQuotaRegistry,
  accountQuotaRegistry,
  type AccountQuotaLimits,
  type AccountQuotaReservation,
} from "./account-quota.js";

/** Upper bound on parked callers; beyond this we reject instead of growing unbounded. */
const MAX_WAITERS = 1024;

interface Waiter {
  done: boolean;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (woke: boolean) => void;
}

export interface SchedulerKeySeed {
  id: string;
  label: string;
  maskedKey: string;
  weight: number;
  enabled: boolean;
  status: KeyStatus;
  /** False when the stored ciphertext cannot be decrypted with the current master key. */
  decryptable?: boolean;
  requestCount?: number;
  successCount?: number;
  failureCount?: number;
  consecutiveFailures?: number;
  avgLatencyMs?: number | null;
  quotaUsedToday?: number;
  quotaDate?: string | null;
  cooldownUntil?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}

interface RuntimeKey extends Required<Omit<SchedulerKeySeed, "avgLatencyMs" | "cooldownUntil">> {
  avgLatencyMs: number | null;
  cooldownUntilMs: number | null;
  inFlight: number;
  peakInFlight: number;
  window: number[];
  lastUsedAtMs: number | null;
  lastFailureAtMs: number | null;
  dirty: boolean;
}

export interface KeyRuntimeSnapshot {
  id: string;
  label: string;
  maskedKey: string;
  status: KeyStatus;
  inFlight: number;
  /** Highest in-flight value observed since the scheduler was created. */
  peakInFlight: number;
  rpmUsed: number;
  quotaUsedToday: number;
  quotaDate: string | null;
  requestCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  avgLatencyMs: number | null;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  enabled: boolean;
  weight: number;
}

export interface KeyReleaseOutcome {
  ok: boolean;
  latencyMs?: number;
  code?: string;
  message?: string;
  retryAfterMs?: number;
  cancelled?: boolean;
  /** 租约已取但请求未发出：完整退回 Key 与账户组槽位，不计成功/失败。 */
  notSent?: boolean;
}

export interface KeySchedulerOptions {
  providerId: string;
  strategy: KeyStrategy;
  /** Maximum simultaneous requests per key. */
  perKeyConcurrency: number;
  rpmLimit: number;
  dailyQuota: number | null;
  cooldownMs: number;
  breakerThreshold: number;
  keys: SchedulerKeySeed[];
  onDirty?: (snapshot: KeyRuntimeSnapshot) => void;
  /**
   * Account group shared by every provider instance that bills the same vendor
   * account. When set, per-key limits still apply **and** the group budget is
   * enforced, so N keys cannot multiply the vendor's rate limit.
   */
  accountGroup?: string | null;
  accountLimits?: AccountQuotaLimits | null;
  registry?: AccountQuotaRegistry;
}

const MAX_COOLDOWN_MS = 10 * 60_000;

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/**
 * Concurrency-safe per-provider key scheduler.
 *
 * Correctness argument (single process):
 *  - `tryAcquire()` is fully synchronous: candidate filtering, selection,
 *    `inFlight` increment and rate-window bookkeeping happen in one
 *    uninterruptible JavaScript turn. There is no `await` inside the critical
 *    section, so 100 concurrent callers cannot observe a stale slot.
 *  - The slot is released only via an idempotent lease, including on abort.
 *  - Multi-instance deployments are NOT coordinated by this class. A Redis
 *    backend is required (documented limitation, not silently ignored).
 */

export class KeyScheduler {
  readonly providerId: string;
  private accountGroup: string | null;
  private accountLimits: AccountQuotaLimits | null;
  private readonly registry: AccountQuotaRegistry;
  /** True when the last tryAcquire was rejected by the account budget. */
  accountDenied = false;
  private keys: RuntimeKey[] = [];
  private cursor = 0;
  private strategy: KeyStrategy;
  private perKeyConcurrency: number;
  private rpmLimit: number;
  private dailyQuota: number | null;
  private cooldownMs: number;
  private breakerThreshold: number;
  private readonly onDirty?: (snapshot: KeyRuntimeSnapshot) => void;
  /** Number of requests currently parked waiting for a slot (bounded). */
  private waiting = 0;
  private waiters: Waiter[] = [];

  constructor(options: KeySchedulerOptions) {
    this.providerId = options.providerId;
    this.strategy = options.strategy;
    this.perKeyConcurrency = Math.max(1, options.perKeyConcurrency);
    this.rpmLimit = options.rpmLimit;
    this.dailyQuota = options.dailyQuota;
    this.cooldownMs = options.cooldownMs;
    this.breakerThreshold = Math.max(1, options.breakerThreshold);
    this.onDirty = options.onDirty;
    this.accountGroup = options.accountGroup ?? null;
    this.accountLimits = options.accountLimits ?? null;
    this.registry = options.registry ?? accountQuotaRegistry;
    this.keys = options.keys.map((seed) => this.toRuntimeKey(seed));
  }

  get keyCount(): number {
    return this.keys.length;
  }

  hasKeys(): boolean {
    return this.keys.length > 0;
  }

  /** Rewires the account group without recreating the scheduler. */
  setAccount(group: string | null, limits: AccountQuotaLimits | null): void {
    this.accountGroup = group;
    this.accountLimits = limits;
    // The reserved/denied flag belongs to the previous group; drop it so a UI
    // warning does not survive a config change.
    this.accountDenied = false;
  }

  /** Account-level budget state, for the admin UI. Null when no group is set. */
  accountSnapshot(now: number = Date.now()) {
    if (!this.accountGroup) return null;
    const snapshot = this.registry.snapshot(this.accountGroup, now);
    if (snapshot) return snapshot;
    // The group exists in configuration but no request has used it yet. Return
    // a zeroed snapshot so the UI can show the configured limits instead of
    // pretending the group is not configured.
    return {
      group: this.accountGroup,
      rpmUsed: 0,
      rpmLimit: this.accountLimits?.rpmLimit ?? 0,
      quotaUsedToday: 0,
      dailyQuota: this.accountLimits?.dailyQuota ?? null,
      lastDeniedAt: null,
      parkedUntil: this.registry.parkedUntil(this.accountGroup, now) === null
        ? null
        : new Date(this.registry.parkedUntil(this.accountGroup, now)!).toISOString(),
    };
  }

  totalInFlight(): number {
    return this.keys.reduce((sum, key) => sum + key.inFlight, 0);
  }

  setStrategy(strategy: KeyStrategy): void {
    this.strategy = strategy;
  }

  setLimits(limits: {
    perKeyConcurrency?: number;
    rpmLimit?: number;
    dailyQuota?: number | null;
    cooldownMs?: number;
    breakerThreshold?: number;
  }): void {
    if (limits.perKeyConcurrency !== undefined) {
      this.perKeyConcurrency = Math.max(1, limits.perKeyConcurrency);
    }
    if (limits.rpmLimit !== undefined) this.rpmLimit = limits.rpmLimit;
    if (limits.dailyQuota !== undefined) this.dailyQuota = limits.dailyQuota;
    if (limits.cooldownMs !== undefined) this.cooldownMs = limits.cooldownMs;
    if (limits.breakerThreshold !== undefined) {
      this.breakerThreshold = Math.max(1, limits.breakerThreshold);
    }
  }

  /** Adds, removes and updates keys while preserving live counters. */
  syncKeys(seeds: SchedulerKeySeed[]): void {
    const next = new Map(seeds.map((seed) => [seed.id, seed]));
    const kept: RuntimeKey[] = [];
    for (const existing of this.keys) {
      const seed = next.get(existing.id);
      if (!seed) continue;
      existing.label = seed.label;
      existing.maskedKey = seed.maskedKey;
      existing.weight = Math.max(1, seed.weight);
      existing.enabled = seed.enabled;
      existing.decryptable = seed.decryptable ?? true;
      existing.status = seed.enabled ? seed.status : "disabled";
      existing.requestCount = seed.requestCount ?? existing.requestCount;
      existing.successCount = seed.successCount ?? existing.successCount;
      existing.failureCount = seed.failureCount ?? existing.failureCount;
      existing.consecutiveFailures = seed.consecutiveFailures ?? existing.consecutiveFailures;
      existing.avgLatencyMs = seed.avgLatencyMs ?? existing.avgLatencyMs;
      existing.quotaUsedToday = seed.quotaUsedToday ?? existing.quotaUsedToday;
      existing.quotaDate = seed.quotaDate ?? existing.quotaDate;
      const cooldown = seed.cooldownUntil ? Date.parse(seed.cooldownUntil) : Number.NaN;
      existing.cooldownUntilMs = Number.isNaN(cooldown) ? null : cooldown;
      existing.lastErrorCode = seed.lastErrorCode ?? null;
      existing.lastErrorMessage = seed.lastErrorMessage ?? null;
      next.delete(existing.id);
      kept.push(existing);
    }
    for (const seed of next.values()) kept.push(this.toRuntimeKey(seed));
    this.keys = kept;
    if (this.cursor >= this.keys.length) this.cursor = 0;
  }

  /**
   * Selects a key and reserves a slot, waiting briefly when every slot is busy.
   * Waiting does not break the atomicity guarantee: each attempt still reserves
   * a slot synchronously, so the concurrency ceiling is never exceeded.
   * Returns null once the wait budget or the caller's deadline is exhausted.
   */
  async acquire(options: { maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<KeyLease | null> {
    const result = await this.acquireWithReason(options);
    return result.lease;
  }

  /**
   * Same as acquire(), but distinguishes a permanently unusable key pool from
   * a temporarily saturated one so callers can return NO_AVAILABLE_KEY vs
   * QUEUE_TIMEOUT instead of conflating both.
   */
  async acquireWithReason(
    options: { maxWaitMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ lease: KeyLease | null; reason?: "no_key" | "queue_timeout" | "account_quota" }> {
    const immediate = this.tryAcquire();
    if (immediate) return { lease: immediate };
    // The account budget, not the key pool, is the blocker. Waiting cannot help
    // until the account window rolls over, so fail fast with a precise reason.
    if (this.accountDenied) return { lease: null, reason: "account_quota" };

    // Distinguish "temporarily saturated" from "permanently unavailable".
    if (!this.hasPotentiallyUsableKey(Date.now())) return { lease: null, reason: "no_key" };
    if (this.waiting >= MAX_WAITERS) return { lease: null, reason: "queue_timeout" };

    const waitBudget = Math.max(0, options.maxWaitMs ?? 2_000);
    const deadline = Date.now() + waitBudget;
    this.waiting += 1;
    try {
      while (Date.now() < deadline) {
        if (options.signal?.aborted) return { lease: null, reason: "queue_timeout" };
        // Woken by release() instead of polling: this keeps the observed
        // schedule close to ceil(requests / slots) * latency.
        await this.waitForSlot(Math.min(deadline - Date.now(), 250), options.signal);
        const lease = this.tryAcquire();
        if (lease) return { lease };
        if (!this.hasPotentiallyUsableKey(Date.now())) return { lease: null, reason: "no_key" };
      }
      return { lease: null, reason: "queue_timeout" };
    } finally {
      this.waiting -= 1;
    }
  }

  /**
   * 显式 Key 租约。manual 只绕过状态/冷却/Key 数值配额，仍校验启用、可解密、
   * 并发上限与账户组数值配额；其他调用方使用正常自动选择规则。
   */
  async acquireForKeyWithReason(
    keyId: string,
    options: { maxWaitMs?: number; signal?: AbortSignal; manual?: boolean } = {},
  ): Promise<{ lease: KeyLease | null; reason?: "no_key" | "queue_timeout" | "account_quota" }> {
    const immediate = this.tryAcquireKey(keyId, { manual: options.manual });
    if (immediate) return { lease: immediate };
    if (this.accountDenied) return { lease: null, reason: "account_quota" };
    if (!this.explicitKeyPotentiallyUsable(keyId, options.manual ?? false, Date.now())) {
      return { lease: null, reason: "no_key" };
    }
    if (this.waiting >= MAX_WAITERS) return { lease: null, reason: "queue_timeout" };

    const waitBudget = Math.max(0, options.maxWaitMs ?? 2_000);
    const deadline = Date.now() + waitBudget;
    this.waiting += 1;
    try {
      while (Date.now() < deadline) {
        if (options.signal?.aborted) return { lease: null, reason: "queue_timeout" };
        await this.waitForSlot(Math.min(deadline - Date.now(), 250), options.signal);
        const lease = this.tryAcquireKey(keyId, { manual: options.manual });
        if (lease) return { lease };
        if (this.accountDenied) return { lease: null, reason: "account_quota" };
        if (!this.explicitKeyPotentiallyUsable(keyId, options.manual ?? false, Date.now())) {
          return { lease: null, reason: "no_key" };
        }
      }
      return { lease: null, reason: "queue_timeout" };
    } finally {
      this.waiting -= 1;
    }
  }

  /** Number of callers currently parked waiting for a slot. */
  get waitingCount(): number {
    return this.waiting;
  }

  /** Wakes exactly one waiter after a slot is released. */
  private wakeOne(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.done) continue;
      waiter.done = true;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(true);
      return;
    }
  }

  private waitForSlot(maxMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        done: false,
        timer: setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          resolve(false);
        }, Math.max(1, maxMs)),
        ...(signal === undefined ? {} : { signal }),
        onAbort: () => {
          if (waiter.done) return;
          waiter.done = true;
          clearTimeout(waiter.timer);
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(false);
        },
        resolve: (woke: boolean) => resolve(woke),
      };
      waiter.timer.unref?.();
      if (signal) {
        if (signal.aborted) {
          waiter.done = true;
          clearTimeout(waiter.timer);
          resolve(false);
          return;
        }
        signal.addEventListener("abort", waiter.onAbort!, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** True when at least one key is enabled, not invalid and not in long cooldown. */
  private hasPotentiallyUsableKey(now: number): boolean {
    for (const key of this.keys) {
      if (!key.enabled || !key.decryptable) continue;
      // `quota_exhausted` is terminal for the day: retrying it costs a request
      // and always fails, so it must not be offered as a usable key.
      if (
        key.status === "invalid" ||
        key.status === "disabled" ||
        key.status === "forbidden" ||
        key.status === "quota_exhausted"
      ) {
        continue;
      }
      this.refreshKey(key, now);
      if (key.cooldownUntilMs !== null && key.cooldownUntilMs - now > 60_000) continue;
      if (this.dailyQuota !== null && key.quotaUsedToday >= this.dailyQuota) continue;
      if (this.rpmLimit > 0 && key.window.length >= this.rpmLimit) continue;
      return true;
    }
    return false;
  }

  private explicitKeyPotentiallyUsable(keyId: string, manual: boolean, now: number): boolean {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key || !key.enabled || !key.decryptable) return false;
    if (!manual) {
      if (key.status === "invalid" || key.status === "forbidden" || key.status === "quota_exhausted") {
        return false;
      }
      this.refreshKey(key, now);
      if (key.cooldownUntilMs !== null) return false;
      if (this.rpmLimit > 0 && key.window.length >= this.rpmLimit) return false;
      if (this.dailyQuota !== null && key.quotaUsedToday >= this.dailyQuota) return false;
    }
    return true;
  }

  /**
   * Atomically selects a key and reserves one concurrency slot.
   * Returns null when no key can serve the request right now.
   */
  tryAcquire(now: number = Date.now()): KeyLease | null {
    // The account budget is consumed BEFORE a key slot: if the account is out of
    // quota, holding a key slot would only delay other requests that also cannot
    // succeed.
    const reservation = this.reserveAccount(now);
    if (reservation === null) return null;

    const available = this.availableKeys(now);
    if (available.length === 0) {
      // Return the reserved slot: no request will be made against the vendor.
      if (reservation) this.registry.refundReservation(reservation);
      return null;
    }

    const selected = this.pick(available);
    if (!selected) {
      if (reservation) this.registry.refundReservation(reservation);
      return null;
    }
    return this.reserveKey(selected, now, reservation ?? null);
  }

  /** 同步显式取 Key；manual 允许恢复 invalid/forbidden/cooldown/quota_exhausted。 */
  tryAcquireKey(keyId: string, options: { manual?: boolean; now?: number } = {}): KeyLease | null {
    const now = options.now ?? Date.now();
    const key = this.keys.find((item) => item.id === keyId);
    if (!key || !key.enabled || !key.decryptable) return null;
    this.refreshKey(key, now);
    if (key.inFlight >= this.perKeyConcurrency) return null;
    if (!options.manual) {
      if (key.status === "invalid" || key.status === "forbidden" || key.status === "quota_exhausted") {
        return null;
      }
      if (key.cooldownUntilMs !== null) return null;
      if (this.rpmLimit > 0 && key.window.length >= this.rpmLimit) return null;
      if (this.dailyQuota !== null && key.quotaUsedToday >= this.dailyQuota) return null;
    }
    const reservation = this.reserveAccount(now, options.manual ?? false);
    if (reservation === null) return null;
    return this.reserveKey(key, now, reservation ?? null);
  }

  private reserveAccount(now: number, manual: boolean = false): AccountQuotaReservation | null | undefined {
    this.accountDenied = false;
    if (!this.accountGroup || !this.accountLimits) return undefined;
    const reservation = this.registry.reserve(this.accountGroup, this.accountLimits, now, { ignorePark: manual });
    if (!reservation) this.accountDenied = true;
    return reservation;
  }

  private reserveKey(
    key: RuntimeKey,
    now: number,
    reservation: AccountQuotaReservation | null,
  ): KeyLease {
    const previousLastUsedAtMs = key.lastUsedAtMs;
    // --- critical section: no awaits below this line ---
    key.inFlight += 1;
    if (key.inFlight > key.peakInFlight) key.peakInFlight = key.inFlight;
    key.requestCount += 1;
    key.lastUsedAtMs = now;
    key.window.push(now);
    if (this.dailyQuota !== null) key.quotaUsedToday += 1;
    key.dirty = true;
    this.emitDirty(key);
    // --- critical section end ---

    return new KeyLease(
      this,
      key.id,
      key.label,
      now,
      reservation,
      previousLastUsedAtMs,
      this.dailyQuota !== null,
      utcDayKey(now),
    );
  }

  /** Called by a lease; idempotent. */
  release(
    keyId: string,
    outcome: KeyReleaseOutcome,
    now: number = Date.now(),
    reservation: AccountQuotaReservation | null = null,
    previousLastUsedAtMs: number | null = null,
    reservedAt: number = now,
    countedDaily: boolean = false,
    quotaDateAtReserve: string | null = null,
  ): void {
    // The credential may have been deleted while the request was in flight.
    // Refund its exact account reservation before looking up mutable Key state.
    if (outcome.notSent && reservation) this.registry.refundReservation(reservation);
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return;

    key.inFlight = Math.max(0, key.inFlight - 1);
    if (outcome.notSent) {
      key.requestCount = Math.max(0, key.requestCount - 1);
      const index = key.window.lastIndexOf(reservedAt);
      if (index >= 0) key.window.splice(index, 1);
      if (countedDaily && key.quotaDate === quotaDateAtReserve) {
        key.quotaUsedToday = Math.max(0, key.quotaUsedToday - 1);
      }
      key.lastUsedAtMs = previousLastUsedAtMs;
      key.dirty = true;
      this.emitDirty(key);
      this.wakeOne();
      return;
    }

    if (outcome.cancelled) {
      key.dirty = true;
      this.emitDirty(key);
      this.wakeOne();
      return;
    }

    const affectedAccountGroup = reservation?.group ?? this.accountGroup;
    if (outcome.ok) {
      key.successCount += 1;
      key.consecutiveFailures = 0;
      if (outcome.latencyMs !== undefined) {
        key.avgLatencyMs =
          key.avgLatencyMs === null
            ? outcome.latencyMs
            : key.avgLatencyMs * 0.7 + outcome.latencyMs * 0.3;
      }
      // Only a real successful request proves the credential/account recovered.
      if (
        key.status === "rate_limited" ||
        key.status === "cooldown" ||
        key.status === "unknown" ||
        key.status === "invalid" ||
        key.status === "forbidden" ||
        key.status === "quota_exhausted"
      ) {
        key.cooldownUntilMs = null;
        key.status = key.enabled ? "healthy" : "disabled";
        key.lastErrorCode = null;
        key.lastErrorMessage = null;
      }
      if (affectedAccountGroup) this.registry.unpark(affectedAccountGroup);
    } else {
      key.failureCount += 1;
      key.consecutiveFailures += 1;
      key.lastFailureAtMs = now;
      key.lastErrorCode = outcome.code ?? "unknown";
      key.lastErrorMessage = (outcome.message ?? "Unknown provider error").slice(0, 500);

      switch (outcome.code) {
        case "rate_limited": {
          key.status = "rate_limited";
          key.cooldownUntilMs = now + (outcome.retryAfterMs ?? this.cooldownMs);
          break;
        }
        case "quota_exceeded": {
          key.status = "quota_exhausted";
          key.cooldownUntilMs = Math.max(
            nextUtcMidnight(now) + 1_000,
            outcome.retryAfterMs ? now + outcome.retryAfterMs : 0,
          );
          if (affectedAccountGroup) this.registry.park(affectedAccountGroup, key.cooldownUntilMs);
          break;
        }
        case "forbidden":
        case "blocked": {
          key.status = "forbidden";
          key.cooldownUntilMs = now + (outcome.retryAfterMs ?? this.cooldownMs);
          if (affectedAccountGroup) this.registry.park(affectedAccountGroup, key.cooldownUntilMs);
          break;
        }
        case "auth_invalid": {
          // 兼容共享 HTTP helper 仍把 403 映射为 auth_invalid 的旧路径；
          // 状态机不能把明确的权限拒绝误判成无效密钥。
          if (/\b403\b|forbidden/i.test(outcome.message ?? "")) {
            key.status = "forbidden";
            key.cooldownUntilMs = now + (outcome.retryAfterMs ?? this.cooldownMs);
            if (affectedAccountGroup) this.registry.park(affectedAccountGroup, key.cooldownUntilMs);
          } else {
            key.status = "invalid";
            key.cooldownUntilMs = null;
          }
          break;
        }
        case "timeout":
        case "network":
        case "dns":
        case "tls":
        case "server_error": {
          if (key.consecutiveFailures >= this.breakerThreshold) {
            const over = key.consecutiveFailures - this.breakerThreshold;
            const backoff = Math.min(this.cooldownMs * 2 ** over, MAX_COOLDOWN_MS);
            key.status = "cooldown";
            key.cooldownUntilMs = now + backoff;
          }
          break;
        }
        default:
          // empty_results/bad_response 等不证明凭据无效，保留当前有效性状态。
          break;
      }
    }

    key.dirty = true;
    this.emitDirty(key);
    this.wakeOne();
  }

  /** Manual re-test success resets an invalid or cooling key. */
  markHealthy(keyId: string): void {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return;
    key.status = key.enabled ? "healthy" : "disabled";
    key.consecutiveFailures = 0;
    key.cooldownUntilMs = null;
    key.lastErrorCode = null;
    key.lastErrorMessage = null;
    if (this.accountGroup) this.registry.unpark(this.accountGroup);
    key.dirty = true;
    this.emitDirty(key);
  }

  setKeyEnabled(keyId: string, enabled: boolean): void {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return;
    key.enabled = enabled;
    key.status = enabled ? (key.status === "disabled" ? "healthy" : key.status) : "disabled";
    if (!enabled) key.cooldownUntilMs = null;
    key.dirty = true;
    this.emitDirty(key);
  }

  /** 凭据库在租约等待期间发生变化时，立即把该 Key 移出自动候选。 */
  setKeyDecryptable(keyId: string, decryptable: boolean): void {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return;
    key.decryptable = decryptable;
  }

  accountParkedUntil(now: number = Date.now()): string | null {
    if (!this.accountGroup) return null;
    const until = this.registry.parkedUntil(this.accountGroup, now);
    return until === null ? null : new Date(until).toISOString();
  }

  /** Returns and clears the dirty flags; used by the API persistence flusher. */
  drainDirty(): KeyRuntimeSnapshot[] {
    const dirty = this.keys.filter((key) => key.dirty);
    for (const key of dirty) key.dirty = false;
    return dirty.map((key) => this.snapshotKey(key));
  }

  /** 非消耗式可用性判断，供管理端汇总；不会预留或修改配额。 */
  keyAvailable(keyId: string, now: number = Date.now()): boolean {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key || !key.enabled || !key.decryptable) return false;
    this.refreshKey(key, now);
    if (
      key.status === "invalid" ||
      key.status === "disabled" ||
      key.status === "forbidden" ||
      key.status === "quota_exhausted" ||
      key.cooldownUntilMs !== null ||
      key.inFlight >= this.perKeyConcurrency
    ) {
      return false;
    }
    if (this.rpmLimit > 0 && key.window.length >= this.rpmLimit) return false;
    if (this.dailyQuota !== null && key.quotaUsedToday >= this.dailyQuota) return false;
    const account = this.accountSnapshot(now);
    if (!account) return true;
    if (account.parkedUntil !== null && account.parkedUntil !== undefined) return false;
    if (account.rpmLimit > 0 && account.rpmUsed >= account.rpmLimit) return false;
    return account.dailyQuota === null || account.quotaUsedToday < account.dailyQuota;
  }

  /** 账户组是否因 park 或日配额耗尽而不可用（RPM 瞬时限流不算耗尽）。 */
  accountQuotaExhausted(now: number = Date.now()): boolean {
    if (!this.accountGroup) return false;
    if (this.registry.parkedUntil(this.accountGroup, now) !== null) return true;
    const account = this.accountSnapshot(now);
    return account !== null && account.dailyQuota !== null && account.quotaUsedToday >= account.dailyQuota;
  }

  snapshot(now: number = Date.now()): KeyRuntimeSnapshot[] {
    for (const key of this.keys) this.refreshKey(key, now);
    return this.keys.map((key) => this.snapshotKey(key));
  }

  private toRuntimeKey(seed: SchedulerKeySeed): RuntimeKey {
    const cooldown = seed.cooldownUntil ? Date.parse(seed.cooldownUntil) : Number.NaN;
    return {
      id: seed.id,
      label: seed.label,
      maskedKey: seed.maskedKey,
      weight: Math.max(1, seed.weight),
      enabled: seed.enabled,
      status: seed.enabled ? seed.status : "disabled",
      decryptable: seed.decryptable ?? true,
      requestCount: seed.requestCount ?? 0,
      successCount: seed.successCount ?? 0,
      failureCount: seed.failureCount ?? 0,
      consecutiveFailures: seed.consecutiveFailures ?? 0,
      avgLatencyMs: seed.avgLatencyMs ?? null,
      quotaUsedToday: seed.quotaUsedToday ?? 0,
      quotaDate: seed.quotaDate ?? null,
      cooldownUntilMs: Number.isNaN(cooldown) ? null : cooldown,
      lastErrorCode: seed.lastErrorCode ?? null,
      lastErrorMessage: seed.lastErrorMessage ?? null,
      inFlight: 0,
      peakInFlight: 0,
      window: [],
      lastUsedAtMs: null,
      lastFailureAtMs: null,
      dirty: false,
    };
  }

  private refreshKey(key: RuntimeKey, now: number): void {
    const today = utcDayKey(now);
    if (key.quotaDate !== today) {
      key.quotaDate = today;
      key.quotaUsedToday = 0;
      key.dirty = true;
    }
    if (key.window.length > 0) {
      const cutoff = now - 60_000;
      const firstValid = key.window.findIndex((timestamp) => timestamp > cutoff);
      if (firstValid === -1) key.window = [];
      else if (firstValid > 0) key.window = key.window.slice(firstValid);
    }
    if (key.cooldownUntilMs !== null && key.cooldownUntilMs <= now) {
      key.cooldownUntilMs = null;
      if (
        key.status === "rate_limited" ||
        key.status === "cooldown" ||
        key.status === "forbidden" ||
        key.status === "quota_exhausted"
      ) {
        key.status = key.enabled ? "healthy" : "disabled";
      }
      key.dirty = true;
    }
  }

  private availableKeys(now: number): RuntimeKey[] {
    const today = utcDayKey(now);
    const result: RuntimeKey[] = [];
    for (const key of this.keys) {
      if (key.quotaDate !== today) {
        key.quotaDate = today;
        key.quotaUsedToday = 0;
      }
      this.refreshKey(key, now);

      if (!key.enabled || !key.decryptable) continue;
      // `quota_exhausted` is terminal for the day: retrying it costs a request
      // and always fails, so it must not be offered as a usable key.
      if (
        key.status === "invalid" ||
        key.status === "disabled" ||
        key.status === "forbidden" ||
        key.status === "quota_exhausted"
      ) {
        continue;
      }
      if (key.cooldownUntilMs !== null) continue;
      if (key.inFlight >= this.perKeyConcurrency) continue;
      if (this.rpmLimit > 0 && key.window.length >= this.rpmLimit) continue;
      if (this.dailyQuota !== null && key.quotaUsedToday >= this.dailyQuota) continue;
      result.push(key);
    }
    return result;
  }

  private pick(candidates: RuntimeKey[]): RuntimeKey | null {
    if (candidates.length === 0) return null;
    switch (this.strategy) {
      case "random":
        return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
      case "weighted_random": {
        const total = candidates.reduce((sum, key) => sum + key.weight, 0);
        let ticket = Math.random() * total;
        for (const key of candidates) {
          ticket -= key.weight;
          if (ticket <= 0) return key;
        }
        return candidates[candidates.length - 1] ?? null;
      }
      case "least_used": {
        let best = candidates[0]!;
        for (const key of candidates.slice(1)) {
          if (key.requestCount < best.requestCount) best = key;
          else if (key.requestCount === best.requestCount) {
            const bestUsed = best.lastUsedAtMs ?? 0;
            const keyUsed = key.lastUsedAtMs ?? 0;
            if (keyUsed < bestUsed) best = key;
          }
        }
        return best;
      }
      case "failover": {
        // Keys are kept in insertion order; the first healthy key always wins.
        return candidates[0] ?? null;
      }
      case "round_robin":
      default: {
        for (let offset = 0; offset < this.keys.length; offset += 1) {
          const index = (this.cursor + offset) % this.keys.length;
          const key = this.keys[index];
          if (!key) continue;
          if (candidates.includes(key)) {
            this.cursor = (index + 1) % this.keys.length;
            return key;
          }
        }
        return candidates[0] ?? null;
      }
    }
  }

  private snapshotKey(key: RuntimeKey): KeyRuntimeSnapshot {
    return {
      id: key.id,
      label: key.label,
      maskedKey: key.maskedKey,
      status: key.status,
      inFlight: key.inFlight,
      peakInFlight: key.peakInFlight,
      rpmUsed: key.window.length,
      quotaUsedToday: key.quotaUsedToday,
      quotaDate: key.quotaDate,
      requestCount: key.requestCount,
      successCount: key.successCount,
      failureCount: key.failureCount,
      consecutiveFailures: key.consecutiveFailures,
      avgLatencyMs: key.avgLatencyMs === null ? null : Math.round(key.avgLatencyMs),
      cooldownUntil: key.cooldownUntilMs === null ? null : new Date(key.cooldownUntilMs).toISOString(),
      lastUsedAt: key.lastUsedAtMs === null ? null : new Date(key.lastUsedAtMs).toISOString(),
      lastFailureAt:
        key.lastFailureAtMs === null ? null : new Date(key.lastFailureAtMs).toISOString(),
      lastErrorCode: key.lastErrorCode,
      lastErrorMessage: key.lastErrorMessage,
      enabled: key.enabled,
      weight: key.weight,
    };
  }

  private emitDirty(key: RuntimeKey): void {
    if (!this.onDirty) return;
    // Copy now: the flusher may batch this snapshot asynchronously.
    this.onDirty(this.snapshotKey(key));
  }
}

export class KeyLease {
  private released = false;

  constructor(
    private readonly scheduler: KeyScheduler,
    readonly keyId: string,
    readonly keyLabel: string,
    readonly acquiredAt: number,
    private readonly accountReservation: AccountQuotaReservation | null = null,
    private readonly previousLastUsedAtMs: number | null = null,
    private readonly countedDaily: boolean = false,
    private readonly quotaDateAtReserve: string | null = null,
  ) {}

  release(outcome: KeyReleaseOutcome): void {
    if (this.released) return;
    this.released = true;
    const latencyMs = outcome.latencyMs ?? Date.now() - this.acquiredAt;
    this.scheduler.release(
      this.keyId,
      { ...outcome, latencyMs },
      Date.now(),
      this.accountReservation,
      this.previousLastUsedAtMs,
      this.acquiredAt,
      this.countedDaily,
      this.quotaDateAtReserve,
    );
  }
}
