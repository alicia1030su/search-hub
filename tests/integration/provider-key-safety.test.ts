import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import * as providersPackage from "@search-hub/providers";
import { addKey, allowLocalhost, closeStubs, createProvider } from "../helpers/vendor-stubs.js";
import { startBatchHarness, type BatchHarness } from "../helpers/batch-harness.js";

type StubMode = "ok" | "empty" | "401" | "403" | "429" | "quota" | "500" | "reset" | "slow";

interface SafetyStub {
  base: string;
  hits(): number;
  hitsFor(key: string): number;
  peak(): number;
  setMode(key: string, mode: StubMode): void;
}

const open: Server[] = [];
const harnesses: BatchHarness[] = [];

afterEach(async () => {
  await closeStubs();
  for (const server of open.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

async function safetyStub(): Promise<SafetyStub> {
  let requests = 0;
  let inFlight = 0;
  let peak = 0;
  const hits = new Map<string, number>();
  const modes = new Map<string, StubMode>();
  const server = createServer((request, response) => {
    requests += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const key = String(request.headers["x-subscription-token"] ?? "");
    hits.set(key, (hits.get(key) ?? 0) + 1);
    response.on("close", () => {
      inFlight -= 1;
    });
    const mode = modes.get(key) ?? "ok";
    if (mode === "reset") {
      request.socket.destroy();
      return;
    }
    if (mode === "401" || mode === "403" || mode === "429" || mode === "quota" || mode === "500") {
      const status = mode === "quota" ? 402 : Number(mode);
      const message =
        mode === "quota"
          ? "insufficient balance"
          : mode === "401"
            ? "unauthorized"
            : mode === "403"
              ? "forbidden"
              : mode === "429"
                ? "too many requests"
                : "server error";
      response.writeHead(status, {
        "content-type": "application/json",
        ...(mode === "429" ? { "retry-after": "120" } : {}),
      });
      response.end(JSON.stringify({ error: { message } }));
      return;
    }
    const send = () => {
      if (response.destroyed) return;
      const results =
        mode === "empty"
          ? []
          : Array.from({ length: 2 }, (_, index) => ({
              title: `safety result ${index + 1}`,
              url: `https://example.org/safety-${index + 1}`,
              description: "local stub",
            }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ web: { results } }));
    };
    if (mode === "slow") setTimeout(send, 1_000).unref?.();
    else send();
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind");
  return {
    base: `http://127.0.0.1:${address.port}`,
    hits: () => requests,
    hitsFor: (key) => hits.get(key) ?? 0,
    peak: () => peak,
    setMode: (key, mode) => modes.set(key, mode),
  };
}

async function harness(): Promise<BatchHarness> {
  const value = await startBatchHarness();
  harnesses.push(value);
  await allowLocalhost(value.app, value.write());
  return value;
}

async function braveProvider(
  value: BatchHarness,
  stub: SafetyStub,
  options: { name?: string; config?: Record<string, unknown>; maxConcurrency?: number; breakerThreshold?: number; timeoutMs?: number } = {},
): Promise<string> {
  return createProvider(value.app, value.write(), {
    name: options.name ?? `safety-${randomUUID()}`,
    type: "brave",
    baseUrl: stub.base,
    timeoutMs: options.timeoutMs ?? 5_000,
    maxRetries: 0,
    maxConcurrency: options.maxConcurrency ?? 4,
    breakerThreshold: options.breakerThreshold ?? 5,
    ...(options.config ? { config: options.config } : {}),
  });
}

async function key(value: BatchHarness, providerId: string, secret: string): Promise<string> {
  await addKey(value.app, value.write(), providerId, secret);
  const row = value.ctx.sqlite
    .prepare("SELECT id FROM api_keys WHERE provider_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(providerId) as { id: string };
  return row.id;
}

function keyRow(value: BatchHarness, id: string) {
  return value.ctx.sqlite.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as {
    status: string;
    cooldown_until: string | null;
    last_error_code: string | null;
    request_count: number;
    quota_used_today: number;
  };
}

function healthCount(value: BatchHarness, providerId?: string): number {
  return (
    (providerId
      ? value.ctx.sqlite
          .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ?")
          .get(providerId)
      : value.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_checks").get()) as { n: number }
  ).n;
}

function budgetCount(value: BatchHarness): number {
  return (value.ctx.sqlite.prepare("SELECT COALESCE(SUM(used), 0) AS n FROM health_probe_budget").get() as { n: number })
    .n;
}

async function testKey(value: BatchHarness, keyId: string) {
  return value.app.inject({
    method: "POST",
    url: `/api/admin/keys/${keyId}/test`,
    ...value.write(),
    payload: {},
  });
}

function nextUtcMidnight(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

interface AcquireKeyLease {
  keyId: string;
  release(outcome: {
    ok: boolean;
    code?: string;
    message?: string;
    cancelled?: boolean;
    notSent?: boolean;
    retryAfterMs?: number;
  }): Promise<void>;
}

type ProviderContract = {
  acquireKey(
    providerId: string,
    options?: { keyId?: string; manual?: boolean; maxWaitMs?: number },
  ): Promise<{ ok: true; keyId: string; secret: string; release: AcquireKeyLease["release"] } | { ok: false; reason: string; message: string }>;
  keyAvailability(ids: string[]): Map<
    string,
    {
      total: number;
      enabled: number;
      decryptable: number;
      available: number;
      invalid: number;
      quotaExhausted: number;
      coolingUntil: string | null;
      accountQuotaExhausted: boolean;
    }
  >;
};

function contract(value: BatchHarness): ProviderContract {
  return value.ctx.providers as unknown as ProviderContract;
}

const requiresKey = providersPackage as unknown as {
  providerRequiresKey(type: string, config: Record<string, unknown>): boolean;
};

describe("provider key safety H46-H54", () => {
  it("H46 401 invalidates the key and a later real success restores it", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const secret = `h46-${randomUUID()}`;
    stub.setMode(secret, "401");
    const providerId = await braveProvider(value, stub);
    const keyId = await key(value, providerId, secret);

    const failed = await testKey(value, keyId);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(keyRow(value, keyId).status).toBe("invalid");
    expect(stub.hits()).toBe(1);

    stub.setMode(secret, "ok");
    const recovered = await testKey(value, keyId);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().cause).toBe("ok");
    expect(keyRow(value, keyId).status).toBe("healthy");
    expect(keyRow(value, keyId).cooldown_until).toBeNull();
  });

  it("H47 403 is forbidden, parks the account group, and never becomes invalid", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const secret = `h47-${randomUUID()}`;
    const group = `h47-${randomUUID()}`;
    stub.setMode(secret, "403");
    const providerId = await braveProvider(value, stub, {
      config: { accountGroup: group, accountDailyQuota: 10 },
    });
    const keyId = await key(value, providerId, secret);

    const failed = await testKey(value, keyId);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json().cause).toBe("forbidden");
    expect(keyRow(value, keyId).status).toBe("forbidden");
    expect(keyRow(value, keyId).status).not.toBe("invalid");
    expect(Date.parse(keyRow(value, keyId).cooldown_until!)).toBeGreaterThan(Date.now());
    expect(contract(value).keyAvailability([providerId]).get(providerId)?.accountQuotaExhausted).toBe(true);

    stub.setMode(secret, "ok");
    const recovered = await testKey(value, keyId);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(keyRow(value, keyId).status).toBe("healthy");
    expect(contract(value).keyAvailability([providerId]).get(providerId)?.accountQuotaExhausted).toBe(false);
  });

  it("H48 429 is rate_limited with the vendor cooldown and can recover", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const secret = `h48-${randomUUID()}`;
    stub.setMode(secret, "429");
    const providerId = await braveProvider(value, stub);
    const keyId = await key(value, providerId, secret);

    const failed = await testKey(value, keyId);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json().cause).toBe("rate_limited");
    expect(keyRow(value, keyId).status).toBe("rate_limited");
    expect(Date.parse(keyRow(value, keyId).cooldown_until!)).toBeGreaterThan(Date.now() + 100_000);

    stub.setMode(secret, "ok");
    const recovered = await testKey(value, keyId);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(keyRow(value, keyId).status).toBe("healthy");
  });

  it("H49 quota parks the key until the next UTC midnight and parks the account", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const secret = `h49-${randomUUID()}`;
    const group = `h49-${randomUUID()}`;
    stub.setMode(secret, "quota");
    const providerId = await braveProvider(value, stub, {
      config: { accountGroup: group, accountDailyQuota: 10 },
    });
    const keyId = await key(value, providerId, secret);

    const failed = await testKey(value, keyId);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json().cause).toBe("quota_exceeded");
    expect(keyRow(value, keyId).status).toBe("quota_exhausted");
    const until = Date.parse(keyRow(value, keyId).cooldown_until!);
    expect(until).toBeGreaterThanOrEqual(nextUtcMidnight());
    expect(until).toBeLessThan(nextUtcMidnight() + 2_000);
    expect(contract(value).keyAvailability([providerId]).get(providerId)?.accountQuotaExhausted).toBe(true);

    stub.setMode(secret, "ok");
    const recovered = await testKey(value, keyId);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(keyRow(value, keyId).status).toBe("healthy");
  });

  it("H50 a single 500 does not cool a key before the breaker threshold", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const secret = `h50-${randomUUID()}`;
    stub.setMode(secret, "500");
    const providerId = await braveProvider(value, stub, { breakerThreshold: 3 });
    const keyId = await key(value, providerId, secret);

    const failed = await testKey(value, keyId);
    expect(failed.statusCode, failed.body).toBe(200);
    expect(failed.json().cause).toBe("server_error");
    expect(keyRow(value, keyId).status).not.toBe("invalid");
    expect(keyRow(value, keyId).cooldown_until).toBeNull();

    await testKey(value, keyId);
    const threshold = await testKey(value, keyId);
    expect(threshold.statusCode, threshold.body).toBe(200);
    expect(keyRow(value, keyId).status).toBe("cooldown");
    expect(Date.parse(keyRow(value, keyId).cooldown_until!)).toBeGreaterThan(Date.now());
  });

  it("H50 timeout/network/DNS/TLS only affect the breaker, never credential validity", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const secret = `h50-transport-${randomUUID()}`;
    const providerId = await braveProvider(value, stub, { breakerThreshold: 2, timeoutMs: 500 });
    const keyId = await key(value, providerId, secret);

    stub.setMode(secret, "slow");
    const timeout = await value.ctx.health.checkOne(providerId, { keyId, kind: "connect" });
    expect(timeout.cause).toBe("timeout");
    expect(keyRow(value, keyId).status).not.toBe("invalid");
    expect(keyRow(value, keyId).cooldown_until).toBeNull();

    stub.setMode(secret, "reset");
    const network = await value.ctx.health.checkOne(providerId, { keyId, kind: "connect" });
    expect(network.cause).toBe("network");
    expect(keyRow(value, keyId).status).toBe("cooldown");
    expect(keyRow(value, keyId).status).not.toBe("invalid");
  });

  it("H51 empty results do not change credential validity", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const secret = `h51-${randomUUID()}`;
    stub.setMode(secret, "empty");
    const providerId = await braveProvider(value, stub);
    const keyId = await key(value, providerId, secret);

    const empty = await testKey(value, keyId);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json().cause).toBe("empty_results");
    expect(keyRow(value, keyId).status).toBe("unknown");
    expect(keyRow(value, keyId).status).not.toBe("invalid");
    expect(keyRow(value, keyId).cooldown_until).toBeNull();

    value.ctx.sqlite.prepare("UPDATE api_keys SET status = 'invalid' WHERE id = ?").run(keyId);
    value.ctx.providers.reload();
    const stillInvalid = await testKey(value, keyId);
    expect(stillInvalid.statusCode, stillInvalid.body).toBe(200);
    expect(stillInvalid.json().cause).toBe("empty_results");
    expect(keyRow(value, keyId).status).toBe("invalid");
  });

  it("H52 a cross-provider key is rejected before health, budget, or upstream work", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const providerA = await braveProvider(value, stub, { name: `h52-a-${randomUUID()}` });
    const providerB = await braveProvider(value, stub, { name: `h52-b-${randomUUID()}` });
    const keyB = await key(value, providerB, `h52-${randomUUID()}`);

    await expect(value.ctx.health.checkOne(providerA, { keyId: keyB, kind: "connect" })).rejects.toMatchObject({
      status: 400,
    });
    const response = await value.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerA}/test`,
      ...value.write(),
      payload: { keyId: keyB, kind: "connect" },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(stub.hits()).toBe(0);
    expect(healthCount(value)).toBe(0);
    expect(budgetCount(value)).toBe(0);
  });

  it.each(["disabled", "deleted", "undecryptable"] as const)(
    "H53 %s key is rejected with no request, health row, or budget spend",
    async (state) => {
      const value = await harness();
      const stub = await safetyStub();
      const providerId = await braveProvider(value, stub);
      const keyId = await key(value, providerId, `h53-${randomUUID()}`);
      if (state === "disabled") {
        value.ctx.sqlite.prepare("UPDATE api_keys SET enabled = 0 WHERE id = ?").run(keyId);
      } else if (state === "deleted") {
        value.ctx.sqlite.prepare("DELETE FROM api_keys WHERE id = ?").run(keyId);
      } else {
        value.ctx.sqlite.prepare("UPDATE api_keys SET key_tag = ? WHERE id = ?").run("00".repeat(16), keyId);
      }
      value.ctx.providers.reload();

      const response = await testKey(value, keyId);
      expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, response.body).toBeLessThan(500);
      expect(stub.hits()).toBe(0);
      expect(healthCount(value)).toBe(0);
      expect(budgetCount(value)).toBe(0);
      const facts = contract(value).keyAvailability([providerId]).get(providerId);
      expect(facts?.total).toBe(state === "deleted" ? 0 : 1);
      expect(facts?.enabled).toBe(state === "disabled" ? 0 : state === "deleted" ? 0 : 1);
      expect(facts?.decryptable).toBe(state === "undecryptable" || state === "deleted" ? 0 : 1);
      expect(facts?.available).toBe(0);
    },
  );

  it("H54 automatic selection skips an invalid first key and uses the second", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const first = `h54-first-${randomUUID()}`;
    const second = `h54-second-${randomUUID()}`;
    stub.setMode(first, "401");
    const providerId = await braveProvider(value, stub);
    const firstId = await key(value, providerId, first);
    const secondId = await key(value, providerId, second);

    const initial = await value.ctx.health.checkOne(providerId, { kind: "connect" });
    expect(initial.keyId).toBe(firstId);
    expect(keyRow(value, firstId).status).toBe("invalid");

    const fallback = await value.ctx.health.checkOne(providerId, { kind: "connect" });
    expect(fallback.status).toBe("healthy");
    expect(fallback.keyId).toBe(secondId);
    expect(stub.hitsFor(first)).toBe(1);
    expect(stub.hitsFor(second)).toBe(1);
  });

  it("H54 all-invalid keys produce no upstream request or budget spend", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const providerId = await braveProvider(value, stub);
    const firstId = await key(value, providerId, `h54-all-${randomUUID()}`);
    const secondId = await key(value, providerId, `h54-all-${randomUUID()}`);
    value.ctx.sqlite
      .prepare("UPDATE api_keys SET status = 'invalid' WHERE id IN (?, ?)")
      .run(firstId, secondId);
    value.ctx.providers.reload();

    const result = await value.ctx.health.checkOne(providerId, { kind: "search" });
    expect(result.status).toBe("unverified");
    expect(result.requests).toBeNull();
    expect(stub.hits()).toBe(0);
    expect(budgetCount(value)).toBe(0);
  });

  it("H54 account-group quota is shared and also constrains manual key tests", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const group = `h54-account-${randomUUID()}`;
    const providerA = await braveProvider(value, stub, {
      name: `h54-a-${randomUUID()}`,
      config: { accountGroup: group, accountDailyQuota: 1 },
    });
    const providerB = await braveProvider(value, stub, {
      name: `h54-b-${randomUUID()}`,
      config: { accountGroup: group, accountDailyQuota: 1 },
    });
    const keyA = await key(value, providerA, `h54-a-${randomUUID()}`);
    const keyB = await key(value, providerB, `h54-b-${randomUUID()}`);

    const first = await contract(value).acquireKey(providerA);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.release({ ok: true });

    const denied = await contract(value).acquireKey(providerB, { keyId: keyB, manual: true, maxWaitMs: 0 });
    expect(denied).toMatchObject({ ok: false, reason: "account_quota" });
    expect(keyA).not.toBe(keyB);
    expect(contract(value).keyAvailability([providerB]).get(providerB)?.accountQuotaExhausted).toBe(true);
    expect(stub.hits()).toBe(0);
  });

  it("H54 same-key concurrency is bounded and notSent restores every slot", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const providerId = await braveProvider(value, stub, { maxConcurrency: 1 });
    const keyId = await key(value, providerId, `h54-concurrent-${randomUUID()}`);

    const first = await contract(value).acquireKey(providerId, { keyId, manual: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const waiting = await contract(value).acquireKey(providerId, { keyId, manual: true, maxWaitMs: 0 });
    expect(waiting).toMatchObject({ ok: false, reason: "queue_timeout" });
    expect(contract(value).keyAvailability([providerId]).get(providerId)?.available).toBe(0);

    await first.release({ ok: false, notSent: true });
    expect(keyRow(value, keyId).request_count).toBe(0);
    expect(keyRow(value, keyId).quota_used_today).toBe(0);
    expect(contract(value).keyAvailability([providerId]).get(providerId)?.available).toBe(1);
  });

  it("H54 lease release flushes key state before the API can observe it", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const providerId = await braveProvider(value, stub);
    const keyId = await key(value, providerId, `h54-flush-${randomUUID()}`);

    const lease = await contract(value).acquireKey(providerId, { keyId, manual: true });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    await lease.release({ ok: false, code: "auth_invalid", message: "rejected" });
    expect(keyRow(value, keyId).status).toBe("invalid");
  });

  it("H54 a refused paid budget returns the key and account reservation with notSent", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const group = `h54-budget-${randomUUID()}`;
    const providerId = await braveProvider(value, stub, {
      config: { accountGroup: group, accountDailyQuota: 2 },
    });
    const keyId = await key(value, providerId, `h54-budget-${randomUUID()}`);

    await expect(value.ctx.health.checkOne(providerId, { kind: "search" })).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(stub.hits()).toBe(0);
    expect(healthCount(value)).toBe(0);
    expect(budgetCount(value)).toBe(0);
    expect(keyRow(value, keyId).request_count).toBe(0);
    expect(keyRow(value, keyId).quota_used_today).toBe(0);
    expect(contract(value).keyAvailability([providerId]).get(providerId)?.available).toBe(1);
    expect(contract(value).keyAvailability([providerId]).get(providerId)?.accountQuotaExhausted).toBe(false);
  });

  it("H54 builtin credential requirements follow the adapter", () => {
    expect(requiresKey.providerRequiresKey("brave", {})).toBe(true);
    expect(requiresKey.providerRequiresKey("hackernews", {})).toBe(false);
  });

  it.each([
    { keyInjection: { in: "header", name: "x-api-key" } },
    { headers: { Authorization: "Bearer {{key}}" } },
    { query: { api_key: "{{key}}" } },
    { body: { credentials: { key: "{{key}}" } } },
  ])("H54 generic credential template is classified and connect is refused: %j", async (config) => {
    expect(requiresKey.providerRequiresKey("generic-http", config)).toBe(true);
    const value = await harness();
    const stub = await safetyStub();
    const providerId = await createProvider(value.app, value.write(), {
      name: `h54-generic-${randomUUID()}`,
      type: "generic-http",
      baseUrl: stub.base,
      config: { path: "/search", ...config },
      maxRetries: 0,
    });

    const response = await value.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...value.write(),
      payload: { kind: "connect" },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message.toLowerCase()).toContain("search");
    expect(stub.hits()).toBe(0);
    expect(healthCount(value)).toBe(0);
    expect(budgetCount(value)).toBe(0);
  });

  it("H54 an optional key pool does not turn a keyless search into a paid probe", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const providerId = await createProvider(value.app, value.write(), {
      name: `h54-optional-${randomUUID()}`,
      type: "generic-http",
      baseUrl: stub.base,
      config: { path: "/search", query: { q: "{{query}}" } },
      maxRetries: 0,
    });
    const keyId = await key(value, providerId, `h54-optional-${randomUUID()}`);

    const result = await value.ctx.health.checkOne(providerId, { kind: "search" });
    expect(result.cause).toBe("bad_response");
    expect(stub.hits()).toBe(1);
    expect(keyRow(value, keyId).request_count).toBe(0);
    const paid = value.ctx.sqlite
      .prepare("SELECT used FROM health_probe_budget WHERE kind = 'search'")
      .get() as { used: number } | undefined;
    const anonymous = value.ctx.sqlite
      .prepare("SELECT used FROM health_probe_budget WHERE kind = 'search_anonymous'")
      .get() as { used: number };
    expect(paid?.used ?? 0).toBe(0);
    expect(anonymous.used).toBe(1);
  });

  it("H54 an anonymous probe that never reaches the wire returns its run slot", async () => {
    const value = await harness();
    const stub = await safetyStub();
    const impossible = await createProvider(value.app, value.write(), {
      name: `h54-anon-none-${randomUUID()}`,
      type: "generic-http",
      config: { path: "/search" },
      maxRetries: 0,
    });
    const working = await createProvider(value.app, value.write(), {
      name: `h54-anon-ok-${randomUUID()}`,
      type: "generic-http",
      baseUrl: stub.base,
      config: { path: "/search", query: { q: "{{query}}" } },
      maxRetries: 0,
    });
    await value.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...value.write(),
      payload: { health: { anonymousMaxRequestsPerRun: 1, anonymousMaxRequestsPerDay: 5 } },
    });

    const run = await value.ctx.health.checkMany([impossible, working], {
      kind: "search",
      concurrency: 1,
      gapMs: 0,
    });
    expect(run.skipped).toEqual([]);
    expect(run.results).toHaveLength(2);
    expect(run.results.find((item) => item.providerId === impossible)?.requests).toBeNull();
    expect(stub.hits()).toBe(1);
  });

  it("H54 anonymous generic connect runs but is charged to search_anonymous", async () => {
    expect(requiresKey.providerRequiresKey("generic-http", { query: { q: "{{query}}" } })).toBe(false);
    const value = await harness();
    const stub = await safetyStub();
    const providerId = await createProvider(value.app, value.write(), {
      name: `h54-anonymous-${randomUUID()}`,
      type: "generic-http",
      baseUrl: stub.base,
      config: { path: "/search", query: { q: "{{query}}" } },
      maxRetries: 0,
    });

    const result = await value.ctx.health.checkOne(providerId, { kind: "connect" });
    expect(result.cause).toBe("bad_response");
    expect(stub.hits()).toBe(1);
    const row = value.ctx.sqlite
      .prepare("SELECT kind, used FROM health_probe_budget WHERE kind = 'search_anonymous'")
      .get() as { kind: string; used: number };
    expect(row).toEqual({ kind: "search_anonymous", used: 1 });
  });
});
