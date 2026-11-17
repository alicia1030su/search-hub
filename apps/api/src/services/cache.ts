import { and, asc, eq, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Logger, SearchResponse } from "@search-hub/shared";
import type { SearchHubDb } from "@search-hub/db";
import { searchCache, searchCacheMetrics, searchCacheState } from "@search-hub/db";

/**
 * Persistent search response cache.
 *
 * Three properties matter here and each of them was chosen against a failure
 * mode that a purely in-memory cache had:
 *
 *  - **survives restarts** — the rows live in the same SQLite file as the rest
 *    of the application, so a Docker volume, a systemd restart or a Windows
 *    reboot all keep them, and the existing backup/upgrade paths cover them.
 *  - **bounded** — a cache that grows without limit is a slow-motion disk-full
 *    incident. Entry count and total bytes are both capped, and the eviction
 *    policy is LRU by `last_accessed_at`.
 *  - **honest statistics** — hits, misses, evictions and sweeps are counted per
 *    UTC hour, so the dashboard can report a 24-hour rate or say "no data yet"
 *    instead of inventing a number from a single request.
 *
 * The cache key is a SHA-256 over the request fingerprint. Never the query
 * text: a raw query as a primary key turns the table into a readable history of
 * what everyone searched for, and long queries make the index expensive.
 */

export interface CacheLimits {
  maxEntries: number;
  maxBytes: number;
}

/** 5000 entries / 256 MB: high enough to be useful, low enough to stay local. */
export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  maxEntries: 5_000,
  maxBytes: 256 * 1024 * 1024,
};

export const CACHE_SWEEP_INTERVAL_MS = 10 * 60_000;

export interface CacheStats {
  enabled: boolean;
  ttlSeconds: number;
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  /** Cumulative since the instance was created. */
  hits: number;
  misses: number;
  hitRate: number | null;
  /** Last 24 hours only; null when nothing was looked up in that window. */
  hits24h: number;
  misses24h: number;
  hitRate24h: number | null;
  expiredRemoved: number;
  evicted: number;
  lastSweepAt: string | null;
  windowHours: number;
}

export interface CacheLookup {
  response: SearchResponse;
  createdAt: string;
  expiresAt: string;
  hitCount: number;
}

export interface CacheServiceDeps {
  db: SearchHubDb;
  logger: Logger;
  limits?: CacheLimits;
  /** Injected in tests so TTL behaviour can be asserted without waiting. */
  now?: () => number;
}

export class CacheService {
  private readonly limits: CacheLimits;
  private readonly now: () => number;
  /** Guards against two sweeps (manual + scheduled) running at once. */
  private sweeping = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CacheServiceDeps) {
    this.limits = deps.limits ?? DEFAULT_CACHE_LIMITS;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Stable cache key for a request fingerprint.
   *
   * The fingerprint is serialised with sorted keys so that two logically
   * identical requests can never produce two different keys because of object
   * insertion order — a subtle bug that silently halves the hit rate.
   */
  static buildKey(fingerprint: unknown): string {
    return createHash("sha256").update(canonicalJson(fingerprint)).digest("hex");
  }

  get(key: string): CacheLookup | null {
    const nowIso = new Date(this.now()).toISOString();
    const row = this.deps.db.select().from(searchCache).where(eq(searchCache.cacheKey, key)).get();
    if (!row) {
      this.count("misses");
      return null;
    }
    if (row.expiresAt <= nowIso) {
      // Expired rows are removed on read so a stale row can never be served,
      // even if the sweeper has not run yet.
      this.deps.db.delete(searchCache).where(eq(searchCache.cacheKey, key)).run();
      this.count("misses");
      return null;
    }

    let parsed: SearchResponse;
    try {
      parsed = JSON.parse(row.responseJson) as SearchResponse;
    } catch {
      // A row we cannot parse is worse than a miss: drop it.
      this.deps.db.delete(searchCache).where(eq(searchCache.cacheKey, key)).run();
      this.count("misses");
      return null;
    }

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

  put(key: string, response: SearchResponse, ttlSeconds: number, mode: string): void {
    const nowMs = this.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
    const responseJson = JSON.stringify(response);
    // The cap is about disk, so measure the bytes on disk, not `string.length`.
    const sizeBytes = Buffer.byteLength(responseJson, "utf8");

    // insert-or-replace plus the eviction pass run in one transaction: a
    // concurrent writer must never be able to observe (or leave behind) a cache
    // that is over the limit.
    this.deps.db.transaction((tx) => {
      tx.insert(searchCache)
        .values({
          cacheKey: key,
          responseJson,
          status: response.status,
          mode,
          createdAt,
          expiresAt,
          lastAccessedAt: createdAt,
          sizeBytes,
          hitCount: 0,
        })
        .onConflictDoUpdate({
          target: searchCache.cacheKey,
          set: { responseJson, status: response.status, mode, createdAt, expiresAt, sizeBytes },
        })
        .run();
      this.enforceLimits(tx);
    });
  }

  /**
   * Applies the entry count and byte caps by evicting the least recently used
   * rows. Runs inside the caller's transaction when there is one.
   */
  private enforceLimits(tx: SearchHubDb): void {
    const totals = tx
      .select({
        entries: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${searchCache.sizeBytes}), 0)`,
      })
      .from(searchCache)
      .all()[0] ?? { entries: 0, bytes: 0 };

    let entries = Number(totals.entries);
    let bytes = Number(totals.bytes);
    if (entries <= this.limits.maxEntries && bytes <= this.limits.maxBytes) return;

    // Fetch just the LRU prefix. `last_accessed_at` ties are broken by
    // `created_at` so the order is deterministic and the assertion in tests can
    // name the exact row that must go.
    const candidates = tx
      .select({ key: searchCache.cacheKey, size: searchCache.sizeBytes })
      .from(searchCache)
      .orderBy(asc(searchCache.lastAccessedAt), asc(searchCache.createdAt))
      .limit(Math.min(Math.max(entries - this.limits.maxEntries, 0) + 64, entries))
      .all();

    let evicted = 0;
    for (const candidate of candidates) {
      if (entries <= this.limits.maxEntries && bytes <= this.limits.maxBytes) break;
      tx.delete(searchCache).where(eq(searchCache.cacheKey, candidate.key)).run();
      entries -= 1;
      bytes -= Number(candidate.size);
      evicted += 1;
    }
    if (evicted > 0) {
      this.count("evicted", evicted, tx);
      this.deps.logger.info(
        { evicted, entries, bytes, limits: this.limits },
        "cache over capacity; evicted least-recently-used entries",
      );
    }
  }

  /**
   * Deletes expired rows. Returns how many were removed.
   *
   * Deliberately does **not** VACUUM: the file does not shrink immediately and
   * vacuuming on every sweep would block the writer for no operational gain.
   */
  sweepExpired(): number {
    const nowIso = new Date(this.now()).toISOString();
    const result = this.deps.db.delete(searchCache).where(lte(searchCache.expiresAt, nowIso)).run();
    const removed = Number(result.changes ?? 0);
    this.setState("lastSweepAt", nowIso);
    if (removed > 0) {
      this.count("expiredRemoved", removed);
      this.deps.logger.info({ removed }, "swept expired cache entries");
    }
    return removed;
  }

  /** Deletes every cached response. Settings and statistics are untouched. */
  clear(): number {
    const result = this.deps.db.delete(searchCache).run();
    return Number(result.changes ?? 0);
  }

  /**
   * Re-times every still-valid entry after a TTL change.
   *
   * Two rules, both directed by the task:
   *  - an entry that is still valid expires `ttl` after it was **created**, so
   *    shortening the TTL takes effect immediately instead of leaving a 72-hour
   *    entry alive;
   *  - an entry that has already expired is **not** revived by lengthening the
   *    TTL — it is deleted rather than extended.
   */
  retime(ttlSeconds: number): { retimed: number; removed: number } {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const rows = this.deps.db
      .select({
        key: searchCache.cacheKey,
        createdAt: searchCache.createdAt,
        expiresAt: searchCache.expiresAt,
      })
      .from(searchCache)
      .all();

    let retimed = 0;
    let removed = 0;
    this.deps.db.transaction((tx) => {
      for (const row of rows) {
        if (row.expiresAt <= nowIso) {
          tx.delete(searchCache).where(eq(searchCache.cacheKey, row.key)).run();
          removed += 1;
          continue;
        }
        const createdMs = Date.parse(row.createdAt);
        const nextExpiry = new Date(createdMs + ttlSeconds * 1000).toISOString();
        if (nextExpiry <= nowIso) {
          // The new TTL already elapsed for this entry.
          tx.delete(searchCache).where(eq(searchCache.cacheKey, row.key)).run();
          removed += 1;
          continue;
        }
        if (nextExpiry !== row.expiresAt) {
          tx.update(searchCache)
            .set({ expiresAt: nextExpiry })
            .where(eq(searchCache.cacheKey, row.key))
            .run();
          retimed += 1;
        }
      }
    });
    if (removed > 0) this.count("expiredRemoved", removed);
    return { retimed, removed };
  }

  stats(options: { enabled: boolean; ttlSeconds: number }): CacheStats {
    const totals = this.deps.db
      .select({
        entries: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${searchCache.sizeBytes}), 0)`,
      })
      .from(searchCache)
      .all()[0] ?? { entries: 0, bytes: 0 };

    const all = this.deps.db.select().from(searchCacheMetrics).all();
    const hits = all.reduce((sum, row) => sum + row.hits, 0);
    const misses = all.reduce((sum, row) => sum + row.misses, 0);
    const expiredRemoved = all.reduce((sum, row) => sum + row.expiredRemoved, 0);
    const evicted = all.reduce((sum, row) => sum + row.evicted, 0);

    // The 24-hour window is the trailing 24 hourly buckets, not "since the
    // process started": a restart must not reset the rate to zero.
    const cutoff = new Date(this.now() - 86_400_000).toISOString().slice(0, 13);
    const recent = all.filter((row) => row.bucket >= cutoff);
    const hits24h = recent.reduce((sum, row) => sum + row.hits, 0);
    const misses24h = recent.reduce((sum, row) => sum + row.misses, 0);

    return {
      enabled: options.enabled,
      ttlSeconds: options.ttlSeconds,
      entries: Number(totals.entries),
      bytes: Number(totals.bytes),
      maxEntries: this.limits.maxEntries,
      maxBytes: this.limits.maxBytes,
      hits,
      misses,
      hitRate: hits + misses === 0 ? null : hits / (hits + misses),
      hits24h,
      misses24h,
      hitRate24h: hits24h + misses24h === 0 ? null : hits24h / (hits24h + misses24h),
      expiredRemoved,
      evicted,
      lastSweepAt: this.getState("lastSweepAt"),
      windowHours: 24,
    };
  }

  /**
   * Starts the background sweep: once at startup, then every 10 minutes.
   *
   * The tick is wrapped so a failing sweep is logged and retried on the next
   * tick — a cache problem must never take the API process down with it — and a
   * re-entrancy guard stops a slow sweep from stacking up behind itself.
   */
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
    // Do not hold the process open just for the cache.
    this.timer.unref();
    return () => this.stopScheduler();
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Hourly buckets older than 31 days are of no use to any surface. */
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
    const row = this.deps.db
      .select()
      .from(searchCacheState)
      .where(eq(searchCacheState.key, key))
      .get();
    return row?.value ?? null;
  }

  private setState(key: string, value: string): void {
    const updatedAt = new Date(this.now()).toISOString();
    this.deps.db
      .insert(searchCacheState)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: searchCacheState.key, set: { value, updatedAt } })
      .run();
  }
}

/**
 * JSON with sorted object keys, so `{a,b}` and `{b,a}` hash identically.
 *
 * Arrays keep their order: for provider fingerprints the caller sorts them
 * explicitly, and silently reordering a user-supplied list would be wrong.
 */
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

/** Deletes rows for one key; used by tests and by the "invalidate on change" path. */
export function deleteCacheKey(db: SearchHubDb, key: string): void {
  db.delete(searchCache).where(eq(searchCache.cacheKey, key)).run();
}

/** Count helper for tests that need the raw row count without a stats window. */
export function cacheEntryCount(db: SearchHubDb): number {
  const rows = db.select({ count: sql<number>`count(*)` }).from(searchCache).all();
  return Number(rows[0]?.count ?? 0);
}

/** Rows whose expiry is in the past; used by tests to assert the sweeper ran. */
export function expiredCacheCount(db: SearchHubDb, nowMs: number): number {
  const rows = db
    .select({ count: sql<number>`count(*)` })
    .from(searchCache)
    .where(and(lte(searchCache.expiresAt, new Date(nowMs).toISOString())))
    .all();
  return Number(rows[0]?.count ?? 0);
}
