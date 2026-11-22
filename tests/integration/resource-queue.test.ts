import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiKeys, createDb, providerInstances, resolveMigrationsDir, runMigrations, type DbHandle } from "@search-hub/db";
import { KeyScheduler, type SchedulerKeySeed } from "@search-hub/core";
import { ProviderService } from "../../apps/api/src/services/providers.js";
import { HealthService, type HealthCheckResult } from "../../apps/api/src/services/health.js";
import { SecretBox } from "../../apps/api/src/security/crypto.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const seed: SchedulerKeySeed = { id: "key", label: "key", maskedKey: "sk-***", weight: 1, enabled: true, status: "healthy" };
function scheduler(deltas: number[]) {
  return new KeyScheduler({ providerId: "provider", strategy: "round_robin", perKeyConcurrency: 1, rpmLimit: 100_000, dailyQuota: null, cooldownMs: 0, breakerThreshold: 5, keys: [seed], onWaitingChange: (delta) => deltas.push(delta) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function database() {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-queue-"));
  dirs.push(dir);
  const handle = createDb({ file: join(dir, "queue.db") });
  handles.push(handle);
  runMigrations(handle.sqlite, resolveMigrationsDir());
  return { dir, handle };
}

function addProvider(handle: DbHandle, id: string): void {
  const now = new Date().toISOString();
  handle.db.insert(providerInstances).values({ id, name: id, type: "mock", enabled: true, timeoutMs: 1000, maxConcurrency: 1, maxRetries: 0, resultsPerPage: 1, rpmLimit: 100_000, keyStrategy: "round_robin", cooldownMs: 0, breakerThreshold: 5, breakerCooldownMs: 1000, configJson: "{}", searchConfigJson: "{}", createdAt: now, updatedAt: now }).run();
}

function result(id: string): HealthCheckResult {
  return { id, providerId: id, providerName: id, providerType: "mock", keyId: null, kind: "connect", status: "healthy", cause: "ok", errorCode: null, latencyMs: 1, resultCount: 1, healthScore: 100, message: "ok", checkedAt: new Date().toISOString(), trigger: "manual", cooldownUntil: null, requests: 1 };
}

describe("O(1) resource queue counters", () => {
  it("notifies KeyScheduler wait +1/-1 on abort, timeout, release, and syncKeys", async () => {
    const deltas: number[] = [];
    const keys = scheduler(deltas);
    const first = await keys.acquire();
    expect(first).not.toBeNull();
    const controller = new AbortController();
    const waiting = keys.acquire({ signal: controller.signal, maxWaitMs: 1000 });
    await Promise.resolve();
    expect(keys.waitingCount).toBe(1);
    controller.abort(new Error("cancel"));
    expect(await waiting).toBeNull();
    expect(keys.waitingCount).toBe(0);
    first!.release({ ok: true });

    const held = await keys.acquire();
    const timedOut = keys.acquire({ maxWaitMs: 15 });
    expect(await timedOut).toBeNull();
    expect(keys.waitingCount).toBe(0);
    const pending = keys.acquire({ maxWaitMs: 1000 });
    await Promise.resolve();
    keys.syncKeys([seed]);
    expect(keys.waitingCount).toBe(1);
    held!.release({ ok: true });
    const acquired = await pending;
    expect(acquired).not.toBeNull();
    acquired!.release({ ok: true });
    expect(deltas.reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("keeps ProviderService queueDepth stable across reload until old waiters finish", async () => {
    const { dir, handle } = database();
    addProvider(handle, "provider");
    const secrets = SecretBox.fromEnvOrFile(dir);
    const encrypted = secrets.encrypt("sk-test");
    const now = new Date().toISOString();
    handle.db.insert(apiKeys).values({ id: "key", providerId: "provider", label: "key", keyCiphertext: encrypted.ciphertext, keyIv: encrypted.iv, keyTag: encrypted.tag, keyVersion: 1, keyHint: "sk-***", weight: 1, enabled: true, status: "healthy", createdAt: now, updatedAt: now }).run();
    const providers = new ProviderService(handle.db, secrets);
    const keys = providers.activeRuntimes()[0]!.scheduler;
    const first = await keys.acquire();
    const pending = keys.acquire({ maxWaitMs: 1000 });
    await Promise.resolve();
    expect(providers.queueDepth).toBe(1);
    providers.reload();
    expect(providers.queueDepth).toBe(1);
    first!.release({ ok: true });
    const second = await pending;
    expect(second).not.toBeNull();
    second!.release({ ok: true });
    expect(providers.queueDepth).toBe(0);
  });

  it("aggregates two providers and survives abort, timeout, and deleted-provider reload", async () => {
    const { dir, handle } = database();
    addProvider(handle, "p1");
    addProvider(handle, "p2");
    const secrets = SecretBox.fromEnvOrFile(dir);
    const now = new Date().toISOString();
    for (const [id, providerId] of [["key1", "p1"], ["key2", "p2"]]) {
      const encrypted = secrets.encrypt(`sk-${id}`);
      handle.db.insert(apiKeys).values({ id, providerId, label: id, keyCiphertext: encrypted.ciphertext, keyIv: encrypted.iv, keyTag: encrypted.tag, keyVersion: 1, keyHint: "sk-***", weight: 1, enabled: true, status: "healthy", createdAt: now, updatedAt: now }).run();
    }
    const providers = new ProviderService(handle.db, secrets);
    const firstKeys = providers.activeRuntimes().find((entry) => entry.config.id === "p1")!.scheduler;
    const secondKeys = providers.activeRuntimes().find((entry) => entry.config.id === "p2")!.scheduler;
    const firstHeld = await firstKeys.acquire();
    const secondHeld = await secondKeys.acquire();
    const aborter = new AbortController();
    const firstWaiter = firstKeys.acquire({ signal: aborter.signal, maxWaitMs: 1000 });
    const secondWaiter = secondKeys.acquire({ maxWaitMs: 1000 });
    await Promise.resolve();
    expect(providers.queueDepth).toBe(2);
    aborter.abort(new Error("abort provider waiter"));
    expect(await firstWaiter).toBeNull();
    expect(providers.queueDepth).toBe(1);
    firstHeld!.release({ ok: true });

    const firstHeldAgain = await firstKeys.acquire();
    const timedOut = firstKeys.acquire({ maxWaitMs: 15 });
    expect(await timedOut).toBeNull();
    expect(providers.queueDepth).toBe(1);
    firstHeldAgain!.release({ ok: true });

    handle.db.delete(providerInstances).where(eq(providerInstances.id, "p2")).run();
    providers.reload();
    expect(providers.queueDepth).toBe(1);
    secondHeld!.release({ ok: true });
    const secondAcquired = await secondWaiter;
    expect(secondAcquired).not.toBeNull();
    secondAcquired!.release({ ok: true });
    expect(providers.queueDepth).toBe(0);
  });

  it("waits for all Health workers after onItem throws before subtracting the remaining queue", async () => {
    const { handle } = database();
    for (const id of ["p1", "p2", "p3"]) addProvider(handle, id);
    const health = new HealthService({
      db: handle.db,
      settings: { get: () => ({ health: { concurrency: 2 } }) } as never,
      providers: { providerRequiresKey: () => false, keyAvailability: () => new Map(), acquireKey: async () => ({ ok: false, reason: "no_key", message: "none" }) } as never,
      fetch: (async () => { throw new Error("unused"); }) as never,
      appLogger: logger,
    });
    const internal = health as unknown as { inFlight: Set<string>; probeWithLock: (id: string) => Promise<HealthCheckResult> };
    const blocked = deferred();
    const started = deferred();
    internal.probeWithLock = async (id) => {
      internal.inFlight.add(id);
      try {
        if (id === "p2") { started.resolve(); await blocked.promise; }
        return result(id);
      } finally {
        internal.inFlight.delete(id);
      }
    };
    let settled = false;
    const run = health.checkMany(["p1", "p2", "p3"], { concurrency: 2, gapMs: 0, onItem: (item) => { if (item.providerId === "p1") throw new Error("onItem failed"); } })
      .catch((error: unknown) => { settled = true; throw error; });
    await started.promise;
    expect(health.queueDepth).toBe(1);
    expect(health.activeProbeCount).toBe(1);
    expect(settled).toBe(false);
    blocked.resolve();
    await expect(run).rejects.toThrow("onItem failed");
    expect(health.queueDepth).toBe(0);
    expect(health.activeProbeCount).toBe(0);
  });

  it("sums concurrent checkMany queues and returns to zero after cancellation", async () => {
    const { handle } = database();
    for (const id of ["p1", "p2", "p3", "p4"]) addProvider(handle, id);
    const health = new HealthService({
      db: handle.db,
      settings: { get: () => ({ health: { concurrency: 1 } }) } as never,
      providers: { providerRequiresKey: () => false, keyAvailability: () => new Map(), acquireKey: async () => ({ ok: false, reason: "no_key", message: "none" }) } as never,
      fetch: (async () => { throw new Error("unused"); }) as never,
      appLogger: logger,
    });
    const internal = health as unknown as { inFlight: Set<string>; probeWithLock: (id: string, options: { signal?: AbortSignal }) => Promise<HealthCheckResult> };
    const gates = new Map([["p1", deferred()], ["p3", deferred()]]);
    internal.probeWithLock = async (id, options) => {
      internal.inFlight.add(id);
      try {
        const gate = gates.get(id);
        if (gate) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1000);
            options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("cancelled", "AbortError")); }, { once: true });
          });
        }
        return result(id);
      } finally {
        internal.inFlight.delete(id);
      }
    };
    const controller = new AbortController();
    const first = health.checkMany(["p1", "p2"], { concurrency: 1, gapMs: 0, signal: controller.signal });
    const second = health.checkMany(["p3", "p4"], { concurrency: 1, gapMs: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(health.queueDepth).toBe(2);
    controller.abort(new Error("cancel"));
    gates.get("p3")!.resolve();
    await Promise.all([first, second]);
    expect(health.queueDepth).toBe(0);
    expect(health.activeProbeCount).toBe(0);
  });
});
