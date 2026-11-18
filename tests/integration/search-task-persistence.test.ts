/**
 * P1: a failure the caller can see must exist in history.
 *
 * When the health gate parked every selected source, the service returned a
 * structured `failed` response *before* the `search_tasks` insert. The caller
 * received a taskId that `getTask` could not find, the failure never reached
 * the dashboard, and the operator had no record of why a search stopped.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { providerHealthChecks, searchTasks } from "../../packages/db/src/schema.js";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "tasks.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-task-persistence-"));
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

async function addProvider(harness: Harness, name: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: {
      name,
      type: "mock",
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0,
      config: { resultCount: 2, latencyMs: 1, namespace: name },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

function park(harness: Harness, providerId: string): void {
  const now = Date.now();
  harness.ctx.db
    .insert(providerHealthChecks)
    .values({
      id: `phc_${providerId}_${now}`,
      providerId,
      keyId: null,
      kind: "search",
      status: "unhealthy",
      errorCode: "quota_exceeded",
      latencyMs: null,
      resultCount: 0,
      healthScore: 0,
      detailJson: JSON.stringify({
        cause: "quota_exceeded",
        cooldownUntil: new Date(now + 30 * 60_000).toISOString(),
      }),
      trigger: "manual",
      checkedAt: new Date(now).toISOString(),
    })
    .run();
}

describe("task persistence", () => {
  it("S01/S03: a search rejected by the health gate leaves a queryable failed task", async () => {
    const h = await createHarness();
    const parked = await addProvider(h, "parked-task");
    park(h, parked);

    const response = await h.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { query: "everything is parked", providers: [parked] },
    });
    // REST answers 503 for a failed search; the body still carries the reason.
    expect(response.statusCode).toBe(503);
    const body = response.json() as {
      taskId: string;
      status: string;
      failedSources: Array<{ id: string }>;
      errors: Array<{ code: string }>;
    };
    expect(body.status).toBe("failed");
    expect(body.failedSources.map((item) => item.id)).toEqual([parked]);

    // The id the caller was given must resolve.
    const task = await h.app.inject({
      method: "GET",
      url: `/api/search/tasks/${body.taskId}`,
      cookies: { sh_session: h.cookie },
    });
    expect(task.statusCode, task.body).toBe(200);
    const stored = task.json() as { status: string; response: { failedSources: Array<{ id: string }> } | null };
    expect(stored.status).toBe("failed");
    expect(stored.response?.failedSources.map((item) => item.id)).toEqual([parked]);

    // And it is in the table, not only in the response.
    const row = h.ctx.db.select().from(searchTasks).all().find((item) => item.id === body.taskId);
    expect(row).toBeTruthy();
    expect(row!.status).toBe("failed");
    expect(row!.resultCount).toBe(0);
  });

  it("S04: another actor cannot read that task", async () => {
    const h = await createHarness();
    const parked = await addProvider(h, "parked-owner");
    park(h, parked);

    const response = await h.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { query: "owner only", providers: [parked] },
    });
    const taskId = response.json().taskId as string;

    const token = await h.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "reader", scopes: ["search"] },
    });
    expect(token.statusCode, token.body).toBe(200);
    const secret = (token.json().token ?? token.json().plainToken) as string;

    const denied = await h.app.inject({
      method: "GET",
      url: `/api/search/tasks/${taskId}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    // 404 rather than 403: the existence of another caller's task is itself data.
    expect(denied.statusCode).toBe(404);
  });

  it("S05: evaluation traffic writes no task and no statistics", async () => {
    const h = await createHarness();
    const first = await addProvider(h, "eval-task");

    const before = h.ctx.db.select().from(searchTasks).all().length;
    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 2).map((item) => item.id);
    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        mode: "live",
        fusion: { strategy: "rrf" },
        providerIds: [first],
        requestBudget: 10,
        confirmPaid: true,
        queryIds,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const runId = started.json().run.id as string;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detailRun = await h.app.inject({
        method: "GET",
        url: `/api/admin/quality/runs/${runId}`,
        cookies: { sh_session: h.cookie },
      });
      if (detailRun.json().run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const after = h.ctx.db.select().from(searchTasks).all().length;
    expect(after).toBe(before);
  }, 30_000);

  it("S02/S06: a partial search keeps its results and its failure list", async () => {
    const h = await createHarness();
    const healthy = await addProvider(h, "healthy-task");
    const parked = await addProvider(h, "parked-partial");
    park(h, parked);

    const response = await h.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { query: "partial case", providers: [healthy, parked] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      taskId: string;
      status: string;
      results: unknown[];
      failedSources: Array<{ id: string }>;
    };
    expect(body.status).toBe("partial");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.failedSources.map((item) => item.id)).toEqual([parked]);

    const row = h.ctx.db.select().from(searchTasks).all().find((item) => item.id === body.taskId);
    // A partial search is never recorded as completed: that would inflate the
    // dashboard's success rate by exactly the number of sources that broke.
    expect(row?.status).toBe("partial");
  });
});
