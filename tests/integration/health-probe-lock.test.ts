import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { startBatchHarness, waitFor, type BatchHarness } from "../helpers/batch-harness.js";
import { addKey, allowLocalhost, createProvider } from "../helpers/vendor-stubs.js";

/**
 * The health probe lock is shared by batch runs, scheduled passes and the
 * single-provider endpoint. These tests hold real local HTTP requests open with
 * explicit gates, so every overlap assertion is about sockets on the wire.
 */

const harnesses: BatchHarness[] = [];
const stubs: ControlledBraveStub[] = [];

afterEach(async () => {
  const openStubs = stubs.splice(0);
  for (const stub of openStubs) stub.release();
  try {
    await Promise.all(
      harnesses.map((harness) =>
        waitFor(
          () => harness.ctx.providers.listRows().every((provider) => !harness.ctx.health.isProbing(provider.id)),
          { label: "in-flight probes to settle during cleanup" },
        ),
      ),
    );
  } finally {
    await Promise.all(openStubs.map((stub) => stub.close()));
    for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
  }
});

function track(harness: BatchHarness): BatchHarness {
  harnesses.push(harness);
  return harness;
}

function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class Barrier {
  private arrivals = 0;
  private opened = false;
  private readonly ready = gate();
  private readonly released = gate();

  constructor(private readonly expected: number) {}

  arrive(): void {
    if (this.opened) return;
    this.arrivals += 1;
    if (this.arrivals === this.expected) this.ready.open();
  }

  wait(): Promise<void> {
    return within(this.ready.promise, `${this.expected} concurrent upstream requests`);
  }

  open(): void {
    this.opened = true;
    this.released.open();
  }

  get release(): Promise<void> {
    return this.released.promise;
  }
}

interface ControlledBraveStub {
  base: string;
  hits(): number;
  peak(): number;
  firstRequest: Promise<void>;
  release(): void;
  close(): Promise<void>;
}

function sendBrave(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      web: {
        results: [
          { title: "Probe result one", url: "https://example.org/one", description: "stub" },
          { title: "Probe result two", url: "https://example.org/two", description: "stub" },
        ],
      },
    }),
  );
}

async function startControlledBraveStub(
  options: { holdFirst?: boolean; destroyFirst?: boolean; barrier?: Barrier } = {},
): Promise<ControlledBraveStub> {
  let hits = 0;
  let inFlight = 0;
  let peak = 0;
  const firstArrival = gate();
  const releaseGate = gate();
  const sockets = new Set<Socket>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    hits += 1;
    const requestNumber = hits;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    if (requestNumber === 1) firstArrival.open();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      inFlight -= 1;
    };
    response.once("close", finish);

    void (async () => {
      if (options.destroyFirst && requestNumber === 1) {
        request.socket.destroy();
        return;
      }
      if (options.barrier) {
        options.barrier.arrive();
        await options.barrier.release;
      } else if (options.holdFirst && requestNumber === 1) {
        await releaseGate.promise;
      }
      if (!response.destroyed && !response.writableEnded) sendBrave(response);
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const stub: ControlledBraveStub = {
    base: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    peak: () => peak,
    firstRequest: firstArrival.promise,
    release: () => releaseGate.open(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  stubs.push(stub);
  return stub;
}

async function setUp(
  name: string,
  stub: ControlledBraveStub,
  existingHarness?: BatchHarness,
): Promise<{ harness: BatchHarness; providerId: string }> {
  const harness = existingHarness ?? track(await startBatchHarness());
  if (!existingHarness) {
    await allowLocalhost(harness.app, harness.write());
    const settings = await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: {
        health: {
          paidProbesEnabled: false,
          connectMaxRequestsPerProbe: 20,
          connectMaxRequestsPerDay: 1000,
          concurrency: 2,
        },
      },
    });
    expect(settings.statusCode, settings.body).toBe(200);
  }
  const providerId = await createProvider(harness.app, harness.write(), {
    name,
    type: "brave",
    baseUrl: stub.base,
    resultsPerPage: 5,
  });
  await addKey(harness.app, harness.write(), providerId, `sk-${name.toUpperCase()}-0000000000`);
  return { harness, providerId };
}

function healthRowCount(harness: BatchHarness, providerId: string): number {
  const row = harness.ctx.sqlite
    .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ?")
    .get(providerId) as { n: number };
  return row.n;
}

function keyState(harness: BatchHarness, providerId: string) {
  const runtime = harness.ctx.providers.runtimeSnapshots().find((item) => item.providerId === providerId);
  expect(runtime, `runtime for ${providerId}`).toBeDefined();
  expect(runtime!.keys).toHaveLength(1);
  const persisted = harness.ctx.sqlite
    .prepare("SELECT success_count FROM api_keys WHERE provider_id = ?")
    .get(providerId) as { success_count: number };
  return { ...runtime!.keys[0]!, successCount: persisted.success_count };
}

function expectIdleKey(
  harness: BatchHarness,
  providerId: string,
  expected: { requestCount: number; successCount: number; failureCount: number; status?: string },
): void {
  expect(keyState(harness, providerId)).toMatchObject({
    inFlight: 0,
    requestCount: expected.requestCount,
    successCount: expected.successCount,
    failureCount: expected.failureCount,
    ...(expected.status === undefined ? {} : { status: expected.status }),
  });
}

async function singleTest(harness: BatchHarness, providerId: string) {
  return harness.app.inject({
    method: "POST",
    url: `/api/admin/providers/${providerId}/test`,
    ...harness.write(),
    payload: { kind: "connect" },
  });
}

interface BatchJobView {
  status: string;
  counts: { total: number; done: number; ok: number; failed: number; pending: number; skipped: number; remaining: number };
  items: Array<{ state: string; code: string; checkId: string | null; requests: number | null }>;
}

async function waitForBatch(harness: BatchHarness, jobId: string): Promise<BatchJobView> {
  let last: BatchJobView | undefined;
  await waitFor(
    async () => {
      const response = await harness.app.inject({
        method: "GET",
        url: `/api/admin/provider-health/batch-test/${jobId}`,
        ...harness.read(),
      });
      expect(response.statusCode, response.body).toBe(200);
      last = response.json() as BatchJobView;
      return last.status !== "running";
    },
    { label: `batch ${jobId} to finish` },
  );
  return last!;
}

describe("shared per-provider health probe lock", () => {
  it("S06 a batch probe blocks the single-test endpoint with 409 and sends one request", async () => {
    const stub = await startControlledBraveStub({ holdFirst: true });
    const { harness, providerId } = await setUp("s06-batch", stub);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [providerId], concurrency: 1 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().jobId as string;

    await within(stub.firstRequest, "the batch probe to reach the stub");
    expect(harness.ctx.health.isProbing(providerId)).toBe(true);
    expect(keyState(harness, providerId).inFlight).toBe(1);

    const duplicate = await singleTest(harness, providerId);
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json().error.code).toBe("already_running");
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(0);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(1);

    stub.release();
    const job = await waitForBatch(harness, jobId);
    expect(job.status).toBe("completed");
    expect(job.counts).toMatchObject({ total: 1, done: 1, ok: 1, failed: 0, skipped: 0, remaining: 0 });
    expect(job.items[0]).toMatchObject({ state: "ok", code: "ok", requests: 1 });
    expect(job.items[0]!.checkId).not.toBeNull();
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(1);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(1);
    expectIdleKey(harness, providerId, { requestCount: 1, successCount: 1, failureCount: 0, status: "healthy" });
  }, 15_000);

  it("S06b a provider probe blocks the explicit Key-test endpoint with 409 and sends one request", async () => {
    const stub = await startControlledBraveStub({ holdFirst: true });
    const { harness, providerId } = await setUp("s06b-key-test", stub);
    const keyId = harness.ctx.sqlite
      .prepare("SELECT id FROM api_keys WHERE provider_id = ?")
      .get(providerId) as { id: string };

    const first = harness.ctx.health.checkOne(providerId, { kind: "connect", trigger: "manual" });
    await within(stub.firstRequest, "the provider probe to reach the stub");
    const duplicate = await harness.app.inject({
      method: "POST",
      url: `/api/admin/keys/${keyId.id}/test`,
      ...harness.write(),
      payload: { kind: "connect", manual: true },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json().error.code).toBe("already_running");
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(0);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(1);

    stub.release();
    await first;
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(1);
    expectIdleKey(harness, providerId, { requestCount: 1, successCount: 1, failureCount: 0, status: "healthy" });
  }, 15_000);

  it("S07 a scheduled probe blocks the single-test endpoint with 409 and sends one request", async () => {
    const stub = await startControlledBraveStub({ holdFirst: true });
    const { harness, providerId } = await setUp("s07-scheduled", stub);
    const enabled = await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: { health: { scheduledEnabled: true, intervalMinutes: 5 } },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);

    const scheduled = harness.ctx.health.runScheduledNow();
    await within(stub.firstRequest, "the scheduled probe to reach the stub");
    expect(harness.ctx.health.isProbing(providerId)).toBe(true);

    const duplicate = await singleTest(harness, providerId);
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(duplicate.json().error.code).toBe("already_running");
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(0);

    stub.release();
    const run = await scheduled;
    expect(run).not.toBeNull();
    expect(run!.results).toHaveLength(1);
    expect(run!.skipped).toEqual([]);
    expect(run!.results[0]).toMatchObject({ providerId, kind: "connect", trigger: "schedule", cause: "ok", requests: 1 });
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(1);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(1);
    expectIdleKey(harness, providerId, { requestCount: 1, successCount: 1, failureCount: 0, status: "healthy" });
  }, 15_000);

  it("S08 different providers can hold probes simultaneously, proven by a peak of two", async () => {
    const barrier = new Barrier(2);
    const stub = await startControlledBraveStub({ barrier });
    const first = await setUp("s08-first", stub);
    const second = await setUp("s08-second", stub, first.harness);

    const both = Promise.all([
      first.harness.ctx.health.checkOne(first.providerId, { kind: "connect", trigger: "manual" }),
      first.harness.ctx.health.checkOne(second.providerId, { kind: "connect", trigger: "manual" }),
    ]);
    try {
      await barrier.wait();
      expect(stub.hits()).toBe(2);
      expect(stub.peak()).toBe(2);
      expect(first.harness.ctx.health.isProbing(first.providerId)).toBe(true);
      expect(first.harness.ctx.health.isProbing(second.providerId)).toBe(true);
      expect(keyState(first.harness, first.providerId).inFlight).toBe(1);
      expect(keyState(first.harness, second.providerId).inFlight).toBe(1);
      expect(healthRowCount(first.harness, first.providerId)).toBe(0);
      expect(healthRowCount(first.harness, second.providerId)).toBe(0);
    } finally {
      barrier.open();
      await both;
    }

    const results = await both;
    expect(results.map((item) => item.cause)).toEqual(["ok", "ok"]);
    expect(stub.hits()).toBe(2);
    expect(stub.peak()).toBe(2);
    expect(healthRowCount(first.harness, first.providerId)).toBe(1);
    expect(healthRowCount(first.harness, second.providerId)).toBe(1);
    expect(first.harness.ctx.health.budget().connectUsedToday).toBe(2);
    expectIdleKey(first.harness, first.providerId, { requestCount: 1, successCount: 1, failureCount: 0, status: "healthy" });
    expectIdleKey(first.harness, second.providerId, { requestCount: 1, successCount: 1, failureCount: 0, status: "healthy" });
  }, 15_000);

  it("S09 a destroyed request socket records network failure, releases the lock and permits a retry", async () => {
    const stub = await startControlledBraveStub({ destroyFirst: true });
    const { harness, providerId } = await setUp("s09-socket", stub);

    const failed = await harness.ctx.health.checkOne(providerId, { kind: "connect", trigger: "manual" });
    expect(failed).toMatchObject({ providerId, kind: "connect", cause: "network", status: "unhealthy", requests: 1 });
    expect(harness.ctx.health.isProbing(providerId)).toBe(false);
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(1);
    expectIdleKey(harness, providerId, { requestCount: 1, successCount: 0, failureCount: 1 });

    const retried = await harness.ctx.health.checkOne(providerId, { kind: "connect", trigger: "manual" });
    expect(retried).toMatchObject({ providerId, kind: "connect", cause: "ok", status: "healthy", requests: 1 });
    expect(stub.hits()).toBe(2);
    expect(healthRowCount(harness, providerId)).toBe(2);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(2);
    expectIdleKey(harness, providerId, { requestCount: 2, successCount: 1, failureCount: 1, status: "healthy" });
  }, 15_000);

  it("S10 two concurrent checkOne calls yield one success and one already_running without double spending", async () => {
    const stub = await startControlledBraveStub({ holdFirst: true });
    const { harness, providerId } = await setUp("s10-double", stub);
    const before = harness.ctx.health.budget().connectUsedToday;

    const first = harness.ctx.health.checkOne(providerId, { kind: "connect", trigger: "manual" });
    await within(stub.firstRequest, "the first checkOne to reach the stub");
    const duplicate = await Promise.allSettled([
      harness.ctx.health.checkOne(providerId, { kind: "connect", trigger: "manual" }),
    ]);
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]!.status).toBe("rejected");
    if (duplicate[0]!.status === "rejected") {
      expect(duplicate[0]!.reason).toMatchObject({ code: "already_running" });
    }
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(0);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(before + 1);
    expect(keyState(harness, providerId)).toMatchObject({ inFlight: 1, requestCount: 1, successCount: 0, failureCount: 0 });

    stub.release();
    const succeeded = await first;
    expect(succeeded).toMatchObject({ providerId, kind: "connect", cause: "ok", requests: 1 });
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(1);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(before + 1);
    expectIdleKey(harness, providerId, { requestCount: 1, successCount: 1, failureCount: 0, status: "healthy" });
  }, 15_000);

  it("S16 aborting an in-flight checkOne releases the lock, keeps the sent hop counted and allows retry", async () => {
    const stub = await startControlledBraveStub({ holdFirst: true });
    const { harness, providerId } = await setUp("s16-abort", stub);
    const controller = new AbortController();
    const before = harness.ctx.health.budget().connectUsedToday;

    const cancelled = harness.ctx.health.checkOne(providerId, {
      kind: "connect",
      trigger: "manual",
      signal: controller.signal,
    });
    await within(stub.firstRequest, "the cancellable probe to reach the stub");
    expect(harness.ctx.health.isProbing(providerId)).toBe(true);
    controller.abort(Object.assign(new Error("cancelled by test"), { code: "cancelled" }));

    await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
    expect(harness.ctx.health.isProbing(providerId)).toBe(false);
    expect(stub.hits()).toBe(1);
    expect(healthRowCount(harness, providerId)).toBe(0);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(before + 1);
    expectIdleKey(harness, providerId, { requestCount: 1, successCount: 0, failureCount: 0 });

    const retried = await harness.ctx.health.checkOne(providerId, { kind: "connect", trigger: "manual" });
    expect(retried).toMatchObject({ providerId, kind: "connect", cause: "ok", requests: 1 });
    expect(stub.hits()).toBe(2);
    expect(healthRowCount(harness, providerId)).toBe(1);
    expect(harness.ctx.health.budget().connectUsedToday).toBe(before + 2);
    expectIdleKey(harness, providerId, { requestCount: 2, successCount: 1, failureCount: 0, status: "healthy" });
  }, 15_000);
});
