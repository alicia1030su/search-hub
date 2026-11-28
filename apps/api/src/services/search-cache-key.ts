import { createHash } from "node:crypto";

export type SearchCacheMode =
  | "basic"
  | "rrf"
  | "rerank"
  | "embedding"
  | "embedding_rerank"
  | "rerank_summary"
  | "deep"
  | "web"
  | "grounded"
  | "research";

export type SearchCacheStrategy = "auto" | "fast" | "balanced" | "quality" | "deep";

export interface SearchCacheRequest {
  query: string;
  mode?: SearchCacheMode;
  strategy?: SearchCacheStrategy;
  capability?: string | null;
  limit?: number;
  perProviderLimit?: number | null;
  timeoutMs?: number | null;
  language?: string | null;
  freshness?: string | null;
  rerank?: boolean;
  embedding?: boolean;
  summarize?: boolean;
}

export interface SearchCacheModelIdentity {
  fingerprint: string;
  stageVersion: string;
}

export interface SearchCacheProviderIdentity {
  id: string;
  capability: string;
  configFingerprint: string;
  credentialVersion: string;
}

export interface SearchCacheQueryPlanEntry {
  queryId: string;
  query: string;
  kind: "original" | "expanded" | "rewrite";
  round: number;
  weight: number;
}

export interface SearchCacheV2Input extends SearchCacheRequest {
  /** Effective request values after settings defaults and mode resolution. */
  effectiveMode: SearchCacheMode;
  effectiveStrategy?: SearchCacheStrategy;
  limit: number;
  perProviderLimit?: number | null;
  providers: readonly SearchCacheProviderIdentity[];
  engineVersion?: string;
  pipelineVersion?: string;
  routeVersion?: string;
  queryExpansion?: boolean;
  maxRounds?: number;
  maxSubqueries?: number;
  queryPlan?: readonly SearchCacheQueryPlanEntry[];
  models?: Partial<Record<"embedding" | "rerank" | "chat", SearchCacheModelIdentity>>;
  parked?: readonly string[];
}

export interface SearchCacheV1Input extends SearchCacheRequest {
  mode: SearchCacheMode;
  limit: number;
  providers: readonly string[];
  models: {
    rerank: string | null;
    embedding: string | null;
    chat: string | null;
  };
  parked?: readonly string[];
  rerank: boolean;
  embedding: boolean;
  summarize: boolean;
}

const DEFAULT_ENGINE_VERSION = "search-engine-v0.1.18";
const DEFAULT_PIPELINE_VERSION = "search-pipeline-v2";
const DEFAULT_ROUTE_VERSION = "search-route-v1";
const UNCHANGED_V1_MODES = new Set<SearchCacheMode>(["basic", "rrf"]);
const EQUIVALENT_PRESET_MODES = new Set<SearchCacheMode>(["web", "grounded", "research"]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with recursively sorted object keys; array order remains meaningful. */
export function canonicalSearchCacheJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalSearchCacheJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalSearchCacheJson(record[key])}`)
    .join(",")}}`;
}

/** Canonical JSON is hashed by CacheService.buildKey; query text is never persisted. */
export function buildSearchFingerprintV1(input: SearchCacheV1Input): Record<string, unknown> {
  return {
    v: 1,
    query: input.query,
    mode: input.mode,
    capability: input.capability ?? null,
    providers: [...input.providers].sort(),
    limit: input.limit,
    perProviderLimit: input.perProviderLimit ?? null,
    timeoutMs: input.timeoutMs ?? null,
    language: input.language ?? null,
    freshness: input.freshness ?? null,
    includeRaw: false,
    rerank: input.rerank,
    embedding: input.embedding,
    summarize: input.summarize,
    models: input.models,
    parked: [...(input.parked ?? [])].sort(),
  };
}

/**
 * Serialize-safe v2 identity. Query plaintext is only a hash input: neither the
 * request nor expanded queries appear in metadata. Query digests keep distinct
 * plans distinct without exposing search terms in diagnostics or stored keys.
 */
export function buildSearchFingerprintV2(input: SearchCacheV2Input): Record<string, unknown> {
  const queryPlan = [...(input.queryPlan ?? [])].sort((left, right) => {
    if (left.queryId !== right.queryId) return left.queryId < right.queryId ? -1 : 1;
    return left.query < right.query ? -1 : left.query > right.query ? 1 : 0;
  });
  return {
    cacheFormatVersion: 2,
    engineVersion: input.engineVersion ?? DEFAULT_ENGINE_VERSION,
    pipelineVersion: input.pipelineVersion ?? DEFAULT_PIPELINE_VERSION,
    routeVersion: input.routeVersion ?? DEFAULT_ROUTE_VERSION,
    queryDigest: sha256(input.query),
    effectiveMode: input.effectiveMode,
    effectiveStrategy: input.effectiveStrategy ?? null,
    requestedMode: input.mode ?? null,
    requestedStrategy: input.strategy ?? null,
    capability: input.capability ?? null,
    limit: input.limit,
    perProviderLimit: input.perProviderLimit ?? null,
    timeoutMs: input.timeoutMs ?? null,
    maxRounds: input.maxRounds ?? null,
    maxSubqueries: input.maxSubqueries ?? null,
    language: input.language ?? null,
    freshness: input.freshness ?? null,
    includeRaw: false,
    rerank: input.rerank ?? false,
    embedding: input.embedding ?? false,
    summarize: input.summarize ?? false,
    providers: [...input.providers]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .map((provider) => ({
        id: provider.id,
        capability: provider.capability,
        configFingerprint: provider.configFingerprint,
        credentialVersion: provider.credentialVersion,
      })),
    queryExpansion: {
      enabled: input.queryExpansion ?? false,
      maxSubqueries: input.maxSubqueries ?? null,
      actualQueryPlan: queryPlan.map((entry) => ({
        queryId: entry.queryId,
        queryDigest: sha256(entry.query),
        kind: entry.kind,
        round: entry.round,
        weight: entry.weight,
      })),
    },
    models: Object.fromEntries(
      Object.entries(input.models ?? {})
        .filter((entry): entry is [string, SearchCacheModelIdentity] => entry[1] !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([stage, model]) => [stage, {
          fingerprint: model.fingerprint,
          stageVersion: model.stageVersion,
        }]),
    ),
    parked: [...(input.parked ?? [])].sort(),
  };
}

/**
 * B6 compatibility gate. The caller must first look up the version-1 key rebuilt
 * from `legacyFingerprint`; this predicate never authorizes a v1 row by itself.
 */
export function canReadV1(
  request: SearchCacheV1Input & { strategy?: SearchCacheStrategy },
  legacyFingerprint: Record<string, unknown> | null | undefined,
): boolean {
  if (!legacyFingerprint || legacyFingerprint.v !== 1 || request.strategy !== undefined) return false;
  if (!Array.isArray(legacyFingerprint.providers) || !legacyFingerprint.providers.every((value) => typeof value === "string") ||
      !Array.isArray(legacyFingerprint.parked) || !legacyFingerprint.parked.every((value) => typeof value === "string") ||
      typeof legacyFingerprint.models !== "object" || legacyFingerprint.models === null) return false;
  const mode = request.mode ?? "basic";
  if (!UNCHANGED_V1_MODES.has(mode) && !EQUIVALENT_PRESET_MODES.has(mode)) return false;

  const rerank = request.rerank ?? false;
  const embedding = request.embedding ?? false;
  const summarize = request.summarize ?? false;
  // A preset is equivalent only when it selects a plain, non-model stage.
  if (mode === "web" && request.capability != null && request.capability !== "raw_search") return false;
  if (mode === "grounded" && request.capability != null && request.capability !== "grounded_answer") return false;
  if (rerank || embedding || summarize) return false;

  const legacyMode = legacyFingerprint.mode;
  const expectedCapability = mode === "web" ? "raw_search" : mode === "grounded" ? "grounded_answer" : request.capability ?? null;
  const legacyCapability = legacyFingerprint.capability ?? null;
  // Rebuilding a real v1 key must preserve its persisted preset mode. RRF is
  // an internal stage, not permission to cross-reuse web/grounded/research rows.
  const expectedMode = mode;
  if (legacyMode !== expectedMode || legacyCapability !== expectedCapability) return false;
  if (legacyFingerprint.rerank !== false || legacyFingerprint.embedding !== false || legacyFingerprint.summarize !== false) return false;
  const legacyModels = legacyFingerprint.models as SearchCacheV1Input["models"] | undefined;
  if (legacyModels?.rerank != null || legacyModels?.embedding != null || legacyModels?.chat != null) return false;

  // Rebuild the exact legacy identity from resolved effective inputs. The
  // request must contain the same effective recall/model/provider values.
  const expected = buildSearchFingerprintV1({
    query: request.query,
    mode: expectedMode,
    capability: expectedCapability,
    providers: request.providers,
    limit: request.limit,
    perProviderLimit: request.perProviderLimit,
    timeoutMs: request.timeoutMs,
    language: request.language,
    freshness: request.freshness,
    rerank,
    embedding,
    summarize,
    models: legacyModels ?? { rerank: null, embedding: null, chat: null },
    parked: request.parked,
  });
  return canonicalSearchCacheJson(expected) === canonicalSearchCacheJson(
    buildSearchFingerprintV1(legacyFingerprint as unknown as SearchCacheV1Input),
  );
}
