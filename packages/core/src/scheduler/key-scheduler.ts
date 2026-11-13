import type { KeyStatus, KeyStrategy } from "@search-hub/shared";

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
    this.keys = options.keys.map((seed) => this.toRuntimeKey(seed));
  }

  get keyCount(): number {
    return this.keys.length;
  }

  hasKeys(): boolean {
    return this.keys.length > 0;
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
      if (!seed.enabled) existing.status = "disabled";
      else if (existing.status === "disabled" && seed.enabled) existing.status = "healthy";
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
  ): Promise<{ lease: KeyLease | null; reason?: "no_key" | "queue_timeout" }> {
    const immediate = this.tryAcquire();
    if (immediate) return { lease: immediate };

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
      if (!key.enabled) continue;
      if (key.status === "invalid" || key.status === "disabled") continue;
      this.refreshKey(key, now);
      if (key.cooldownUntilMs !== null && key.cooldownUntilMs - now > 60_000) continue;
      if (this.dailyQuota !== null && key.quotaUsedToday >= this.dailyQuota) continue;
      if (this.rpmLimit > 0 && key.window.length >= this.rpmLimit) continue;
      return true;
    }
    return false;
  }

  /**
   * Atomically selects a key and reserves one concurrency slot.
   * Returns null when no key can serve the request right now.
   */
  tryAcquire(now: number = Date.now()): KeyLease | null {
    const available = this.availableKeys(now);
    if (available.length === 0) return null;

    const selected = this.pick(available);
    if (!selected) return null;

    // --- critical section: no awaits below this line ---
    selected.inFlight += 1;
    if (selected.inFlight > selected.peakInFlight) selected.peakInFlight = selected.inFlight;
    selected.requestCount += 1;
    selected.lastUsedAtMs = now;
    selected.window.push(now);
    if (this.dailyQuota !== null) selected.quotaUsedToday += 1;
    selected.dirty = true;
    this.emitDirty(selected);
    // --- critical section end ---

    return new KeyLease(this, selected.id, selected.label, now);
  }

  /** Called by a lease; idempotent. */
  release(keyId: string, outcome: KeyReleaseOutcome, now: number = Date.now()): void {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return;

    key.inFlight = Math.max(0, key.inFlight - 1);
    if (outcome.cancelled) {
      key.dirty = true;
      this.emitDirty(key);
      this.wakeOne();
      return;
    }

    if (outcome.ok) {
      key.successCount += 1;
      key.consecutiveFailures = 0;
      if (outcome.latencyMs !== undefined) {
        key.avgLatencyMs =
          key.avgLatencyMs === null
            ? outcome.latencyMs
            : key.avgLatencyMs * 0.7 + outcome.latencyMs * 0.3;
      }
      if (key.status === "rate_limited" || key.status === "cooldown") {
        key.cooldownUntilMs = null;
        key.status = "healthy";
      } else if (key.status === "unknown") {
        key.status = "healthy";
      } else if (key.status === "invalid") {
        // A real successful call proves the credential still works.
        key.status = "healthy";
        key.lastErrorCode = null;
        key.lastErrorMessage = null;
      }
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
          key.status = "cooldown";
          key.cooldownUntilMs = outcome.retryAfterMs
            ? now + outcome.retryAfterMs
            : nextUtcMidnight(now) + 1000;
          break;
        }
        case "auth_invalid": {
          key.status = "invalid";
          key.cooldownUntilMs = null;
          break;
        }
        case "timeout":
        case "network":
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

  /** Returns and clears the dirty flags; used by the API persistence flusher. */
  drainDirty(): KeyRuntimeSnapshot[] {
    const dirty = this.keys.filter((key) => key.dirty);
    for (const key of dirty) key.dirty = false;
    return dirty.map((key) => this.snapshotKey(key));
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
      if (key.status === "rate_limited" || key.status === "cooldown") {
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

      if (!key.enabled) continue;
      if (key.status === "invalid" || key.status === "disabled") continue;
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
  ) {}

  release(outcome: KeyReleaseOutcome): void {
    if (this.released) return;
    this.released = true;
    const latencyMs = outcome.latencyMs ?? Date.now() - this.acquiredAt;
    this.scheduler.release(this.keyId, { ...outcome, latencyMs });
  }
}
