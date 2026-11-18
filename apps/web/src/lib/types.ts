/**
 * Wire types for the Search Hub REST API.
 * These mirror the shared contract; the web app keeps its own copy so the
 * browser build never imports server-side modules.
 */

export type ProviderCategory = "general" | "ai" | "vertical" | "compat" | "custom";
export type ProviderAuthType = "none" | "api_key" | "bearer" | "basic";
export type ProviderImplementation = "builtin" | "generic" | "planned" | "unavailable";
export type ProviderVerification =
  | "documented"
  | "live_tested"
  | "mock_verified"
  | "unverified"
  | "no_official_api";
export type ProviderType = string;

export type KeyStrategy = "round_robin" | "random" | "weighted_random" | "least_used" | "failover";
export type KeyStatus = "healthy" | "rate_limited" | "cooldown" | "invalid" | "disabled" | "unknown";
export type Freshness = "day" | "week" | "month" | "year" | "all";
export type SearchMode =
  | "web"
  | "grounded"
  | "research"
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
  /** Platform-level search parameters stored for this instance. */
  searchConfig: Record<string, unknown>;
  accountGroup: string | null;
  accountRpmLimit: number;
  accountDailyQuota: number | null;
  /** Enabled AND has a usable credential when the provider needs one. */
  ready: boolean;
  notReadyReason: string | null;
}

export type ProviderCapability = "raw_search" | "grounded_answer";
export type CatalogFieldType = "text" | "password" | "number" | "select" | "boolean" | "textarea";

export interface ProviderCatalogField {
  key: string;
  label: string;
  type: CatalogFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  target?: "config" | "baseUrl" | "credential" | "model";
  default?: string | number | boolean;
  min?: number;
  max?: number;
}

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
    supported: string[];
    limits: Record<string, { min?: number; max?: number; default?: string | number | boolean; pageSize?: number }>;
  };
  pagination: { supported: boolean; mode: string; pageSize?: number; maxPages?: number; maxResults?: number };
  accountQuota: { scope: "none" | "account" | "key"; sharedAcrossKeys: boolean; note?: string };
  resultMapping: { title: string; url: string; snippet: string; publishedAt?: string; score?: string };
  documentationUrl?: string;
  verificationStatus: ProviderVerification;
  implementationStatus: ProviderImplementation;
}

export interface ProviderCatalogEntry {
  type: string;
  name: string;
  category: ProviderCategory;
  capability?: ProviderCapability;
  credentialKind?: "single" | "pair";
  fields?: ProviderCatalogField[];
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
  /** Declarative capability documents; the UI renders forms from these. */
  manifests?: ProviderManifest[];
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
  /** Platform-level search parameters, validated against the provider manifest. */
  searchConfig?: Record<string, unknown>;
  /** Only accepted on create; the server writes provider + key atomically. */
  credential?: {
    label: string;
    key: string;
    weight: number;
    enabled: boolean;
  };
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

export type GroundedSignal = boolean | "unknown";

export interface GroundedStatus {
  toolProvided: boolean;
  toolInvoked: GroundedSignal;
  retrievalSucceeded: GroundedSignal;
  hasVerifiableSources: GroundedSignal;
  answerSupported: GroundedSignal;
}

export interface GroundedDisplay {
  suggestions: Array<{ label: string; url: string }>;
  textFallback?: string;
  vendorHtmlWithheld?: boolean;
}

export interface GroundedSupport {
  startIndex: number;
  endIndex: number;
  chunkIndices: number[];
}

export interface GroundedAnswer {
  text: string;
  citations: Array<{
    title: string;
    url: string;
    snippet?: string;
    publishedAt?: string;
    providerIndex?: number;
  }>;
  status: GroundedStatus;
  model?: string;
  provider: string;
  searchQueries?: string[];
  supports?: GroundedSupport[];
  display?: GroundedDisplay;
  latencyMs?: number;
  degraded?: boolean;
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
  upstreamRank?: number;
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
  answers?: GroundedAnswer[];
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
    partial?: number;
    failed?: number;
    cancelled?: number;
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

/** Live cache usage, counters and capacity (GET /api/admin/cache). */
export interface CacheStats {
  enabled: boolean;
  ttlSeconds: number;
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  /** null when nothing has been looked up — never a fabricated 0. */
  hitRate: number | null;
  hits24h: number;
  misses24h: number;
  hitRate24h: number | null;
  expiredRemoved: number;
  evicted: number;
  lastSweepAt: string | null;
  windowHours: number;
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

// ---- v0.1.5: provider health ----

export type HealthStatusValue = "healthy" | "degraded" | "unhealthy" | "unverified";
export type HealthProbeKindValue = "connect" | "search";

/**
 * Runtime health as an operator reads it. Distinct from the implementation
 * verification below: a provider can be `documented` (never live-tested) and
 * `healthy` at the same time, and neither implies the other.
 */
export type RuntimeHealthValue =
  | "unknown"
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "rate_limited"
  | "quota_exceeded"
  | "invalid_credentials"
  | "permission_denied"
  | "cooldown"
  | "unverified"
  | "disabled";

export type VerificationValue =
  | "documented"
  | "live_tested"
  | "mock_verified"
  | "unverified"
  | "no_official_api";

export interface ProviderHealthPolicy {
  scheduledEnabled: boolean;
  intervalMinutes: number;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  paidProbesEnabled: boolean;
  includeUnverified: boolean;
  concurrency: number;
}

export interface HealthCheckResult {
  id: string;
  providerId: string;
  providerName: string;
  providerType: string;
  keyId: string | null;
  kind: HealthProbeKindValue;
  status: HealthStatusValue;
  cause: string;
  errorCode: string | null;
  latencyMs: number | null;
  resultCount: number | null;
  healthScore: number;
  message: string;
  checkedAt: string;
  trigger: string;
  cooldownUntil: string | null;
}

export interface ProviderHealthRow {
  providerId: string;
  providerName: string;
  providerType: string;
  enabled: boolean;
  status: HealthStatusValue;
  healthScore: number;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  searchCalls: number;
  keyAvailable: number;
  keyTotal: number;
  runtime: RuntimeHealthValue;
  implementation: {
    verification: VerificationValue;
    implementation: "builtin" | "generic" | "planned" | "unavailable";
    docsUrl: string | null;
  };
  autoProbeEnabled: boolean;
  nextProbeAt: string | null;
  probeMode: HealthProbeKindValue;
  lastProbe: {
    kind: HealthProbeKindValue;
    status: HealthStatusValue;
    checkedAt: string;
    errorCode: string | null;
    resultCount: number | null;
  } | null;
  trend: Array<{ bucket: string; healthy: number; degraded: number; unhealthy: number }>;
}

export interface HealthOverview {
  generatedAt: string;
  providers: ProviderHealthRow[];
  totals: Record<HealthStatusValue, number>;
  runtimeTotals: Record<RuntimeHealthValue, number>;
  budget: {
    day: string;
    maxPerRun: number;
    maxPerDay: number;
    usedToday: number;
    connectUsedToday: number;
    /** Real searches against keyless sources: counted, never called free. */
    anonymousSearchUsedToday: number;
    remainingToday: number;
    paidProbesEnabled: boolean;
    scheduledEnabled: boolean;
    intervalMinutes: number;
  };
}

export interface McpStatus {
  sdkLatest: string;
  sdkSupported: string[];
  serverVersion: string;
  sdkVersion: string;
  transports: { http: string; stdio: string };
  toolCount: number;
  revision2026Supported: boolean;
  notes: string[];
}

export interface McpUpdateCheck {
  checkedAt: string;
  source: string;
  sdk: { installed: string; latest: string | null; updateAvailable: boolean | null; error: string | null; releaseNotesUrl: string };
  protocol: { current: string; latestDeclared: string | null; revision2026Supported: boolean };
  application: { currentVersion: string; latestTag: string | null; updateAvailable: boolean | null; error: string | null; releaseUrl: string };
  kinds: Array<{ kind: "protocol" | "sdk" | "application"; action: string; requiresRestart: boolean }>;
}

export interface SkillSummary {
  name: string;
  directory: string;
  valid: boolean;
  issues: Array<{ level: "error" | "warning"; field: string; message: string }>;
  metadata: { name: string | null; description: string | null; license: string | null; version: string | null };
  files: Array<{ path: string; bytes: number }>;
  references: string[];
  installPath?: string;
  builtin?: boolean;
}

export interface UpdateStatusResponse {
  currentVersion: string;
  deployment: "standalone" | "docker";
  latest: { tag: string; version: string; publishedAt: string; notesUrl: string; prerelease: boolean } | null;
  updateAvailable: boolean | null;
  matchingAsset: string | null;
  error: string | null;
  checkedAt: string;
  pending: { version: string; assetName: string; stagedAt: string } | null;
}

// ---------------------------------------------------------------- quality lab

export type QualityCategory =
  | "general"
  | "chinese"
  | "english"
  | "code"
  | "academic"
  | "news"
  | "documentation"
  | "factual"
  | "multi_hop";

export type QualityFusionStrategy = "single" | "base" | "rrf";

export interface QualityFusion {
  strategy: QualityFusionStrategy;
  k?: number;
  providerId?: string;
  providerWeights?: Record<string, number>;
}

export interface QualityDatasetSummary {
  id: string;
  name: string;
  description: string;
  language: string;
  version: number;
  status: "draft" | "frozen";
  origin: "manual" | "imported" | "synthetic_fixture";
  judgmentsComplete: boolean;
  createdAt: string;
  updatedAt: string;
  frozenAt: string | null;
  queryCount: number;
  judgmentCount: number;
}

export interface QualityQueryRow {
  id: string;
  datasetId: string;
  query: string;
  category: QualityCategory;
  language: string;
  intent: string;
  notes: string;
  createdAt: string;
}

export interface QualityJudgmentRow {
  id: string;
  datasetId: string;
  queryId: string;
  documentId: string;
  relevance: 0 | 1 | 2 | 3;
  assessor: string;
  source: "human" | "machine_generated" | "synthetic_fixture";
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface QualityDatasetDetail {
  dataset: QualityDatasetSummary;
  queries: QualityQueryRow[];
  judgments: QualityJudgmentRow[];
  coverage: { judgedDocuments: number; judgedQueries: number; queryCount: number; unjudgedQueries: number };
}

export interface QualityMetricValue {
  value: number | null;
  status: "ok" | "na";
  reason?: string;
  sampleSize: number;
  provisionalCount: number;
  lowSample: boolean;
}

export interface QualityQueryMetrics {
  queryId: string;
  judgedCount: number;
  unjudgedCount: number;
  returnedCount: number;
  provisional: boolean;
  precisionAtK: QualityMetricValue;
  recallAtK: QualityMetricValue;
  mrrAtK: QualityMetricValue;
  ndcgAtK: QualityMetricValue;
}

export interface QualityRunSummary {
  id: string;
  datasetId: string;
  datasetVersion: number;
  datasetOrigin: "manual" | "imported" | "synthetic_fixture";
  name: string;
  mode: "offline" | "live";
  fusion: QualityFusion;
  status: "running" | "completed" | "failed" | "cancelled";
  limit: number;
  /** Metric cutoff the stored numbers were measured at. */
  cutoff: number;
  queryCount: number;
  requestsUsed: number;
  requestBudget: number;
  codeCommit: string | null;
  engineVersion: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface QualityRunDetail {
  run: QualityRunSummary;
  metrics: Record<string, QualityMetricValue>;
  latency: {
    count: number;
    p50: number | null;
    p95: number | null;
    mean: number | null;
    min: number | null;
    max: number | null;
    lowSample: boolean;
  };
  cost: {
    /** Physical upstream HTTP requests. */
    requests: number;
    /** Searches the caller asked for. */
    logicalSearches: number;
    /** Adapter invocations, retries included. */
    adapterAttempts: number;
    /** Same number as `requests`, under its real name. */
    httpRequests: number;
    /** `null` when no vendor billing rule is known — never 0. */
    billableUnits: number | null;
    cacheHits: number;
    knownCost: number | null;
    estimatedCost: number | null;
    unknownCost: boolean;
  };
  quality: Record<string, QualityMetricValue>;
  perQuery: Array<{
    queryId: string;
    query: string;
    status: string;
    ranked: Array<{ documentId: string; title: string; url: string }>;
    metrics: QualityQueryMetrics;
    latencyMs: number | null;
  }>;
}

export interface QualityComparisonRow {
  queryId: string;
  query: string;
  category: QualityCategory;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  verdict: "improved" | "degraded" | "unchanged" | "not_comparable";
}

export interface QualityComparison {
  metric: "precisionAtK" | "recallAtK" | "mrrAtK" | "ndcgAtK";
  baseline: QualityMetricValue;
  candidate: QualityMetricValue;
  absoluteDelta: number | null;
  relativeDelta: number | null;
  improved: QualityComparisonRow[];
  degraded: QualityComparisonRow[];
  comparableQueries: number;
  verdict: "candidate_better" | "baseline_better" | "no_difference" | "insufficient_evidence";
  reason?: string;
  datasetId: string;
  datasetVersion: number;
}

export interface QualitySweepResult {
  split: { development: number; holdout: number };
  candidates: Array<{ k: number; development: Record<string, QualityMetricValue>; holdout: Record<string, QualityMetricValue> }>;
  chosen: number | null;
  holdoutVerdict: string | null;
  comparison: QualityComparison | null;
  evidence: "sufficient" | "INSUFFICIENT_EVIDENCE";
  reason?: string;
}
