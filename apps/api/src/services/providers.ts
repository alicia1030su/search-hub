import { asc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  SearchHubError,
  redactSecrets,
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
import { getAdapter, getCatalogEntry, buildManifest, providerRequiresKey, resolveSearchConfig } from "@search-hub/providers";
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

export interface KeyProbeRelease {
  ok: boolean;
  latencyMs?: number;
  code?: string;
  message?: string;
  retryAfterMs?: number;
  cancelled?: boolean;
  notSent?: boolean;
}

export interface KeyAvailability {
  total: number;
  enabled: number;
  decryptable: number;
  available: number;
  invalid: number;
  quotaExhausted: number;
  coolingUntil: string | null;
  accountQuotaExhausted: boolean;
}

export type AcquireKeyResult =
  | {
      ok: true;
      keyId: string;
      keyLabel: string;
      secret: string;
      release(outcome: KeyProbeRelease): Promise<void>;
    }
  | {
      ok: false;
      reason:
        | "no_key"
        | "queue_timeout"
        | "account_quota"
        | "key_not_found"
        | "key_disabled"
        | "key_undecryptable"
        | "provider_disabled";
      message: string;
    };

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
    // A config reload must not replace newer in-memory outcomes with stale DB rows.
    this.persistDirty();
    const rows = this.db.select().from(providerInstances).all();
    const keyRows = this.db.select().from(apiKeys).all();
    const next = new Map<string, ProviderRuntimeEntry>();

    for (const row of rows) {
      const adapter = getAdapter(row.type);
      if (!adapter) continue;

      const seeds = this.seedsFor(row.id, keyRows);

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
      /** Keys the scheduler can use now (enabled, decryptable, not cooling or quota-blocked). */
      availableKeyCount: number;
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
    const rows = this.listRows();
    const availability = this.keyAvailability(rows.map((row) => row.id));
    return rows.map((row) => {
      const entry = this.runtimes.get(row.id);
      const snapshot = entry?.scheduler.snapshotReadOnly() ?? [];
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
          const config = parseJson<Record<string, unknown>>(row.configJson, {});
          const needsKey = this.providerRequiresKey(row.type, config);
          const hasUsableKey = (availability.get(row.id)?.available ?? 0) > 0;
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
        availableKeyCount: availability.get(row.id)?.available ?? 0,
        circuitOpen:
          entry !== undefined &&
          entry.breaker.openUntilMs !== null &&
          entry.breaker.openUntilMs > Date.now(),
      };
    });
  }

  listKeys(providerId: string): ApiKeySummary[] {
    const entry = this.runtimes.get(providerId);
    const live = new Map(entry?.scheduler.snapshotReadOnly().map((key) => [key.id, key] as const) ?? []);
    return this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.providerId, providerId))
      .all()
      .map((row) => {
        const snapshot = live.get(row.id);
        const lastErrorMessage = snapshot?.lastErrorMessage ?? row.lastErrorMessage;
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
          lastFailureAt: snapshot?.lastFailureAt ?? row.lastFailureAt,
          avgLatencyMs:
            snapshot?.avgLatencyMs ?? (row.avgLatencyMs === null ? null : Math.round(row.avgLatencyMs)),
          inFlight: snapshot?.inFlight ?? 0,
          cooldownUntil: snapshot?.cooldownUntil ?? row.cooldownUntil,
          quotaUsedToday: snapshot?.quotaUsedToday ?? row.quotaUsedToday,
          lastErrorCode: snapshot?.lastErrorCode ?? row.lastErrorCode,
          lastErrorMessage: row.lastErrorSanitized
            ? this.redactKeyMessage(row.id, lastErrorMessage)
            : lastErrorMessage === null
              ? null
              : "[redacted: legacy diagnostic]",
          createdAt: row.createdAt,
        };
      });
  }

  /**
   * Redacts a diagnostic with the current credential for a specific key.
   *
   * Older releases could persist an upstream echo before it was sanitized. The
   * plaintext is still in the encrypted key row, so reads can protect clients
   * without rewriting audit history. If the key was deleted or cannot be
   * decrypted, the shared query-name and token-shape filters still apply.
   */
  redactKeyMessage(keyId: string | null | undefined, message: string | null | undefined): string | null {
    if (message == null) return null;
    const row = keyId ? this.db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get() : undefined;
    const secret = row ? this.decryptRow(row) : undefined;
    return redactSecrets(message, secret ? [secret] : []);
  }

  /** Redacts a diagnostic with every current credential belonging to a provider. */
  redactProviderMessage(providerId: string, message: string | null | undefined): string | null {
    if (message == null) return null;
    const secrets = this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.providerId, providerId))
      .all()
      .map((row) => this.decryptRow(row))
      .filter((secret): secret is string => secret !== undefined);
    return redactSecrets(message, secrets);
  }

  /** Decrypts a key for an in-flight provider call. Never leaves the server. */
  resolveKey(id: string): string | undefined {
    const row = this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
    if (!row || !row.enabled) return undefined;
    return this.decryptRow(row);
  }

  providerRequiresKey(type: string, config: Record<string, unknown>): boolean {
    return providerRequiresKey(type, config);
  }

  /**
   * 管理端 Key 池事实，以 providerId 为键；available 与自动选择共用规则。
   *
   * Strictly read-only: GET/preview paths must not flush dirty scheduler state,
   * sync stale DB rows over live counters, or create UTC-rollover dirty writes.
   * Write paths reload the scheduler after committing configuration changes.
   */
  keyAvailability(ids: string[]): Map<string, KeyAvailability> {
    const result = new Map<string, KeyAvailability>();
    const providerIds = [...new Set(ids)];
    if (providerIds.length === 0) return result;
    const rows = this.db
      .select()
      .from(apiKeys)
      .where(inArray(apiKeys.providerId, providerIds))
      .all();
    const rowsByProvider = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = rowsByProvider.get(row.providerId) ?? [];
      list.push(row);
      rowsByProvider.set(row.providerId, list);
    }
    const now = Date.now();
    for (const providerId of providerIds) {
      const providerRows = rowsByProvider.get(providerId) ?? [];
      const provider = this.getRow(providerId);
      const entry = this.runtimes.get(providerId);
      const snapshots = entry?.scheduler.snapshotReadOnly(now) ?? [];
      const liveById = new Map(snapshots.map((key) => [key.id, key] as const));
      const rowById = new Map(providerRows.map((row) => [row.id, row] as const));
      const accountParkedUntil = entry?.scheduler.accountParkedUntilReadOnly(now) ?? null;
      const cooling = [
        ...providerRows.map((row) => liveById.get(row.id)?.cooldownUntil ?? row.cooldownUntil),
        accountParkedUntil,
      ]
        .filter((value): value is string => value !== null && Date.parse(value) > now)
        .sort();
      const statusOf = (row: typeof providerRows[number]): KeyStatus =>
        liveById.get(row.id)?.status ?? (row.enabled ? row.status : "disabled") as KeyStatus;
      result.set(providerId, {
        total: providerRows.length,
        enabled: providerRows.filter((key) => key.enabled).length,
        decryptable: providerRows.filter((key) => this.decryptRow(key) !== undefined).length,
        available: snapshots.filter((key) => {
          const row = rowById.get(key.id);
          if (!row) return false;
          const status = statusOf(row);
          if (status === "invalid" || status === "disabled" || status === "forbidden" || status === "quota_exhausted") return false;
          if ((liveById.get(key.id)?.cooldownUntil ?? row.cooldownUntil) &&
              Date.parse(liveById.get(key.id)?.cooldownUntil ?? row.cooldownUntil!) > now) return false;
          // Legacy rows without a quota date cannot prove today's counter rolled
          // over; keep their persisted usage as a conservative lower bound.
          if (provider?.dailyQuota !== null && provider?.dailyQuota !== undefined &&
              row.quotaDate === null && row.quotaUsedToday >= provider.dailyQuota) return false;
          return entry?.scheduler.keyAvailableReadOnly(key.id, now) ?? false;
        }).length,
        invalid: providerRows.filter((row) => statusOf(row) === "invalid").length,
        quotaExhausted: providerRows.filter((row) => statusOf(row) === "quota_exhausted").length,
        coolingUntil: cooling.at(-1) ?? null,
        accountQuotaExhausted: entry?.scheduler.accountQuotaExhaustedReadOnly(now) ?? false,
      });
    }
    return result;
  }

  /** 取一个可执行请求的 Key 租约；release 会等待 dirty 状态落库。 */
  async acquireKey(
    providerId: string,
    options: { keyId?: string; signal?: AbortSignal; maxWaitMs?: number; manual?: boolean } = {},
  ): Promise<AcquireKeyResult> {
    const provider = this.getRow(providerId);
    if (!provider) {
      return { ok: false, reason: "key_not_found", message: "Provider not found" };
    }
    if (!provider.enabled) {
      return { ok: false, reason: "provider_disabled", message: "Provider is disabled" };
    }
    if (options.signal?.aborted) {
      return { ok: false, reason: "queue_timeout", message: "Key acquisition was cancelled" };
    }
    const entry = this.syncSchedulerKeys(providerId);
    if (!entry) return { ok: false, reason: "key_not_found", message: "Provider not found" };

    if (options.keyId) {
      const target = this.db.select().from(apiKeys).where(eq(apiKeys.id, options.keyId)).get();
      if (!target || target.providerId !== providerId) {
        return { ok: false, reason: "key_not_found", message: "API key not found for this provider" };
      }
      if (!target.enabled) {
        return { ok: false, reason: "key_disabled", message: "API key is disabled" };
      }
      if (this.decryptRow(target) === undefined) {
        return { ok: false, reason: "key_undecryptable", message: "Stored API key could not be decrypted" };
      }
    }

    const maxAttempts = options.keyId ? 1 : entry.scheduler.keyCount + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const acquired = options.keyId
        ? await entry.scheduler.acquireForKeyWithReason(options.keyId, {
            manual: options.manual,
            maxWaitMs: options.maxWaitMs,
            signal: options.signal,
          })
        : await entry.scheduler.acquireWithReason({ maxWaitMs: options.maxWaitMs, signal: options.signal });
      const lease = acquired.lease;
      if (!lease) {
        const reason = acquired.reason ?? "no_key";
        return {
          ok: false,
          reason,
          message:
            reason === "account_quota"
              ? "Account-level quota for this provider is exhausted"
              : reason === "queue_timeout"
                ? "All API key slots were busy beyond the queue budget"
                : "No available API key for this provider",
        };
      }

      // The row may have been disabled/deleted/re-encrypted while this caller
      // waited. Revalidate after the atomic lease, before any budget or request.
      const row = this.db.select().from(apiKeys).where(eq(apiKeys.id, lease.keyId)).get();
      const secret = row?.providerId === providerId && row.enabled ? this.decryptRow(row) : undefined;
      if (row && secret !== undefined) {
        let released = false;
        return {
          ok: true,
          keyId: lease.keyId,
          keyLabel: lease.keyLabel,
          secret,
          release: async (outcome) => {
            if (released) return;
            released = true;
            lease.release(outcome);
            await this.flushDirty();
          },
        };
      }

      lease.release({ ok: false, notSent: true });
      await this.flushDirty();
      entry.scheduler.setKeyDecryptable(lease.keyId, false);
      if (options.keyId) {
        return {
          ok: false,
          reason: !row || row.providerId !== providerId ? "key_not_found" : row.enabled ? "key_undecryptable" : "key_disabled",
          message: "API key changed while the lease was being acquired",
        };
      }
    }
    return { ok: false, reason: "no_key", message: "No available API key for this provider" };
  }

  runtimeSnapshots(): ProviderRuntimeSnapshot[] {
    return this.listRows().map((row) => {
      const entry = this.runtimes.get(row.id);
      const keys = entry?.scheduler.snapshotReadOnly() ?? [];
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
        account: entry?.scheduler.accountSnapshotReadOnly() ?? null,
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
        requiresKey: this.providerRequiresKey(entry.config.type, entry.config.config),
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
    this.persistDirty();
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

  /**
   * Version stamp for a provider's credentials, safe to put in a cache key.
   *
   * Only identity is hashed — key ids, their enabled flag and the encryption
   * version — never the ciphertext, the plaintext or the hint. Adding, removing,
   * disabling or re-encrypting a key changes this stamp, which invalidates
   * cached responses that were produced with the previous credential set.
   */
  credentialVersion(providerId: string): string {
    const rows = this.db
      .select({
        id: apiKeys.id,
        enabled: apiKeys.enabled,
        version: apiKeys.keyVersion,
        updatedAt: apiKeys.updatedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.providerId, providerId))
      .all();
    if (rows.length === 0) return "none";
    const material = rows
      .map((row) => `${row.id}:${row.enabled ? 1 : 0}:${row.version}:${row.updatedAt}`)
      .sort()
      .join("|");
    return createHash("sha256").update(material).digest("hex").slice(0, 16);
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

  private persistDirty(): void {
    if (this.dirtyKeys.size === 0) return;
    const pending = [...this.dirtyKeys.values()];
    this.dirtyKeys.clear();
    const now = new Date().toISOString();
    try {
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
              quotaDate: snapshot.quotaDate,
              lastErrorCode: snapshot.lastErrorCode,
              lastErrorMessage: snapshot.lastErrorMessage,
              lastErrorSanitized: true,
              updatedAt: now,
            })
            .where(eq(apiKeys.id, snapshot.id))
            .run();
        }
      });
    } catch (error) {
      for (const snapshot of pending) this.dirtyKeys.set(snapshot.id, snapshot);
      throw error;
    }
  }

  private seedsFor(providerId: string, rows: Array<typeof apiKeys.$inferSelect>): SchedulerKeySeed[] {
    return rows
      .filter((key) => key.providerId === providerId)
      .map((key) => ({
        id: key.id,
        label: key.label,
        maskedKey: key.keyHint,
        weight: key.weight,
        enabled: key.enabled,
        status: key.status as KeyStatus,
        decryptable: this.decryptRow(key) !== undefined,
        requestCount: key.requestCount,
        successCount: key.successCount,
        failureCount: key.failureCount,
        consecutiveFailures: key.consecutiveFailures,
        avgLatencyMs: key.avgLatencyMs,
        quotaUsedToday: key.quotaUsedToday,
        quotaDate: key.quotaDate,
        cooldownUntil: key.cooldownUntil,
        lastErrorCode: key.lastErrorCode,
        // Never load pre-v0.1.12 free-form diagnostics into the live scheduler:
        // a later dirty flush must not relabel an old leaked message as safe.
        lastErrorMessage: key.lastErrorSanitized ? key.lastErrorMessage : null,
      }));
  }

  private syncSchedulerKeys(
    providerId: string,
    rows?: Array<typeof apiKeys.$inferSelect>,
  ): ProviderRuntimeEntry | null {
    this.persistDirty();
    const entry = this.runtimes.get(providerId);
    if (!entry) return null;
    const keyRows = rows ?? this.db.select().from(apiKeys).where(eq(apiKeys.providerId, providerId)).all();
    entry.scheduler.syncKeys(this.seedsFor(providerId, keyRows));
    return entry;
  }

  private decryptRow(row: typeof apiKeys.$inferSelect): string | undefined {
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
