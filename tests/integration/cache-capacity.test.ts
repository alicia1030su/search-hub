import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchResponse } from "@search-hub/shared";
import { createDb, resolveMigrationsDir, runMigrations, type DbHandle } from "@search-hub/db";
import { CacheBusyError, CacheService, deleteCacheKey } from "../../apps/api/src/services/cache.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const handles: DbHandle[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function response(padding = 0, label = "capacity"): SearchResponse {
  return {
    taskId: "task", query: label, mode: "basic", status: "completed",
    results: [{ id: label, title: label, url: "https://example.com/result", snippet: "x".repeat(padding), source: "stub", provider: "stub", providerType: "stub", providerName: "Stub", retrievedAt: "2026-01-01T00:00:00.000Z", score: 1, sources: [{ providerId: "stub", providerName: "Stub", providerType: "stub", url: "https://example.com/result", rank: 1 }] }],
    stats: { rawCount: 1, dedupedCount: 1, fusedCount: 1, providers: [{ providerId: "stub", providerName: "Stub", providerType: "stub", ok: true, attempts: 1, resultCount: 1, latencyMs: 1 }], rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false, timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 } },
    errors: [], failedSources: [], debug: { rewrittenQueries: [] },
  };
}

function fixture(limits = { maxEntries: 200, maxBytes: 1024 * 1024 }, now = { value: Date.parse("2026-01-01T00:00:00.000Z") }) {
  const directory = mkdtempSync(join(tmpdir(), "search-hub-capacity-"));
  directories.push(directory);
  const file = join(directory, "cache.db");
  const handle = createDb({ file });
  handles.push(handle);
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const cache = new CacheService({ db: handle.db, logger, limits, now: () => now.value, dbPath: file });
  return { directory, file, handle, cache, now };
}

function actualTotals(handle: DbHandle): { entries: number; bytes: number } {
  return handle.sqlite.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes),0) AS bytes FROM search_cache").get() as { entries: number; bytes: number };
}

function assertExactTotals(handle: DbHandle): void {
  const actual = actualTotals(handle);
  const row = handle.sqlite.prepare("SELECT value FROM search_cache_state WHERE key='cache:totals'").get() as { value: string };
  const totals = JSON.parse(row.value) as { entries: number; bytes: number };
  expect(totals.entries).toBe(actual.entries);
  expect(totals.bytes).toBe(actual.bytes);
}

describe("C01-C05 cache capacity and concurrency", () => {
  it("reproduces the 17/2,229,227 baseline fixture and enforces both caps after the fix", () => {
    const { handle, cache } = fixture();
    const large = response(0, "baseline fixture");
    const targetBytes = 131_131;
    const base = Buffer.byteLength(JSON.stringify(large), "utf8");
    large.results[0]!.snippet = "x".repeat(targetBytes - base + large.results[0]!.snippet.length);
    const json = JSON.stringify(large);
    expect(Buffer.byteLength(json, "utf8")).toBe(targetBytes);
    const insert = handle.sqlite.prepare("INSERT INTO search_cache (cache_key,response_json,status,mode,created_at,expires_at,last_accessed_at,size_bytes) VALUES (?,?,?,?,?,?,?,?)");
    for (let index = 0; index < 80; index += 1) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      insert.run(`old-${index}`, json, "completed", "basic", timestamp, "2027-01-01T00:00:00.000Z", timestamp, targetBytes);
    }
    cache.initialize();
    const result = cache.put("new-entry", large, 3600, "basic");
    const actual = actualTotals(handle);
    expect(result.evicted).toBeGreaterThan(64);
    expect(actual.entries).toBeLessThanOrEqual(200);
    expect(actual.bytes).toBeLessThanOrEqual(1024 * 1024);
    assertExactTotals(handle);
  });

  it("evicts in bounded LRU batches without over-evicting the entry cap", () => {
    const { handle, cache, now } = fixture({ maxEntries: 3, maxBytes: 8 * 1024 * 1024 });
    cache.initialize();
    for (const key of ["one", "two", "three"]) {
      now.value += 1000;
      cache.put(key, response(10, key), 3600, "basic");
    }
    now.value += 1000;
    expect(cache.get("one")?.response.query).toBe("one");
    now.value += 1000;
    cache.put("four", response(10, "four"), 3600, "basic");
    const actual = actualTotals(handle);
    expect(actual.entries).toBe(3);
    expect(actual.bytes).toBe(Number((handle.sqlite.prepare("SELECT SUM(size_bytes) AS n FROM search_cache").get() as { n: number }).n));
    expect(handle.sqlite.prepare("SELECT cache_key FROM search_cache ORDER BY cache_key").all()).toEqual([{ cache_key: "four" }, { cache_key: "one" }, { cache_key: "three" }]);
    assertExactTotals(handle);
  });

  it("reads the previous size inside the same transaction when replacing a key", () => {
    const { handle, cache } = fixture({ maxEntries: 10, maxBytes: 1024 * 1024 });
    cache.initialize();
    cache.put("replace", response(10), 3600, "basic");
    cache.put("replace", response(1000), 3600, "basic");
    expect(actualTotals(handle).entries).toBe(1);
    expect(actualTotals(handle).bytes).toBe(Buffer.byteLength(JSON.stringify(response(1000)), "utf8"));
    assertExactTotals(handle);
  });

  it("measures UTF-8 bytes and rejects oversize writes without touching valid rows", () => {
    const exact = response(0, "中文😀");
    const maxBytes = Buffer.byteLength(JSON.stringify(exact), "utf8");
    const { handle, cache } = fixture({ maxEntries: 10, maxBytes });
    cache.initialize();
    expect(cache.put("valid", exact, 3600, "basic").stored).toBe(true);
    const before = actualTotals(handle);
    const oversize = response(1, "中文😀");
    expect(cache.put("oversize", oversize, 3600, "basic")).toEqual({ stored: false, reason: "oversize", sizeBytes: Buffer.byteLength(JSON.stringify(oversize), "utf8") });
    expect(actualTotals(handle)).toEqual(before);
    expect(cache.get("valid")?.response.query).toBe("中文😀");
    assertExactTotals(handle);
  });

  it("keeps totals exact for expired/corrupt get, sweep, clear, retime, and deleteCacheKey", () => {
    const { handle, cache, now } = fixture({ maxEntries: 20, maxBytes: 1024 * 1024 });
    handle.sqlite.prepare("INSERT INTO search_cache (cache_key,response_json,status,mode,created_at,expires_at,last_accessed_at,size_bytes) VALUES ('corrupt','{broken','completed','basic',?,?,?,?)")
      .run(new Date(now.value).toISOString(), new Date(now.value + 3_600_000).toISOString(), new Date(now.value).toISOString(), 7);
    cache.initialize();
    cache.put("expired", response(1), 1, "basic");
    cache.put("valid", response(1), 3600, "basic");
    now.value += 2000;
    expect(cache.get("expired")).toBeNull();
    assertExactTotals(handle);
    expect(cache.get("corrupt")).toBeNull();
    assertExactTotals(handle);
    cache.put("sweep", response(1), 1, "basic");
    now.value += 2000;
    expect(cache.sweepExpired()).toBe(1);
    assertExactTotals(handle);
    expect(cache.retime(7200).removed).toBe(0);
    assertExactTotals(handle);
    deleteCacheKey(handle.db, "valid");
    assertExactTotals(handle);
    cache.put("last", response(1), 3600, "basic");
    expect(cache.clear()).toBeGreaterThan(0);
    assertExactTotals(handle);
  });

  it("rebuilds missing totals inside deleteCacheKey without scanning outside the transaction", () => {
    const { handle } = fixture();
    const json = JSON.stringify(response(1));
    handle.sqlite.prepare("INSERT INTO search_cache (cache_key,response_json,status,mode,created_at,expires_at,last_accessed_at,size_bytes) VALUES ('legacy',?,'completed','basic',?,?,?,?)")
      .run(json, "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", Buffer.byteLength(json));
    deleteCacheKey(handle.db, "legacy");
    assertExactTotals(handle);
    expect(actualTotals(handle)).toEqual({ entries: 0, bytes: 0 });
  });

  it("validates positive finite integer limits", () => {
    for (const limits of [{ maxEntries: 0, maxBytes: 1 }, { maxEntries: 1.5, maxBytes: 1 }, { maxEntries: 1, maxBytes: Number.POSITIVE_INFINITY }]) {
      expect(() => new CacheService({ db: {} as never, logger, limits })).toThrow(/positive finite integers/);
    }
  });

  it("serializes two independent processes with the same real DB limits", async () => {
    const { directory, file, handle } = fixture({ maxEntries: 50, maxBytes: 512 * 1024 });
    const repoRoot = resolve(import.meta.dirname, "../..");
    const workerPath = join(directory, "capacity-worker.mjs");
    const worker = `
import { createDb, resolveMigrationsDir, runMigrations } from ${JSON.stringify(pathToFileURL(join(repoRoot, "packages/db/src/index.ts")).href)};
import { CacheService } from ${JSON.stringify(pathToFileURL(join(repoRoot, "apps/api/src/services/cache.ts")).href)};
const handle = createDb({ file: process.argv[2] });
runMigrations(handle.sqlite, resolveMigrationsDir());
const cache = new CacheService({ db: handle.db, logger: {debug(){},info(){},warn(){},error(){}}, limits: {maxEntries:50,maxBytes:512*1024} });
const id = process.argv[3];
let busyErrors = 0;
const violations = [];
process.send?.({ type: "ready" });
process.once("message", async () => {
  try {
    cache.initialize();
    for (let round = 0; round < 20; round += 1) {
      for (let index = 0; index < 10; index += 1) {
        const size = (round + index) % 3 === 0 ? 64 * 1024 : 8 * 1024;
        const body = { taskId:"worker", query:"fixture", mode:"basic", status:"completed", results:[{title:"fixture",url:"https://example.com/"+id,snippet:"x".repeat(size)}], stats:{rawCount:1,dedupedCount:1,fusedCount:1,providers:[],rerankApplied:false,embeddingApplied:false,summaryApplied:false,partial:false,timing:{totalMs:0,fanoutMs:0,fusionMs:0}}, errors:[],failedSources:[],debug:{rewrittenQueries:[]} };
        try { cache.put(id + "-" + round + "-" + index, body, 3600, "basic"); } catch (error) { if (error.name === "CacheBusyError") busyErrors += 1; else throw error; }
      }
      const totals = handle.sqlite.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes),0) AS bytes FROM search_cache").get();
      if (totals.entries > 50 || totals.bytes > 512 * 1024) violations.push({ round, ...totals });
    }
    process.send?.({ type: "done", busyErrors, violations });
  } catch (error) {
    process.send?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    handle.close();
    process.disconnect?.();
  }
});
`;
    writeFileSync(workerPath, worker, "utf8");
    const runWorker = (id: string): Promise<{ busyErrors: number; violations: unknown[] }> => new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", workerPath, file, id], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.on("message", (message: { type: string; busyErrors?: number; violations?: unknown[]; message?: string }) => {
        if (message.type === "ready") child.send("start");
        if (message.type === "done") resolvePromise({ busyErrors: message.busyErrors ?? 0, violations: message.violations ?? [] });
        if (message.type === "error") reject(new Error(message.message));
      });
      child.once("error", reject);
      child.once("close", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`)); });
    });
    const results = await Promise.all([runWorker("a"), runWorker("b")]);
    expect(results.flatMap((result) => result.violations)).toEqual([]);
    const actual = actualTotals(handle);
    expect(actual.entries).toBeLessThanOrEqual(50);
    expect(actual.bytes).toBeLessThanOrEqual(512 * 1024);
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_tasks").get()).toEqual({ n: 0 });
    assertExactTotals(handle);
    rmSync(workerPath, { force: true });
  }, 30_000);

  it("wraps persistent BUSY/LOCKED failures in CacheBusyError", () => {
    const transaction = () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); };
    const fakeDb = { transaction } as unknown as ConstructorParameters<typeof CacheService>[0]["db"];
    const cache = new CacheService({ db: fakeDb, logger, limits: { maxEntries: 1, maxBytes: 1024 } });
    expect(() => cache.initialize()).toThrow(CacheBusyError);
  });
});
