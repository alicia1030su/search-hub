import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SearchResponse } from "@search-hub/shared";
import { accessTokens, sessions } from "@search-hub/db";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createOpenApiDocument } from "../../apps/api/src/routes/openapi-routes.js";

let app: FastifyInstance | null = null;
let ctx: AppContext | null = null;
let dir: string | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  ctx = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function harness() {
  dir = mkdtempSync(join(tmpdir(), "search-hub-resources-"));
  const config = {
    ...loadConfig(), nodeEnv: "test" as const, dataDir: dir, dbPath: join(dir, "resources.db"),
    staticDir: null, cookieSecure: false, setupToken: null, logLevel: "silent" as const,
    corsOrigins: [], rateLimitPerMin: 100_000,
  };
  ctx = createContext(config);
  app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! } });
  expect(setup.statusCode).toBe(200);
  const cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  const csrf = setup.json().csrfToken as string;
  return { cookie, csrf };
}

function watchedRows(handle: AppContext["sqlite"]): Record<string, unknown> {
  const tables = ["admin_users", "sessions", "access_tokens", "settings", "search_cache_state", "search_tasks", "audit_logs", "provider_health_checks", "search_cache_metrics", "health_probe_budget"];
  return Object.fromEntries(tables.map((table) => [table, handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe("GET /api/admin/resources", () => {
  it("enforces schema and the session-only auth matrix", async () => {
    const { cookie, csrf } = await harness();
    expect((await app!.inject({ method: "GET", url: "/api/admin/resources" })).statusCode).toBe(401);
    expect((await app!.inject({ method: "GET", url: "/api/admin/resources", cookies: { sh_session: "invalid" } })).statusCode).toBe(401);
    const token = await app!.inject({ method: "POST", url: "/api/admin/tokens", cookies: { sh_session: cookie }, headers: { "x-csrf-token": csrf }, payload: { name: "resources", scopes: ["admin"], rateLimitPerMin: 100 } });
    const bearer = token.json().token as string;
    const tokenBefore = ctx!.db.select().from(accessTokens).all()[0]!;
    expect((await app!.inject({ method: "GET", url: "/api/admin/resources", headers: { authorization: `Bearer ${bearer}` } })).statusCode).toBe(403);
    expect(ctx!.db.select().from(accessTokens).all()[0]!.lastUsedAt).toBe(tokenBefore.lastUsedAt);
    expect((await app!.inject({ method: "GET", url: "/api/admin/resources", headers: { authorization: "Bearer invalid" } })).statusCode).toBe(403);
    expect((await app!.inject({ method: "GET", url: "/api/admin/resources", headers: { authorization: `Bearer ${bearer}` }, cookies: { sh_session: cookie } })).statusCode).toBe(403);
    const revoked = await app!.inject({ method: "DELETE", url: `/api/admin/tokens/${token.json().record.id}`, cookies: { sh_session: cookie }, headers: { "x-csrf-token": csrf } });
    expect(revoked.statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: "/api/admin/resources", headers: { authorization: `Bearer ${bearer}` } })).statusCode).toBe(403);
    const response = await app!.inject({ method: "GET", url: "/api/admin/resources", cookies: { sh_session: cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe(1);
    expect(body.process.memory.rssBytes).toBeGreaterThan(0);
    expect(body.activity.queue.total).toBe(body.activity.queue.providerKey + body.activity.queue.health + body.activity.queue.singleflightFollowers);
    expect(body.cache.diskScope).toBe("whole_sqlite_database");
    expect(body.cache.dbFileBytes).toBeGreaterThan(0);
    expect(response.body).not.toContain(dir!);
    expect(response.body).not.toContain(bearer);
    expect(response.body).not.toContain("resource-fixture");
    expect(createOpenApiDocument("test").paths["/api/admin/resources"]).toBeDefined();
  });

  it("returns 401 for an expired session without deleting its row", async () => {
    const { cookie } = await harness();
    ctx!.db.update(sessions).set({ expiresAt: "2020-01-01T00:00:00.000Z" }).run();
    const before = ctx!.db.select().from(sessions).all();
    const response = await app!.inject({ method: "GET", url: "/api/admin/resources", cookies: { sh_session: cookie } });
    expect(response.statusCode).toBe(401);
    expect(ctx!.db.select().from(sessions).all()).toEqual(before);
  });

  it("degrades missing cache totals without writing to the database", async () => {
    const { cookie } = await harness();
    ctx!.sqlite.prepare("DELETE FROM search_cache_state WHERE key = 'cache:totals'").run();
    const before = (ctx!.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const response = await app!.inject({ method: "GET", url: "/api/admin/resources", cookies: { sh_session: cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().cache).toMatchObject({ entries: null, bytes: null, totalsReason: "totals_missing" });
    expect(response.json().unavailable).toContainEqual({ field: "cache.totals", source: "search_cache_state", reason: "totals_missing" });
    expect((ctx!.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(before);
  });

  it("keeps cache totals/disk exact and performs zero writes across 1000 sequential reads", async () => {
    const { cookie } = await harness();
    const response: SearchResponse = {
      taskId: "task", query: "fixture", mode: "basic", status: "completed", results: [],
      stats: { rawCount: 0, dedupedCount: 0, fusedCount: 0, providers: [], rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false, timing: { totalMs: 0, fanoutMs: 0, fusionMs: 0 } },
      errors: [], failedSources: [], debug: { rewrittenQueries: [] },
    };
    ctx!.cache.put("resource-fixture", response, 3600, "basic");
    ctx!.db.update(sessions).set({ lastSeenAt: "2020-01-01T00:00:00.000Z" }).run();
    const beforeChanges = (ctx!.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const beforeRows = watchedRows(ctx!.sqlite);
    for (let index = 0; index < 1000; index += 1) {
      const result = await app!.inject({ method: "GET", url: "/api/admin/resources", cookies: { sh_session: cookie } });
      expect(result.statusCode, result.body).toBe(200);
    }
    expect((ctx!.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(beforeChanges);
    expect(watchedRows(ctx!.sqlite)).toEqual(beforeRows);
    expect(ctx!.db.select().from(sessions).all()[0]?.lastSeenAt).toBe("2020-01-01T00:00:00.000Z");
    const snapshot = ctx!.runtimeMonitor.snapshot();
    expect(snapshot.cache.entries).toBe(1);
    expect(snapshot.cache.bytes).toBe(Buffer.byteLength(JSON.stringify(response), "utf8"));
    expect(snapshot.cache.dbFileBytes).toBeGreaterThan(0);
  });

  it("uses primary-key/index lookups rather than table scans", async () => {
    await harness();
    const plans = [
      ctx!.sqlite.prepare("EXPLAIN QUERY PLAN SELECT value FROM search_cache_state WHERE key = 'cache:totals'").all(),
      ctx!.sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE token_hash = 'x'").all(),
      ctx!.sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM admin_users WHERE id = 'x'").all(),
    ];
    for (const plan of plans) {
      const detail = JSON.stringify(plan);
      expect(detail).toMatch(/USING (PRIMARY KEY|INDEX)/i);
      expect(detail).not.toMatch(/SCAN/i);
    }
  });
});
