import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { searchTasks } from "../../packages/db/src/schema.js";

/**
 * Regression tests for the v0.1.4-beta.6 stability audit.
 *
 * Every case here corresponds to a defect that shipped in beta.5:
 *  1. deep search reported `completed` when every sub-query failed,
 *  2. the cache key ignored includeRaw / perProviderLimit / provider config,
 *  3. a cached partial response was recorded as `completed`,
 *  4. an explicitly requested disabled model was still called.
 */

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
    dbPath: join(dir, "audit.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-audit-"));
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
  const cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  const harness: Harness = { app, ctx, dir, cookie, csrf: setup.json().csrfToken as string };
  harnesses.push(harness);
  return harness;
}

function adminHeaders(harness: Harness) {
  return { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } };
}

async function addMock(
  harness: Harness,
  name: string,
  config: Record<string, unknown>,
): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...adminHeaders(harness),
    payload: { name, type: "mock", enabled: true, timeoutMs: 5000, maxConcurrency: 2, maxRetries: 0, rpmLimit: 600, config },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

/**
 * A chat model is required by deep mode. The base URL is allowlisted so the
 * configuration is accepted; the call itself fails, which is exactly the
 * "rewrite is best-effort" path.
 */
async function addChatModel(harness: Harness, enabled = true): Promise<string> {
  await harness.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...adminHeaders(harness),
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/models",
    ...adminHeaders(harness),
    payload: {
      name: "audit-chat",
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      modelId: "audit",
      enabled,
      isDefault: enabled,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().id as string;
}

describe("deep search status", () => {
  it("fails the whole request when every sub-query fails", async () => {
    const harness = await createHarness();
    await addMock(harness, "always-fail", { resultCount: 0, failMode: "server_error" });
    await addChatModel(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "deep audit", mode: "deep", limit: 5, skipCache: true },
    });

    // Before the fix this was 200 + status "completed" with 0 results.
    expect(response.statusCode).toBe(503);
    const body = response.json() as {
      status: string;
      results: unknown[];
      errors: Array<{ code: string; query?: string }>;
      failedSources: Array<{ id: string; code: string }>;
    };
    expect(body.status).toBe("failed");
    expect(body.results).toEqual([]);
    // The failure must name the query it belongs to.
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]?.query).toBeTruthy();
    expect(body.failedSources.length).toBeGreaterThan(0);
  });

  it("records the task as failed, not completed", async () => {
    const harness = await createHarness();
    await addMock(harness, "always-fail-2", { resultCount: 0, failMode: "server_error" });
    await addChatModel(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "deep audit task", mode: "deep", limit: 5, skipCache: true },
    });
    const taskId = (response.json() as { taskId: string }).taskId;
    const task = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${taskId}`,
      cookies: { sh_session: harness.cookie },
    });
    expect(task.json().status).toBe("failed");
  });

  it("stays completed when every sub-query succeeds", async () => {
    const harness = await createHarness();
    await addMock(harness, "healthy", { resultCount: 4, latencyMs: 5 });
    await addChatModel(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "deep ok", mode: "deep", limit: 5, skipCache: true },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; stats: { partial: boolean } };
    // The chat model is unreachable here, so the rewrite falls back to the
    // original query; the retrieval itself succeeded, hence completed.
    expect(body.status).toBe("completed");
    expect(body.stats.partial).toBe(false);
  });
});

describe("cache correctness", () => {
  async function enableCache(harness: Harness): Promise<void> {
    const response = await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { cache: { enabled: true, ttlSeconds: 3600 } },
    });
    expect(response.json().cache.enabled).toBe(true);
  }

  it("does not serve a includeRaw=true entry to includeRaw=false", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-rich", { resultCount: 2 });
    await enableCache(harness);

    const search = async (body: Record<string, unknown>) =>
      harness.app.inject({
        method: "POST",
        url: "/api/search",
        ...adminHeaders(harness),
        payload: { query: "cache raw", mode: "basic", limit: 5, ...body },
      });

    await search({ includeRaw: true });
    const plain = await search({ includeRaw: false });
    // Distinct semantics ⇒ distinct key ⇒ a miss, not a cache hit.
    expect(plain.json().stats.cached).toBeUndefined();

    // A genuinely identical request still hits.
    const repeat = await search({ includeRaw: false });
    expect(repeat.json().stats.cached).toBe(true);
  });

  it("does not share a cache entry across perProviderLimit values", async () => {
    const harness = await createHarness();
    await addMock(harness, "cache-limit", { resultCount: 6 });
    await enableCache(harness);

    const search = async (perProviderLimit: number) =>
      harness.app.inject({
        method: "POST",
        url: "/api/search",
        ...adminHeaders(harness),
        payload: { query: "cache per-provider", mode: "basic", limit: 6, perProviderLimit },
      });

    await search(2);
    const wide = await search(9);
    expect(wide.json().stats.cached).toBeUndefined();
  });

  it("invalidates the cache when the provider configuration changes", async () => {
    const harness = await createHarness();
    const providerId = await addMock(harness, "cache-config", { resultCount: 2, namespace: "v1" });
    await enableCache(harness);

    const search = async () =>
      harness.app.inject({
        method: "POST",
        url: "/api/search",
        ...adminHeaders(harness),
        payload: { query: "cache config", mode: "basic", limit: 5 },
      });

    await search();
    // Change the vendor-side configuration: results will differ.
    const patched = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${providerId}`,
      ...adminHeaders(harness),
      payload: { config: { resultCount: 2, namespace: "v2" } },
    });
    expect(patched.statusCode).toBe(200);

    const afterChange = await search();
    expect(afterChange.json().stats.cached).toBeUndefined();
    // The response must be produced by the new configuration, not replayed.
    const urls = (afterChange.json().results as Array<{ url: string }>).map((item) => item.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes("/v2/"))).toBe(true);
    expect(urls.every((url) => url.includes("/v1/"))).toBe(false);
  });

  it("does not cache a partial response, and never records one as completed", async () => {
    const harness = await createHarness();
    // Two providers: one healthy, one failing ⇒ the response is partial.
    await addMock(harness, "good", { resultCount: 3 });
    await addMock(harness, "bad", { resultCount: 0, failMode: "server_error" });
    await enableCache(harness);

    const search = async () =>
      harness.app.inject({
        method: "POST",
        url: "/api/search",
        ...adminHeaders(harness),
        payload: { query: "cache partial", mode: "basic", limit: 5 },
      });

    const first = await search();
    expect(first.json().status).toBe("partial");

    // Behaviour change in the persistent cache: a partial answer is no longer
    // stored. Replaying "one of your sources is broken" for 24 hours would hide
    // a source that recovered a minute later, so it is re-queried instead.
    const second = await search();
    expect(second.json().stats.cached).toBeUndefined();
    expect(second.json().status).toBe("partial");
    expect(second.json().taskId).not.toBe(first.json().taskId);

    const task = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${second.json().taskId}`,
      cookies: { sh_session: harness.cookie },
    });
    // A partial run must never be recorded as completed; that would inflate the
    // dashboard success rate.
    expect(task.json().status).toBe("partial");
  });

  it("never caches a failed response", async () => {
    const harness = await createHarness();
    await addMock(harness, "failing", { resultCount: 0, failMode: "server_error" });
    await enableCache(harness);

    const search = async () =>
      harness.app.inject({
        method: "POST",
        url: "/api/search",
        ...adminHeaders(harness),
        payload: { query: "cache fail", mode: "basic", limit: 5 },
      });

    const first = await search();
    expect(first.statusCode).toBe(503);
    const second = await search();
    // A failure must be retried, not replayed from cache.
    expect(second.json().stats.cached).toBeUndefined();
    expect(second.statusCode).toBe(503);
  });
});

describe("model enable switch", () => {
  it("rejects an explicitly requested disabled chat model", async () => {
    const harness = await createHarness();
    await addMock(harness, "model-mock", { resultCount: 2 });
    const modelId = await addChatModel(harness, false);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "disabled model", mode: "rrf", limit: 5, skipCache: true, chatModelId: modelId },
    });

    // Before the fix the request silently used the disabled model.
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("disabled");
  });

  it("still allows an enabled model", async () => {
    const harness = await createHarness();
    await addMock(harness, "model-mock-2", { resultCount: 2 });
    const modelId = await addChatModel(harness, true);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "enabled model", mode: "rrf", limit: 5, skipCache: true, chatModelId: modelId },
    });
    expect(response.statusCode).toBe(200);
  });

  it("keeps the admin test endpoint able to probe a disabled model", async () => {
    const harness = await createHarness();
    const modelId = await addChatModel(harness, false);
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/models/${modelId}/test`,
      ...adminHeaders(harness),
      payload: {},
    });
    // The probe may fail on the network, but it must not be refused as "disabled".
    expect(response.statusCode).not.toBe(400);
  });
});

/**
 * Task ownership. Before the fix, any token could read another caller's query
 * and results with `GET /api/search/tasks/:id`, and could cancel their search.
 */
describe("task ownership", () => {
  async function tokens(harness: Harness): Promise<{ alice: string; bob: string }> {
    const mint = async (name: string) => {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/admin/tokens",
        ...adminHeaders(harness),
        payload: { name, scopes: ["search"], rateLimitPerMin: 600 },
      });
      return response.json().token as string;
    };
    return { alice: await mint("alice"), bob: await mint("bob") };
  }

  function insertUnownedTask(harness: Harness, id: string, status: "running" | "completed"): void {
    const now = new Date().toISOString();
    harness.ctx.db
      .insert(searchTasks)
      .values({
        id,
        query: "unowned private query",
        mode: "basic",
        status,
        providersJson: "[]",
        resultCount: 0,
        rawCount: 0,
        durationMs: null,
        requestJson: JSON.stringify({ query: "unowned private query" }),
        actor: null,
        createdAt: now,
        finishedAt: status === "completed" ? now : null,
      })
      .run();
  }

  it("BUG-0116-03 service cancel denies an unowned task to another actor", async () => {
    const harness = await createHarness();
    const taskId = "task-unowned-service";
    insertUnownedTask(harness, taskId, "running");
    const controller = new AbortController();
    const controllers = (harness.ctx.search as unknown as { controllers: Map<string, AbortController> }).controllers;
    controllers.set(taskId, controller);

    const cancelled = harness.ctx.search.cancel(taskId, "token:bob");

    expect(cancelled).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("BUG-0116-03 internal trusted bypass can cancel an unowned task", async () => {
    const harness = await createHarness();
    const taskId = "task-unowned-internal";
    insertUnownedTask(harness, taskId, "running");
    const controller = new AbortController();
    const controllers = (harness.ctx.search as unknown as { controllers: Map<string, AbortController> }).controllers;
    controllers.set(taskId, controller);

    expect(harness.ctx.search.cancel(taskId, undefined)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("BUG-0116-03 an owner token can still cancel its own task", async () => {
    const harness = await createHarness();
    const taskId = "task-owned-alice";
    const now = new Date().toISOString();
    harness.ctx.db.insert(searchTasks).values({
      id: taskId,
      query: "alice query",
      mode: "basic",
      status: "running",
      providersJson: "[]",
      resultCount: 0,
      rawCount: 0,
      durationMs: null,
      requestJson: "{}",
      actor: "token:alice",
      createdAt: now,
      finishedAt: null,
    }).run();
    const controller = new AbortController();
    const controllers = (harness.ctx.search as unknown as { controllers: Map<string, AbortController> }).controllers;
    controllers.set(taskId, controller);

    expect(harness.ctx.search.cancel(taskId, "token:alice")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("BUG-0116-03 HTTP read and cancel deny an unowned task to token:bob", async () => {
    const harness = await createHarness();
    const { bob } = await tokens(harness);
    const completedId = "task-unowned-completed";
    const runningId = "task-unowned-running";
    insertUnownedTask(harness, completedId, "completed");
    insertUnownedTask(harness, runningId, "running");
    const controller = new AbortController();
    const controllers = (harness.ctx.search as unknown as { controllers: Map<string, AbortController> }).controllers;
    controllers.set(runningId, controller);

    const read = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${completedId}`,
      headers: { authorization: `Bearer ${bob}` },
    });
    const cancel = await harness.app.inject({
      method: "POST",
      url: `/api/search/tasks/${runningId}/cancel`,
      headers: { authorization: `Bearer ${bob}` },
    });

    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain("unowned private query");
    expect(cancel.json().ok).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("BUG-0116-03 an admin-issued Bearer token cannot read or cancel a null task", async () => {
    const harness = await createHarness();
    const minted = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "admin-bearer", scopes: ["search"], rateLimitPerMin: 600 },
    });
    expect(minted.statusCode).toBe(200);
    const adminBearer = minted.json().token as string;
    expect(harness.ctx.authDeps.tokens.verify(adminBearer)?.type).toBe("token");
    const completedId = "task-unowned-admin-bearer-completed";
    const runningId = "task-unowned-admin-bearer-running";
    insertUnownedTask(harness, completedId, "completed");
    insertUnownedTask(harness, runningId, "running");
    const controller = new AbortController();
    const controllers = (harness.ctx.search as unknown as { controllers: Map<string, AbortController> }).controllers;
    controllers.set(runningId, controller);

    const read = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${completedId}`,
      headers: { authorization: `Bearer ${adminBearer}` },
    });
    const cancel = await harness.app.inject({
      method: "POST",
      url: `/api/search/tasks/${runningId}/cancel`,
      headers: { authorization: `Bearer ${adminBearer}` },
    });

    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain("unowned private query");
    expect(cancel.json().ok).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("BUG-0116-03 admin session can read and cancel a null legacy task", async () => {
    const harness = await createHarness();
    const completedId = "task-unowned-admin-completed";
    const runningId = "task-unowned-admin-running";
    insertUnownedTask(harness, completedId, "completed");
    insertUnownedTask(harness, runningId, "running");
    const controller = new AbortController();
    const controllers = (harness.ctx.search as unknown as { controllers: Map<string, AbortController> }).controllers;
    controllers.set(runningId, controller);

    const read = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${completedId}`,
      cookies: { sh_session: harness.cookie },
    });
    const cancel = await harness.app.inject({
      method: "POST",
      url: `/api/search/tasks/${runningId}/cancel`,
      ...adminHeaders(harness),
    });

    expect(read.statusCode).toBe(200);
    expect(cancel.json().ok).toBe(true);
    expect(controller.signal.aborted).toBe(true);

    const auditRows = harness.ctx.sqlite
      .prepare("SELECT actor, action, target, detail_json FROM audit_logs WHERE target = ?")
      .all(runningId) as Array<{ actor: string; action: string; target: string; detail_json: string | null }>;
    expect(auditRows).toHaveLength(1);
    const [auditRow] = auditRows;
    expect(auditRow).toMatchObject({
      actor: "admin:admin@example.com",
      action: "search.task.cancel.unowned",
      target: runningId,
    });
    const auditDetail = JSON.parse(auditRow!.detail_json ?? "{}") as Record<string, unknown>;
    expect(auditDetail).toMatchObject({ taskId: runningId, privileged: true, unowned: true });
    const serializedAudit = JSON.stringify(auditRow);
    expect(serializedAudit).not.toContain("unowned private query");
    expect(serializedAudit).not.toContain(harness.cookie);
    expect(serializedAudit).not.toContain(harness.csrf);
  });

  it("does not expose one token's task to another token", async () => {
    const harness = await createHarness();
    await addMock(harness, "owner-mock", { resultCount: 2 });
    const { alice, bob } = await tokens(harness);

    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      headers: { authorization: `Bearer ${alice}` },
      payload: { query: "alice private", mode: "basic", limit: 3, skipCache: true },
    });
    const taskId = search.json().taskId as string;

    const read = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${taskId}`,
      headers: { authorization: `Bearer ${bob}` },
    });
    // 404, not 403: the existence of another caller's task must not leak either.
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain("alice private");

    const owner = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${taskId}`,
      headers: { authorization: `Bearer ${alice}` },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().query).toBe("alice private");
    // The owner field itself is not part of the public payload.
    expect(owner.json().actor).toBeUndefined();
  });

  it("does not let another token cancel a task", async () => {
    const harness = await createHarness();
    await addMock(harness, "cancel-mock", { resultCount: 2, latencyMs: 300 });
    const { alice, bob } = await tokens(harness);

    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      headers: { authorization: `Bearer ${alice}` },
      payload: { query: "cancel probe", mode: "basic", limit: 3, skipCache: true },
    });
    const taskId = search.json().taskId as string;

    const foreign = await harness.app.inject({
      method: "POST",
      url: `/api/search/tasks/${taskId}/cancel`,
      headers: { authorization: `Bearer ${bob}` },
    });
    expect(foreign.json().ok).toBe(false);
  });
});

/**
 * Status semantics must agree across REST, the task row and the dashboard.
 * Before the fix, a cancelled run counted as a failed search and dragged the
 * dashboard success rate down.
 */
describe("status agreement", () => {
  it("excludes cancelled runs from the success rate and counts them separately", async () => {
    const harness = await createHarness();
    await addMock(harness, "stats-mock", { resultCount: 2 });

    const ok = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...adminHeaders(harness),
      payload: { query: "stats ok", mode: "basic", limit: 3, skipCache: true },
    });
    expect(ok.statusCode).toBe(200);

    // A cancelled task is written directly: the HTTP path needs a live signal.
    const now = new Date().toISOString();
    harness.ctx.db
      .insert(searchTasks)
      .values({
        id: "task_cancelled_audit",
        query: "cancel me",
        mode: "basic",
        status: "cancelled",
        providersJson: "[]",
        resultCount: 0,
        rawCount: 0,
        durationMs: 5,
        requestJson: "{}",
        actor: "admin:admin@example.com",
        createdAt: now,
        finishedAt: now,
      })
      .run();

    const dashboard = await harness.app.inject({
      method: "GET",
      url: "/api/admin/dashboard?range=24h",
      ...adminHeaders(harness),
    });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const totals = dashboard.json().totals as {
      searches: number;
      successRate: number;
      cancelled: number;
      partial: number;
      failed: number;
    };
    expect(totals.cancelled).toBeGreaterThanOrEqual(1);
    expect(totals.failed).toBe(0);
    // 1 completed of 1 finished run ⇒ 100%, the cancel does not count against it.
    expect(totals.successRate).toBe(1);
  });
});
