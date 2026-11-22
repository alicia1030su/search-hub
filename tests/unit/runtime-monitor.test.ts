import { describe, expect, it, vi } from "vitest";
import { RuntimeMonitor, type RuntimeMonitorDeps } from "../../apps/api/src/services/runtime-monitor.js";

function deps(overrides: Partial<RuntimeMonitorDeps> = {}): RuntimeMonitorDeps {
  return {
    cache: { totals: () => ({ entries: 0, bytes: 0, updatedAt: "2026-01-01T00:00:00.000Z", source: "search_cache_state", reason: null }) },
    search: { activeSearchCount: 0, queuedFollowerCount: 0 },
    providers: { queueDepth: 0 },
    health: { activeProbeCount: 0, queueDepth: 0 },
    dbPath: "/private/search-hub.db",
    now: () => Date.parse("2026-01-01T01:00:00.000Z"),
    memoryUsage: () => ({ rss: 100, heapUsed: 20, heapTotal: 30, external: 4, arrayBuffers: 5 }),
    uptime: () => 42,
    platform: "test-os",
    nodeVersion: "v-test",
    statFile: (filePath) => ({ size: filePath.endsWith("-wal") ? 7 : 11 }),
    ...overrides,
  };
}

describe("RuntimeMonitor", () => {
  it("returns zero values, exact queue sum, sources, and separate disk readings", () => {
    const snapshot = new RuntimeMonitor(deps({
      search: { activeSearchCount: 2, queuedFollowerCount: 3 },
      providers: { queueDepth: 4 },
      health: { activeProbeCount: 5, queueDepth: 6 },
    })).snapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.process.memory).toEqual({ rssBytes: 100, heapUsedBytes: 20, heapTotalBytes: 30, externalBytes: 4, arrayBuffersBytes: 5 });
    expect(snapshot.process.sources).toEqual({ rss: "node_process", heapUsed: "v8", heapTotal: "v8", external: "v8", arrayBuffers: "v8", uptime: "node_process" });
    expect(snapshot.activity).toEqual({ activeSearches: 2, activeProbes: 5, queue: { total: 13, providerKey: 4, health: 6, singleflightFollowers: 3 } });
    expect(snapshot.cache).toMatchObject({ entries: 0, bytes: 0, dbFileBytes: 11, walFileBytes: 7, diskScope: "whole_sqlite_database" });
    expect(snapshot.unavailable).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("/private/");
  });

  it("keeps missing totals and stat failures local with enum reasons and no raw messages", () => {
    const snapshot = new RuntimeMonitor(deps({
      cache: { totals: () => ({ entries: null, bytes: null, updatedAt: null, source: "search_cache_state", reason: "totals_missing" }) },
      statFile: (filePath) => { throw Object.assign(new Error("secret /private/path"), { code: filePath.endsWith("-wal") ? "EACCES" : "ENOENT" }); },
    })).snapshot();
    expect(snapshot.cache.entries).toBeNull();
    expect(snapshot.cache.dbFileBytes).toBeNull();
    expect(snapshot.cache.walFileBytes).toBeNull();
    expect(snapshot.unavailable).toEqual([
      { field: "cache.totals", source: "search_cache_state", reason: "totals_missing" },
      { field: "cache.dbFileBytes", source: "fs.stat", reason: "not_found" },
      { field: "cache.walFileBytes", source: "fs.stat", reason: "permission_denied" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });

  it("marks memory databases unavailable without stat calls", () => {
    const statFile = vi.fn(() => ({ size: 1 }));
    const snapshot = new RuntimeMonitor(deps({ dbPath: ":memory:", statFile })).snapshot();
    expect(statFile).not.toHaveBeenCalled();
    expect(snapshot.unavailable.map((item) => item.reason)).toEqual(["memory_database", "memory_database"]);
  });

  it("degrades invalid memory/stat/uptime and thrown totals locally", () => {
    const snapshot = new RuntimeMonitor(deps({
      cache: { totals: () => { throw new Error("database unavailable"); } },
      memoryUsage: () => ({ rss: Number.NaN, heapUsed: -1, heapTotal: Number.POSITIVE_INFINITY, external: 1, arrayBuffers: 2 }),
      uptime: () => { throw new Error("uptime unavailable"); },
      statFile: () => ({ size: Number.NaN }),
    })).snapshot();
    expect(snapshot.process.memory.rssBytes).toBeNull();
    expect(snapshot.process.memory.heapUsedBytes).toBeNull();
    expect(snapshot.process.memory.heapTotalBytes).toBeNull();
    expect(snapshot.process.uptimeSeconds).toBeNull();
    expect(snapshot.cache.entries).toBeNull();
    expect(snapshot.cache.dbFileBytes).toBeNull();
    expect(snapshot.unavailable.map((item) => item.reason)).toEqual(expect.arrayContaining(["invalid_value", "uptime_unavailable", "totals_unavailable"]));
    expect(JSON.stringify(snapshot)).not.toContain("database unavailable");
  });

  it("never calls stats, listRows, or activeRuntimes and creates no timer", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const forbidden = () => { throw new Error("forbidden full scan"); };
    const snapshot = new RuntimeMonitor(deps({
      cache: { totals: () => ({ entries: 1, bytes: 2, updatedAt: null, source: "search_cache_state", reason: null }), stats: forbidden } as never,
      providers: { queueDepth: 0, listRows: forbidden } as never,
      search: { activeSearchCount: 0, queuedFollowerCount: 0, activeRuntimes: forbidden } as never,
    })).snapshot();
    expect(snapshot.cache.entries).toBe(1);
    expect(setInterval).not.toHaveBeenCalled();
    setInterval.mockRestore();
  });
});
