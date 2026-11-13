import { describe, expect, it } from "vitest";
import { KeyScheduler, type SchedulerKeySeed } from "../../packages/core/src/index.js";

function seed(id: string, weight = 100): SchedulerKeySeed {
  return {
    id,
    label: id,
    maskedKey: `…${id.slice(-4)}`,
    weight,
    enabled: true,
    status: "healthy",
  };
}

describe("KeyScheduler three-tier limits (AC-05)", () => {
  it("never exceeds per-key concurrency under 100 concurrent acquires", async () => {
    const scheduler = new KeyScheduler({
      providerId: "p",
      strategy: "round_robin",
      perKeyConcurrency: 2,
      rpmLimit: 10_000,
      dailyQuota: null,
      cooldownMs: 30_000,
      breakerThreshold: 5,
      keys: [seed("k1"), seed("k2"), seed("k3")],
    });

    // Each task acquires, holds the slot briefly, then releases. Starting all
    // 100 tasks at once is what creates the burst; releasing inside the task
    // (not after Promise.all) is required or the queue can never drain.
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const lease = await scheduler.acquire({ maxWaitMs: 10_000 });
        if (!lease) return null;
        await new Promise((resolve) => setTimeout(resolve, 12));
        lease.release({ ok: true, latencyMs: 12 });
        return lease;
      }),
    );

    // 3 keys × 2 slots = 6 concurrent slots; 100 requests need ~17 rounds.
    expect(outcomes.filter((lease) => lease !== null).length).toBe(100);
    const snapshot = scheduler.snapshot();
    for (const key of snapshot) {
      expect(key.peakInFlight, `key ${key.id} peak`).toBeLessThanOrEqual(2);
      expect(key.inFlight).toBe(0);
    }
    // The peak must actually reach the configured ceiling, otherwise the test
    // would pass on a fully serialised implementation.
    const maxPeak = Math.max(...snapshot.map((key) => key.peakInFlight));
    expect(maxPeak).toBe(2);
    expect(snapshot.reduce((sum, key) => sum + key.requestCount, 0)).toBeGreaterThanOrEqual(100);
  });

  it("enforces the per-key RPM window even when concurrency is free", async () => {
    const scheduler = new KeyScheduler({
      providerId: "p",
      strategy: "round_robin",
      perKeyConcurrency: 32,
      rpmLimit: 10,
      dailyQuota: null,
      cooldownMs: 1_000,
      breakerThreshold: 5,
      keys: [seed("k1")],
    });

    let acquired = 0;
    for (let index = 0; index < 20; index += 1) {
      const lease = scheduler.tryAcquire();
      if (!lease) continue;
      acquired += 1;
      lease.release({ ok: true, latencyMs: 1 });
      if (index === 9) {
        // First 10 within the rolling window consume the RPM budget.
        expect(acquired).toBe(10);
      }
    }
    // Requests 1..10 succeed, and at least the first few of 11..20 must be
    // rejected: the window only slides forward as time passes.
    expect(acquired).toBe(10);
    const snapshot = scheduler.snapshot();
    expect(snapshot[0]!.rpmUsed).toBe(10);
    expect(snapshot[0]!.status === "healthy" || snapshot[0]!.status === "cooldown").toBe(true);

    const rejected = scheduler.tryAcquire();
    expect(rejected).toBeNull();
  });

  it("enforces a daily quota independently of concurrency and RPM", () => {
    const scheduler = new KeyScheduler({
      providerId: "p",
      strategy: "round_robin",
      perKeyConcurrency: 64,
      rpmLimit: 10_000,
      dailyQuota: 3,
      cooldownMs: 1_000,
      breakerThreshold: 5,
      keys: [seed("k1")],
    });

    const leases = Array.from({ length: 3 }, () => scheduler.tryAcquire());
    expect(leases.every((lease) => lease !== null)).toBe(true);
    for (const lease of leases) lease?.release({ ok: true, latencyMs: 1 });

    expect(scheduler.tryAcquire()).toBeNull();
    const snapshot = scheduler.snapshot();
    expect(snapshot[0]!.quotaUsedToday).toBe(3);
    expect(snapshot[0]!.status).toBe("healthy");
  });

  it("distinguishes a saturated pool (queue_timeout) from an unusable one (no_key)", async () => {
    const scheduler = new KeyScheduler({
      providerId: "p",
      strategy: "round_robin",
      perKeyConcurrency: 1,
      rpmLimit: 10_000,
      dailyQuota: null,
      cooldownMs: 1_000,
      breakerThreshold: 5,
      keys: [seed("k1")],
    });

    const held = scheduler.tryAcquire();
    expect(held).not.toBeNull();
    // Pool is saturated but usable: the caller must be told it timed out queueing.
    const saturated = await scheduler.acquireWithReason({ maxWaitMs: 250 });
    expect(saturated.lease).toBeNull();
    expect(saturated.reason).toBe("queue_timeout");
    held?.release({ ok: true, latencyMs: 1 });

    // A key in long cooldown means no key can serve now.
    const lease = scheduler.tryAcquire();
    expect(lease).not.toBeNull();
    lease?.release({ ok: false, code: "auth_invalid", message: "bad key" });
    const unusable = await scheduler.acquireWithReason({ maxWaitMs: 250 });
    expect(unusable.lease).toBeNull();
    expect(unusable.reason).toBe("no_key");
  });

  it("wakes a parked waiter as soon as a slot is released", async () => {
    const scheduler = new KeyScheduler({
      providerId: "p",
      strategy: "round_robin",
      perKeyConcurrency: 1,
      rpmLimit: 10_000,
      dailyQuota: null,
      cooldownMs: 1_000,
      breakerThreshold: 5,
      keys: [seed("k1")],
    });

    const first = scheduler.tryAcquire();
    expect(first).not.toBeNull();
    const startedAt = Date.now();
    const waiting = scheduler.acquire({ maxWaitMs: 1_000 });
    // Release after 80ms; the waiter should be woken well before its 250ms poll ceiling.
    setTimeout(() => first?.release({ ok: true, latencyMs: 1 }), 80);
    const second = await waiting;
    const waited = Date.now() - startedAt;
    expect(second).not.toBeNull();
    expect(waited).toBeLessThan(600);
    second?.release({ ok: true, latencyMs: 1 });
  });
});
