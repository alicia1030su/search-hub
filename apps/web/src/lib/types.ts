/**
 * Wire types for the Search Hub REST API.
 * These mirror the shared contract; the web app keeps its own copy so the
 * browser build never imports server-side modules.
 */

export type ProviderCategory = "general" | "ai" | "compat" | "custom";
export type ProviderAuthType = "none" | "api_key" | "bearer" | "basic";
export type ProviderImplementation = "builtin" | "generic" | "planned" | "unavailable";
export type ProviderVerification = "documented" | "live_tested" | "unverified" | "no_official_api";
export type ProviderType = string;

export type KeyStrategy = "round_robin" | "random" | "weighted_random" | "least_used" | "failover";
export type KeyStatus = "healthy" | "rate_limited" | "cooldown" | "invalid" | "disabled" | "unknown";
export type Freshness = "day" | "week" | "month" | "year" | "all";
export type SearchMode =
  | "basic"
  | "rrf"
  | "rerank"
  | "embedding"
  | "embedding_rerank"
  | "rerank_summary"
  | "deep";
export type SearchStatus = "completed" | "partial" | "failed" | "running" | "cancelled";
export type ModelKind = "chat" | "embedding" | "rerank";
export type ModelProviderType =
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "cohere"
  | "jina"
  | "custom-http";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface SetupStatus {
  initialized: boolean;
  version: string;
  admins: number;
  setupTokenRequired?: boolean;
}

export interface AuthSession {
  user: User;
  csrfToken: string;
  expiresAt: string;
  initialized?: boolean;
  version?: string;
}

export interface SetupInput {
  email: string;
  password: string;
  name: string;
  setupToken?: string;
}

export interface HealthStatus {
  status: string;
  version: string;
  uptimeSeconds: number;
  setupRequired: boolean;
  providers: { total: number; enabled: number; healthy: number; circuitOpen?: number };
  database?: { driver: string; migrations: number };
  encryption?: { source: string };
}

export interface ProviderSummary {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  baseUrl: string | null;
  timeoutMs: number;
  maxConcurrency: number;
  priority: number;
  weight: number;
  maxRetries: number;
  language: string | null;
  freshness: Freshness | null;
  resultsPerPage: number;
  rpmLimit: number;
  dailyQuota: number | null;
  keyStrategy: KeyStrategy;
  cooldownMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  keyCount: number;
  healthyKeyCount: number;
  circuitOpen: boolean;
}

export interface ProviderCatalogEntry {
  type: string;
  name: string;
  category: ProviderCategory;
  authType: ProviderAuthType;
  implementation: ProviderImplementation;
  defaultBaseUrl?: string;
  docsUrl?: string;
  description: string;
  verification: ProviderVerification;
  notes?: string;
}

export interface ProviderRuntimeKey {
  id: string;
  label: string;
  status: KeyStatus;
  inFlight: number;
  rpmUsed: number;
  quotaUsedToday: number;
  requestCount: number;
  failureCount: number;
  avgLatencyMs: number | null;
  cooldownUntil: string | null;
  lastErrorCode: string | null;
}

export interface ProviderRuntimeSnapshot {
  providerId: string;
  providerName: string;
  providerType: string;
  enabled: boolean;
  healthy: boolean;
  circuitOpen: boolean;
  circuitOpenUntil: string | null;
  keys: ProviderRuntimeKey[];
}

export interface ProvidersResponse {
  providers: ProviderSummary[];
  status: ProviderRuntimeSnapshot[];
  catalog: ProviderCatalogEntry[];
  adapters?: string[];
}

export interface ApiKeySummary {
  id: string;
  providerId: string;
  label: string;
  maskedKey: string;
  weight: number;
  enabled: boolean;
  status: KeyStatus;
  requestCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastUsedAt: string | null;
  lastFailureAt: string | null;
  avgLatencyMs: number | null;
  inFlight: number;
  cooldownUntil: string | null;
  quotaUsedToday: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  resultCount?: number;
  message: string;
  sample?: Array<{ title: string; url: string }>;
}

export interface ProviderInput {
  name: string;
  type: ProviderType;
  enabled: boolean;
  baseUrl?: string | null;
  timeoutMs: number;
  maxConcurrency: number;
  priority: number;
  weight: number;
  maxRetries: number;
  language?: string | null;
  freshness?: Freshness | null;
  resultsPerPage: number;
  rpmLimit: number;
  dailyQuota?: number | null;
  keyStrategy: KeyStrategy;
  cooldownMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  config: Record<string, unknown>;
}

export interface KeyInput {
  label: string;
  key?: string;
  weight: number;
  enabled: boolean;
}

export interface GenericProviderConfig {
  method?: "GET" | "POST";
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  keyInjection?: { in: "header" | "query" | "body"; name: string; prefix?: string };
  resultsPath?: string;
  mapping?: {
    title?: string;
    url?: string;
    snippet?: string;
    publishedAt?: string;
    score?: string;
    language?: string;
  };
  timeoutMs?: number;
}

export interface ModelConfig {
  id: string;
  kind: ModelKind;
  name: string;
  providerType: ModelProviderType;
  baseUrl: string;
  modelId: string;
  dimensions: number | null;
  batchSize: number;
  timeoutMs: number;
  maxConcurrency: number;
  params: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
  hasKey?: boolean;
  apiKeyHint?: string | null;
}

export interface ModelInput {
  kind: ModelKind;
  name: string;
  providerType: ModelProviderType;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  dimensions?: number | null;
  batchSize: number;
  timeoutMs: number;
  maxConcurrency: number;
  params: Record<string, unknown>;
  enabled: boolean;
  isDefault: boolean;
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  detail?: unknown;
}

export interface SearchRequest {
  query: string;
  providers?: string[];
  group?: string;
  limit?: number;
  language?: string;
  freshness?: Freshness;
  mode: SearchMode;
  rerank?: boolean;
  summarize?: boolean;
  timeoutMs?: number;
  includeRaw?: boolean;
  skipCache?: boolean;
  rerankModelId?: string;
  embeddingModelId?: string;
  chatModelId?: string;
}

export interface UpstreamAttribution {
  provider?: string;
  providerName?: string;
  source?: string;
  sources?: string[];
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  provider: string;
  providerType: string;
  providerName: string;
  publishedAt?: string;
  retrievedAt: string;
  score: number;
  fusionScore?: number;
  rerankScore?: number;
  language?: string;
  upstream?: UpstreamAttribution;
  sources: Array<{
    providerId: string;
    providerName: string;
    providerType: string;
    rank: number;
    score?: number;
    url: string;
    upstream?: UpstreamAttribution;
  }>;
}

export interface ProviderAttemptStat {
  providerId: string;
  providerName: string;
  providerType: string;
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  resultCount: number;
  keyId?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Non-fatal upstream degradation reported by a gateway provider. */
  warning?: string;
  attempts: number;
}

export interface SearchTiming {
  totalMs: number;
  fanoutMs: number;
  fusionMs: number;
  rerankMs?: number;
  embeddingMs?: number;
  summaryMs?: number;
}

export interface SearchResponse {
  taskId: string;
  query: string;
  mode: SearchMode;
  status: Exclude<SearchStatus, "running">;
  results: SearchResult[];
  stats: {
    rawCount: number;
    dedupedCount: number;
    fusedCount: number;
    providers: ProviderAttemptStat[];
    timing: SearchTiming;
    rerankApplied: boolean;
    embeddingApplied: boolean;
    summaryApplied: boolean;
    partial: boolean;
  };
  errors: Array<{ providerId: string; providerName: string; code: string; message: string }>;
  summary?: {
    text: string;
    modelId?: string;
    citations: Array<{ index: number; title: string; url: string }>;
    degraded?: boolean;
  };
  debug?: {
    providerQueries?: Array<{ providerId: string; query: string }>;
    rewrittenQueries?: string[];
    droppedDuplicates?: Array<{ url: string; keptUrl: string; reason: "exact_url" | "near_title" }>;
    perProviderResults?: Array<{
      providerId: string;
      providerName: string;
      results: SearchResult[];
    }>;
  };
}

export interface SearchTaskRecord {
  id: string;
  query: string;
  mode: SearchMode;
  status: SearchStatus;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  response: SearchResponse | null;
}

export interface DashboardStats {
  range: { from: string; to: string };
  totals: {
    searches: number;
    successRate: number;
    avgLatencyMs: number;
    resultCount: number;
  };
  currentConcurrency: number;
  providers: Array<{
    providerId: string;
    providerName: string;
    providerType: string;
    calls: number;
    errors: number;
    errorRate: number;
    avgLatencyMs: number;
    enabled: boolean;
  }>;
  keys: {
    total: number;
    healthy: number;
    rateLimited: number;
    cooldown: number;
    invalid: number;
    disabled: number;
  };
  models: {
    total: number;
    enabled: number;
    chat: number;
    embedding: number;
    rerank: number;
    calls: number;
  };
  timeline: Array<{ bucket: string; searches: number; errors: number; avgLatencyMs: number }>;
}

export interface AppSettings {
  instance: { name: string; publicBaseUrl: string };
  defaults: { limit: number; timeoutMs: number; mode: SearchMode; language: string; freshness: Freshness };
  security: {
    privateHostAllowlist: string[];
    allowHttp: boolean;
    sessionTtlHours: number;
    loginRateLimitPerMin: number;
  };
  retention: { taskRetentionDays: number; logRetentionDays: number };
  cache: { enabled: boolean; ttlSeconds: number };
  logging: { level: string };
  initializedAt: string | null;
}

export interface AccessTokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface TokenCreateResult {
  token: string;
  record: AccessTokenSummary;
}

export interface LogEvent {
  id: string;
  taskId: string | null;
  providerId: string | null;
  providerName: string | null;
  ok: boolean;
  latencyMs: number;
  resultCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  installPath: string;
  /** null when the server could not read SKILL.md from disk. */
  content: string | null;
}

export interface McpInfo {
  endpoint: string;
  tools: Array<{ name: string; title: string; description: string }>;
}

export interface SearchGroup {
  id: string;
  name: string;
  description: string | null;
  providerIds: string[];
  createdAt: string;
}

export interface GroupInput {
  name: string;
  description?: string;
  providerIds: string[];
}
