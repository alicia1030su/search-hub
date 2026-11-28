import { and, asc, eq, lte, ne, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { Logger, SearchResponse } from "@search-hub/shared";
import type { SearchHubDb, DbHandle } from "@search-hub/db";
import { searchCache, searchCacheMetrics, searchCacheState } from "@search-hub/db";
import {
  CacheDiagnostics,
  type CacheDiagnosticsSnapshot,
  type CacheDiskSnapshot,
} from "./cache-diagnostics.js";

/** Persistent, bounded search-response cache with exact transactional totals. */
export interface CacheLimits {
  maxEntries: number;
  maxBytes: number;
}

export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  maxEntries: 5_000,
  maxBytes: 256 * 1024 * 1024,
};

export const CACHE_SWEEP_INTERVAL_MS = 10 * 60_000;
const TOTALS_KEY = "cache:totals";
const BUSY_RETRY_MS = [10, 25, 50] as const;

export interface CachePutResult {
  stored: boolean;
  reason: "stored" | "oversize";
  sizeBytes: number;
  evicted?: number;
  entries?: number;
  bytes?: number;
}

export interface CacheTotals {
  entries: number;
  bytes: number;
  updatedAt: string;
}

export interface CacheTotalsResult {
  entries: number | null;
  bytes: number | null;
  updatedAt: string | null;
  source: "search_cache_state";
  reason: string | null;
}

export interface CacheStatsDiagnostics extends CacheDiagnosticsSnapshot {
  hitRate: number | null;
  hitRate24h: number | null;
  evicted: number;
}

export interface CacheStats {
  enabled: boolean;
  ttlSeconds: number;
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  hitRate: number | null;
  hits24h: number;
  misses24h: number;
  hitRate24h: number | null;
  expiredRemoved: number;
  evicted: number;
  evictedBytes: number;
  lastSweepAt: string | null;
  windowHours: 24;
  diagnostics: CacheStatsDiagnostics;
}

export interface CacheLookup<T = SearchResponse> {
  response: T;
  createdAt: string;
  expiresAt: string;
  hitCount: number;
}

export interface CacheServiceDeps {
  db: SearchHubDb;
  logger: Logger;
  limits?: CacheLimits;
  now?: () => number;
  /** File path enables DB/WAL byte diagnostics; absent in isolated unit fixtures. */
  dbPath?: string;
  /** Optional raw handle for an allocation-light prepared totals lookup. */
  sqlite?: DbHandle["sqlite"];
  /** Optional read-only OS page-cache collector; unknown values stay null. */
  osPageCache?: () => { value: number | null; source: string; reason: string | null };
}

export class CacheBusyError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CacheBusyError";
  }
}

export class CacheInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheInvariantError";
  }
}

function validateLimits(limits: CacheLimits): CacheLimits {
  if (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries <= 0 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new TypeError("Cache limits must be positive finite integers");
  }
  return { ...limits };
}

function isBusyError(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === "SQLITE_BUSY" || value?.code === "SQLITE_LOCKED" ||
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(value?.message ?? "");
}

function sleepSync(durationMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function withBusyRetry<T>(operation: () => T): T {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= BUSY_RETRY_MS.length; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      lastError = error;
      const delay = BUSY_RETRY_MS[attempt];
      if (delay !== undefined) sleepSync(delay);
    }
  }
  throw new CacheBusyError(lastError);
}

function parseTotals(value: string | undefined): CacheTotals | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CacheTotals>;
    if (!Number.isSafeInteger(parsed.entries) || (parsed.entries ?? -1) < 0 ||
        !Number.isSafeInteger(parsed.bytes) || (parsed.bytes ?? -1) < 0 ||
        typeof parsed.updatedAt !== "string") return null;
    const updatedAtMs = Date.parse(parsed.updatedAt);
    if (!Number.isFinite(updatedAtMs) || new Date(updatedAtMs).toISOString() !== parsed.updatedAt) return null;
    return { entries: parsed.entries!, bytes: parsed.bytes!, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function readTotals(tx: SearchHubDb): CacheTotals | null {
  const row = tx.select({ value: searchCacheState.value })
    .from(searchCacheState)
    .where(eq(searchCacheState.key, TOTALS_KEY))
    .get();
  return parseTotals(row?.value);
}

function writeCacheTotals(tx: SearchHubDb, entries: number, bytes: number, updatedAt: string): void {
  const value = JSON.stringify({ entries, bytes, updatedAt });
  tx.insert(searchCacheState)
    .values({ key: TOTALS_KEY, value, updatedAt })
    .onConflictDoUpdate({ target: searchCacheState.key, set: { value, updatedAt } })
    .run();
}

function aggregateCacheTotals(tx: SearchHubDb, now: () => number): CacheTotals {
  const aggregate = tx.select({
    entries: sql<number>`count(*)`,
    bytes: sql<number>`coalesce(sum(${searchCache.sizeBytes}), 0)`,
  }).from(searchCache).all()[0] ?? { entries: 0, bytes: 0 };
  return { entries: Number(aggregate.entries), bytes: Number(aggregate.bytes), updatedAt: new Date(now()).toISOString() };
}

function ensureCacheTotals(tx: SearchHubDb, now: () => number): CacheTotals {
  const existing = readTotals(tx);
  if (existing) return existing;
  const totals = aggregateCacheTotals(tx, now);
  writeCacheTotals(tx, totals.entries, totals.bytes, totals.updatedAt);
  return totals;
}

export class CacheService {
  private readonly limits: CacheLimits;
  private readonly now: () => number;
  private readonly diagnostics = new CacheDiagnostics();
  private readonly totalsStatement: { get(key: string): { value: string } | undefined } | null;
  private sweeping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CacheServiceDeps) {
    this.limits = validateLimits(deps.limits ?? DEFAULT_CACHE_LIMITS);
    this.now = deps.now ?? (() => Date.now());
    this.totalsStatement = deps.sqlite
      ? deps.sqlite.prepare("SELECT value FROM search_cache_state WHERE key = ?") as unknown as { get(key: string): { value: string } | undefined }
      : null;
  }

  /** Stable v1 request-fingerprint key; never contains query text or credentials. */
  static buildKey(fingerprint: unknown): string {
    return createHash("sha256").update(canonicalJson(fingerprint)).digest("hex");
  }

  /**
   * Validate totals against COUNT/SUM once at startup and rebuild missing,
   * corrupt, or stale values. The comparison and repair share one IMMEDIATE
   * transaction so concurrent boot cannot install stale totals.
   */
  initialize(): CacheTotals {
    return withBusyRetry(() => this.deps.db.transaction((tx) => {
      const existing = readTotals(tx);
      const actual = aggregateCacheTotals(tx, this.now);
      if (existing && existing.entries === actual.entries && existing.bytes === actual.bytes) return existing;
      writeCacheTotals(tx, actual.entries, actual.bytes, actual.updatedAt);
      return actual;
    }, { behavior: "immediate" }));
  }

  /** O(1) primary-key read for runtime monitoring; never scans or repairs. */
  totals(): CacheTotalsResult {
    const row = this.totalsStatement
      ? this.totalsStatement.get(TOTALS_KEY)
      : this.deps.db
        .select({ value: searchCacheState.value })
        .from(searchCacheState)
        .where(eq(searchCacheState.key, TOTALS_KEY))
        .get();
    const totals = parseTotals(row?.value);
    return totals
      ? { ...totals, source: "search_cache_state", reason: null }
      : { entries: null, bytes: null, updatedAt: null, source: "search_cache_state", reason: "totals_missing" };
  }

  get(key: string): CacheLookup | null {
    return this.readJson<SearchResponse>(key);
  }

  /** Generic JSON reads share the existing lookup and LRU-touch path. */
  getJson<T>(key: string): CacheLookup<T> | null {
    return this.readJson<T>(key);
  }

  private readJson<T>(key: string): CacheLookup<T> | null {
    const started = performance.now();
    try {
      return this.getInternal<T>(key);
    } finally {
      const duration = performance.now() - started;
      this.diagnostics.recordQuery(duration);
      this.diagnostics.recordRead(duration);
    }
  }

  private getInternal<T>(key: string): CacheLookup<T> | null {
    const nowIso = new Date(this.now()).toISOString();
    const row = this.deps.db.select().from(searchCache).where(eq(searchCache.cacheKey, key)).get();
    if (!row) {
      this.count("misses");
      return null;
    }
    if (row.expiresAt <= nowIso) {
      this.deleteKeyWithTotals(key);
      this.diagnostics.recordExpiredRemoved(1);
      this.count("misses");
      return null;
    }

    let parsed: T;
    try {
      parsed = JSON.parse(row.responseJson) as T;
    } catch {
      this.deleteKeyWithTotals(key);
      this.count("misses");
      return null;
    }

    // C08 intentionally preserves the original two-write hit path. Combining
    // transactions alone does not reduce mutating SQL and is not an optimization.
    this.deps.db
      .update(searchCache)
      .set({ lastAccessedAt: nowIso, hitCount: row.hitCount + 1 })
      .where(eq(searchCache.cacheKey, key))
      .run();
    this.count("hits");
    return {
      response: parsed,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      hitCount: row.hitCount + 1,
    };
  }

  put(key: string, response: SearchResponse, ttlSeconds: number, mode: string): CachePutResult {
    return this.putValue(key, response, ttlSeconds, mode, response.status);
  }

  /** Generic JSON values share the same table, TTL, LRU limits and totals. */
  putJson<T>(key: string, value: T, ttlSeconds: number, mode: string, status: string): CachePutResult {
    return this.putValue(key, value, ttlSeconds, mode, status);
  }

  private putValue<T>(key: string, response: T, ttlSeconds: number, mode: string, status: string): CachePutResult {
    const responseJson = JSON.stringify(response);
    const sizeBytes = Buffer.byteLength(responseJson, "utf8");
    // Oversize responses are a successful search with no cache write: no
    // transaction, eviction, totals update, or metric mutation.
    if (sizeBytes > this.limits.maxBytes) return { stored: false, reason: "oversize", sizeBytes };

    const started = performance.now();
    let committedEvictedBytes = 0;
    try {
      const result: CachePutResult = withBusyRetry(() => this.deps.db.transaction((tx) => {
        committedEvictedBytes = 0;
        const totals = this.ensureTotals(tx);
        const previous = tx
          .select({ sizeBytes: searchCache.sizeBytes })
          .from(searchCache)
          .where(eq(searchCache.cacheKey, key))
          .get();
        const nowMs = this.now();
        const createdAt = new Date(nowMs).toISOString();
        const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
        tx.insert(searchCache)
          .values({
            cacheKey: key,
            responseJson,
            status,
            mode,
            createdAt,
            expiresAt,
            lastAccessedAt: createdAt,
            sizeBytes,
            hitCount: 0,
          })
          .onConflictDoUpdate({
            target: searchCache.cacheKey,
            set: { responseJson, status, mode, createdAt, expiresAt, lastAccessedAt: createdAt, sizeBytes },
          })
          .run();

        let entries = totals.entries + (previous ? 0 : 1);
        let bytes = totals.bytes - (previous?.sizeBytes ?? 0) + sizeBytes;
        let evicted = 0;
        let evictedBytes = 0;
        while (entries > this.limits.maxEntries || bytes > this.limits.maxBytes) {
          const batch = tx
            .select({ key: searchCache.cacheKey, sizeBytes: searchCache.sizeBytes })
            .from(searchCache)
            .where(ne(searchCache.cacheKey, key))
            .orderBy(asc(searchCache.lastAccessedAt), asc(searchCache.createdAt), asc(searchCache.cacheKey))
            .limit(Math.min(256, Math.max(entries, 1)))
            .all();
          if (batch.length === 0) throw new CacheInvariantError("Capacity eviction cannot remove the current write or make progress");
          for (const row of batch) {
            if (entries <= this.limits.maxEntries && bytes <= this.limits.maxBytes) break;
            tx.delete(searchCache).where(eq(searchCache.cacheKey, row.key)).run();
            entries -= 1;
            bytes -= row.sizeBytes;
            evicted += 1;
            evictedBytes += row.sizeBytes;
          }
        }
        if (entries < 0 || bytes < 0 || entries > this.limits.maxEntries || bytes > this.limits.maxBytes) {
          throw new CacheInvariantError(`Cache invariant failed: entries=${entries}, bytes=${bytes}`);
        }
        this.writeTotals(tx, entries, bytes);
        if (evicted > 0) {
          this.count("evicted", evicted, tx);
          committedEvictedBytes = evictedBytes;
        }
        return { stored: true, reason: "stored", sizeBytes, evicted, entries, bytes };
      }, { behavior: "immediate" }));
      if ((result.evicted ?? 0) > 0) {
        this.diagnostics.recordEvictedBytes(committedEvictedBytes);
        this.deps.logger.info(
          { evicted: result.evicted, evictedBytes: committedEvictedBytes, entries: result.entries, bytes: result.bytes, limits: this.limits },
          "cache over capacity; evicted least-recently-used entries",
        );
      }
      return result;
    } finally {
      const duration = performance.now() - started;
      this.diagnostics.recordQuery(duration);
      this.diagnostics.recordWrite(duration);
    }
  }

  /** Delete expired rows and update totals/metrics/state in one transaction. */
  sweepExpired(): number {
    const started = performance.now();
    const nowIso = new Date(this.now()).toISOString();
    const removed = withBusyRetry(() => this.deps.db.transaction((tx) => {
      const totals = this.ensureTotals(tx);
      const rows = tx.delete(searchCache)
        .where(lte(searchCache.expiresAt, nowIso))
        .returning({ sizeBytes: searchCache.sizeBytes })
        .all();
      const removedBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
      this.writeTotals(tx, totals.entries - rows.length, totals.bytes - removedBytes);
      this.setState("lastSweepAt", nowIso, tx);
      if (rows.length > 0) this.count("expiredRemoved", rows.length, tx);
      return rows.length;
    }, { behavior: "immediate" }));
    this.diagnostics.recordExpiredRemoved(removed);
    this.diagnostics.recordMaintenance("sweep", performance.now() - started);
    if (removed > 0) this.deps.logger.info({ removed }, "swept expired cache entries");
    return removed;
  }

  /** Clear only search_cache; settings and statistics remain intact. */
  clear(): number {
    const started = performance.now();
    const removed = withBusyRetry(() => this.deps.db.transaction((tx) => {
      this.ensureTotals(tx);
      const result = tx.delete(searchCache).run();
      this.writeTotals(tx, 0, 0);
      return Number(result.changes ?? 0);
    }, { behavior: "immediate" }));
    this.diagnostics.recordMaintenance("clear", performance.now() - started);
    return removed;
  }

  /** Shorten/extend TTL without reviving entries that are already expired. */
  retime(ttlSeconds: number): { retimed: number; removed: number } {
    const started = performance.now();
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const result = withBusyRetry(() => this.deps.db.transaction((tx) => {
      const totals = this.ensureTotals(tx);
      const rows = tx.select({
        key: searchCache.cacheKey,
        createdAt: searchCache.createdAt,
        expiresAt: searchCache.expiresAt,
        sizeBytes: searchCache.sizeBytes,
      }).from(searchCache).all();
      let entries = totals.entries;
      let bytes = totals.bytes;
      let retimed = 0;
      let removed = 0;
      for (const row of rows) {
        const nextExpiry = new Date(Date.parse(row.createdAt) + ttlSeconds * 1000).toISOString();
        if (row.expiresAt <= nowIso || nextExpiry <= nowIso) {
          tx.delete(searchCache).where(eq(searchCache.cacheKey, row.key)).run();
          entries -= 1;
          bytes -= row.sizeBytes;
          removed += 1;
        } else if (nextExpiry !== row.expiresAt) {
          tx.update(searchCache).set({ expiresAt: nextExpiry }).where(eq(searchCache.cacheKey, row.key)).run();
          retimed += 1;
        }
      }
      this.writeTotals(tx, entries, bytes);
      if (removed > 0) this.count("expiredRemoved", removed, tx);
      return { retimed, removed };
    }, { behavior: "immediate" }));
    this.diagnostics.recordExpiredRemoved(result.removed);
    this.diagnostics.recordMaintenance("retime", performance.now() - started);
    return result;
  }

  stats(options: { enabled: boolean; ttlSeconds: number }): CacheStats {
    const totals = this.liveTotals();
    const all = this.deps.db.select().from(searchCacheMetrics).all();
    const hits = all.reduce((sum, row) => sum + row.hits, 0);
    const misses = all.reduce((sum, row) => sum + row.misses, 0);
    const expiredRemoved = all.reduce((sum, row) => sum + row.expiredRemoved, 0);
    const evicted = all.reduce((sum, row) => sum + row.evicted, 0);
    const cutoff = new Date(this.now() - 86_400_000).toISOString().slice(0, 13);
    const recent = all.filter((row) => row.bucket >= cutoff);
    const hits24h = recent.reduce((sum, row) => sum + row.hits, 0);
    const misses24h = recent.reduce((sum, row) => sum + row.misses, 0);
    const hitRate = hits + misses === 0 ? null : hits / (hits + misses);
    const hitRate24h = hits24h + misses24h === 0 ? null : hits24h / (hits24h + misses24h);
    const diagnostics: CacheStatsDiagnostics = {
      ...this.diagnostics.snapshot({ entries: totals.entries, bytes: totals.bytes, disk: this.diskSnapshot() }),
      hitRate,
      hitRate24h,
      evicted,
    };
    return {
      enabled: options.enabled,
      ttlSeconds: options.ttlSeconds,
      ...totals,
      maxEntries: this.limits.maxEntries,
      maxBytes: this.limits.maxBytes,
      hits,
      misses,
      hitRate,
      hits24h,
      misses24h,
      hitRate24h,
      expiredRemoved,
      evicted,
      evictedBytes: diagnostics.evictedBytes,
      lastSweepAt: this.getState("lastSweepAt"),
      windowHours: 24,
      diagnostics,
    };
  }

  /** Start the existing bounded startup/periodic sweep. */
  startScheduler(intervalMs = CACHE_SWEEP_INTERVAL_MS): () => void {
    if (this.timer) return () => this.stopScheduler();
    const tick = (): void => {
      if (this.sweeping) return;
      this.sweeping = true;
      try {
        this.sweepExpired();
        this.pruneMetrics();
      } catch (error) {
        this.deps.logger.warn({ err: error }, "cache sweep failed; will retry on the next tick");
      } finally {
        this.sweeping = false;
      }
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    return () => this.stopScheduler();
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureTotals(tx: SearchHubDb): CacheTotals {
    return ensureCacheTotals(tx, this.now);
  }

  private writeTotals(tx: SearchHubDb, entries: number, bytes: number, updatedAt = new Date(this.now()).toISOString()): void {
    writeCacheTotals(tx, entries, bytes, updatedAt);
  }

  private deleteKeyWithTotals(key: string): number {
    return withBusyRetry(() => this.deps.db.transaction((tx) => {
      const totals = this.ensureTotals(tx);
      const row = tx.select({ sizeBytes: searchCache.sizeBytes }).from(searchCache)
        .where(eq(searchCache.cacheKey, key)).get();
      if (!row) return 0;
      tx.delete(searchCache).where(eq(searchCache.cacheKey, key)).run();
      this.writeTotals(tx, totals.entries - 1, totals.bytes - row.sizeBytes);
      return row.sizeBytes;
    }, { behavior: "immediate" }));
  }

  private liveTotals(): { entries: number; bytes: number } {
    const totals = this.deps.db.select({
      entries: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${searchCache.sizeBytes}), 0)`,
    }).from(searchCache).all()[0] ?? { entries: 0, bytes: 0 };
    return { entries: Number(totals.entries), bytes: Number(totals.bytes) };
  }

  private diskSnapshot(): CacheDiskSnapshot {
    const size = (filePath: string): number | null => {
      try { return statSync(filePath).size; } catch { return null; }
    };
    const pageCache = this.deps.osPageCache?.() ?? { value: null, source: "unavailable", reason: "os_page_cache_not_collected" };
    return {
      dbFileBytes: this.deps.dbPath ? size(this.deps.dbPath) : null,
      walFileBytes: this.deps.dbPath ? size(`${this.deps.dbPath}-wal`) : null,
      osPageCacheBytes: pageCache.value,
      dbSource: this.deps.dbPath ? "fs.stat" : "unavailable",
      walSource: this.deps.dbPath ? "fs.stat" : "unavailable",
      osPageCacheSource: pageCache.source,
      osPageCacheReason: pageCache.reason,
    };
  }

  private pruneMetrics(): void {
    const cutoff = new Date(this.now() - 31 * 86_400_000).toISOString().slice(0, 13);
    this.deps.db.delete(searchCacheMetrics).where(lte(searchCacheMetrics.bucket, cutoff)).run();
  }

  private bucket(): string {
    return new Date(this.now()).toISOString().slice(0, 13);
  }

  private count(
    field: "hits" | "misses" | "expiredRemoved" | "evicted",
    amount = 1,
    db: SearchHubDb = this.deps.db,
  ): void {
    const bucket = this.bucket();
    const updatedAt = new Date(this.now()).toISOString();
    db.insert(searchCacheMetrics)
      .values({ bucket, hits: 0, misses: 0, expiredRemoved: 0, evicted: 0, updatedAt, [field]: amount })
      .onConflictDoUpdate({
        target: searchCacheMetrics.bucket,
        set: { [field]: sql`${searchCacheMetrics[field]} + ${amount}`, updatedAt },
      })
      .run();
  }

  private getState(key: string): string | null {
    const row = this.deps.db.select().from(searchCacheState)
      .where(eq(searchCacheState.key, key)).get();
    return row?.value ?? null;
  }

  private setState(key: string, value: string, db: SearchHubDb = this.deps.db): void {
    const updatedAt = new Date(this.now()).toISOString();
    db.insert(searchCacheState)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: searchCacheState.key, set: { value, updatedAt } })
      .run();
  }
}

/** JSON with sorted object keys; arrays preserve their explicit order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(",")}}`;
}

/** Delete one key and keep cache:totals exact in the same immediate transaction. */
export function deleteCacheKey(db: SearchHubDb, key: string): void {
  withBusyRetry(() => db.transaction((tx) => {
    const totals = ensureCacheTotals(tx, () => Date.now());
    const row = tx.select({ sizeBytes: searchCache.sizeBytes }).from(searchCache)
      .where(eq(searchCache.cacheKey, key)).get();
    if (!row) return;
    tx.delete(searchCache).where(eq(searchCache.cacheKey, key)).run();
    const entries = totals.entries - 1;
    const bytes = totals.bytes - row.sizeBytes;
    if (entries < 0 || bytes < 0) throw new CacheInvariantError("Cannot decrement invalid cache totals");
    writeCacheTotals(tx, entries, bytes, new Date().toISOString());
  }, { behavior: "immediate" }));
}

export function cacheEntryCount(db: SearchHubDb): number {
  const rows = db.select({ count: sql<number>`count(*)` }).from(searchCache).all();
  return Number(rows[0]?.count ?? 0);
}

export function expiredCacheCount(db: SearchHubDb, nowMs: number): number {
  const rows = db.select({ count: sql<number>`count(*)` }).from(searchCache)
    .where(and(lte(searchCache.expiresAt, new Date(nowMs).toISOString())))
    .all();
  return Number(rows[0]?.count ?? 0);
}
