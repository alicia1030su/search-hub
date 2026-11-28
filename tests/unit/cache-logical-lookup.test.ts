import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchResponse } from "@search-hub/shared";
import { createDb, runMigrations, resolveMigrationsDir, type DbHandle } from "@search-hub/db";
import { CacheService } from "../../apps/api/src/services/cache.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
let directory: string | null = null;
let handle: DbHandle | null = null;

afterEach(() => {
  handle?.close();
  handle = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

function response(query: string): SearchResponse {
  return {
    taskId: query,
    query,
    mode: "basic",
    status: "completed",
    results: [],
    stats: {
      rawCount: 0, dedupedCount: 0, fusedCount: 0, providers: [],
      rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false,
      timing: { totalMs: 0, fanoutMs: 0, fusionMs: 0 },
    },
    errors: [], failedSources: [], debug: { rewrittenQueries: [] },
  };
}

function setup(): CacheService {
  directory = mkdtempSync(join(tmpdir(), "search-hub-logical-cache-"));
  handle = createDb({ file: join(directory, "cache.db") });
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const cache = new CacheService({ db: handle.db, logger });
  cache.initialize();
  return cache;
}

describe("CacheService.getAny logical lookup metrics", () => {
  it("counts v2 miss + legacy miss as exactly one miss", () => {
    const cache = setup();
    expect(cache.getAny(["v2", "legacy"])).toBeNull();
    expect(cache.stats({ enabled: true, ttlSeconds: 60 })).toMatchObject({ hits: 0, misses: 1 });
  });

  it("counts v2 miss + legacy hit as one hit and zero misses, touching only the legacy row", () => {
    const cache = setup();
    cache.putJson("legacy", response("old"), 60, "basic", "completed");
    expect(cache.getAny(["v2", "legacy"])?.response.query).toBe("old");
    expect(cache.stats({ enabled: true, ttlSeconds: 60 })).toMatchObject({ hits: 1, misses: 0 });
    expect(handle!.sqlite.prepare("SELECT cache_key, hit_count FROM search_cache").all()).toEqual([
      { cache_key: "legacy", hit_count: 1 },
    ]);
  });

  it("counts a v2 hit as one hit without checking the fallback", () => {
    const cache = setup();
    cache.putJson("v2", response("new"), 60, "basic", "completed");
    expect(cache.getAny(["v2", "legacy"])?.response.query).toBe("new");
    expect(cache.stats({ enabled: true, ttlSeconds: 60 })).toMatchObject({ hits: 1, misses: 0 });
  });
});
