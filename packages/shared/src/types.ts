/**
 * Search Hub shared contracts.
 * Every module (core, providers, models, api, mcp, web) must depend on these
 * types instead of re-declaring its own shapes.
 */

export const SEARCH_HUB_VERSION = "0.1.0";

export type ProviderCategory = "general" | "ai" | "compat" | "custom";
export type ProviderAuthType = "none" | "api_key" | "bearer" | "basic";
export type ProviderImplementation = "builtin" | "generic" | "planned" | "unavailable";

export type KeyStrategy =
  | "round_robin"
  | "random"
  | "weighted_random"
  | "least_used"
  | "failover";

export type KeyStatus =
  | "healthy"
  | "rate_limited"
  | "cooldown"
  | "invalid"
  | "disabled"
  | "unknown";

export type Freshness = "day" | "week" | "month" | "year" | "all";

export type SearchMode =
  | "basic"
  | "rrf"
  | "rerank"
  | "embedding"
  | "embedding_rerank"
  | "rerank_summary"
  | "deep";

export type SearchTaskStatus = "running" | "completed" | "partial" | "failed" | "cancelled";

export type ProviderErrorCode =
  | "rate_limited"
  | "auth_invalid"
  | "quota_exceeded"
  | "timeout"
  | "network"
  | "server_error"
  | "bad_request"
  | "blocked"
  | "no_available_key"
  | "unsupported"
  | "cancelled"
  | "unknown";

export interface SearchRequest {
  query: string;
  /** Provider instance ids. When omitted, all enabled providers are used. */
  providers?: string[];
  /** Named provider group. Takes precedence over `providers` when both are set. */
  group?: string;
  limit?: number;
  perProviderLimit?: number;
  language?: string;
  freshness?: Freshness;
  mode?: SearchMode;
  rerank?: boolean;
  embedding?: boolean;
  summarize?: boolean;
  timeoutMs?: number;
  includeRaw?: boolean;
  /** Optional model config id used for rerank / embedding / summarization. */
  rerankModelId?: string;
  embeddingModelId?: string;
  chatModelId?: string;
}

export interface ResultSource {
  providerId: string;
  providerName: string;
  providerType: string;
  rank: number;
  score?: number;
  url: string;
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
  metadata?: Record<string, unknown>;
  sources: ResultSource[];
  raw?: unknown;
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
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  attempts: number;
}

export interface SearchErrorSummary {
  providerId: string;
  providerName: string;
  code: ProviderErrorCode;
  message: string;
}

/** Reason a provider could not be used, surfaced alongside partial results. */
export interface FailedSource {
  id: string;
  code: ProviderErrorCode;
}

export interface SearchTiming {
  totalMs: number;
  fanoutMs: number;
  fusionMs: number;
  rerankMs?: number;
  embeddingMs?: number;
  summaryMs?: number;
}

export interface SearchSummary {
  text: string;
  modelId?: string;
  citations: Array<{ index: number; title: string; url: string }>;
  degraded?: boolean;
}

export interface SearchResponse {
  taskId: string;
  query: string;
  mode: SearchMode;
  status: Exclude<SearchTaskStatus, "running">;
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
    cached?: boolean;
  };
  errors: SearchErrorSummary[];
  /** Compact view of failing providers, stable for client assertions. */
  failedSources: FailedSource[];
  summary?: SearchSummary;
  debug?: SearchDebugInfo;
}

export interface SearchDebugInfo {
  providerQueries?: Array<{ providerId: string; query: string }>;
  rewrittenQueries?: string[];
  droppedDuplicates?: Array<{ url: string; keptUrl: string; reason: "exact_url" | "near_title" }>;
  perProviderResults?: Array<{ providerId: string; providerName: string; results: SearchResult[] }>;
}

/** Provider runtime configuration after DB + credential resolution. */
export interface ProviderRuntimeConfig {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  timeoutMs: number;
  maxResults: number;
  language: string | null;
  freshness: Freshness | null;
  model: string | null;
  maxRetries: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  config: Record<string, unknown>;
}

export interface ProviderSearchInput {
  query: string;
  limit: number;
  language?: string;
  freshness?: Freshness;
  signal: AbortSignal;
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  score?: number;
  language?: string;
  raw?: unknown;
}

export interface ProviderSearchOutput {
  results: RawSearchResult[];
  requestUrl?: string;
  warnings?: string[];
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  resultCount?: number;
  message: string;
  sample?: Array<{ title: string; url: string }>;
}

export interface SafeFetchResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  url: string;
}

export type SafeFetch = <T = unknown>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; maxBytes?: number },
) => Promise<SafeFetchResponse<T>>;

export interface ProviderContext {
  fetch: SafeFetch;
  apiKey?: string;
  config: ProviderRuntimeConfig;
  signal: AbortSignal;
  logger: Logger;
}

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Plugin contract. Implementations live in packages/providers. */
export interface SearchProviderAdapter {
  readonly type: string;
  readonly requiresKey: boolean;
  readonly supportsTest: boolean;
  search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput>;
  test?(ctx: ProviderContext): Promise<ProviderTestResult>;
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
  /** Honest verification status. Never set this to verified without a recorded live test. */
  verification: "documented" | "live_tested" | "unverified" | "no_official_api";
  notes?: string;
}

export interface ProviderInstance {
  id: string;
  name: string;
  type: string;
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

export interface KeyLeaseInfo {
  providerId: string;
  keyId: string;
  keyLabel: string;
  acquiredAt: number;
}

export interface ProviderRuntimeSnapshot {
  providerId: string;
  providerName: string;
  providerType: string;
  enabled: boolean;
  healthy: boolean;
  circuitOpen: boolean;
  circuitOpenUntil: string | null;
  keys: Array<{
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
  }>;
}

export interface SearchGroup {
  id: string;
  name: string;
  description: string | null;
  providerIds: string[];
  createdAt: string;
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

export type ModelKind = "chat" | "embedding" | "rerank";
export type ModelProviderType =
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "cohere"
  | "jina"
  | "custom-http";

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
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  json?: boolean;
}

export interface ChatResult {
  text: string;
  modelId: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface EmbeddingResult {
  vectors: number[][];
  modelId: string;
  dimensions: number;
}

export interface RerankDocument {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
  index: number;
}

export interface RerankResponse {
  results: RerankResult[];
  modelId: string;
}

export interface DashboardRange {
  from: string;
  to: string;
}

export interface DashboardStats {
  range: DashboardRange;
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
