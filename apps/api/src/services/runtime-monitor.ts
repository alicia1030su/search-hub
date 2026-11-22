import { statSync } from "node:fs";
import type { CacheTotalsResult } from "./cache.js";

export interface RuntimeUnavailable {
  field: string;
  source: string;
  reason: "totals_missing" | "totals_unavailable" | "memory_database" | "not_found" | "permission_denied" | "stat_failed" | "memory_unavailable" | "uptime_unavailable" | "invalid_value";
}

export interface RuntimeResourceSnapshot {
  schemaVersion: 1;
  sampledAt: string;
  process: {
    platform: string;
    nodeVersion: string;
    uptimeSeconds: number | null;
    memory: {
      rssBytes: number | null;
      heapUsedBytes: number | null;
      heapTotalBytes: number | null;
      externalBytes: number | null;
      arrayBuffersBytes: number | null;
    };
    sources: {
      rss: string;
      heapUsed: string;
      heapTotal: string;
      external: string;
      arrayBuffers: string;
      uptime: string;
    };
  };
  activity: {
    activeSearches: number;
    activeProbes: number;
    queue: { total: number; providerKey: number; health: number; singleflightFollowers: number };
  };
  cache: {
    entries: number | null;
    bytes: number | null;
    totalsUpdatedAt: string | null;
    totalsSource: string;
    totalsReason: string | null;
    dbFileBytes: number | null;
    walFileBytes: number | null;
    dbFileSource: string;
    walFileSource: string;
    diskScope: "whole_sqlite_database";
  };
  unavailable: RuntimeUnavailable[];
}

const PROCESS_SOURCES: RuntimeResourceSnapshot["process"]["sources"] = Object.freeze({
  rss: "node_process",
  heapUsed: "v8",
  heapTotal: "v8",
  external: "v8",
  arrayBuffers: "v8",
  uptime: "node_process",
});
const EMPTY_UNAVAILABLE: RuntimeUnavailable[] = [];

export interface RuntimeMonitorDeps {
  cache: { totals(): CacheTotalsResult };
  search: { activeSearchCount: number; queuedFollowerCount: number };
  providers: { queueDepth: number };
  health: { activeProbeCount: number; queueDepth: number };
  dbPath: string | null;
  now?: () => number;
  memoryUsage?: () => NodeJS.MemoryUsage;
  uptime?: () => number;
  platform?: string;
  nodeVersion?: string;
  statFile?: (filePath: string) => { size: number };
}

/** Read-only, allocation-bounded runtime snapshot; owns no timers or listeners. */
export class RuntimeMonitor {
  constructor(private readonly deps: RuntimeMonitorDeps) {}

  snapshot(): RuntimeResourceSnapshot {
    const unavailable: RuntimeUnavailable[] = [];
    const now = this.deps.now ?? (() => Date.now());
    const memoryUsage = this.deps.memoryUsage ?? (() => process.memoryUsage());
    let memory: RuntimeResourceSnapshot["process"]["memory"] = {
      rssBytes: null,
      heapUsedBytes: null,
      heapTotalBytes: null,
      externalBytes: null,
      arrayBuffersBytes: null,
    };
    try {
      const usage = memoryUsage();
      const bytes = (value: number): number | null => Number.isSafeInteger(value) && value >= 0 ? value : null;
      memory = {
        rssBytes: bytes(usage.rss),
        heapUsedBytes: bytes(usage.heapUsed),
        heapTotalBytes: bytes(usage.heapTotal),
        externalBytes: bytes(usage.external),
        arrayBuffersBytes: bytes(usage.arrayBuffers),
      };
      for (const field of ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"] as const) {
        if (memory[field] === null) unavailable.push({ field: `process.memory.${field}`, source: "node_process", reason: "invalid_value" });
      }
    } catch {
      for (const field of ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"] as const) {
        unavailable.push({ field: `process.memory.${field}`, source: "node_process", reason: "memory_unavailable" });
      }
    }

    let totals: CacheTotalsResult;
    try {
      totals = this.deps.cache.totals();
    } catch {
      totals = { entries: null, bytes: null, updatedAt: null, source: "search_cache_state", reason: "totals_unavailable" };
    }
    if (totals.entries === null || totals.bytes === null) {
      unavailable.push({ field: "cache.totals", source: totals.source, reason: totals.reason === "totals_missing" ? "totals_missing" : "totals_unavailable" });
    }
    const dbPath = this.deps.dbPath;
    const readDisk = (suffix: "" | "-wal"): { bytes: number | null; source: string } => {
      if (dbPath === null || dbPath === ":memory:") {
        const reason = dbPath === ":memory:" ? "memory_database" : "not_found";
        unavailable.push({ field: suffix ? "cache.walFileBytes" : "cache.dbFileBytes", source: "fs.stat", reason });
        return { bytes: null, source: "unavailable" };
      }
      try {
        const stat = (this.deps.statFile ?? statSync)(`${dbPath}${suffix}`);
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
          unavailable.push({ field: suffix ? "cache.walFileBytes" : "cache.dbFileBytes", source: "fs.stat", reason: "invalid_value" });
          return { bytes: null, source: "unavailable" };
        }
        return { bytes: stat.size, source: "fs.stat" };
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        const reason = code === "ENOENT" ? "not_found" : code === "EACCES" || code === "EPERM" ? "permission_denied" : "stat_failed";
        unavailable.push({ field: suffix ? "cache.walFileBytes" : "cache.dbFileBytes", source: "fs.stat", reason });
        return { bytes: null, source: "unavailable" };
      }
    };
    const db = readDisk("");
    const wal = readDisk("-wal");
    const providerKey = this.deps.providers.queueDepth;
    const health = this.deps.health.queueDepth;
    const singleflightFollowers = this.deps.search.queuedFollowerCount;
    let uptimeSeconds: number | null = null;
    try {
      const value = this.deps.uptime?.() ?? process.uptime();
      if (Number.isFinite(value) && value >= 0) uptimeSeconds = value;
      else unavailable.push({ field: "process.uptimeSeconds", source: "node_process", reason: "invalid_value" });
    } catch {
      unavailable.push({ field: "process.uptimeSeconds", source: "node_process", reason: "uptime_unavailable" });
    }
    return {
      schemaVersion: 1,
      sampledAt: new Date(now()).toISOString(),
      process: {
        platform: this.deps.platform ?? process.platform,
        nodeVersion: this.deps.nodeVersion ?? process.version,
        uptimeSeconds,
        memory,
        sources: PROCESS_SOURCES,
      },
      activity: {
        activeSearches: this.deps.search.activeSearchCount,
        activeProbes: this.deps.health.activeProbeCount,
        queue: { total: providerKey + health + singleflightFollowers, providerKey, health, singleflightFollowers },
      },
      cache: {
        entries: totals.entries,
        bytes: totals.bytes,
        totalsUpdatedAt: totals.updatedAt,
        totalsSource: totals.source,
        totalsReason: totals.reason,
        dbFileBytes: db.bytes,
        walFileBytes: wal.bytes,
        dbFileSource: db.source,
        walFileSource: wal.source,
        diskScope: "whole_sqlite_database",
      },
      unavailable: unavailable.length === 0 ? EMPTY_UNAVAILABLE : unavailable,
    };
  }
}
