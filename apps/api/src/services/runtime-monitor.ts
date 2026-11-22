import { statSync } from "node:fs";
import type { CacheTotalsResult } from "./cache.js";

export interface RuntimeUnavailable {
  field: string;
  source: string;
  reason: "totals_missing" | "memory_database" | "not_found" | "permission_denied" | "stat_failed" | "memory_unavailable";
}

export interface RuntimeResourceSnapshot {
  schemaVersion: 1;
  sampledAt: string;
  process: {
    platform: string;
    nodeVersion: string;
    uptimeSeconds: number;
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
      memory = {
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
      };
    } catch {
      for (const field of ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"] as const) {
        unavailable.push({ field: `process.memory.${field}`, source: "node_process", reason: "memory_unavailable" });
      }
    }

    const totals = this.deps.cache.totals();
    if (totals.entries === null || totals.bytes === null) {
      unavailable.push({ field: "cache.totals", source: totals.source, reason: "totals_missing" });
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
    return {
      schemaVersion: 1,
      sampledAt: new Date(now()).toISOString(),
      process: {
        platform: this.deps.platform ?? process.platform,
        nodeVersion: this.deps.nodeVersion ?? process.version,
        uptimeSeconds: this.deps.uptime?.() ?? process.uptime(),
        memory,
        sources: {
          rss: "node_process",
          heapUsed: "v8",
          heapTotal: "v8",
          external: "v8",
          arrayBuffers: "v8",
          uptime: "node_process",
        },
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
      unavailable,
    };
  }
}
