import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateResourcePressure,
  ResourceBudgetController,
  ResourceSemaphore,
  type ResourceSample,
} from "../../apps/api/src/services/resource-budget.js";

const controllers: ResourceBudgetController[] = [];

function createController(options: { minBudget?: number; hardMax?: number; sample?: () => ResourceSample | null } = {}) {
  const controller = new ResourceBudgetController({
    minBudget: options.minBudget ?? 4,
    hardMax: options.hardMax ?? 32,
    sample: options.sample ?? (() => ({ rssRatio: 0.1 })),
    clock: () => Date.now(),
  });
  controllers.push(controller);
  return controller;
}

function tick(samples = 1): void {
  vi.advanceTimersByTime(samples * 1_000);
}

function lowSample(pressure = 0.5): ResourceSample {
  return { rssRatio: pressure };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resource pressure", () => {
  it("uses the maximum valid ratio and ignores missing or invalid signals", () => {
    expect(calculateResourcePressure({ rssRatio: 0.2, heapRatio: null, queueRatio: 0.8, inFlightRatio: Number.NaN })).toBe(0.8);
    expect(calculateResourcePressure({ rssRatio: 0.2, heapRatio: undefined, queueRatio: -1, inFlightRatio: Number.POSITIVE_INFINITY })).toBe(0.2);
  });

  it("returns null when no signal is valid instead of treating missing signals as zero", () => {
    expect(calculateResourcePressure({})).toBeNull();
    expect(calculateResourcePressure({ rssRatio: null, heapRatio: Number.NaN })).toBeNull();
    expect(calculateResourcePressure(null)).toBeNull();
  });
});

describe("resource budget thresholds and hysteresis", () => {
  it("crosses the exact normal, warning and critical boundaries", () => {
    let pressure = 0.7499;
    const controller = createController({ sample: () => lowSample(pressure) });
    expect(controller.snapshot()).toMatchObject({
      state: "normal",
      stateSince: "2026-11-28T00:00:00.000Z",
      lastTransitionReason: "initial_state",
    });
    controller.start();

    tick();
    expect(controller.snapshot()).toMatchObject({ state: "normal", budget: 32, pressure: 0.7499 });

    pressure = 0.75;
    tick();
    expect(controller.snapshot()).toMatchObject({
      state: "warning",
      stateSince: "2026-11-28T00:00:02.000Z",
      lastTransitionReason: "pressure_warning",
      budget: 16,
      reason: "pressure_warning",
    });

    pressure = 0.9;
    tick();
    expect(controller.snapshot()).toMatchObject({
      state: "critical",
      stateSince: "2026-11-28T00:00:03.000Z",
      lastTransitionReason: "pressure_critical",
      budget: 4,
      reason: "pressure_critical",
    });
  });

  it("moves warning directly to recovering at P<=0.55 without dwell", () => {
    let pressure = 0.8;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.55;
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "recovering", budget: 4, reason: "recovering" });
  });

  it("returns warning directly to normal when 0.55<P<0.75", () => {
    let pressure = 0.8;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.5501;
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "normal", budget: 32, reason: "recovered" });
  });

  it("does not recover warning while pressure remains at or above 0.75", () => {
    const controller = createController({ sample: () => lowSample(0.75) });
    controller.start();
    tick(5);
    expect(controller.snapshot()).toMatchObject({ state: "warning", budget: 16, reason: "pressure_warning" });
  });

  it("moves warning directly to critical without waiting for hysteresis", () => {
    let pressure = 0.8;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.9;
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "critical", budget: 4 });
  });

  it("requires three consecutive P<=0.55 samples before critical enters recovering", () => {
    let pressure = 0.95;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.55;
    tick(2);
    expect(controller.snapshot()).toMatchObject({ state: "critical", lowPressureSamples: 2, budget: 4 });

    tick();
    expect(controller.snapshot()).toMatchObject({ state: "recovering", budget: 4, lowPressureSamples: 0 });
  });

  it("resets the critical low-pressure streak when pressure rises above 0.55", () => {
    let pressure = 0.95;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.5;
    tick();
    expect(controller.snapshot().lowPressureSamples).toBe(1);

    pressure = 0.5501;
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "critical", lowPressureSamples: 0 });
  });

  it("drops critical to warning after three samples below 0.90 but not low enough to recover", () => {
    let pressure = 0.95;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.6;
    tick(2);
    expect(controller.snapshot().state).toBe("critical");
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "warning", budget: 16, reason: "pressure_warning" });
  });

  it("keeps critical under sustained high pressure and downgrades as soon as P<0.90 after dwell", () => {
    let pressure = 0.95;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick(4);
    expect(controller.snapshot().state).toBe("critical");

    pressure = 0.8999;
    tick();
    expect(controller.snapshot().state).toBe("warning");
  });
});

describe("resource budget recovery", () => {
  it("steps from minBudget in four ceil-sized increments and then returns to normal", () => {
    let pressure = 0.95;
    const controller = createController({ hardMax: 40, minBudget: 4, sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.5;
    tick(3);
    expect(controller.snapshot()).toMatchObject({
      state: "recovering",
      stateSince: "2026-11-28T00:00:04.000Z",
      lastTransitionReason: "recovering",
      budget: 4,
    });

    tick(3);
    expect(controller.snapshot()).toMatchObject({
      state: "recovering",
      stateSince: "2026-11-28T00:00:04.000Z",
      lastTransitionReason: "recovering",
      budget: 13,
      reason: "recovering_step",
    });
    tick(3);
    expect(controller.snapshot().budget).toBe(22);
    tick(3);
    expect(controller.snapshot().budget).toBe(31);
    tick(3);
    expect(controller.snapshot()).toMatchObject({ state: "normal", budget: 40, reason: "recovered" });
  });

  it("resets recovery progress and returns to warning when pressure reaches 0.75", () => {
    let pressure = 0.95;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();

    pressure = 0.5;
    tick(6);
    expect(controller.snapshot()).toMatchObject({ state: "recovering", budget: 11 });

    pressure = 0.75;
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "warning", budget: 16, lowPressureSamples: 0 });

    pressure = 0.5;
    tick(3);
    expect(controller.snapshot()).toMatchObject({ state: "recovering", budget: 4 });
  });

  it("returns recovering directly to critical at P>=0.90", () => {
    let pressure = 0.95;
    const controller = createController({ sample: () => lowSample(pressure) });
    controller.start();
    tick();
    pressure = 0.5;
    tick(3);

    pressure = 0.9;
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "critical", budget: 4 });
  });
});

describe("resource sample failures", () => {
  it("holds the previous budget for two failures, then fails closed to critical/minBudget", () => {
    let sample: ResourceSample | null = lowSample(0.8);
    const controller = createController({ sample: () => sample });
    controller.start();
    tick();
    expect(controller.snapshot().budget).toBe(16);

    sample = null;
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "warning", budget: 16, staleSamples: 1, reason: "stale_sample" });
    tick();
    expect(controller.snapshot()).toMatchObject({ state: "warning", budget: 16, staleSamples: 2, reason: "stale_sample" });
    tick();
    expect(controller.snapshot()).toMatchObject({
      state: "critical",
      stateSince: "2026-11-28T00:00:04.000Z",
      lastTransitionReason: "sample_failure_limit",
      budget: 4,
      staleSamples: 3,
      reason: "sample_failure_limit",
    });
  });

  it("keeps transition metadata stable for stale samples and non-transition limit changes", () => {
    let sample: ResourceSample | null = lowSample(0.8);
    const controller = createController({ sample: () => sample });
    controller.start();
    tick();
    const transition = {
      stateSince: "2026-11-28T00:00:01.000Z",
      lastTransitionReason: "pressure_warning",
    };

    sample = null;
    tick();
    expect(controller.snapshot()).toMatchObject(transition);
    controller.setHardLimit(20);
    expect(controller.snapshot()).toMatchObject(transition);
  });

  it("treats thrown samples and samples without valid ratios as failures", () => {
    let mode: "throw" | "empty" | "valid" = "throw";
    const controller = createController({
      sample: () => {
        if (mode === "throw") throw new Error("sample unavailable");
        return mode === "empty" ? { rssRatio: Number.NaN } : lowSample(0.1);
      },
    });
    controller.start();

    tick(3);
    expect(controller.snapshot()).toMatchObject({ state: "critical", budget: 4, staleSamples: 3 });
    mode = "empty";
    tick();
    expect(controller.snapshot().staleSamples).toBe(4);
    mode = "valid";
    tick(3);
    expect(controller.snapshot()).toMatchObject({ state: "recovering", staleSamples: 0, budget: 4 });
  });

  it("requires three fresh low-pressure samples after failures before recovery", () => {
    let sample: ResourceSample | null = null;
    const controller = createController({ sample: () => sample });
    controller.start();
    tick(3);

    sample = lowSample(0.5);
    tick(2);
    expect(controller.snapshot().state).toBe("critical");
    tick();
    expect(controller.snapshot().state).toBe("recovering");
  });

  it("resets the low-pressure streak when a sample fails during recovery qualification", () => {
    let sample: ResourceSample | null = null;
    const controller = createController({ sample: () => sample });
    controller.start();
    tick(3);

    sample = lowSample(0.5);
    tick(2);
    sample = null;
    tick();
    sample = lowSample(0.5);
    tick(2);
    expect(controller.snapshot()).toMatchObject({ state: "critical", lowPressureSamples: 2 });
    tick();
    expect(controller.snapshot().state).toBe("recovering");
  });
});

describe("resource budget limits and timer lifecycle", () => {
  it("quantizes concurrency down to at least one and embedding batches down to a multiple of eight", () => {
    let pressure = 0.1;
    const controller = createController({ hardMax: 31, minBudget: 3, sample: () => lowSample(pressure) });
    expect(controller.budgetFor("concurrency")).toBe(31);
    expect(controller.budgetFor("embeddingBatch")).toBe(24);

    pressure = 0.8;
    controller.start();
    tick();
    expect(controller.snapshot().budgets).toEqual({ concurrency: 15, embeddingBatch: 8 });

    pressure = 0.95;
    tick();
    expect(controller.snapshot().budgets).toEqual({ concurrency: 3, embeddingBatch: 8 });
  });

  it("keeps hardMax unchanged when it equals minBudget", () => {
    const controller = createController({ hardMax: 8, minBudget: 8 });
    controller.start();
    tick(4);
    expect(controller.snapshot()).toMatchObject({ state: "normal", budget: 8 });
    expect(controller.budgetFor("concurrency")).toBe(8);
  });

  it("applies a lowered administrator hardMax immediately in every state", () => {
    let pressure = 0.1;
    const normal = createController({ sample: () => lowSample(pressure) });
    normal.setHardLimit(12);
    expect(normal.snapshot()).toMatchObject({ state: "normal", budget: 12, reason: "hard_limit_lowered" });

    pressure = 0.8;
    const warning = createController({ sample: () => lowSample(pressure) });
    warning.start();
    tick();
    warning.setHardLimit(10);
    expect(warning.snapshot()).toMatchObject({ state: "warning", budget: 5 });

    pressure = 0.95;
    const critical = createController({ sample: () => lowSample(pressure) });
    critical.start();
    tick();
    critical.setHardLimit(8);
    expect(critical.snapshot()).toMatchObject({ state: "critical", budget: 4 });
  });

  it("clamps an in-progress recovery when the administrator lowers hardMax", () => {
    let pressure = 0.95;
    const controller = createController({ hardMax: 40, minBudget: 4, sample: () => lowSample(pressure) });
    controller.start();
    tick();
    pressure = 0.5;
    tick(9);
    expect(controller.snapshot()).toMatchObject({ state: "recovering", budget: 22 });

    controller.setHardLimit(20);
    expect(controller.snapshot()).toMatchObject({
      state: "normal",
      stateSince: "2026-11-28T00:00:10.000Z",
      lastTransitionReason: "recovered",
      reason: "hard_limit_lowered",
      budget: 20,
      hardMax: 20,
    });
    tick(4);
    expect(controller.snapshot().budget).toBeLessThanOrEqual(20);
  });

  it("applies a raised hardMax immediately in normal state", () => {
    const controller = createController();
    controller.start();
    tick();
    controller.setHardLimit(64);
    expect(controller.snapshot()).toMatchObject({ state: "normal", budget: 64, hardMax: 64, reason: "hard_limit_raised" });
    tick();
    expect(controller.snapshot().budget).toBe(64);
  });

  it("uses a one-second unref timer, starts idempotently and cleans up on stop", () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    let calls = 0;
    const controller = createController({ sample: () => { calls += 1; return lowSample(0.1); } });

    controller.start();
    controller.start();
    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(1_000);
    const timer = intervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);

    tick();
    expect(calls).toBe(1);
    expect(controller.snapshot().sampledAt).toBe("2026-11-28T00:00:01.000Z");

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
    tick(3);
    expect(calls).toBe(1);

    controller.start();
    tick();
    expect(calls).toBe(2);
    controller.stop();
  });

  it("rejects invalid budget limits and accepts the minimum valid hardMax", () => {
    expect(() => createController({ minBudget: 0 })).toThrow(RangeError);
    expect(() => createController({ minBudget: 8, hardMax: 7 })).toThrow(RangeError);
    expect(() => createController({ hardMax: 1.5 })).toThrow(RangeError);

    const controller = createController({ minBudget: 1, hardMax: 8 });
    expect(controller.budgetFor("embeddingBatch")).toBe(8);
    expect(() => controller.setHardLimit(7)).toThrow(RangeError);
    expect(() => controller.setHardLimit(Number.NaN)).toThrow(RangeError);
    controller.setHardLimit(16);
    expect(() => controller.setHardLimit(7)).toThrow(RangeError);
    controller.setHardLimit(8);
    expect(controller.snapshot().hardMax).toBe(8);
  });
});

describe("resource semaphore", () => {
  it("bounds concurrency and grants waiters in order after release", async () => {
    const semaphore = new ResourceSemaphore(() => 1);
    const first = await semaphore.acquire();
    let granted = false;
    const second = semaphore.acquire().then((release) => {
      granted = true;
      return release;
    });

    await Promise.resolve();
    expect(granted).toBe(false);
    first();
    const releaseSecond = await second;
    expect(granted).toBe(true);
    releaseSecond();
  });

  it("removes aborted and expired waiters without leaking capacity", async () => {
    const semaphore = new ResourceSemaphore(() => 1);
    const held = await semaphore.acquire();
    const controller = new AbortController();
    const aborted = semaphore.acquire(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(aborted).rejects.toThrow(/cancelled/i);

    const expired = semaphore.acquire(undefined, Date.now() + 5);
    const expiration = expect(expired).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5);
    await expiration;
    held();

    const release = await semaphore.acquire();
    release();
  });

  it("rejects queued waiters when disposed", async () => {
    const semaphore = new ResourceSemaphore(() => 1);
    const held = await semaphore.acquire();
    const queued = semaphore.acquire();
    semaphore.dispose();
    await expect(queued).rejects.toThrow(/shut down/i);
    held();
  });
});
