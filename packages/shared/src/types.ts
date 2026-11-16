/**
 * Search Hub shared contracts.
 * Every module (core, providers, models, api, mcp, web) must depend on these
 * types instead of re-declaring its own shapes.
 */

export const SEARCH_HUB_VERSION = "0.1.0";

export type ProviderCategory = "general" | "ai" | "vertical" | "compat" | "custom";
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
  /** Preset: raw_search providers only, plain web list. */
  | "web"
  /** Preset: grounded_answer providers only, answer + citations. */
  | "grounded"
  /** Preset: both families, kept separate in the response. */
  | "research"
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
  | "queue_timeout"
  | "circuit_open"
  | "unsupported"
  | "cancelled"
  | "unknown";

export interface SearchRequest {
  query: string;
  /** Provider instance ids. When omitted, all enabled providers are used. */
  providers?: string[];
  /** Named provider group. Takes precedence over `providers` when both are set. */
  group?: string;
  /**
   * Restricts the search to one capability. `raw_search` returns web pages,
   * `grounded_answer` returns AI answers with citations. Omit for both.
   */
  capability?: ProviderCapability;
  limit?: number;
  perProviderLimit?: number;
  language?: string;
  freshness?: Freshness;
  mode?: SearchMode;
  rerank?: boolean;
  embedding?: boolean;
  summarize?: boolean;
  timeoutMs?: number;
  /** Bypass the optional response cache. */
  skipCache?: boolean;
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
  /** Upstream attribution when this row arrived through a gateway. */
  upstream?: UpstreamAttribution;
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
  /** Upstream attribution when this row arrived through a gateway adapter. */
  upstream?: UpstreamAttribution;
  /** Vendor-assigned position, distinct from our own `score` and source rank. */
  upstreamRank?: number;
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
  /** Non-fatal upstream degradation, e.g. a legacy gateway reported "partial". */
  warning?: string;
  attempts: number;
}

export interface SearchErrorSummary {
  providerId: string;
  providerName: string;
  code: ProviderErrorCode;
  message: string;
  /**
   * Set by deep search: the rewritten query this failure belongs to. Without it
   * a caller cannot tell which sub-query produced the error.
   */
  query?: string;
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
  /** Time spent in SQLite writes (task insert + final task/event persist). */
  dbWriteMs?: number;
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
    /** True when an optional stage (rerank / embedding / summary) failed and was skipped. */
    degraded?: boolean;
    cached?: boolean;
  };
  errors: SearchErrorSummary[];
  /** AI answers with citations; kept separate from `results` on purpose. */
  answers?: GroundedAnswer[];
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
  /** Platform-level search parameters resolved for this call. */
  search?: ResolvedSearchConfig;
}

/** Search parameters after manifest clamping and admin locks are applied. */
export interface ResolvedSearchConfig {
  targetResults: number;
  maxPages: number;
  maxRequestsPerSearch: number;
  pageSize: number;
  region?: string;
  safeSearch?: "off" | "moderate" | "strict";
  searchDepth?: "fast" | "balanced" | "deep";
  includeDomains?: string[];
  excludeDomains?: string[];
  sort?: string;
}

export interface ProviderSearchInput {
  query: string;
  limit: number;
  language?: string;
  freshness?: Freshness;
  signal: AbortSignal;
}

/**
 * Attribution reported by an upstream gateway (for example a legacy Search Hub
 * instance). Every field is optional and is copied verbatim from the upstream
 * payload; the platform never derives a provider/source from a URL or domain.
 */
export interface UpstreamAttribution {
  /** Upstream provider id/type as reported by the gateway (e.g. "brave"). */
  provider?: string;
  /** Upstream display name, when the gateway reports one separately. */
  providerName?: string;
  /** Upstream `source` string, when present. */
  source?: string;
  /** Upstream source list, flattened to strings. */
  sources?: string[];
}

/** How a provider produces results. */
export type ProviderCapability = "raw_search" | "grounded_answer";

/** One citation attached to a grounded answer. URL is always provider-supplied. */
export interface GroundedCitation {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  /** 1-based index the vendor uses in its own answer text, when it reports one. */
  providerIndex?: number;
}

/**
 * Five separate facts about one grounded answer. They are deliberately not
 * collapsed into a single `toolInvoked` boolean: "the tool was offered", "the
 * model called it", "the call returned content", "the sources are verifiable"
 * and "the answer is actually supported by those sources" are different claims,
 * and each can be legitimately unknown.
 *
 * `unknown` must be used when the vendor response does not carry enough
 * evidence. Guessing true/false would fabricate a verification state.
 */
export interface GroundedStatus {
  /** The request included a search tool. For these adapters this is always true. */
  toolProvided: boolean;
  /** The model actually emitted a search tool call. */
  toolInvoked: boolean | "unknown";
  /** The tool call returned usable content (chunks / results / sources). */
  retrievalSucceeded: boolean | "unknown";
  /** At least one citation with a real http(s) URL exists. */
  hasVerifiableSources: boolean | "unknown";
  /** The answer text is linked to those sources by the vendor's own mapping. */
  answerSupported: boolean | "unknown";
}

/**
 * Display metadata a vendor requires us to render (Google Search Suggestions).
 * We never forward vendor HTML: `suggestions` is parsed into plain data and the
 * UI renders its own elements, so no foreign markup can reach the admin page.
 */
export interface GroundedDisplay {
  /** Human-readable suggestion chips extracted from searchEntryPoint. */
  suggestions: Array<{ label: string; url: string }>;
  /** Plain text of the vendor's rendered widget, for operators comparing with docs. */
  textFallback?: string;
  /** True when the vendor sent HTML that we deliberately did not forward. */
  vendorHtmlWithheld?: boolean;
}

/** A supported text segment: which characters of the answer cite which chunk. */
export interface GroundedSupport {
  startIndex: number;
  endIndex: number;
  chunkIndices: number[];
}

/**
 * An AI-generated answer with verifiable citations. `toolInvoked=false` means
 * the model answered without calling its search tool; callers must not present
 * that as a search result.
 */
export interface GroundedAnswer {
  text: string;
  citations: GroundedCitation[];
  status: GroundedStatus;
  model?: string;
  provider: string;
  /** Queries the model actually ran, when the vendor reports them. */
  searchQueries?: string[];
  /** Character-to-chunk mapping, when the vendor reports it. */
  supports?: GroundedSupport[];
  /** Vendor-mandated display data (plain data only, never HTML). */
  display?: GroundedDisplay;
  /** Latency of the single vendor call, milliseconds. */
  latencyMs?: number;
  /** True when the provider answered without any search call. */
  degraded?: boolean;
}

export interface RawSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  score?: number;
  language?: string;
  /** Set only by gateway adapters that can see upstream attribution. */
  upstream?: UpstreamAttribution;
  /**
   * Position the vendor assigned to this row. Kept separate from `upstream`
   * because a rank is not a source; it must never be shown as a provider name.
   */
  upstreamRank?: number;
  raw?: unknown;
}

export interface ProviderSearchOutput {
  results: RawSearchResult[];
  requestUrl?: string;
  warnings?: string[];
  /** Present only for `grounded_answer` providers that actually invoked search. */
  answer?: GroundedAnswer;
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
  readonly capability?: ProviderCapability;
  search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput>;
  test?(ctx: ProviderContext): Promise<ProviderTestResult>;
}

export type CatalogFieldType = "text" | "password" | "number" | "select" | "boolean" | "textarea";

/** Declarative field rendered by the web provider form. */
export interface ProviderCatalogField {
  key: string;
  label: string;
  type: CatalogFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  /** Where the value is stored. `credential` fields are joined into the key value. */
  target?: "config" | "baseUrl" | "credential" | "model";
  default?: string | number | boolean;
  min?: number;
  max?: number;
}

/**
 * Search parameters a provider can accept. The key names are platform-level; each
 * manifest maps them to the vendor's own field names. Sending a platform key that
 * a provider does not support is an error at the boundary, not a silent no-op.
 */
export type SearchParameterKey =
  | "targetResults"
  | "maxPages"
  | "maxRequestsPerSearch"
  | "language"
  | "region"
  | "freshness"
  | "safeSearch"
  | "searchDepth"
  | "includeDomains"
  | "excludeDomains"
  | "sort";

export interface ParameterLimit {
  min?: number;
  max?: number;
  default?: number | string | boolean;
  /** Vendor's per-request page size, when pagination is supported. */
  pageSize?: number;
  step?: number;
}

export type PaginationMode = "none" | "offset" | "page" | "cursor" | "limit";

export interface PaginationCapability {
  supported: boolean;
  mode: PaginationMode;
  /** Rows per request at the vendor. */
  pageSize?: number;
  /** Hard cap on pages the vendor allows (offset 0-9 means 10 pages). */
  maxPages?: number;
  /** Absolute cap on rows one search can produce. */
  maxResults?: number;
}

export type AccountQuotaScope = "none" | "account" | "key";

export interface AccountQuotaCapability {
  /** Whether the vendor bills/limits per account rather than per key. */
  scope: AccountQuotaScope;
  /** True when several keys of one account share one vendor budget. */
  sharedAcrossKeys: boolean;
  note?: string;
}

export interface ResultMappingSpec {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: string;
}

/**
 * Declarative description of one provider. The web UI renders its configuration
 * form from this document instead of hand-writing a form per vendor, and the
 * server validates requests against it.
 *
 * A manifest is data only: it cannot carry code, shell commands or URLs to
 * execute. Anything that needs behaviour still lives in a typed adapter.
 */
export interface ProviderManifest {
  manifestVersion: 1;
  providerId: string;
  displayName: string;
  description: string;
  category: ProviderCategory;
  capability: ProviderCapability;
  version: string;
  auth: {
    type: ProviderAuthType;
    credentialKind: "single" | "pair";
    required: boolean;
    fields: ProviderCatalogField[];
  };
  configuration: {
    defaultEndpoint?: string;
    endpointEditable: boolean;
    fields: ProviderCatalogField[];
  };
  parameters: {
    supported: SearchParameterKey[];
    limits: Partial<Record<SearchParameterKey, ParameterLimit>>;
  };
  pagination: PaginationCapability;
  accountQuota: AccountQuotaCapability;
  resultMapping: ResultMappingSpec;
  documentationUrl?: string;
  /** Honest verification status; mirrors `ProviderCatalogEntry.verification`. */
  verificationStatus: "documented" | "live_tested" | "unverified" | "no_official_api" | "mock_verified";
  implementationStatus: ProviderImplementation;
}

export interface ProviderCatalogEntry {
  type: string;
  name: string;
  category: ProviderCategory;
  /** Defaults to `raw_search` when omitted. */
  capability?: ProviderCapability;
  /** `pair` means two secrets (e.g. SecretId + SecretKey) stored as one credential. */
  credentialKind?: "single" | "pair";
  /** Declarative web-form fields; empty/omitted means the generic fields only. */
  fields?: ProviderCatalogField[];
  /** Platform-level search parameters this provider can honour. */
  parameters?: SearchParameterKey[];
  /** Per-parameter vendor limits, used by the UI and by request validation. */
  parameterLimits?: Partial<Record<SearchParameterKey, ParameterLimit>>;
  /** How many rows one request can return and whether we may page. */
  pagination?: PaginationCapability;
  /** Whether the vendor limits per account or per key. */
  accountQuota?: AccountQuotaCapability;
  /** Where each result field comes from in the vendor payload. */
  resultMapping?: ResultMappingSpec;
  /** Set when the vendor has shut the service down. */
  deprecated?: boolean;
  authType: ProviderAuthType;
  implementation: ProviderImplementation;
  defaultBaseUrl?: string;
  docsUrl?: string;
  description: string;
  /** Honest verification status. Never set this to verified without a recorded live test. */
  /**
   * `mock_verified` means "contract-tested against a local double only" — it
   * must never be reported as a real vendor integration.
   */
  verification: "documented" | "live_tested" | "mock_verified" | "unverified" | "no_official_api";
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
  /**
   * Shared vendor account this provider draws its quota from. Multiple keys of
   * the same account must use the same group, otherwise N keys look like N
   * accounts and the vendor's account-level limit is exceeded.
   */
  /** Platform-level search parameters stored for this instance. */
  searchConfig: Record<string, unknown>;
  accountGroup: string | null;
  /** Requests/minute for the whole account group. 0 disables the group limit. */
  accountRpmLimit: number;
  /** Requests/day for the whole account group. null disables it. */
  accountDailyQuota: number | null;
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
  /** Account-group budget usage, when this provider belongs to a group. */
  account?: {
    group: string;
    rpmUsed: number;
    rpmLimit: number;
    quotaUsedToday: number;
    dailyQuota: number | null;
    lastDeniedAt: string | null;
  } | null;
  keys: Array<{
    id: string;
    label: string;
    status: KeyStatus;
    inFlight: number;
    peakInFlight: number;
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
    /**
     * Share of *finished, non-cancelled* searches that completed. A user cancel
     * is not a failure, so it is excluded from the denominator instead of
     * dragging the rate down.
     */
    successRate: number;
    /** Finished searches that returned results with some upstream failure. */
    partial: number;
    failed: number;
    cancelled: number;
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
