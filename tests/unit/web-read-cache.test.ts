import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations, resolveMigrationsDir, type DbHandle } from "@search-hub/db";
import type { Logger, SafeFetch, SafeFetchResponse } from "@search-hub/shared";
import { CacheService } from "../../apps/api/src/services/cache.js";
import {
  DEFAULT_WEBPAGE_CACHE_TTL_SECONDS,
  WebReadService,
  WebpageSingleFlight,
  buildWebpageCacheKey,
  isCachedWebpageRead,
  normalizeWebpageCacheUrl,
} from "../../apps/api/src/services/web-read.js";

const ARTICLE = Array.from({ length: 45 }, (_, index) => `Paragraph ${index} explains reliable web reading with useful detail and evidence for every reader.`).join(" ");
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
let directory: string | null = null;
let handle: DbHandle | null = null;

afterEach(() => {
  handle?.close();
  handle = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

function page(title = "Cached article"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${ARTICLE}</p></article></body></html>`;
}

function response(html = page(), url = "https://example.com/final"): SafeFetchResponse<string> {
  return { status: 200, headers: new Headers({ "content-type": "text/html; charset=utf-8" }), data: html, url };
}

function fakeFetch(html = page(), url = "https://example.com/final") {
  return vi.fn(async () => response(html, url)) as unknown as SafeFetch;
}

function cacheAt(now: () => number, limits?: { maxEntries: number; maxBytes: number }): CacheService {
  directory = mkdtempSync(join(tmpdir(), "search-hub-web-cache-"));
  handle = createDb({ file: join(directory, "cache.db") });
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const cache = new CacheService({ db: handle!.db, logger, now, limits });
  cache.initialize();
  return cache;
}

async function read(service: WebReadService, fetch: SafeFetch, url = "https://example.com/start", extra = {}) {
  return service.read({ url, ...extra }, { fetch, actor: "admin" });
}

describe("webpage cache identity", () => {
  it("normalizes URLs without credentials or fragments", () => {
    expect(normalizeWebpageCacheUrl("HTTPS://EXAMPLE.COM:443/a?b=2&a=1#token=secret")).toBe("https://example.com/a?b=2&a=1");
    expect(() => normalizeWebpageCacheUrl("https://user:pass@example.com/")).toThrow(TypeError);
  });

  it("changes keys for read mode, content limits and extractor/classifier versions", () => {
    const input = { url: "https://example.com/a#one" };
    expect(buildWebpageCacheKey(input)).toBe(buildWebpageCacheKey({ url: "https://example.com/a#two" }));
    expect(buildWebpageCacheKey(input)).not.toBe(buildWebpageCacheKey({ ...input, render: true }));
    expect(buildWebpageCacheKey(input)).not.toBe(buildWebpageCacheKey({ ...input, maxContentChars: 100 }));
    expect(buildWebpageCacheKey(input)).not.toBe(buildWebpageCacheKey({ ...input, maxHtmlBytes: 1024 }));
    expect(buildWebpageCacheKey(input)).toMatch(/^web:v1:[a-f0-9]{64}$/);
    expect(buildWebpageCacheKey(input)).not.toContain("example.com");
  });

  it("refuses credential-bearing URL keys", () => {
    expect(() => buildWebpageCacheKey({ url: "https://example.com/?token=secret" })).toThrow(/not cacheable/);
    expect(() => buildWebpageCacheKey({ url: "https://example.com/?api_key=secret" })).toThrow(/not cacheable/);
  });
});

describe("WebReadService SQLite cache", () => {
  it("caches ok pages and preserves requested/final URL, truncation and status", async () => {
    let now = Date.parse("2026-11-28T00:00:00.000Z");
    const cache = cacheAt(() => now);
    const fetch = fakeFetch(page(), "https://example.com/redirected");
    const service = new WebReadService({ cache, logger });
    const first = await read(service, fetch, "https://example.com/start#fragment", { maxContentChars: 120 });
    now += 1000;
    const second = await read(service, fetch, "https://example.com/start#other", { maxContentChars: 120 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ requestedUrl: "https://example.com/start", finalUrl: "https://example.com/redirected", readStatus: "ok", truncated: true, contentLength: 120 });
    expect(cache.totals().entries).toBe(1);
    expect(handle!.sqlite.prepare("SELECT mode, status FROM search_cache").get()).toEqual({ mode: "web_read", status: "ok" });
  });

  it("expires entries at TTL and caps configured TTL at one hour", async () => {
    let now = Date.parse("2026-11-28T00:00:00.000Z");
    const cache = cacheAt(() => now);
    const service = new WebReadService({ cache, logger, ttlSeconds: 999_999 });
    const fetch = fakeFetch();
    await read(service, fetch);
    expect(handle!.sqlite.prepare("SELECT expires_at, created_at FROM search_cache").get()).toEqual({
      created_at: "2026-11-28T00:00:00.000Z",
      expires_at: "2026-11-28T01:00:00.000Z",
    });
    now += DEFAULT_WEBPAGE_CACHE_TTL_SECONDS * 1000;
    await read(service, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("skipCache bypasses reads and writes; refresh bypasses reads and replaces the row", async () => {
    const cache = cacheAt(() => Date.now());
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    await read(service, fetch);
    await read(service, fetch, "https://example.com/start", { skipCache: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.totals().entries).toBe(1);
    await read(service, fetch, "https://example.com/start", { refresh: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cache.totals().entries).toBe(1);
    await read(service, fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["login", "<!doctype html><title>Login</title><p>Please sign in to continue.</p>"],
    ["captcha", `<!doctype html><title>Verify you are human</title><form><input name="response"></form>`],
    ["maintenance", "<!doctype html><title>Site Maintenance</title><p>We will be back shortly.</p>"],
    ["not_found", "<!doctype html><title>404 Not Found</title><h1>404 Not Found</h1><p>The page you requested could not be found.</p>"],
    ["unsupported", "<!doctype html><title>Empty</title><p>Hello.</p>"],
  ])("does not cache %s pages", async (_name, html) => {
    const cache = cacheAt(() => Date.now());
    const fetch = fakeFetch(html);
    const service = new WebReadService({ cache, logger });
    const first = await read(service, fetch);
    const second = await read(service, fetch);
    expect(first.readStatus).not.toBe("ok");
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.totals().entries).toBe(0);
  });

  it("does not cache network failures", async () => {
    const cache = cacheAt(() => Date.now());
    const fetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as SafeFetch;
    const service = new WebReadService({ cache, logger });
    await expect(read(service, fetch)).rejects.toThrow("offline");
    await expect(read(service, fetch)).rejects.toThrow("offline");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.totals().entries).toBe(0);
  });

  it("falls back to a real fetch when cache lookup or write fails", async () => {
    const cache = cacheAt(() => Date.now());
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    vi.spyOn(cache, "get").mockImplementation(() => { throw new Error("db locked"); });
    vi.spyOn(cache, "putJson").mockImplementation(() => { throw new Error("disk full"); });
    await expect(read(service, fetch)).resolves.toMatchObject({ readStatus: "ok" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats malformed cached values as misses", async () => {
    const cache = cacheAt(() => Date.now());
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    await read(service, fetch);
    handle!.sqlite.prepare("UPDATE search_cache SET response_json = ?").run(JSON.stringify({ readStatus: "ok", content: "corrupt" }));
    await expect(read(service, fetch)).resolves.toMatchObject({ readStatus: "ok", content: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(isCachedWebpageRead({ readStatus: "ok" })).toBe(false);
  });

  it("shares bounded LRU capacity and totals with search rows", async () => {
    let now = Date.parse("2026-11-28T00:00:00.000Z");
    const cache = cacheAt(() => now, { maxEntries: 2, maxBytes: 1_000_000 });
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    await read(service, fetch, "https://example.com/a");
    now += 1;
    await read(service, fetch, "https://example.com/b");
    now += 1;
    await read(service, fetch, "https://example.com/a");
    now += 1;
    await read(service, fetch, "https://example.com/c");
    expect(cache.totals().entries).toBe(2);
    expect(handle!.sqlite.prepare("SELECT COUNT(*) AS n FROM search_cache").get()).toEqual({ n: 2 });
    await read(service, fetch, "https://example.com/c");
    expect(fetch).toHaveBeenCalledTimes(3);
    await read(service, fetch, "https://example.com/b");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not write oversized bodies or mutate totals", async () => {
    const cache = cacheAt(() => Date.now(), { maxEntries: 2, maxBytes: 32 });
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    await expect(read(service, fetch)).resolves.toMatchObject({ readStatus: "ok" });
    expect(cache.totals().entries).toBe(0);
    expect(handle!.sqlite.prepare("SELECT COUNT(*) AS n FROM search_cache").get()).toEqual({ n: 0 });
  });

  it("does not forward Cookie or Authorization headers", async () => {
    const cache = cacheAt(() => Date.now());
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    await read(service, fetch);
    expect(fetch).toHaveBeenCalledWith("https://example.com/start", expect.objectContaining({
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
    }));
    const stored = handle!.sqlite.prepare("SELECT response_json FROM search_cache").get() as { response_json: string };
    expect(stored.response_json).not.toMatch(/cookie|authorization/i);
  });

  it("rejects unimplemented browser rendering rather than pretending to render", async () => {
    const cache = cacheAt(() => Date.now());
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    await expect(read(service, fetch, "https://example.com/", { render: true })).rejects.toMatchObject({ code: "validation_error", status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("webpage singleflight", () => {
  it("coalesces concurrent identical misses into one upstream fetch", async () => {
    const cache = cacheAt(() => Date.now());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => {
      await gate;
      return response(page(), "https://example.com/final");
    }) as unknown as SafeFetch;
    const service = new WebReadService({ cache, logger, singleFlight: new WebpageSingleFlight() });
    const first = read(service, fetch);
    const second = read(service, fetch);
    await Promise.resolve();
    release();
    const results = await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    expect(cache.totals().entries).toBe(1);
  });

  it("isolates follower cancellation without cancelling the shared fetch", async () => {
    const cache = cacheAt(() => Date.now());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => { await gate; return response(); }) as unknown as SafeFetch;
    const service = new WebReadService({ cache, logger, singleFlight: new WebpageSingleFlight() });
    const controller = new AbortController();
    const first = read(service, fetch);
    const second = service.read({ url: "https://example.com/start" }, { fetch, signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error("follower stopped"));
    await expect(second).rejects.toThrow("follower stopped");
    release();
    await expect(first).resolves.toMatchObject({ readStatus: "ok" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors pre-cancelled requests without fetching or writing", async () => {
    const cache = cacheAt(() => Date.now());
    const fetch = fakeFetch();
    const service = new WebReadService({ cache, logger });
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    await expect(service.read({ url: "https://example.com/start" }, { fetch, signal: controller.signal })).rejects.toThrow("already stopped");
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.totals().entries).toBe(0);
  });

  it("continues to work without an injected cache", async () => {
    const fetch = fakeFetch();
    const service = new WebReadService();
    const first = await read(service, fetch);
    const second = await read(service, fetch);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
