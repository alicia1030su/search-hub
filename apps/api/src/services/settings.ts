import { eq } from "drizzle-orm";
import type { Freshness, SearchMode } from "@search-hub/shared";
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
  cache: { enabled: false, ttlSeconds: 0 },
  health: {
    scheduledEnabled: false,
    intervalMinutes: 360,
    maxRequestsPerRun: 3,
    maxRequestsPerDay: 20,
    paidProbesEnabled: false,
    includeUnverified: true,
  },
  logging: { level: "info" },
  initializedAt: null,
};

const SETTINGS_KEY = "app";

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
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(
    private readonly db: SearchHubDb,
    private readonly config: AppConfig,
  ) {
    this.current = this.load();
  }

  get(): AppSettings {
    return this.current;
  }

  onChange(listener: (settings: AppSettings) => void): void {
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
    this.persist(merged);
    this.current = merged;
    for (const listener of this.listeners) listener(merged);
    return merged;
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
