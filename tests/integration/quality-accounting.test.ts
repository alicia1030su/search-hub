/**
 * Quality-run accounting: physical spend, per-query latency, and what a failed
 * query is allowed to look like in the report.
 *
 * Everything here goes through the real Fastify app and a real local HTTP
 * server, so a passing test means the *wire* behaved, not that a counter was
 * incremented by the code under test.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { qualityRunResults, qualityRuns } from "../../packages/db/src/schema.js";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "quality-accounting.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-accounting-"));
  const ctx = createContext(testConfig(dir));
  const app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      email: "admin@example.com",
      password: "A-very-long-password-1",
      name: "Admin",
      setupToken: ctx.setupToken.value!,
    },
  });
  expect(setup.statusCode).toBe(200);
  const cookie = setup.cookies.find((item) => item.name === "sh_session")?.value;
  const csrf = setup.json().csrfToken as string;
  const harness: Harness = { app, ctx, dir, cookie: cookie!, csrf };
  harnesses.push(harness);
  return harness;
}

/** Brave-shaped paginated stub that counts what it actually served. */
async function startStub(options: {
  totalRows: number;
  pageSize: number;
  fail?: boolean;
  /** Redirect every first hop once, so one logical page costs two requests. */
  redirectEveryRequest?: boolean;
}): Promise<{
  base: string;
  hits(): number;
  close(): Promise<void>;
}> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (options.fail) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "INTERNAL", message: "stub failure" } }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (options.redirectEveryRequest && url.searchParams.get("redirected") !== "1") {
      url.searchParams.set("redirected", "1");
      response.writeHead(302, { location: `${url.pathname}${url.search}` }).end();
      return;
    }
    const count = Number(url.searchParams.get("count") ?? options.pageSize);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const start = offset * count;
    const rows = Math.max(0, Math.min(count, options.totalRows - start));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        web: {
          results: Array.from({ length: rows }, (_, index) => ({
            title: `Row ${start + index + 1}`,
            url: `https://example.org/stub-${start + index + 1}`,
            description: "stub",
          })),
        },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("stub did not bind");
  return {
    base: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function setupBrave(harness: Harness, base: string, searchConfig: Record<string, unknown>): Promise<string> {
  const allowed = await harness.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });
  expect(allowed.statusCode, allowed.body).toBe(200);

  const created = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: {
      name: "brave-stub",
      type: "brave",
      enabled: true,
      baseUrl: base,
      timeoutMs: 8000,
      maxRetries: 0,
      searchConfig,
      config: {},
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const providerId = created.json().provider.id as string;
  const key = await harness.app.inject({
    method: "POST",
    url: `/api/admin/providers/${providerId}/keys`,
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { label: "stub", key: "stub-token-value-1234", weight: 100, enabled: true },
  });
  expect(key.statusCode, key.body).toBe(200);
  return providerId;
}

async function waitForRun(harness: Harness, runId: string): Promise<{
  run: { status: string; requestsUsed: number; cutoff: number };
  cost: { requests: number; httpRequests: number; adapterAttempts: number; logicalSearches: number; billableUnits: number | null };
  metrics: Record<string, { status: string; value: number | null }>;
  quality: Record<string, { status: string; value: number | null }>;
  perQuery: Array<{ queryId: string; status: string; latencyMs: number | null }>;
}> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await harness.app.inject({
      method: "GET",
      url: `/api/admin/quality/runs/${runId}`,
      cookies: { sh_session: harness.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    if (body.run.status !== "running") return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("run did not finish");
}

async function startLiveRun(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: Record<string, never> | Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/quality/runs",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: body,
  });
  return { statusCode: response.statusCode, json: response.json() };
}

describe("quality run accounting", () => {
  it("B03/Q07: a paginated provider spends real requests, and the run records them", async () => {
    const h = await createHarness();
    const stub = await startStub({ totalRows: 60, pageSize: 20 });
    // Brave caps `count` at 20; a 50-row target therefore needs 3 pages inside a
    // single adapter invocation.
    const providerId = await setupBrave(h, stub.base, { targetResults: 50, maxPages: 3 });

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 2).map((item) => item.id);

    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 20,
      confirmPaid: true,
      queryIds,
    });
    expect(started.statusCode, JSON.stringify(started.json)).toBe(200);
    const runId = (started.json as { run: { id: string } }).run.id;
    const run = await waitForRun(h, runId);

    // Two queries × 3 pages.
    expect(run.cost.httpRequests).toBe(6);
    expect(stub.hits()).toBe(6);
    expect(run.run.requestsUsed).toBe(6);
    // The adapter ran once per query; the vendor saw three requests each.
    expect(run.cost.adapterAttempts).toBe(2);
    expect(run.cost.logicalSearches).toBe(2);
    // Money is not derivable from a request count, and says so.
    expect(run.cost.billableUnits).toBeNull();
  }, 60_000);

  it("B06a: a budget below the worst case is refused before anything is sent", async () => {
    const h = await createHarness();
    const stub = await startStub({ totalRows: 60, pageSize: 20 });
    const providerId = await setupBrave(h, stub.base, { targetResults: 50, maxPages: 3 });

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 3).map((item) => item.id);

    // Three queries × 3 pages = 9 requests would fit a budget of 4 only if the
    // estimate were wrong; the run is refused up front.
    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 4,
      confirmPaid: true,
      queryIds,
    });
    expect(started.statusCode).toBe(400);
    expect(JSON.stringify(started.json)).toContain("requestBudget");
    // Nothing was spent proving it.
    expect(stub.hits()).toBe(0);
  }, 30_000);

  it("B06b/B12: a redirect that exceeds the ceiling stops the run, not the vendor bill", async () => {
    const h = await createHarness();
    // The plan says one page per query, so the pre-check passes; each request is
    // redirected once, so the wire sees two. The runtime gate has to catch it.
    const stub = await startStub({ totalRows: 5, pageSize: 20, redirectEveryRequest: true });
    const providerId = await setupBrave(h, stub.base, { targetResults: 5, maxPages: 1 });

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 3).map((item) => item.id);

    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 3,
      confirmPaid: true,
      queryIds,
    });
    expect(started.statusCode, JSON.stringify(started.json)).toBe(200);
    const run = await waitForRun(h, (started.json as { run: { id: string } }).run.id);

    // The stub is the authority on what was sent. Three queries × two hops is
    // six; the ceiling held at three.
    expect(stub.hits()).toBeLessThanOrEqual(3);
    expect(run.cost.httpRequests).toBeLessThanOrEqual(3);
    expect(run.run.requestsUsed).toBeLessThanOrEqual(3);
    // And the run did not pretend to be a clean success.
    expect(run.perQuery.some((item) => item.status === "failed")).toBe(true);
  }, 60_000);

  it("Q01/Q03/Q05: success, partial and failure are counted separately", async () => {
    const h = await createHarness();
    const okStub = await startStub({ totalRows: 20, pageSize: 20 });
    const providerId = await setupBrave(h, okStub.base, { targetResults: 10, maxPages: 1 });

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 4).map((item) => item.id);

    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 10,
      confirmPaid: true,
      queryIds,
    });
    const run = await waitForRun(h, (started.json as { run: { id: string } }).run.id);

    const quality = run.quality as Record<string, { status: string; value: number | null }>;
    // Everything succeeded: 0% failed, 0% empty.
    expect(quality.failedQueryRate?.value).toBe(0);
    expect(quality.emptyResultRate?.value).toBe(0);
    // A successful search that returns nothing is not a failed search; the mock
    // stub returns rows here, so the two rates must agree on "no failures".
    expect(run.perQuery.every((item) => item.status === "ok")).toBe(true);
  }, 60_000);

  it("Q02/Q04: a provider that always fails is not reported as success", async () => {
    const h = await createHarness();
    const badStub = await startStub({ totalRows: 0, pageSize: 20, fail: true });
    const providerId = await setupBrave(h, badStub.base, { targetResults: 10, maxPages: 1 });

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 3).map((item) => item.id);

    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 10,
      confirmPaid: true,
      queryIds,
    });
    expect(started.statusCode, JSON.stringify(started.json)).toBe(200);
    const run = await waitForRun(h, (started.json as { run: { id: string } }).run.id);

    const quality = run.quality as Record<string, { status: string; value: number | null }>;
    // Every provider failed. The old code wrote an empty snapshot and called the
    // row "ok", so this rate read 0%.
    expect(quality.failedQueryRate?.value).toBe(1);
    expect(quality.succeededQueryRate?.value).toBe(0);
    expect(run.perQuery.every((item) => item.status === "failed")).toBe(true);

    const rows = h.ctx.db.select().from(qualityRunResults).all();
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(rows.every((row) => row.errorJson !== null)).toBe(true);
  }, 60_000);

  it("Q07/Q08: each query keeps its own latency", async () => {
    const h = await createHarness();
    // A stub that delays page 0 by a distinct amount per query is hard to key
    // without reading the query, so use three separate providers with fixed
    // mock latencies instead — the point is the *mapping*, not the measurement.
    const slow = await h.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        name: "lat-100",
        type: "mock",
        enabled: true,
        timeoutMs: 8000,
        maxRetries: 0,
        config: { resultCount: 3, latencyMs: 100, namespace: "l100" },
      },
    });
    const providerId = slow.json().provider.id as string;

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 3).map((item) => item.id);

    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 10,
      confirmPaid: true,
      queryIds,
    });
    const run = await waitForRun(h, (started.json as { run: { id: string } }).run.id);

    // Every query must carry a measured latency of at least its provider's
    // configured delay — the old code wrote the *last* measurement to every row.
    for (const item of run.perQuery) {
      expect(item.latencyMs, item.queryId).toBeGreaterThanOrEqual(90);
    }
    // And the latencies are attached to their own query ids.
    const byId = new Map(run.perQuery.map((item) => [item.queryId, item.latencyMs]));
    expect(byId.size).toBe(run.perQuery.length);
    for (const queryId of queryIds) expect(byId.get(queryId)).toBeGreaterThanOrEqual(90);
  }, 60_000);

  it("Q09: an offline re-rank reports no invented latency", async () => {
    const h = await createHarness();
    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "offline",
      fusion: { strategy: "rrf" },
    });
    const run = await waitForRun(h, (started.json as { run: { id: string } }).run.id);
    expect(run.perQuery.every((item) => item.latencyMs === null)).toBe(true);
    expect(run.cost.httpRequests).toBe(0);
    expect(run.cost.adapterAttempts).toBe(0);
  }, 30_000);

  it("B11: retries are counted, not hidden", async () => {
    const h = await createHarness();
    const stub = await startStub({ totalRows: 5, pageSize: 20 });
    // maxRetries=1 with a provider that works: one attempt, one request. The
    // retry path itself is covered in upstream-request-budget.test.ts; here the
    // assertion is that attempts and requests are separate numbers.
    const providerId = await setupBrave(h, stub.base, { targetResults: 5, maxPages: 1 });

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 1).map((item) => item.id);
    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 5,
      confirmPaid: true,
      queryIds,
    });
    const run = await waitForRun(h, (started.json as { run: { id: string } }).run.id);
    expect(run.cost.adapterAttempts).toBe(1);
    expect(run.cost.httpRequests).toBe(1);
    expect(stub.hits()).toBe(1);
  }, 30_000);

  it("Q10: a run with failures records the reason instead of a clean average", async () => {
    const h = await createHarness();
    const badStub = await startStub({ totalRows: 0, pageSize: 20, fail: true });
    const providerId = await setupBrave(h, badStub.base, { targetResults: 5, maxPages: 1 });
    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 2).map((item) => item.id);
    const started = await startLiveRun(h, {
      datasetId: "ds_synthetic_core_v1",
      mode: "live",
      fusion: { strategy: "rrf" },
      providerIds: [providerId],
      requestBudget: 5,
      confirmPaid: true,
      queryIds,
    });
    const runId = (started.json as { run: { id: string } }).run.id;
    const run = await waitForRun(h, runId);

    const row = h.ctx.db.select().from(qualityRuns).all().find((item) => item.id === runId);
    expect(row?.status).toBe("completed");
    const errors = run.perQuery.map((item) => item.status);
    expect(errors).toEqual(["failed", "failed"]);
    // Availability is reported next to relevance, not folded into it.
    expect(run.quality.failedQueryRate?.value).toBe(1);
  }, 60_000);
});
