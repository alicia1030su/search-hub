import { asc, eq } from "drizzle-orm";
import {
  SearchHubError,
  type ApiKeySummary,
  type Freshness,
  type KeyStatus,
  type KeyStrategy,
  type ProviderInstance,
  type ProviderRuntimeConfig,
  type ProviderRuntimeSnapshot,
} from "@search-hub/shared";
import type { SearchHubDb } from "@search-hub/db";
import { apiKeys, providerInstances } from "@search-hub/db";
import {
  KeyScheduler,
  type KeyRuntimeSnapshot,
  type ProviderRuntime as EngineProviderRuntime,
  type SchedulerKeySeed,
} from "@search-hub/core";
import { getAdapter, getCatalogEntry, buildManifest, resolveSearchConfig } from "@search-hub/providers";
import type { SecretBox } from "../security/crypto.js";

interface ProviderRuntimeEntry {
  config: ProviderRuntimeConfig;
  adapter: NonNullable<ReturnType<typeof getAdapter>>;
  scheduler: KeyScheduler;
  enabled: boolean;
  breaker: { failures: number; openUntilMs: number | null };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Owns provider configuration, key schedulers and their persistence.
 * Decrypted keys only exist in memory for the duration of one provider call.
 */
export class ProviderService {
  private runtimes = new Map<string, ProviderRuntimeEntry>();
  private dirtyFlushTimer: NodeJS.Timeout | null = null;
  private readonly dirtyKeys = new Map<string, KeyRuntimeSnapshot>();

  constructor(
    private readonly db: SearchHubDb,
    private readonly secrets: SecretBox,
  ) {
    this.reload();
  }

  /** (Re)builds schedulers from the database after any write. */
  reload(): void {
    const rows = this.db.select().from(providerInstances).all();
    const keyRows = this.db.select().from(apiKeys).all();
    const next = new Map<string, ProviderRuntimeEntry>();

    for (const row of rows) {
      const adapter = getAdapter(row.type);
      if (!adapter) continue;

      const seeds: SchedulerKeySeed[] = keyRows
        .filter((key) => key.providerId === row.id)
        .map((key) => ({
          id: key.id,
          label: key.label,
          maskedKey: key.keyHint,
          weight: key.weight,
          enabled: key.enabled,
          status: key.status as KeyStatus,
          requestCount: key.requestCount,
          successCount: key.successCount,
          failureCount: key.failureCount,
          consecutiveFailures: key.consecutiveFailures,
          avgLatencyMs: key.avgLatencyMs,
          quotaUsedToday: key.quotaUsedToday,
          quotaDate: key.quotaDate,
          cooldownUntil: key.cooldownUntil,
          lastErrorCode: key.lastErrorCode,
          lastErrorMessage: key.lastErrorMessage,
        }));

      const providerConfig = parseJson<Record<string, unknown>>(row.configJson, {});
      const account = readAccountLimits(providerConfig);
      const catalogEntry = getCatalogEntry(row.type);
      const search = catalogEntry
        ? resolveSearchConfig(
            buildManifest(catalogEntry),
            parseJson<Record<string, unknown>>(row.searchConfigJson, {}),
          )
        : undefined;

      const previous = this.runtimes.get(row.id);
      let scheduler: KeyScheduler;
      if (previous) {
        scheduler = previous.scheduler;
        scheduler.setStrategy(row.keyStrategy as KeyStrategy);
        scheduler.setLimits({
          perKeyConcurrency: row.maxConcurrency,
          rpmLimit: row.rpmLimit,
          dailyQuota: row.dailyQuota,
          cooldownMs: row.cooldownMs,
          breakerThreshold: row.breakerThreshold,
        });
        scheduler.syncKeys(seeds);
      } else {
        scheduler = new KeyScheduler({
          providerId: row.id,
          strategy: row.keyStrategy as KeyStrategy,
          perKeyConcurrency: row.maxConcurrency,
          rpmLimit: row.rpmLimit,
          dailyQuota: row.dailyQuota,
          cooldownMs: row.cooldownMs,
          breakerThreshold: row.breakerThreshold,
          keys: seeds,
          onDirty: (snapshot) => this.markDirty(snapshot),
          accountGroup: account.group,
          accountLimits: account.limits,
        });
      }
      // Keep the group wiring in sync on reload: changing the group or its
      // limits must take effect without a restart.
      scheduler.setAccount(account.group, account.limits);

      next.set(row.id, {
        config: {
          id: row.id,
          name: row.name,
          type: row.type,
          baseUrl: row.baseUrl,
          timeoutMs: row.timeoutMs,
          maxResults: row.resultsPerPage,
          language: row.language,
          freshness: row.freshness as Freshness | null,
          model: null,
          maxRetries: row.maxRetries,
          breakerThreshold: row.breakerThreshold,
          breakerCooldownMs: row.breakerCooldownMs,
          config: providerConfig,
          ...(search === undefined ? {} : { search }),
        },
        adapter,
        scheduler,
        enabled: row.enabled,
        breaker: previous?.breaker ?? { failures: 0, openUntilMs: null },
      });
    }

    this.runtimes = next;
  }

  listRows(): Array<typeof providerInstances.$inferSelect> {
    return this.db.select().from(providerInstances).orderBy(asc(providerInstances.priority)).all();
  }

  getRow(id: string): typeof providerInstances.$inferSelect | null {
    return this.db.select().from(providerInstances).where(eq(providerInstances.id, id)).get() ?? null;
  }

  providerSummaries(): Array<
    ProviderInstance & {
      keyCount: number;
      healthyKeyCount: number;
      circuitOpen: boolean;
      searchConfig: Record<string, unknown>;
      accountGroup: string | null;
      accountRpmLimit: number;
      accountDailyQuota: number | null;
      /** True when the instance is enabled AND has a key when one is required. */
      ready: boolean;
      /** Why it is not ready; empty when ready. */
      notReadyReason: string | null;
    }
  > {
    const keyRows = this.db.select().from(apiKeys).all();
    return this.listRows().map((row) => {
      const entry = this.runtimes.get(row.id);
      const snapshot = entry?.scheduler.snapshot() ?? [];
      const keys = keyRows.filter((key) => key.providerId === row.id);
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        enabled: row.enabled,
        baseUrl: row.baseUrl,
        timeoutMs: row.timeoutMs,
        maxConcurrency: row.maxConcurrency,
        priority: row.priority,
        weight: row.weight,
        maxRetries: row.maxRetries,
        language: row.language,
        freshness: row.freshness as Freshness | null,
        searchConfig: parseJson<Record<string, unknown>>(row.searchConfigJson, {}),
        ...(() => {
          const account = readAccountLimits(parseJson<Record<string, unknown>>(row.configJson, {}));
          return {
            accountGroup: account.group,
            accountRpmLimit: account.limits?.rpmLimit ?? 0,
            accountDailyQuota: account.limits?.dailyQuota ?? null,
          };
        })(),
        ...(() => {
          // "Ready" means it can actually answer a search right now. A provider
          // that needs a credential but has none is saved-without-credential,
          // which must never be auto-enabled.
          const adapter = getAdapter(row.type);
          const needsKey = adapter?.requiresKey ?? false;
          const hasUsableKey = keys.some((key) => key.enabled);
          const ready = row.enabled && (!needsKey || hasUsableKey);
          const reason = !row.enabled
            ? "search source is disabled"
            : needsKey && !hasUsableKey
              ? "no credential configured"
              : null;
          return { ready, notReadyReason: reason };
        })(),
        resultsPerPage: row.resultsPerPage,
        rpmLimit: row.rpmLimit,
        dailyQuota: row.dailyQuota,
        keyStrategy: row.keyStrategy as KeyStrategy,
        cooldownMs: row.cooldownMs,
        breakerThreshold: row.breakerThreshold,
        breakerCooldownMs: row.breakerCooldownMs,
        config: parseJson<Record<string, unknown>>(row.configJson, {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        keyCount: keys.length,
        healthyKeyCount: snapshot.filter((key) => key.status === "healthy" && key.enabled).length,
        circuitOpen:
          entry !== undefined &&
          entry.breaker.openUntilMs !== null &&
          entry.breaker.openUntilMs > Date.now(),
      };
    });
  }

  listKeys(providerId: string): ApiKeySummary[] {
    const entry = this.runtimes.get(providerId);
    const live = new Map(entry?.scheduler.snapshot().map((key) => [key.id, key] as const) ?? []);
    return this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.providerId, providerId))
      .all()
      .map((row) => {
        const snapshot = live.get(row.id);
        return {
          id: row.id,
          providerId: row.providerId,
          label: row.label,
          maskedKey: row.keyHint,
          weight: row.weight,
          enabled: row.enabled,
          status: (snapshot?.status ?? row.status) as KeyStatus,
          requestCount: snapshot?.requestCount ?? row.requestCount,
          successCount: snapshot?.successCount ?? row.successCount,
          failureCount: snapshot?.failureCount ?? row.failureCount,
          consecutiveFailures: snapshot?.consecutiveFailures ?? row.consecutiveFailures,
          lastUsedAt: snapshot?.lastUsedAt ?? row.lastUsedAt,
          lastFailureAt: row.lastFailureAt,
          avgLatencyMs:
            snapshot?.avgLatencyMs ?? (row.avgLatencyMs === null ? null : Math.round(row.avgLatencyMs)),
          inFlight: snapshot?.inFlight ?? 0,
          cooldownUntil: snapshot?.cooldownUntil ?? row.cooldownUntil,
          quotaUsedToday: snapshot?.quotaUsedToday ?? row.quotaUsedToday,
          lastErrorCode: snapshot?.lastErrorCode ?? row.lastErrorCode,
          lastErrorMessage: snapshot?.lastErrorMessage ?? row.lastErrorMessage,
          createdAt: row.createdAt,
        };
      });
  }

  /** Decrypts a key for an in-flight provider call. Never leaves the server. */
  resolveKey(id: string): string | undefined {
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
    if (!row || !row.enabled) return undefined;
    try {
      return this.secrets.decrypt({
        ciphertext: row.keyCiphertext,
        iv: row.keyIv,
        tag: row.keyTag,
        version: row.keyVersion,
      });
    } catch {
      return undefined;
    }
  }

  runtimeSnapshots(): ProviderRuntimeSnapshot[] {
    return this.listRows().map((row) => {
      const entry = this.runtimes.get(row.id);
      const keys = entry?.scheduler.snapshot() ?? [];
      return {
        providerId: row.id,
        providerName: row.name,
        providerType: row.type,
        enabled: row.enabled,
        healthy: keys.some((key) => key.status === "healthy" && key.enabled),
        circuitOpen:
          entry !== undefined &&
          entry.breaker.openUntilMs !== null &&
          entry.breaker.openUntilMs > Date.now(),
        circuitOpenUntil:
          entry && entry.breaker.openUntilMs !== null
            ? new Date(entry.breaker.openUntilMs).toISOString()
            : null,
        account: entry?.scheduler.accountSnapshot() ?? null,
        keys: keys.map((key) => ({
          id: key.id,
          label: key.label,
          status: key.status,
          inFlight: key.inFlight,
          peakInFlight: key.peakInFlight,
          rpmUsed: key.rpmUsed,
          quotaUsedToday: key.quotaUsedToday,
          requestCount: key.requestCount,
          failureCount: key.failureCount,
          avgLatencyMs: key.avgLatencyMs,
          cooldownUntil: key.cooldownUntil,
          lastErrorCode: key.lastErrorCode,
        })),
      };
    });
  }

  currentConcurrency(): number {
    return [...this.runtimes.values()].reduce(
      (sum, entry) => sum + entry.scheduler.totalInFlight(),
      0,
    );
  }

  activeRuntimes(): EngineProviderRuntime[] {
    return this.listRows()
      .filter((row) => row.enabled)
      .map((row) => this.runtimes.get(row.id))
      .filter((entry): entry is ProviderRuntimeEntry => entry !== undefined)
      .map((entry) => ({
        config: entry.config,
        adapter: entry.adapter,
        scheduler: entry.scheduler,
        enabled: true,
        breaker: entry.breaker,
      }));
  }

  runtimesFor(ids: string[]): EngineProviderRuntime[] {
    const active = this.activeRuntimes();
    if (ids.length === 0) return active;
    const idSet = new Set(ids);
    return active.filter((runtime) => idSet.has(runtime.config.id));
  }

  markKeyHealthy(providerId: string, keyId: string): void {
    const entry = this.runtimes.get(providerId);
    if (!entry) throw new SearchHubError("not_found", "Provider not found");
    entry.scheduler.markHealthy(keyId);
  }

  setKeyEnabled(providerId: string, keyId: string, enabled: boolean): void {
    const entry = this.runtimes.get(providerId);
    if (!entry) throw new SearchHubError("not_found", "Provider not found");
    entry.scheduler.setKeyEnabled(keyId, enabled);
  }

  async flushDirty(): Promise<void> {
    if (this.dirtyKeys.size === 0) return;
    const pending = [...this.dirtyKeys.values()];
    this.dirtyKeys.clear();
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const snapshot of pending) {
        tx.update(apiKeys)
          .set({
            status: snapshot.status,
            requestCount: snapshot.requestCount,
            successCount: snapshot.successCount,
            failureCount: snapshot.failureCount,
            consecutiveFailures: snapshot.consecutiveFailures,
            lastUsedAt: snapshot.lastUsedAt,
            lastFailureAt: snapshot.lastFailureAt,
            avgLatencyMs: snapshot.avgLatencyMs,
            cooldownUntil: snapshot.cooldownUntil,
            quotaUsedToday: snapshot.quotaUsedToday,
            lastErrorCode: snapshot.lastErrorCode,
            lastErrorMessage: snapshot.lastErrorMessage,
            updatedAt: now,
          })
          .where(eq(apiKeys.id, snapshot.id))
          .run();
      }
    });
  }

  startFlusher(intervalMs = 1500): void {
    if (this.dirtyFlushTimer) return;
    this.dirtyFlushTimer = setInterval(() => {
      void this.flushDirty().catch(() => {
        // Best-effort stats persistence; never crash the request path.
      });
    }, intervalMs);
    this.dirtyFlushTimer.unref?.();
  }

  stopFlusher(): void {
    if (this.dirtyFlushTimer) {
      clearInterval(this.dirtyFlushTimer);
      this.dirtyFlushTimer = null;
    }
  }

  deleteRow(id: string): void {
    this.db.delete(providerInstances).where(eq(providerInstances.id, id)).run();
    this.runtimes.delete(id);
  }

  findKeyById(keyId: string): { id: string; providerId: string } | null {
    const row = this.db
      .select({ id: apiKeys.id, providerId: apiKeys.providerId })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .get();
    return row ?? null;
  }

  keysForProvider(providerId: string): Array<{ id: string; enabled: boolean }> {
    return this.db
      .select({ id: apiKeys.id, enabled: apiKeys.enabled })
      .from(apiKeys)
      .where(eq(apiKeys.providerId, providerId))
      .all();
  }

  assertImplemented(type: string): void {
    if (!getAdapter(type)) {
      const entry = getCatalogEntry(type);
      throw new SearchHubError(
        "not_implemented",
        entry
          ? `Provider "${entry.name}" is not implemented yet (${entry.implementation}). ${entry.description}`
          : `Unknown provider type "${type}"`,
        { details: { type, implementation: entry?.implementation ?? "unknown" } },
      );
    }
  }

  catalogFor(type: string) {
    return getCatalogEntry(type);
  }

  private markDirty(snapshot: KeyRuntimeSnapshot): void {
    this.dirtyKeys.set(snapshot.id, snapshot);
  }
}

/**
 * Reads the account-level budget from the provider config.
 *
 * These live in the config JSON rather than dedicated columns on purpose: they
 * are billing metadata that varies per vendor and should not force a schema
 * migration for every new provider.
 */
function readAccountLimits(config: Record<string, unknown>): {
  group: string | null;
  limits: { rpmLimit: number; dailyQuota: number | null } | null;
} {
  const rawGroup = config["accountGroup"];
  const group = typeof rawGroup === "string" && rawGroup.trim() ? rawGroup.trim().slice(0, 80) : null;
  const rawRpm = config["accountRpmLimit"];
  const rpmLimit =
    typeof rawRpm === "number" && Number.isFinite(rawRpm) ? Math.max(0, Math.trunc(rawRpm)) : 0;
  const rawQuota = config["accountDailyQuota"];
  const dailyQuota =
    typeof rawQuota === "number" && Number.isFinite(rawQuota) && rawQuota > 0 ? Math.trunc(rawQuota) : null;
  if (!group) return { group: null, limits: null };
  if (rpmLimit === 0 && dailyQuota === null) return { group, limits: null };
  return { group, limits: { rpmLimit, dailyQuota } };
}
