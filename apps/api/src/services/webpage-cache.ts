import { createHash } from "node:crypto";
import {
  DEFAULT_WEB_MAX_CONTENT_CHARS,
  fetchWebpage,
  type WebpageReadResult,
} from "@search-hub/core";
import { normalizeUrl, SearchHubError, type Logger, type SafeFetch } from "@search-hub/shared";
import type { CacheService } from "./cache.js";

export const DEFAULT_WEBPAGE_CACHE_TTL_SECONDS = 60 * 60;
export const WEBPAGE_CACHE_FORMAT_VERSION = 1;
export const WEBPAGE_EXTRACTOR_VERSION = "markdown-v1";
export const WEBPAGE_CLASSIFIER_VERSION = "b5-v1";

export interface WebpageCacheKeyInput {
  url: string;
  render?: boolean;
  maxContentChars?: number;
  maxHtmlBytes?: number;
}

const CREDENTIAL_QUERY_KEY = /^(?:api_?key|token|access_?token|auth|authorization|signature|sig|password|passwd|secret|credential|key)$/i;

/** Canonical identity without fragments or credential-bearing URL parameters. */
export function normalizeWebpageCacheUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new TypeError("Webpage URL must use HTTP(S) without credentials");
  }
  if (hasCredentialQuery(parsed)) throw new TypeError("Credential-bearing webpage URLs are not allowed");
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) throw new TypeError("Webpage URL must use HTTP or HTTPS");
  return normalized;
}

function hasCredentialQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key));
}

export function buildWebpageCacheKey(input: WebpageCacheKeyInput): string {
  const url = new URL(normalizeWebpageCacheUrl(input.url));
  if (hasCredentialQuery(url)) throw new TypeError("Credential-bearing webpage URLs are not cacheable");
  const fingerprint = {
    cacheFormatVersion: WEBPAGE_CACHE_FORMAT_VERSION,
    url: url.toString(),
    readMode: input.render === true ? "browser" : "http",
    maxContentChars: input.maxContentChars ?? DEFAULT_WEB_MAX_CONTENT_CHARS,
    maxHtmlBytes: input.maxHtmlBytes ?? null,
    extractorVersion: WEBPAGE_EXTRACTOR_VERSION,
    classifierVersion: WEBPAGE_CLASSIFIER_VERSION,
  };
  const canonical = JSON.stringify(fingerprint, Object.keys(fingerprint).sort());
  return `web:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function isCachedWebpageRead(value: unknown): value is WebpageReadResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Partial<WebpageReadResult>;
  return result.readStatus === "ok" && result.reasonCode === "ok" &&
    typeof result.requestedUrl === "string" && typeof result.finalUrl === "string" &&
    typeof result.content === "string" && typeof result.truncated === "boolean" &&
    typeof result.contentLength === "number" && result.contentLength === result.content.length &&
    (result.title === null || typeof result.title === "string") &&
    (result.author === null || typeof result.author === "string") &&
    (result.publishedAt === null || typeof result.publishedAt === "string");
}

/** In-flight coordination only; all cached content lives in SQLite. */
export class WebpageSingleFlight {
  private readonly flights = new Map<string, Promise<WebpageReadResult>>();

  constructor(private readonly maxFlights = 256) {}

  run(key: string, signal: AbortSignal | undefined, factory: () => Promise<WebpageReadResult>): Promise<WebpageReadResult> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const existing = this.flights.get(key);
    if (existing) return this.withSignal(existing, signal);
    if (this.flights.size >= this.maxFlights) return factory();
    const flight = factory();
    this.flights.set(key, flight);
    void flight.finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key);
    }).catch(() => {});
    return this.withSignal(flight, signal);
  }

  private withSignal(promise: Promise<WebpageReadResult>, signal?: AbortSignal): Promise<WebpageReadResult> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
}

export interface WebReadServiceOptions {
  cache?: CacheService;
  logger?: Logger;
  ttlSeconds?: number;
  singleFlight?: WebpageSingleFlight;
}

export interface WebReadInput extends WebpageCacheKeyInput {
  url: string;
  timeoutMs?: number;
  skipCache?: boolean;
  refresh?: boolean;
}

export interface WebReadContext {
  signal?: AbortSignal;
  actor?: string;
  cache?: CacheService;
  fetch: SafeFetch;
}

export class WebReadService {
  private readonly singleFlight: WebpageSingleFlight;

  constructor(private readonly options: WebReadServiceOptions = {}) {
    const requestedTtl = options.ttlSeconds ?? DEFAULT_WEBPAGE_CACHE_TTL_SECONDS;
    if (!Number.isSafeInteger(requestedTtl) || requestedTtl < 1) throw new TypeError("Webpage cache TTL must be a positive integer");
    this.options.ttlSeconds = Math.min(requestedTtl, DEFAULT_WEBPAGE_CACHE_TTL_SECONDS);
    this.singleFlight = options.singleFlight ?? new WebpageSingleFlight();
  }

  async read(input: WebReadInput, context: WebReadContext): Promise<WebpageReadResult> {
    const url = normalizeWebpageCacheUrl(input.url);
    if (input.render === true) {
      throw new SearchHubError("validation_error", "Rendered webpage reading is not enabled", { status: 400 });
    }
    const cache = context.cache ?? this.options.cache;
    const bypass = input.skipCache === true || input.refresh === true;
    let key: string | null = null;
    if (cache && !bypass) {
      try {
        key = buildWebpageCacheKey(input);
        const hit = cache.getJson<unknown>(key);
        if (hit && isCachedWebpageRead(hit.response)) return hit.response;
      } catch (error) {
        this.warn("webpage cache lookup failed", error);
      }
    }
    return this.singleFlight.run(key ?? `uncached:${crypto.randomUUID()}`, context.signal, async () => {
      const result = await fetchWebpage(url, {
        fetch: context.fetch,
        signal: context.signal,
        timeoutMs: input.timeoutMs,
        maxContentChars: input.maxContentChars,
        maxHtmlBytes: input.maxHtmlBytes,
      });
      if (cache && result.readStatus === "ok") {
        try {
          const writeKey = key ?? buildWebpageCacheKey(input);
          cache.putJson(writeKey, result, this.options.ttlSeconds!, "web_read", result.readStatus);
        } catch (error) {
          this.warn("webpage cache write failed", error);
        }
      }
      return result;
    });
  }

  private warn(message: string, error: unknown): void {
    this.options.logger?.warn({ err: error }, message);
  }
}
