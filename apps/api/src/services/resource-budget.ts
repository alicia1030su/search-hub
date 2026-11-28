import { SearchHubError } from "@search-hub/shared";

export type BudgetState = "normal" | "warning" | "critical" | "recovering";

export type ResourceBudgetKind = "concurrency" | "embeddingBatch";

export interface ResourceSample {
  rssRatio?: number | null;
  heapRatio?: number | null;
  queueRatio?: number | null;
  inFlightRatio?: number | null;
}

export type ResourceBudgetReason =
  | "normal"
  | "pressure_warning"
  | "pressure_critical"
  | "recovering"
  | "recovering_step"
  | "recovered"
  | "stale_sample"
  | "sample_failure_limit"
  | "hard_limit_lowered"
  | "hard_limit_raised"
  | "initial_state";

export interface ResourceBudgetSnapshot {
  state: BudgetState;
  stateSince: string | null;
  lastTransitionReason: ResourceBudgetReason;
  budget: number;
  hardMax: number;
  minBudget: number;
  pressure: number | null;
  reason: ResourceBudgetReason;
  staleSamples: number;
  lowPressureSamples: number;
  stateSamples: number;
  sampledAt: string | null;
  budgets: Record<ResourceBudgetKind, number>;
}

export interface ResourceBudgetControllerOptions {
  minBudget: number;
  hardMax: number;
  sample: () => ResourceSample | null | undefined;
  clock?: () => number;
}

const SAMPLE_INTERVAL_MS = 1_000;
const WARNING_THRESHOLD = 0.75;
const CRITICAL_THRESHOLD = 0.9;
const RECOVERY_THRESHOLD = 0.55;
const STATE_DWELL_SAMPLES = 3;
const RECOVERY_STEP_SAMPLES = 3;
const RECOVERY_STEPS = 4;
const SAMPLE_FAILURE_LIMIT = 3;

export function calculateResourcePressure(sample: ResourceSample | null | undefined): number | null {
  if (!sample) return null;
  let pressure: number | null = null;
  for (const ratio of [sample.rssRatio, sample.heapRatio, sample.queueRatio, sample.inFlightRatio]) {
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) continue;
    pressure = pressure === null ? ratio : Math.max(pressure, ratio);
  }
  return pressure;
}

export class ResourceBudgetController {
  private state: BudgetState = "normal";
  private stateSince: string | null;
  private lastTransitionReason: ResourceBudgetReason = "initial_state";
  private budget: number;
  private pressure: number | null = null;
  private reason: ResourceBudgetReason = "normal";
  private staleSamples = 0;
  private lowPressureSamples = 0;
  private stateSamples = 0;
  private sampledAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: () => number;

  constructor(private readonly options: ResourceBudgetControllerOptions) {
    if (!Number.isSafeInteger(options.minBudget) || options.minBudget < 1) {
      throw new RangeError("minBudget must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.hardMax) || options.hardMax < 8 || options.hardMax < options.minBudget) {
      throw new RangeError("hardMax must be a safe integer greater than or equal to 8 and minBudget");
    }
    this.budget = options.hardMax;
    this.clock = options.clock ?? (() => Date.now());
    this.stateSince = this.readClock();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sampleOnce(), SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ResourceBudgetSnapshot {
    return {
      state: this.state,
      stateSince: this.stateSince,
      lastTransitionReason: this.lastTransitionReason,
      budget: this.budget,
      hardMax: this.options.hardMax,
      minBudget: this.options.minBudget,
      pressure: this.pressure,
      reason: this.reason,
      staleSamples: this.staleSamples,
      lowPressureSamples: this.lowPressureSamples,
      stateSamples: this.stateSamples,
      sampledAt: this.sampledAt,
      budgets: {
        concurrency: this.budgetFor("concurrency"),
        embeddingBatch: this.budgetFor("embeddingBatch"),
      },
    };
  }

  setHardLimit(hardMax: number): void {
    if (!Number.isSafeInteger(hardMax) || hardMax < 8 || hardMax < this.options.minBudget) {
      throw new RangeError("hardMax must be a safe integer greater than or equal to 8 and minBudget");
    }
    const previousHardMax = this.options.hardMax;
    if (hardMax === previousHardMax) return;
    this.options.hardMax = hardMax;

    if (this.state === "normal") {
      this.budget = hardMax;
    } else if (this.state === "warning") {
      this.budget = this.warningBudget();
    } else if (this.state === "critical") {
      this.budget = this.options.minBudget;
    } else {
      this.budget = Math.min(this.budget, hardMax);
      if (this.budget === hardMax) this.transition("normal", "recovered");
    }
    this.reason = hardMax < previousHardMax ? "hard_limit_lowered" : "hard_limit_raised";
  }

  budgetFor(kind: ResourceBudgetKind): number {
    if (kind === "concurrency") return Math.max(1, Math.floor(this.budget));
    return Math.min(this.options.hardMax, Math.max(8, Math.floor(this.budget / 8) * 8));
  }

  private sampleOnce(): void {
    const now = this.readClock();
    let sample: ResourceSample | null | undefined;
    try {
      sample = this.options.sample();
    } catch {
      sample = null;
    }
    const pressure = calculateResourcePressure(sample);
    if (pressure === null) {
      this.recordSampleFailure(now);
      return;
    }

    this.pressure = pressure;
    this.sampledAt = now;
    this.staleSamples = 0;
    this.stateSamples += 1;

    if (this.state === "normal") {
      if (pressure >= CRITICAL_THRESHOLD) this.transition("critical", "pressure_critical", now);
      else if (pressure >= WARNING_THRESHOLD) this.transition("warning", "pressure_warning", now);
      else {
        this.lowPressureSamples = 0;
        this.budget = this.options.hardMax;
        this.reason = "normal";
      }
      return;
    }

    if (this.state === "warning") {
      if (pressure >= CRITICAL_THRESHOLD) {
        this.transition("critical", "pressure_critical", now);
        return;
      }
      if (this.stateSamples >= STATE_DWELL_SAMPLES) {
        if (pressure <= RECOVERY_THRESHOLD) {
          this.transition("recovering", "recovering", now);
          return;
        }
        if (pressure < WARNING_THRESHOLD) {
          this.transition("normal", "recovered", now);
          return;
        }
      }
      this.lowPressureSamples = 0;
      this.budget = Math.min(this.budget, this.warningBudget());
      this.reason = "pressure_warning";
      return;
    }

    if (this.state === "critical") {
      this.lowPressureSamples = pressure <= RECOVERY_THRESHOLD ? this.lowPressureSamples + 1 : 0;
      if (this.stateSamples >= STATE_DWELL_SAMPLES && this.lowPressureSamples >= STATE_DWELL_SAMPLES) {
        this.transition("recovering", "recovering", now);
        return;
      }
      if (this.stateSamples >= STATE_DWELL_SAMPLES && pressure < CRITICAL_THRESHOLD) {
        this.transition("warning", "pressure_warning", now);
        return;
      }
      this.budget = this.options.minBudget;
      this.reason = "pressure_critical";
      return;
    }

    if (pressure >= CRITICAL_THRESHOLD) {
      this.transition("critical", "pressure_critical", now);
      return;
    }
    if (pressure >= WARNING_THRESHOLD) {
      this.transition("warning", "pressure_warning", now);
      return;
    }

    this.lowPressureSamples += 1;
    if (this.lowPressureSamples < RECOVERY_STEP_SAMPLES) {
      this.reason = "recovering";
      return;
    }

    this.lowPressureSamples = 0;
    if (this.budget >= this.options.hardMax) {
      this.transition("normal", "recovered", now);
      return;
    }
    const step = Math.ceil((this.options.hardMax - this.options.minBudget) / RECOVERY_STEPS);
    this.budget = Math.min(this.options.hardMax, this.budget + step);
    if (this.budget === this.options.hardMax) this.transition("normal", "recovered", now);
    else this.reason = "recovering_step";
  }

  private recordSampleFailure(sampledAt: string | null): void {
    this.sampledAt = sampledAt;
    this.staleSamples += 1;
    this.lowPressureSamples = 0;
    this.stateSamples = 0;
    if (this.staleSamples < SAMPLE_FAILURE_LIMIT) {
      this.reason = "stale_sample";
      return;
    }
    if (this.state !== "critical") this.transition("critical", "sample_failure_limit", sampledAt);
    else {
      this.budget = this.options.minBudget;
      this.reason = "sample_failure_limit";
    }
  }

  private transition(state: BudgetState, reason: ResourceBudgetReason, stateSince: string | null = this.readClock()): void {
    this.state = state;
    this.stateSince = stateSince;
    this.lastTransitionReason = reason;
    this.reason = reason;
    this.stateSamples = 0;
    this.lowPressureSamples = 0;
    if (state === "normal") this.budget = this.options.hardMax;
    else if (state === "warning") this.budget = this.warningBudget();
    else if (state === "critical") this.budget = this.options.minBudget;
    else this.budget = this.options.minBudget;
  }

  private warningBudget(): number {
    return Math.max(this.options.minBudget, Math.floor(0.5 * this.options.hardMax));
  }

  private readClock(): string | null {
    try {
      const value = this.clock();
      return Number.isFinite(value) ? new Date(value).toISOString() : null;
    } catch {
      return null;
    }
  }
}

export interface ResourceSlotLimiter {
  acquire(signal?: AbortSignal, deadlineAtMs?: number): Promise<() => void>;
}

interface SlotWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: NodeJS.Timeout;
}

/** Bounded, cancellation-aware semaphore used by search and webpage extraction. */
export class ResourceSemaphore implements ResourceSlotLimiter {
  private active = 0;
  private readonly waiters: SlotWaiter[] = [];

  constructor(
    private readonly limit: () => number,
    private readonly maxWaiters = 256,
  ) {}

  acquire(signal?: AbortSignal, deadlineAtMs?: number): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("cancelled"));
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
      return Promise.reject(new SearchHubError("timeout", "Resource wait deadline exceeded", { status: 504, retryable: true }));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SlotWaiter = { resolve, reject, signal };
      const cleanup = (): void => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      };
      const fail = (error: unknown): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        cleanup();
        reject(error);
      };
      waiter.onAbort = () => fail(signal?.reason ?? new Error("cancelled"));
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (deadlineAtMs !== undefined) {
        waiter.timer = setTimeout(() => fail(new SearchHubError("timeout", "Resource wait deadline exceeded", { status: 504, retryable: true })), Math.max(0, deadlineAtMs - Date.now()));
        waiter.timer.unref?.();
      }

      if (this.waiters.length === 0 && this.active < this.limit()) {
        cleanup();
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active = Math.max(0, this.active - 1);
          this.pump();
        });
        return;
      }
      if (this.waiters.length >= this.maxWaiters) {
        fail(new SearchHubError("rate_limited", "Resource wait queue is full", { status: 429, retryable: true }));
        return;
      }
      this.waiters.push(waiter);
    });
  }

  dispose(): void {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("resource pool shut down"));
    }
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.active < this.limit()) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.pump();
      });
    }
  }
}
