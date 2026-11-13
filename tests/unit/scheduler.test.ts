import { describe, expect, it } from "vitest";
import { KeyScheduler, type SchedulerKeySeed } from "@search-hub/core";

function key(id: string, overrides: Partial<SchedulerKeySeed> = {}): SchedulerKeySeed {
  return {
    id,
    label: id,
    maskedKey: `…${id.slice(-4)}`,
    weight: 10,
    enabled: true,
    status: "healthy",
    ...overrides,
  };
}

function makeScheduler(options: Partial<ConstructorParameters<typeof KeyScheduler>[0]> = {}) {
  return new KeyScheduler({
    providerId: "prv_test",
    strategy: "round_robin",
    perKeyConcurrency: 3,
    rpmLimit: 1000,
    dailyQuota: null,
    cooldownMs: 30_000,
    breakerThreshold: 3,
    keys: [key("k1"), key("k2"), key("k3"), key("k4"), key("k5")],
    ...options,
  });
}

describe("KeyScheduler concurrency safety", () => {
  it("never exceeds the per-key concurrency limit under 100 concurrent acquires", () => {
    const scheduler = makeScheduler();
    const leases = [];
    for (let i = 0; i < 100; i += 1) {
      const lease = scheduler.tryAcquire();
      if (lease) leases.push(lease);
    }

    // 5 keys × 3 slots
    expect(leases.length).toBe(15);
    const snapshot = scheduler.snapshot();
    for (const item of snapshot) {
      expect(item.inFlight).toBeLessThanOrEqual(3);
    }
    expect(snapshot.reduce((sum, item) => sum + item.inFlight, 0)).toBe(15);
    // Every key must have been used: a global serialisation bug would leave 4 keys idle.
    expect(snapshot.filter((item) => item.inFlight === 3).length).toBe(5);

    for (const lease of leases) lease.release({ ok: true, latencyMs: 10 });
    expect(scheduler.snapshot().every((item) => item.inFlight === 0)).toBe(true);
  });

  it("releases slots exactly once even if release is called twice", () => {
    const scheduler = makeScheduler({ keys: [key("k1")], perKeyConcurrency: 2 });
    const lease = scheduler.tryAcquire();
    expect(lease).not.toBeNull();
    lease!.release({ ok: true, latencyMs: 5 });
    lease!.release({ ok: true, latencyMs: 5 });
    expect(scheduler.snapshot()[0]?.inFlight).toBe(0);
    expect(scheduler.snapshot()[0]?.successCount).toBe(1);
  });

  it("enforces the per-minute request limit independently of concurrency", () => {
    const scheduler = makeScheduler({ keys: [key("k1")], perKeyConcurrency: 10, rpmLimit: 5 });
    const leases = [];
    for (let i = 0; i < 20; i += 1) {
      const lease = scheduler.tryAcquire();
      if (lease) leases.push(lease);
    }
    expect(leases.length).toBe(5);
    for (const lease of leases) lease.release({ ok: true, latencyMs: 1 });
    expect(scheduler.tryAcquire()).toBeNull();
    // One minute later the window is empty again.
    expect(scheduler.tryAcquire(Date.now() + 61_000)).not.toBeNull();
  });

  it("enforces the daily quota and resets it on the next UTC day", () => {
    const scheduler = makeScheduler({
      keys: [key("k1")],
      perKeyConcurrency: 10,
      dailyQuota: 2,
      rpmLimit: 1000,
    });
    expect(scheduler.tryAcquire()).not.toBeNull();
    expect(scheduler.tryAcquire()).not.toBeNull();
    expect(scheduler.tryAcquire()).toBeNull();
    const tomorrow = Date.now() + 86_400_000;
    expect(scheduler.tryAcquire(tomorrow)).not.toBeNull();
  });
});

describe("KeyScheduler scheduling strategies", () => {
  it("round robin cycles through keys in order", () => {
    const scheduler = makeScheduler({ keys: [key("k1"), key("k2"), key("k3")], perKeyConcurrency: 1, rpmLimit: 1 });
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const lease = scheduler.tryAcquire();
      expect(lease).not.toBeNull();
      seen.push(lease!.keyId);
      lease!.release({ ok: true, latencyMs: 1 });
    }
    expect(seen).toEqual(["k1", "k2", "k3"]);
  });

  it("failover always prefers the first healthy key", () => {
    const scheduler = makeScheduler({
      keys: [key("k1"), key("k2")],
      strategy: "failover",
      perKeyConcurrency: 2,
      rpmLimit: 100,
    });
    const first = scheduler.tryAcquire();
    const second = scheduler.tryAcquire();
    expect(first?.keyId).toBe("k1");
    expect(second?.keyId).toBe("k1");
  });

  it("least_used picks the key with the fewest requests", () => {
    const scheduler = makeScheduler({
      keys: [key("k1", { requestCount: 50 }), key("k2", { requestCount: 2 }), key("k3", { requestCount: 10 })],
      strategy: "least_used",
      perKeyConcurrency: 1,
    });
    expect(scheduler.tryAcquire()?.keyId).toBe("k2");
  });

  it("weighted_random respects weights over many draws", () => {
    const scheduler = makeScheduler({
      keys: [key("heavy", { weight: 90 }), key("light", { weight: 10 })],
      strategy: "weighted_random",
      perKeyConcurrency: 100,
      rpmLimit: 10_000,
    });
    const counts = new Map<string, number>();
    for (let i = 0; i < 500; i += 1) {
      const lease = scheduler.tryAcquire();
      if (!lease) continue;
      counts.set(lease.keyId, (counts.get(lease.keyId) ?? 0) + 1);
      lease.release({ ok: true, latencyMs: 1 });
    }
    expect(counts.get("heavy") ?? 0).toBeGreaterThan(350);
    expect(counts.get("light") ?? 0).toBeGreaterThan(10);
  });
});

describe("KeyScheduler key health state machine", () => {
  it("cools a key on 429 and honours Retry-After", () => {
    const scheduler = makeScheduler({ keys: [key("k1")], perKeyConcurrency: 2 });
    const lease = scheduler.tryAcquire()!;
    lease.release({ ok: false, code: "rate_limited", message: "429", retryAfterMs: 1_000, latencyMs: 10 });

    const after = scheduler.snapshot()[0]!;
    expect(after.status).toBe("rate_limited");
    expect(after.cooldownUntil).not.toBeNull();
    expect(scheduler.tryAcquire()).toBeNull();
    // After the cooldown expires the key returns automatically.
    expect(scheduler.tryAcquire(Date.now() + 2_000)?.keyId).toBe("k1");
  });

  it("marks a key invalid on 401 and requires a manual re-test", () => {
    const scheduler = makeScheduler({ keys: [key("k1")] });
    scheduler.tryAcquire()!.release({ ok: false, code: "auth_invalid", message: "401", latencyMs: 5 });
    expect(scheduler.snapshot()[0]?.status).toBe("invalid");
    expect(scheduler.tryAcquire()).toBeNull();
    expect(scheduler.snapshot()[0]?.lastErrorCode).toBe("auth_invalid");
    scheduler.markHealthy("k1");
    expect(scheduler.tryAcquire()?.keyId).toBe("k1");
  });

  it("opens a cooldown after repeated 5xx failures", () => {
    const scheduler = makeScheduler({ keys: [key("k1")], perKeyConcurrency: 5, breakerThreshold: 3 });
    for (let i = 0; i < 3; i += 1) {
      scheduler.tryAcquire()!.release({
        ok: false,
        code: "server_error",
        message: "503",
        latencyMs: 5,
      });
    }
    const state = scheduler.snapshot()[0]!;
    expect(state.status).toBe("cooldown");
    expect(state.cooldownUntil).not.toBeNull();
  });

  it("disables a key and re-enables it", () => {
    const scheduler = makeScheduler({ keys: [key("k1")] });
    scheduler.setKeyEnabled("k1", false);
    expect(scheduler.tryAcquire()).toBeNull();
    expect(scheduler.snapshot()[0]?.status).toBe("disabled");
    scheduler.setKeyEnabled("k1", true);
    expect(scheduler.tryAcquire()).not.toBeNull();
  });

  it("returns null when every key is in cooldown instead of retrying forever", () => {
    const scheduler = makeScheduler({ keys: [key("k1"), key("k2")] });
    scheduler.tryAcquire()!.release({ ok: false, code: "rate_limited", retryAfterMs: 10_000 });
    scheduler.tryAcquire()!.release({ ok: false, code: "rate_limited", retryAfterMs: 10_000 });
    expect(scheduler.tryAcquire()).toBeNull();
  });
});
