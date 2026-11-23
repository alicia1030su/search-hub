import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchResponse, SafeFetch, SearchProviderAdapter, ProviderSearchOutput } from "@search-hub/shared";
import { createDb, resolveMigrationsDir, runMigrations, type DbHandle } from "@search-hub/db";
import { KeyScheduler, type ProviderRuntime } from "@search-hub/core";
import { CacheService } from "../../apps/api/src/services/cache.js";
import { SearchFlightService } from "../../apps/api/src/services/singleflight.js";
import { SearchService, type SearchServiceDeps } from "../../apps/api/src/services/search.js";
import type { ProviderService } from "../../apps/api/src/services/providers.js";
import type { ModelService } from "../../apps/api/src/services/models.js";
import type { SettingsService } from "../../apps/api/src/services/settings.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const handles: DbHandle[] = [];
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function resultResponse(taskId = "task"): SearchResponse {
  return {
    taskId,
    query: "stampede fixture",
    mode: "basic",
    status: "completed",
    results: [{ id: "stub", title: "stub", url: "https://example.com/stub", snippet: "fixed", source: "stub", provider: "stub", providerType: "stub", providerName: "Stub", retrievedAt: "2026-01-01T00:00:00.000Z", score: 1, sources: [{ providerId: "stub", providerName: "Stub", providerType: "stub", url: "https://example.com/stub", rank: 1 }] }],
    stats: { rawCount: 1, dedupedCount: 1, fusedCount: 1, providers: [{ providerId: "stub", providerName: "Stub", providerType: "stub", ok: true, attempts: 1, resultCount: 1, latencyMs: 1 }], rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false, timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 } },
    errors: [], failedSources: [], debug: { rewrittenQueries: [] },
  };
}

async function stubServer() {
  let calls = 0;
  const server = createServer(async (_request, response) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ title: "stub", url: "https://example.com/stub", snippet: "fixed" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls: () => calls, port: (server.address() as { port: number }).port };
}

async function searchFixture() {
  const directory = mkdtempSync(join(tmpdir(), "search-hub-stampede-"));
  directories.push(directory);
  const file = join(directory, "cache.db");
  const handle = createDb({ file });
  handles.push(handle);
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const cache = new CacheService({ db: handle.db, logger, dbPath: file });
  cache.initialize();
  const stub = await stubServer();
  const makeRuntime = (id: string): ProviderRuntime => {
    const config = { id, name: id, type: "stub", baseUrl: `http://127.0.0.1:${stub.port}`, timeoutMs: 5000, maxResults: 5, language: null, freshness: null, model: null, maxRetries: 0, breakerThreshold: 5, breakerCooldownMs: 30_000, config: {} };
    const adapter: SearchProviderAdapter = {
      type: "stub", requiresKey: false, supportsTest: false,
      async search(input, ctx) { return (await ctx.fetch(`${config.baseUrl}/search?q=${encodeURIComponent(input.query)}`, { signal: input.signal })).data as ProviderSearchOutput; },
    };
    const scheduler = new KeyScheduler({ providerId: id, strategy: "round_robin", perKeyConcurrency: 1000, rpmLimit: 100_000, dailyQuota: null, cooldownMs: 0, breakerThreshold: 5, keys: [] });
    return { config, adapter, scheduler, enabled: true, breaker: { failures: 0, openUntilMs: null } };
  };
  const runtimes = new Map([["stub-a", makeRuntime("stub-a")], ["stub-b", makeRuntime("stub-b")]]);
  const credentialVersions = new Map([["stub-a", "credential-stub-a"], ["stub-b", "credential-stub-b"]]);
  const blocked = new Map<string, { code: string; message: string; until: string }>();
  const providers = {
    runtimesFor: (ids: string[]) => ids.map((id) => runtimes.get(id)!),
    credentialVersion: (id: string) => credentialVersions.get(id) ?? "missing",
    resolveKey: async () => undefined,
    redactKeyMessage: () => null,
    redactProviderMessage: () => null,
  } as unknown as ProviderService;
  const settings = { get: () => ({ defaults: { mode: "basic", limit: 5, timeoutMs: 5000 }, cache: { enabled: true, ttlSeconds: 3600 }, retention: { taskRetentionDays: 7, logRetentionDays: 7 } }) } as unknown as SettingsService;
  const models = { getEnabled() { throw new Error("not configured"); }, findDefault: () => null, resolveConfig: () => null } as unknown as ModelService;
  const deps: SearchServiceDeps = {
    db: handle.db,
    providers,
    models,
    settings,
    fetch: (async <T,>(url: string, init?: RequestInit) => {
      const response = await fetch(url, init);
      const text = await response.text();
      return { status: response.status, headers: response.headers, url: response.url, data: (text ? JSON.parse(text) : null) as T };
    }) as SafeFetch,
    logger,
    health: { blockedProviders: () => blocked },
    cache,
  };
  return {
    handle, cache, search: new SearchService(deps), stub, runtimes,
    setCredentialVersion: (id: string, version: string) => credentialVersions.set(id, version),
    blocked,
  };
}

describe("C09 real cold stampede", () => {
  it("shares 100 equivalent cold misses into one upstream call and one cache row", async () => {
    const { handle, cache, search, stub } = await searchFixture();
    const responses = await Promise.all(Array.from({ length: 100 }, () => search.execute({ query: "cold stampede fixture", mode: "basic", limit: 5, providers: ["stub-a"] })));
    expect(stub.calls()).toBe(1);
    expect(responses.every((response) => response.status === "completed")).toBe(true);
    expect(new Set(responses.map((response) => response.taskId)).size).toBe(100);
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_tasks").get()).toEqual({ n: 100 });
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_cache").get()).toEqual({ n: 1 });
    responses[0]!.results[0]!.title = "mutated";
    expect(responses[1]!.results[0]!.title).toBe("stub");
    const hits = await Promise.all(Array.from({ length: 10 }, () => search.execute({ query: "cold stampede fixture", mode: "basic", limit: 5, providers: ["stub-a"] })));
    expect(hits.every((response) => response.stats.cached === true)).toBe(true);
    expect(stub.calls()).toBe(1);
    expect(search.flightWaitingCount).toBe(0);
    search.shutdown();
    expect(cache.totals().entries).toBe(1);
  });

  it("does not share across provider/credential boundaries or bypass modes", async () => {
    const { handle, search, stub } = await searchFixture();
    await Promise.all([
      search.execute({ query: "provider boundary", mode: "basic", providers: ["stub-a"] }),
      search.execute({ query: "provider boundary", mode: "basic", providers: ["stub-b"] }),
    ]);
    expect(stub.calls()).toBe(2);
    await Promise.all(Array.from({ length: 10 }, () => search.execute({ query: "skip boundary", mode: "basic", skipCache: true, providers: ["stub-a"] })));
    expect(stub.calls()).toBe(12);
    await Promise.all(Array.from({ length: 10 }, () => search.execute({ query: "raw boundary", mode: "basic", includeRaw: true, providers: ["stub-a"] })));
    expect(stub.calls()).toBe(22);
    await Promise.all(Array.from({ length: 10 }, () => search.execute({ query: "evaluate boundary", mode: "basic", providers: ["stub-a"] }, { evaluate: true })));
    expect(stub.calls()).toBe(32);
    await Promise.all(Array.from({ length: 10 }, () => search.execute({ query: "gate boundary", mode: "basic", providers: ["stub-a"] }, { beforeRequest: () => {} })));
    expect(stub.calls()).toBe(42);
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_tasks").get()).toEqual({ n: 32 });
    search.shutdown();
  });

  it("invalidates on credentialVersion and never replays a parked-health result", async () => {
    const { handle, cache, search, stub, setCredentialVersion, blocked } = await searchFixture();
    const request = { query: "credential and health boundary", mode: "basic" as const, providers: ["stub-a"] };
    expect((await search.execute(request)).status).toBe("completed");
    setCredentialVersion("stub-a", "credential-v2");
    expect((await search.execute(request)).stats.cached).toBeUndefined();
    expect(stub.calls()).toBe(2);
    expect(cache.totals().entries).toBe(2);
    blocked.set("stub-a", { code: "quota_exhausted", message: "parked", until: "2027-01-01T00:00:00.000Z" });
    expect((await search.execute(request)).status).toBe("failed");
    expect(stub.calls()).toBe(2);
    expect(cache.totals().entries).toBe(2);
    blocked.clear();
    expect((await search.execute(request)).stats.cached).toBe(true);
    expect(stub.calls()).toBe(2);
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_cache").get()).toEqual({ n: 2 });
    search.shutdown();
  });

  it("does not cache failed physical searches and removes the settled flight", async () => {
    const { cache, search, stub } = await searchFixture();
    const failing = search.execute({ query: "failure boundary", mode: "basic", providers: ["missing"] });
    await expect(failing).rejects.toThrow();
    expect(stub.calls()).toBe(0);
    expect(cache.totals().entries).toBe(0);
    expect(search.flightWaitingCount).toBe(0);
    search.shutdown();
  });
});

describe("C10 bounded singleflight lifecycle", () => {
  it("isolates one waiter cancellation and aborts only after the last waiter leaves", async () => {
    const flights = new SearchFlightService();
    let shared: AbortController | null = null;
    let resolveFactory: ((value: SearchResponse) => void) | null = null;
    const factory = (signal: AbortSignal) => {
      shared = new AbortController();
      signal.addEventListener("abort", () => shared!.abort(), { once: true });
      return new Promise<SearchResponse>((resolve) => { resolveFactory = resolve; });
    };
    const first = new AbortController();
    const second = new AbortController();
    const one = flights.run("same", first.signal, factory);
    const two = flights.run("same", second.signal, factory);
    expect(flights.waitingCount).toBe(2);
    first.abort(new Error("cancel one"));
    await expect(one).rejects.toThrow("cancel one");
    expect(shared!.signal.aborted).toBe(false);
    resolveFactory!(resultResponse());
    expect((await two).taskId).toBe("task");
    expect(flights.waitingCount).toBe(0);

    const all = new AbortController();
    const pending = flights.run("all", all.signal, factory);
    await Promise.resolve();
    all.abort(new Error("cancel all"));
    await expect(pending).rejects.toThrow("cancel all");
    expect(shared!.signal.aborted).toBe(true);
  });

  it("enforces capacity, clears timers/listeners on shutdown, and never crosses keys", async () => {
    const flights = new SearchFlightService({ maxFlights: 1, maxWaitersPerFlight: 2, maxTotalWaiters: 3 });
    const factory = () => new Promise<SearchResponse>(() => {});
    const first = flights.run("one", new AbortController().signal, factory);
    const unshared = flights.run("two", new AbortController().signal, async () => resultResponse("unshared"));
    expect((await unshared).taskId).toBe("unshared");
    expect(flights.size).toBe(1);
    flights.shutdown();
    await expect(first).rejects.toThrow("shut down");
    expect(flights.size).toBe(0);
    expect(flights.waitingCount).toBe(0);
  });
});
