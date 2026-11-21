import { describe, expect, it, vi } from "vitest";
import {
  AccountQuotaRegistry,
  KeyScheduler,
  type KeyReleaseOutcome,
  type SchedulerKeySeed,
} from "@search-hub/core";

function seed(id: string, overrides: Partial<SchedulerKeySeed> = {}): SchedulerKeySeed {
  return {
    id,
    label: id,
    maskedKey: "••••",
    weight: 100,
    enabled: true,
    status: "healthy",
    ...overrides,
  };
}

function scheduler(
  keys: SchedulerKeySeed[],
  options: Partial<ConstructorParameters<typeof KeyScheduler>[0]> = {},
): KeyScheduler {
  return new KeyScheduler({
    providerId: "provider",
    strategy: "failover",
    perKeyConcurrency: 1,
    rpmLimit: 0,
    dailyQuota: null,
    cooldownMs: 30_000,
    breakerThreshold: 2,
    keys,
    ...options,
  });
}

type ManualScheduler = KeyScheduler & {
  tryAcquireKey(keyId: string, options?: { manual?: boolean; now?: number }): ReturnType<KeyScheduler["tryAcquire"]>;
};

describe("account quota reservation refunds", () => {
  it("does not refund an old-day reservation against the new UTC day", () => {
    const registry = new AccountQuotaRegistry();
    const limits = { rpmLimit: 0, dailyQuota: 1 };
    const beforeMidnight = Date.UTC(2026, 10, 20, 23, 59, 59);
    const afterMidnight = Date.UTC(2026, 10, 21, 0, 0, 1);
    const oldReservation = registry.reserve("account", limits, beforeMidnight)!;
    const newReservation = registry.reserve("account", limits, afterMidnight)!;

    registry.refundReservation(oldReservation);

    expect(registry.snapshot("account", afterMidnight)?.quotaUsedToday).toBe(1);
    expect(registry.reserve("account", limits, afterMidnight + 1)).toBeNull();
    registry.refundReservation(newReservation);
    expect(registry.snapshot("account", afterMidnight + 2)?.quotaUsedToday).toBe(0);
  });

  it("refunds the account reservation even when the key was removed before release", () => {
    const registry = new AccountQuotaRegistry();
    const limits = { rpmLimit: 0, dailyQuota: 1 };
    const value = scheduler([seed("key")], {
      accountGroup: "account",
      accountLimits: limits,
      registry,
    });
    const lease = value.tryAcquire(1_000)!;
    value.syncKeys([]);

    lease.release({ ok: false, notSent: true });

    expect(registry.snapshot("account", 1_001)?.quotaUsedToday).toBe(0);
    const replacement = scheduler([seed("replacement")], {
      providerId: "replacement-provider",
      accountGroup: "account",
      accountLimits: limits,
      registry,
    });
    expect(replacement.tryAcquire(1_002)).not.toBeNull();
  });
});

describe("key scheduler safety state machine", () => {
  it.each(["timeout", "network", "dns", "tls", "server_error"] as const)(
    "H50 %s only cools after the breaker threshold",
    (code) => {
      const value = scheduler([seed("key")]);
      const first = value.tryAcquire(1_000)!;
      first.release({ ok: false, code });
      expect(value.snapshot(1_001)[0]?.status).toBe("healthy");
      expect(value.snapshot(1_001)[0]?.cooldownUntil).toBeNull();

      const second = value.tryAcquire(1_002)!;
      second.release({ ok: false, code });
      expect(value.snapshot(1_003)[0]?.status).toBe("cooldown");
      expect(value.snapshot(1_003)[0]?.cooldownUntil).not.toBeNull();
    },
  );

  it("H47 forbidden is a distinct parked state and never invalid", () => {
    const registry = new AccountQuotaRegistry();
    const value = scheduler([seed("key")], {
      accountGroup: "account",
      registry,
    });
    const lease = value.tryAcquire(1_000)!;
    lease.release({ ok: false, code: "forbidden", message: "no entitlement", retryAfterMs: 60_000 });
    expect(value.snapshot(1_001)[0]?.status).toBe("forbidden");
    expect(value.snapshot(1_001)[0]?.status).not.toBe("invalid");

    const other = scheduler([seed("other")], {
      providerId: "other-provider",
      accountGroup: "account",
      accountLimits: { rpmLimit: 0, dailyQuota: 10 },
      registry,
    });
    expect(other.tryAcquire(1_002)).toBeNull();
  });

  it("H47 an auth_invalid wrapper carrying upstream 403 is still forbidden", () => {
    const value = scheduler([seed("key")]);
    const lease = value.tryAcquire(1_000)!;
    lease.release({ ok: false, code: "auth_invalid", message: "Upstream returned HTTP 403: forbidden" });
    expect(value.snapshot(1_001)[0]?.status).toBe("forbidden");
    expect(value.snapshot(1_001)[0]?.status).not.toBe("invalid");
  });

  it("H47 blocked is the upstream forbidden state and never invalid", () => {
    const value = scheduler([seed("key")]);
    const lease = value.tryAcquire(1_000)!;
    lease.release({ ok: false, code: "blocked", message: "No entitlement", retryAfterMs: 60_000 });
    expect(value.snapshot(1_001)[0]?.status).toBe("forbidden");
    expect(value.snapshot(1_001)[0]?.cooldownUntil).not.toBeNull();
  });

  it("H49 quota exhaustion lasts until the next UTC midnight and parks the account", () => {
    const registry = new AccountQuotaRegistry();
    const now = Date.UTC(2026, 10, 20, 12);
    const value = scheduler([seed("key")], {
      accountGroup: "account",
      accountLimits: { rpmLimit: 0, dailyQuota: 10 },
      registry,
    });
    // tryAcquire accepts an explicit clock, but KeyLease.release intentionally
    // uses the real completion time. Pin both ends so this unit test proves the
    // UTC-midnight rule without depending on the calendar day CI happens to run.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const lease = value.tryAcquire(now)!;
      lease.release({ ok: false, code: "quota_exceeded", message: "insufficient balance" });
      const snapshot = value.snapshot(now + 1)[0]!;
      expect(snapshot.status).toBe("quota_exhausted");
      expect(Date.parse(snapshot.cooldownUntil!)).toBeGreaterThanOrEqual(Date.UTC(2026, 10, 21));
      expect(Date.parse(snapshot.cooldownUntil!)).toBeLessThan(Date.UTC(2026, 10, 21) + 2_000);
      expect(value.tryAcquire(now + 2)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("H54 forbidden and undecryptable keys are filtered from automatic selection", async () => {
    const value = scheduler([
      seed("forbidden", { status: "forbidden", cooldownUntil: new Date(Date.now() + 60_000).toISOString() }),
      seed("ciphertext", { decryptable: false } as Partial<SchedulerKeySeed>),
    ]);
    await expect(value.acquireWithReason({ maxWaitMs: 0 })).resolves.toMatchObject({
      lease: null,
      reason: "no_key",
    });
  });

  it("H54 notSent restores key counters and the exact account reservation", async () => {
    const registry = new AccountQuotaRegistry();
    const value = scheduler([seed("key")], {
      accountGroup: "account",
      accountLimits: { rpmLimit: 1, dailyQuota: 1 },
      registry,
    });
    const lease = value.tryAcquire(1_000)!;
    lease.release({ ok: false, notSent: true });
    const snapshot = value.snapshot(1_001)[0]!;
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.requestCount).toBe(0);
    expect(snapshot.rpmUsed).toBe(0);
    expect(snapshot.quotaUsedToday).toBe(0);
    expect(snapshot.status).toBe("healthy");
    expect(value.tryAcquire(1_002)).not.toBeNull();
  });

  it("H54 a sent cancellation consumes the reservation and is not refunded", () => {
    const registry = new AccountQuotaRegistry();
    const value = scheduler([seed("key")], {
      accountGroup: "account",
      accountLimits: { rpmLimit: 1, dailyQuota: 1 },
      registry,
    });
    const lease = value.tryAcquire(1_000)!;
    lease.release({ ok: false, cancelled: true });
    expect(value.tryAcquire(1_001)).toBeNull();
  });

  it.each(["invalid", "forbidden", "rate_limited", "cooldown", "quota_exhausted"] as const)(
    "H46-H49 a real manual success restores %s to healthy",
    (status) => {
      const value = scheduler([
        seed("key", {
          status,
          cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        }),
      ]) as ManualScheduler;
      const lease = value.tryAcquireKey("key", { manual: true });
      expect(lease).not.toBeNull();
      lease!.release({ ok: true, latencyMs: 5 } satisfies KeyReleaseOutcome);
      const snapshot = value.snapshot()[0]!;
      expect(snapshot.status).toBe("healthy");
      expect(snapshot.cooldownUntil).toBeNull();
      expect(snapshot.lastErrorCode).toBeNull();
    },
  );
});
