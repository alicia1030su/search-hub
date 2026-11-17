import { eq } from "drizzle-orm";
import { SearchHubError, type Freshness, type SearchMode } from "@search-hub/shared";
import type { SearchHubDb } from "@search-hub/db";
import { settings as settingsTable } from "@search-hub/db";
import type { AppConfig } from "../config.js";

export interface AppSettings {
  instance: {
    name: string;
    publicBaseUrl: string;
  };
  defaults: {
    limit: number;
    timeoutMs: number;
    mode: SearchMode;
    language: string;
    freshness: Freshness;
  };
  security: {
    privateHostAllowlist: string[];
    allowHttp: boolean;
    sessionTtlHours: number;
    loginRateLimitPerMin: number;
  };
  retention: {
    taskRetentionDays: number;
    logRetentionDays: number;
  };
  cache: {
    enabled: boolean;
    /**
     * Cache lifetime in seconds.
     *
     * Seconds are the storage unit (the database and existing clients already
     * speak seconds); the UI presents hours. Valid range while enabled is
     * 1–72 hours; disabled may be 0.
     */
    ttlSeconds: number;
  };
  /**
   * Provider health policy.
   *
   * Scheduled probes are **off by default**: a background job that hits paid
   * search endpoints without an explicit decision is how an operator wakes up to
   * a bill. Connectivity probes are free and may be enabled separately.
   */
  health: {
    scheduledEnabled: boolean;
    intervalMinutes: number;
    maxRequestsPerRun: number;
    maxRequestsPerDay: number;
    /** Paid search probes; without this, only free connectivity probes run. */
    paidProbesEnabled: boolean;
    /** Also probe providers that have no enabled key (will report unverified). */
    includeUnverified: boolean;
    /**
     * How many probes may run at once.
     *
     * Hard-capped at 4: firing probes at every vendor simultaneously is the
     * fastest way to trip all their rate limits and learn nothing.
     */
    concurrency: number;
  };
  logging: {
    level: string;
  };
  initializedAt: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  instance: { name: "Search Hub", publicBaseUrl: "" },
  defaults: { limit: 20, timeoutMs: 15_000, mode: "basic", language: "zh", freshness: "all" },
  security: {
    privateHostAllowlist: [],
    allowHttp: true,
    sessionTtlHours: 168,
    loginRateLimitPerMin: 10,
  },
  retention: { taskRetentionDays: 30, logRetentionDays: 14 },
  // 24 hours by default, matching the UI. Off until an operator turns it on:
  // caching results silently changes what callers see, so it stays opt-in.
  cache: { enabled: false, ttlSeconds: 86_400 },
  health: {
    scheduledEnabled: false,
    intervalMinutes: 360,
    maxRequestsPerRun: 3,
    maxRequestsPerDay: 20,
    paidProbesEnabled: false,
    includeUnverified: true,
    concurrency: 1,
  },
  logging: { level: "info" },
  initializedAt: null,
};

const SETTINGS_KEY = "app";

/** Cache TTL bounds, in seconds. The UI presents them as 1–72 hours. */
export const CACHE_MIN_TTL_SECONDS = 3_600;
export const CACHE_MAX_TTL_SECONDS = 259_200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObject(patch)) return base;
  if (!isObject(base)) return patch as T;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = output[key];
    output[key] = isObject(value) && isObject(existing) ? deepMerge(existing, value) : value;
  }
  return output as T;
}

/**
 * Settings are stored as a single JSON document and kept in memory for fast
 * request-path access. Writes validate through zod in the route layer.
 */
export class SettingsService {
  private current: AppSettings;
  private readonly listeners = new Set<(settings: AppSettings, previous: AppSettings) => void>();

  constructor(
    private readonly db: SearchHubDb,
    private readonly config: AppConfig,
  ) {
    this.current = this.load();
  }

  get(): AppSettings {
    return this.current;
  }

  onChange(listener: (settings: AppSettings, previous: AppSettings) => void): void {
    this.listeners.add(listener);
  }

  update(patch: unknown): AppSettings {
    const merged = deepMerge(this.current, patch);
    merged.security.privateHostAllowlist = merged.security.privateHostAllowlist
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 200);
    merged.defaults.limit = Math.min(100, Math.max(1, Math.round(merged.defaults.limit)));
    merged.defaults.timeoutMs = Math.min(120_000, Math.max(1000, Math.round(merged.defaults.timeoutMs)));
    this.normalizeCache(merged.cache);
    this.normalizeHealth(merged.health);
    const previous = this.current;
    this.persist(merged);
    this.current = merged;
    for (const listener of this.listeners) listener(merged, previous);
    return merged;
  }

  /**
   * Enforces the cache TTL contract on the *merged* settings.
   *
   * The zod schema cannot do this: a patch of `{enabled:true}` alone has no TTL
   * to check, yet the resulting state could still be invalid. The rules:
   *  - enabled ⇒ 1–72 hours (3600–259200 seconds);
   *  - disabled ⇒ 0 allowed, and anything between 1 and 3599 is still rejected
   *    because it would silently mean "almost always expired" the moment
   *    caching is switched back on;
   *  - anything above 72 hours, negative, or fractional is refused.
   *
   * Values are not silently clamped: an operator who typed 100 hours should be
   * told, not given 72.
   */
  /**
   * Clamps the probe policy into a range that can never run away.
   *
   * The zod schema already rejects out-of-range values on the wire; this runs on
   * the *merged* document so a stored value written by an older build cannot put
   * the scheduler into a configuration the UI cannot express.
   */
  private normalizeHealth(health: AppSettings["health"]): void {
    health.intervalMinutes = Math.min(10_080, Math.max(5, Math.round(health.intervalMinutes)));
    // 3 per run / 20 per day are the shipped defaults; the caps are hard.
    health.maxRequestsPerRun = Math.min(200, Math.max(1, Math.round(health.maxRequestsPerRun)));
    health.maxRequestsPerDay = Math.min(2000, Math.max(1, Math.round(health.maxRequestsPerDay)));
    health.concurrency = Math.min(4, Math.max(1, Math.round(health.concurrency)));
    // A run budget larger than the day budget can never be spent; keeping it
    // smaller makes "check all" stop at the daily ceiling instead of queuing.
    if (health.maxRequestsPerRun > health.maxRequestsPerDay) {
      health.maxRequestsPerRun = health.maxRequestsPerDay;
    }
  }

  private normalizeCache(cache: AppSettings["cache"]): void {
    const ttl = cache.ttlSeconds;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl < 0) {
      throw new SearchHubError("validation_error", "Cache TTL must be a whole number of seconds");
    }
    if (ttl > CACHE_MAX_TTL_SECONDS) {
      throw new SearchHubError(
        "validation_error",
        `Cache TTL must not exceed ${CACHE_MAX_TTL_SECONDS} seconds (72 hours)`,
        { details: { ttlSeconds: ttl, max: CACHE_MAX_TTL_SECONDS } },
      );
    }
    if (cache.enabled) {
      if (ttl < CACHE_MIN_TTL_SECONDS) {
        throw new SearchHubError(
          "validation_error",
          `Cache TTL must be at least ${CACHE_MIN_TTL_SECONDS} seconds (1 hour) while caching is enabled`,
          { details: { ttlSeconds: ttl, min: CACHE_MIN_TTL_SECONDS } },
        );
      }
    } else if (ttl !== 0 && ttl < CACHE_MIN_TTL_SECONDS) {
      throw new SearchHubError(
        "validation_error",
        `Cache TTL must be 0 (off) or at least ${CACHE_MIN_TTL_SECONDS} seconds (1 hour)`,
        { details: { ttlSeconds: ttl, min: CACHE_MIN_TTL_SECONDS } },
      );
    }
  }

  markInitialized(): AppSettings {
    return this.update({ initializedAt: new Date().toISOString() });
  }

  /** SSRF policy derived from settings; rebuilt whenever settings change. */
  ssrfPolicy(): { allowPrivateHosts: string[]; maxRedirects: number; allowHttp: boolean } {
    return {
      allowPrivateHosts: this.current.security.privateHostAllowlist,
      maxRedirects: 3,
      allowHttp: this.current.security.allowHttp,
    };
  }

  publicBaseUrl(): string | null {
    return this.config.publicBaseUrl ?? (this.current.instance.publicBaseUrl || null);
  }

  private load(): AppSettings {
    const row = this.db.select().from(settingsTable).where(eq(settingsTable.key, SETTINGS_KEY)).get();
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    try {
      const parsed = JSON.parse(row.valueJson) as unknown;
      return deepMerge(structuredClone(DEFAULT_SETTINGS), parsed);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private persist(value: AppSettings): void {
    const now = new Date().toISOString();
    this.db
      .insert(settingsTable)
      .values({ key: SETTINGS_KEY, valueJson: JSON.stringify(value), updatedAt: now })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { valueJson: JSON.stringify(value), updatedAt: now },
      })
      .run();
  }
}
