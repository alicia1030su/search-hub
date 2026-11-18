import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const adminUsers = sqliteTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("admin"),
    createdAt: text("created_at").notNull(),
    lastLoginAt: text("last_login_at"),
  },
  (table) => [uniqueIndex("idx_admin_users_email").on(table.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    csrfToken: text("csrf_token").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("idx_sessions_token").on(table.tokenHash),
    index("idx_sessions_expires").on(table.expiresAt),
  ],
);

export const providerInstances = sqliteTable(
  "provider_instances",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    baseUrl: text("base_url"),
    timeoutMs: integer("timeout_ms").notNull().default(12000),
    maxConcurrency: integer("max_concurrency").notNull().default(4),
    priority: integer("priority").notNull().default(100),
    weight: integer("weight").notNull().default(100),
    maxRetries: integer("max_retries").notNull().default(1),
    language: text("language"),
    freshness: text("freshness"),
    resultsPerPage: integer("results_per_page").notNull().default(10),
    rpmLimit: integer("rpm_limit").notNull().default(60),
    dailyQuota: integer("daily_quota"),
    keyStrategy: text("key_strategy").notNull().default("round_robin"),
    cooldownMs: integer("cooldown_ms").notNull().default(30000),
    breakerThreshold: integer("breaker_threshold").notNull().default(5),
    breakerCooldownMs: integer("breaker_cooldown_ms").notNull().default(60000),
    configJson: text("config_json").notNull().default("{}"),
    /** Platform-level search parameters (see ProviderManifest.parameters). */
    searchConfigJson: text("search_config_json").notNull().default("{}"),
    /** When this instance was added from the marketplace. */
    installedAt: text("installed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_provider_instances_name").on(table.name),
    index("idx_provider_instances_type").on(table.type),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providerInstances.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    keyCiphertext: text("key_ciphertext").notNull(),
    keyIv: text("key_iv").notNull(),
    keyTag: text("key_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    keyHint: text("key_hint").notNull(),
    weight: integer("weight").notNull().default(100),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    status: text("status").notNull().default("unknown"),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastUsedAt: text("last_used_at"),
    lastFailureAt: text("last_failure_at"),
    avgLatencyMs: real("avg_latency_ms"),
    cooldownUntil: text("cooldown_until"),
    quotaUsedToday: integer("quota_used_today").notNull().default(0),
    quotaDate: text("quota_date"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_api_keys_provider").on(table.providerId)],
);

export const modelConfigs = sqliteTable(
  "model_configs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    providerType: text("provider_type").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyCiphertext: text("api_key_ciphertext"),
    apiKeyIv: text("api_key_iv"),
    apiKeyTag: text("api_key_tag"),
    apiKeyHint: text("api_key_hint"),
    modelId: text("model_id").notNull(),
    dimensions: integer("dimensions"),
    batchSize: integer("batch_size").notNull().default(32),
    timeoutMs: integer("timeout_ms").notNull().default(30000),
    maxConcurrency: integer("max_concurrency").notNull().default(4),
    paramsJson: text("params_json").notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    lastTestOk: integer("last_test_ok", { mode: "boolean" }),
    lastTestAt: text("last_test_at"),
    lastTestError: text("last_test_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_model_configs_kind").on(table.kind)],
);

export const searchGroups = sqliteTable(
  "search_groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    providerIdsJson: text("provider_ids_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_search_groups_name").on(table.name)],
);

export const searchTasks = sqliteTable(
  "search_tasks",
  {
    id: text("id").primaryKey(),
    query: text("query").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    providersJson: text("providers_json").notNull().default("[]"),
    resultCount: integer("result_count").notNull().default(0),
    rawCount: integer("raw_count").notNull().default(0),
    durationMs: integer("duration_ms"),
    errorsJson: text("errors_json"),
    requestJson: text("request_json"),
    responseJson: text("response_json"),
    actor: text("actor"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("idx_search_tasks_created").on(table.createdAt),
    index("idx_search_tasks_status").on(table.status),
  ],
);

export const searchEvents = sqliteTable(
  "search_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerName: text("provider_name").notNull(),
    providerType: text("provider_type").notNull(),
    keyId: text("key_id"),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_search_events_created").on(table.createdAt),
    index("idx_search_events_provider").on(table.providerId),
    index("idx_search_events_task").on(table.taskId),
  ],
);

export const accessTokens = sqliteTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopesJson: text("scopes_json").notNull().default("[]"),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(120),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("idx_access_tokens_hash").on(table.tokenHash)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Persistent search-response cache.
 *
 * The key is a SHA-256 of every input that can change the response, never the
 * query itself: a raw query as a primary key makes the table readable as a
 * search history and lets a long query blow the index size.
 *
 * `size_bytes` is the UTF-8 byte length of `response_json` (not the JavaScript
 * string length), because that is what the file, the WAL and the 256 MB cap
 * actually measure.
 */
export const searchCache = sqliteTable(
  "search_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    responseJson: text("response_json").notNull(),
    /** Kept for diagnostics; never returned to callers. */
    status: text("status").notNull(),
    mode: text("mode").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastAccessedAt: text("last_accessed_at").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
  },
  (table) => [
    index("idx_search_cache_expires").on(table.expiresAt),
    // LRU eviction orders by this column, so it needs its own index.
    index("idx_search_cache_accessed").on(table.lastAccessedAt),
  ],
);

/**
 * Hourly cache counters.
 *
 * One row per UTC hour keeps the 24-hour hit rate a bounded query, and lets the
 * dashboard say "no data yet" instead of inventing a percentage from a single
 * request.
 */
export const searchCacheMetrics = sqliteTable("search_cache_metrics", {
  bucket: text("bucket").primaryKey(),
  hits: integer("hits").notNull().default(0),
  misses: integer("misses").notNull().default(0),
  expiredRemoved: integer("expired_removed").notNull().default(0),
  evicted: integer("evicted").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/** Cache bookkeeping that must survive a restart (last sweep, totals). */
export const searchCacheState = sqliteTable("search_cache_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    detailJson: text("detail_json"),
    ip: text("ip"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_audit_logs_created").on(table.createdAt)],
);

export type AdminUserRow = typeof adminUsers.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ProviderInstanceRow = typeof providerInstances.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ModelConfigRow = typeof modelConfigs.$inferSelect;
export type SearchGroupRow = typeof searchGroups.$inferSelect;
export type SearchTaskRow = typeof searchTasks.$inferSelect;
export type SearchEventRow = typeof searchEvents.$inferSelect;
export type AccessTokenRow = typeof accessTokens.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;

/**
 * One row per completed health probe.
 *
 * `kind` separates a free connectivity probe from a paid search probe; the
 * dashboard must never blend them into a single "healthy" number.
 */
export const providerHealthChecks = sqliteTable(
  "provider_health_checks",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    keyId: text("key_id"),
    /** "connect" (free: DNS/TLS/auth) or "search" (may cost money). */
    kind: text("kind").notNull(),
    /** "healthy" | "degraded" | "unhealthy" | "unverified". */
    status: text("status").notNull(),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms"),
    resultCount: integer("result_count"),
    healthScore: integer("health_score").notNull().default(0),
    detailJson: text("detail_json").notNull().default("{}"),
    /** "manual" | "schedule" | "recovery" | "search". */
    trigger: text("trigger").notNull(),
    checkedAt: text("checked_at").notNull(),
  },
  (table) => [
    index("idx_health_provider_time").on(table.providerId, table.checkedAt),
    index("idx_health_checked_at").on(table.checkedAt),
  ],
);

export type ProviderHealthCheckRow = typeof providerHealthChecks.$inferSelect;

/**
 * Scheduler bookkeeping for one provider.
 *
 * Separate from `provider_health_checks` on purpose: the log is an append-only
 * record of what happened, this is "what should happen next". Changing a
 * schedule therefore never rewrites history.
 */
export const providerProbeState = sqliteTable(
  "provider_probe_state",
  {
    providerId: text("provider_id")
      .primaryKey()
      .references(() => providerInstances.id, { onDelete: "cascade" }),
    /** Per-provider switch; the global switch still gates everything. */
    autoProbeEnabled: integer("auto_probe_enabled", { mode: "boolean" }).notNull().default(true),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    backoffLevel: integer("backoff_level").notNull().default(0),
    nextProbeAt: text("next_probe_at"),
    /**
     * Manual reset marker: probe rows older than this no longer determine the
     * provider's status, but they stay in the log for audit.
     */
    resetAt: text("reset_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_probe_state_next").on(table.nextProbeAt)],
);

/**
 * Durable probe-spend ledger.
 *
 * One row per UTC day and probe kind. A read-then-act count over the probe log
 * would let two concurrent probes both see "19 used" and both spend; this is
 * decremented by a conditional UPDATE instead, so the cap holds under
 * concurrency and across restarts.
 */
export const healthProbeBudget = sqliteTable(
  "health_probe_budget",
  {
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    used: integer("used").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.kind] })],
);

export type ProviderProbeStateRow = typeof providerProbeState.$inferSelect;

/**
 * A versioned qrel set: a dataset of queries and the grades assessors gave to
 * documents for them.
 *
 * `origin` decides what a score may be called. A `synthetic_fixture` dataset
 * validates the machinery; it never describes a real vendor's quality.
 */
export const qualityDatasets = sqliteTable(
  "quality_datasets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    language: text("language").notNull().default("zh"),
    /** Bumped by `freeze`; a run records the version it used. */
    version: integer("version").notNull().default(1),
    /** "draft" | "frozen". A frozen dataset rejects in-place edits. */
    status: text("status").notNull().default("draft"),
    /** "manual" | "imported" | "synthetic_fixture". */
    origin: text("origin").notNull().default("manual"),
    /**
     * True only when the qrels are exhaustive for this query set. Recall is
     * N/A otherwise — a partial ground truth cannot produce a recall figure.
     */
    judgmentsComplete: integer("judgments_complete", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    frozenAt: text("frozen_at"),
  },
  (table) => [index("idx_quality_datasets_status").on(table.status)],
);

export const qualityQueries = sqliteTable(
  "quality_queries",
  {
    id: text("id").primaryKey(),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => qualityDatasets.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    /** general | chinese | english | code | academic | news | ... */
    category: text("category").notNull().default("general"),
    /**
     * Secondary category labels as a JSON array (migration `0007`).
     *
     * The primary label stays in `category` so an old client that never sends
     * extra labels is still valid; the read model exposes them together as
     * `categories`. A query may hold at most three labels in total.
     */
    extraCategories: text("extra_categories").notNull().default("[]"),
    language: text("language").notNull().default("zh"),
    intent: text("intent").notNull().default(""),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_quality_queries_dataset").on(table.datasetId)],
);

export const qualityJudgments = sqliteTable(
  "quality_judgments",
  {
    id: text("id").primaryKey(),
    datasetId: text("dataset_id")
      .notNull()
      .references(() => qualityDatasets.id, { onDelete: "cascade" }),
    queryId: text("query_id")
      .notNull()
      .references(() => qualityQueries.id, { onDelete: "cascade" }),
    /** Normalized document identity, never a list position. */
    documentId: text("document_id").notNull(),
    /** 0 off-topic … 3 fully answers the intent. */
    relevance: integer("relevance").notNull(),
    assessor: text("assessor").notNull(),
    /** human | machine_generated | synthetic_fixture. Only human is truth. */
    source: text("source").notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_quality_judgments_document").on(table.queryId, table.documentId),
    index("idx_quality_judgments_dataset").on(table.datasetId),
  ],
);

export const qualityRuns = sqliteTable(
  "quality_runs",
  {
    id: text("id").primaryKey(),
    datasetId: text("dataset_id").notNull(),
    datasetVersion: integer("dataset_version").notNull(),
    datasetOrigin: text("dataset_origin").notNull(),
    name: text("name").notNull().default(""),
    notes: text("notes").notNull().default(""),
    /** "offline" (never leaves the process) or "live" (spends vendor quota). */
    mode: text("mode").notNull(),
    fusionStrategy: text("fusion_strategy").notNull(),
    fusionJson: text("fusion_json").notNull(),
    limitValue: integer("limit_value").notNull(),
    /** Metric cutoff; @10 and @20 are different questions. */
    cutoffValue: integer("cutoff_value").notNull().default(10),
    /** Re-rank the snapshots of another run instead of capturing new ones. */
    snapshotRunId: text("snapshot_run_id"),
    codeCommit: text("code_commit"),
    engineVersion: text("engine_version").notNull(),
    /**
     * Provenance (migration `0007`): the evidence a score is reproducible from.
     *
     * Every `*Fingerprint` column is a sha256 of a *credential-free* description
     * of what participated in this run. They are NULL on runs recorded before
     * v0.1.10; such a run reports `provenanceComplete: false` instead of
     * borrowing today's settings, which would describe a run that never
     * happened.
     */
    providerIdsJson: text("provider_ids_json"),
    providerFingerprint: text("provider_fingerprint"),
    /** `null` is a fact: no model took part in this run. */
    modelFingerprint: text("model_fingerprint"),
    qrelsFingerprint: text("qrels_fingerprint"),
    /** Per-provider row limit actually requested for each query. */
    perProviderLimit: integer("per_provider_limit"),
    /** Request timeout applied to this run only, never written back to a provider. */
    requestTimeoutMs: integer("request_timeout_ms"),
    /**
     * Why a failed run failed, in a small closed vocabulary the UI translates:
     * `persistence_failed` | `budget_exhausted` | `cancelled` | `internal_error`.
     */
    failureReason: text("failure_reason"),
    /** How many per-query rows were actually written before the run stopped. */
    persistedQueryCount: integer("persisted_query_count").notNull().default(0),
    /** True when only part of the requested queries produced a stored row. */
    partial: integer("partial", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull(),
    /** Hard ceiling on upstream requests, and what was actually spent. */
    requestBudget: integer("request_budget").notNull().default(0),
    requestsUsed: integer("requests_used").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    queryCount: integer("query_count").notNull().default(0),
    errorJson: text("error_json"),
    metricsJson: text("metrics_json"),
    actor: text("actor"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_quality_runs_dataset").on(table.datasetId, table.startedAt)],
);

/**
 * The raw per-provider lists captured by a run.
 *
 * This is what makes a comparison fair: two fusion strategies are re-ranked
 * from the same rows instead of from two different moments on the network.
 */
export const qualitySnapshots = sqliteTable(
  "quality_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => qualityRuns.id, { onDelete: "cascade" }),
    queryId: text("query_id").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_quality_snapshots_query").on(table.runId, table.queryId),
    /** The unjudged listing looks a query up across every run. */
    index("idx_quality_snapshots_query_only").on(table.queryId),
  ],
);

export const qualityRunResults = sqliteTable(
  "quality_run_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => qualityRuns.id, { onDelete: "cascade" }),
    queryId: text("query_id").notNull(),
    status: text("status").notNull(),
    /** Ordered document ids: what a regression is actually about. */
    rankedJson: text("ranked_json").notNull(),
    metricsJson: text("metrics_json").notNull(),
    latencyMs: real("latency_ms"),
    upstreamRequests: integer("upstream_requests").notNull().default(0),
    errorJson: text("error_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_quality_run_results_run").on(table.runId),
    /** The unjudged listing looks a query up across every run. */
    index("idx_quality_run_results_query").on(table.queryId),
  ],
);

export type QualityDatasetRow = typeof qualityDatasets.$inferSelect;
export type QualityQueryRow = typeof qualityQueries.$inferSelect;
export type QualityJudgmentRow = typeof qualityJudgments.$inferSelect;
export type QualityRunRow = typeof qualityRuns.$inferSelect;
export type QualitySnapshotRow = typeof qualitySnapshots.$inferSelect;
export type QualityRunResultRow = typeof qualityRunResults.$inferSelect;
