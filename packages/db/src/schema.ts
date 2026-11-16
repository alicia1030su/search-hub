import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
