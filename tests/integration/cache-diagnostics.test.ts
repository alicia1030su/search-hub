import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SearchResponse } from "@search-hub/shared";
import { createDb, resolveMigrationsDir, runMigrations, type DbHandle } from "@search-hub/db";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { CacheService } from "../../apps/api/src/services/cache.js";
import { CacheDiagnostics, LatencyHistogram } from "../../apps/api/src/services/cache-diagnostics.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const handles: DbHandle[] = [];
const directories: string[] = [];
let app: FastifyInstance | null = null;
let context: AppContext | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  context = null;
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function response(padding = 0): SearchResponse {
  return {
    taskId: "task", query: "sensitive-query-body", mode: "basic", status: "completed",
    results: [{ id: "result", title: "result", url: "https://example.com/result", snippet: "x".repeat(padding), source: "stub", provider: "stub", providerType: "stub", providerName: "Stub", retrievedAt: "2026-01-01T00:00:00.000Z", score: 1, sources: [{ providerId: "stub", providerName: "Stub", providerType: "stub", url: "https://example.com/result", rank: 1 }] }],
    stats: { rawCount: 1, dedupedCount: 1, fusedCount: 1, providers: [{ providerId: "stub", providerName: "Stub", providerType: "stub", ok: true, attempts: 1, resultCount: 1, latencyMs: 1 }], rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false, timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 } },
    errors: [], failedSources: [], debug: { rewrittenQueries: [] },
  };
}

function directCache(maxEntries = 100, maxBytes = 1024 * 1024) {
  const directory = mkdtempSync(join(tmpdir(), "search-hub-diagnostics-"));
  directories.push(directory);
  const file = join(directory, "cache.db");
  const handle = createDb({ file });
  handles.push(handle);
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const cache = new CacheService({
    db: handle.db,
    logger,
    limits: { maxEntries, maxBytes },
    dbPath: file,
    osPageCache: () => ({ value: 4096, source: "fixture", reason: null }),
  });
  cache.initialize();
  return { cache, handle, file };
}

describe("C07 bounded cache diagnostics", () => {
  it("uses fixed logarithmic buckets and null quantiles without samples", () => {
    const histogram = new LatencyHistogram();
    expect(histogram.snapshot().p50Ms).toBeNull();
    expect(histogram.snapshot().p95Ms).toBeNull();
    for (let index = 0; index < 10_000; index += 1) histogram.record(index % 1000);
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(10_000);
    expect(snapshot.buckets).toHaveLength(64);
    expect(snapshot.quantileMethod).toBe("histogram_nearest_bucket");
    expect(snapshot.p50Ms).toBeGreaterThan(0);
    expect(snapshot.p95Ms).toBeGreaterThanOrEqual(snapshot.p50Ms!);
    expect(() => new LatencyHistogram(65)).toThrow(/48\.\.64/);
  });

  it("records entries/bytes, rates, maintenance, evicted bytes, and separate disk readings", () => {
    const { cache, handle, file } = directCache(1, 64 * 1024);
    cache.put("one", response(400), 3600, "basic");
    cache.put("two", response(400), 3600, "basic");
    expect(cache.get("two")).not.toBeNull();
    cache.sweepExpired();
    const stats = cache.stats({ enabled: true, ttlSeconds: 3600 });
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(Buffer.byteLength(JSON.stringify(response(400)), "utf8"));
    expect(stats.evicted).toBe(1);
    expect(stats.evictedBytes).toBe(Buffer.byteLength(JSON.stringify(response(400)), "utf8"));
    expect(stats.diagnostics.query.count).toBe(3);
    expect(stats.diagnostics.read.count).toBe(1);
    expect(stats.diagnostics.write.count).toBe(2);
    expect(stats.diagnostics.maintenance.count).toBe(1);
    expect(stats.diagnostics.lastMaintenance?.kind).toBe("sweep");
    expect(stats.diagnostics.disk.dbFileBytes).toBeGreaterThan(0);
    expect(stats.diagnostics.disk.walFileBytes).toBeGreaterThanOrEqual(0);
    expect(stats.diagnostics.disk.osPageCacheBytes).toBe(4096);
    expect(handle.sqlite.prepare("SELECT value FROM search_cache_state WHERE key='cache:totals'").get()).toBeDefined();
    expect(file).toContain("cache.db");
  });

  it("keeps CacheDiagnostics state bounded and exposes no raw samples", () => {
    const diagnostics = new CacheDiagnostics();
    for (let index = 0; index < 100_000; index += 1) diagnostics.recordRead(index % 100);
    const snapshot = diagnostics.snapshot({ entries: 0, bytes: 0, disk: { dbFileBytes: null, walFileBytes: null, osPageCacheBytes: null, dbSource: "unavailable", walSource: "unavailable", osPageCacheSource: "unavailable", osPageCacheReason: "unknown" } });
    expect(snapshot.read.count).toBe(100_000);
    expect(snapshot.read.buckets).toHaveLength(64);
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-query-body");
  });

  it("returns diagnostics through the admin cache endpoint without query or key material", async () => {
    const directory = mkdtempSync(join(tmpdir(), "search-hub-admin-cache-"));
    directories.push(directory);
    const config = {
      ...loadConfig(),
      nodeEnv: "test" as const,
      dataDir: directory,
      dbPath: join(directory, "cache.db"),
      staticDir: null,
      cookieSecure: false,
      setupToken: null,
      logLevel: "silent" as const,
      corsOrigins: [],
      rateLimitPerMin: 100_000,
    };
    context = createContext(config);
    const fastify = await buildApp(context);
    app = fastify;
    await fastify.ready();
    const setup = await fastify.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: context.setupToken.value! } });
    expect(setup.statusCode).toBe(200);
    const cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
    context.cache.put("diagnostics-key", response(), 3600, "basic");
    const endpoint = await fastify.inject({ method: "GET", url: "/api/admin/cache", cookies: { sh_session: cookie } });
    expect(endpoint.statusCode).toBe(200);
    expect(endpoint.json().diagnostics.entries).toBe(1);
    expect(endpoint.json().diagnostics.quantileMethod).toBe("histogram_nearest_bucket");
    expect(endpoint.json().diagnostics.read.quantileMethod).toBe("histogram_nearest_bucket");
    expect(endpoint.body).not.toContain("sensitive-query-body");
    expect(endpoint.body).not.toContain("diagnostics-key");
  });
});
