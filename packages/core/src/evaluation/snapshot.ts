import { createHash } from "node:crypto";
import type { SearchQueryOrigin } from "@search-hub/shared";
import type { ProviderSnapshot, QuerySnapshot } from "./types.js";

export const EVALUATION_SCHEMA_VERSION = 2 as const;

export type ModelStage = "embedding" | "rerank" | "chat";

/** Non-secret model identity. Scores are optional frozen replay evidence, never live output. */
export interface FrozenModelArtifact {
  modelId: string;
  configFingerprint: string;
  stageVersion: string;
  scores?: Record<string, number>;
}

export type ModelArtifacts = Partial<Record<ModelStage, FrozenModelArtifact>>;

export interface DeepQuerySnapshot extends QuerySnapshot {
  queryIndex: number;
  kind: "original" | "expanded" | "rewrite";
  weight: number;
  round: number;
  providerQueryCalls: number;
  httpRequests: number;
  modelCalls: number;
  budgetExhausted: boolean;
}

/** B8: immutable input envelope. Provider rows are capture-time evidence, never fetched here. */
export interface EvaluationSnapshot extends QuerySnapshot {
  schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
  language: string;
  providerFingerprints: Record<string, string>;
  modelArtifacts: ModelArtifacts;
  deepRounds: readonly DeepQuerySnapshot[];
  route?: { version: string; providerWeights: Record<string, number> };
}

/** Machine-readable structural schema used by Lab/CLI import boundaries. */
export const evaluationSnapshotSchema = {
  type: "object",
  required: ["schemaVersion", "queryId", "query", "category", "capturedAt", "providers", "upstreamRequests", "cacheHits"],
  properties: {
    schemaVersion: { const: EVALUATION_SCHEMA_VERSION },
    queryId: { type: "string", minLength: 1 },
    query: { type: "string", minLength: 1 },
    category: { type: "string", minLength: 1 },
    language: { type: "string" },
    capturedAt: { type: "string" },
    upstreamRequests: { type: "integer", minimum: 0 },
    cacheHits: { type: "integer", minimum: 0 },
    providerFingerprints: { type: "object", additionalProperties: { type: "string" } },
    modelArtifacts: { type: "object" },
    deepRounds: { type: "array" },
    providers: { type: "array" },
  },
  additionalProperties: true,
} as const;

const SECRET_KEY = /(?:api[-_]?key|token|secret|password|authorization|cookie|credential|private[-_]?key)/i;
const SECRET_QUERY_KEY = /(?:api[-_]?key|token|secret|password|authorization|cookie|credential|signature|sig|key)/i;

function sanitizeValue(value: unknown, key: string): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, ""));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([childKey, child]) => [childKey, sanitizeValue(child, childKey)]),
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      for (const queryKey of url.searchParams.keys()) {
        if (SECRET_QUERY_KEY.test(queryKey)) url.searchParams.set(queryKey, "[redacted]");
      }
      return url.href;
    } catch {
      return value;
    }
  }
  return value;
}

/** Canonical JSON: recursively sorted object keys, arrays keep order, secrets removed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sanitizeValue(value, ""));
}

export function fingerprintSnapshot(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export const snapshotFingerprint = fingerprintSnapshot;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseProviders(value: unknown): ProviderSnapshot[] {
  if (!Array.isArray(value)) throw new TypeError("snapshot.providers must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.results)) {
      throw new TypeError(`snapshot.providers[${index}] is invalid`);
    }
    const results = entry.results.map((result, resultIndex) => {
      if (!isRecord(result)) throw new TypeError(`snapshot.providers[${index}].results[${resultIndex}] is invalid`);
      return {
        documentId: requireString(result.documentId, "documentId"),
        title: requireString(result.title, "title"),
        url: requireString(result.url, "url"),
        snippet: typeof result.snippet === "string" ? result.snippet : "",
        rank: nonNegativeInteger(result.rank, "rank"),
        ...(typeof result.score === "number" && Number.isFinite(result.score) ? { score: result.score } : {}),
      };
    });
    return {
      providerId: requireString(entry.providerId, "providerId"),
      providerName: typeof entry.providerName === "string" ? entry.providerName : requireString(entry.providerId, "providerId"),
      providerType: typeof entry.providerType === "string" ? entry.providerType : "unknown",
      results,
      ok: entry.ok !== false,
      ...(typeof entry.errorCode === "string" ? { errorCode: entry.errorCode } : {}),
      ...(typeof entry.latencyMs === "number" && Number.isFinite(entry.latencyMs) ? { latencyMs: entry.latencyMs } : {}),
    };
  });
}

function parseDeepRounds(value: unknown): DeepQuerySnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("snapshot.deepRounds must be an array");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`snapshot.deepRounds[${index}] is invalid`);
    const kind = entry.kind;
    if (kind !== "original" && kind !== "expanded" && kind !== "rewrite") {
      throw new TypeError("deep query kind must be original, expanded or rewrite");
    }
    return {
      ...parseEnvelope(entry),
      queryIndex: nonNegativeInteger(entry.queryIndex, "queryIndex"),
      kind,
      weight: typeof entry.weight === "number" && Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0.8,
      round: nonNegativeInteger(entry.round, "round"),
      providerQueryCalls: nonNegativeInteger(entry.providerQueryCalls, "providerQueryCalls"),
      httpRequests: nonNegativeInteger(entry.httpRequests, "httpRequests"),
      modelCalls: nonNegativeInteger(entry.modelCalls, "modelCalls"),
      budgetExhausted: entry.budgetExhausted === true,
    };
  });
}

function parseModelArtifacts(value: unknown): ModelArtifacts {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError("snapshot.modelArtifacts must be an object");
  const artifacts: ModelArtifacts = {};
  for (const stage of ["embedding", "rerank", "chat"] as const) {
    const artifact = value[stage];
    if (artifact === undefined) continue;
    if (!isRecord(artifact) || typeof artifact.modelId !== "string" ||
        typeof artifact.configFingerprint !== "string" || typeof artifact.stageVersion !== "string") {
      throw new TypeError(`snapshot.modelArtifacts.${stage} is invalid`);
    }
    artifacts[stage] = {
      modelId: artifact.modelId,
      configFingerprint: artifact.configFingerprint,
      stageVersion: artifact.stageVersion,
      ...(isRecord(artifact.scores) ? {
        scores: Object.fromEntries(
          Object.entries(artifact.scores).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
        ),
      } : {}),
    };
  }
  return artifacts;
}

function parseEnvelope(value: unknown): EvaluationSnapshot {
  if (!isRecord(value)) throw new TypeError("snapshot must be an object");
  if (value.schemaVersion !== EVALUATION_SCHEMA_VERSION) throw new TypeError("snapshot.schemaVersion must be 2");
  const providers = parseProviders(value.providers);
  return {
    schemaVersion: 2,
    queryId: requireString(value.queryId, "queryId"),
    query: requireString(value.query, "query"),
    category: requireString(value.category, "category") as QuerySnapshot["category"],
    language: typeof value.language === "string" && value.language ? value.language : "und",
    capturedAt: requireString(value.capturedAt, "capturedAt"),
    upstreamRequests: nonNegativeInteger(value.upstreamRequests, "upstreamRequests"),
    cacheHits: nonNegativeInteger(value.cacheHits, "cacheHits"),
    providers,
    providerFingerprints: isRecord(value.providerFingerprints) && Object.keys(value.providerFingerprints).length > 0
      ? Object.fromEntries(Object.entries(value.providerFingerprints).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : Object.fromEntries(providers.map((provider) => [provider.providerId, fingerprintSnapshot(provider)])),
    modelArtifacts: parseModelArtifacts(value.modelArtifacts),
    deepRounds: parseDeepRounds(value.deepRounds),
    ...(isRecord(value.route) && typeof value.route.version === "string" && isRecord(value.route.providerWeights) ? {
      route: {
        version: value.route.version,
        providerWeights: Object.fromEntries(
          Object.entries(value.route.providerWeights).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
        ),
      },
    } : {}),
  };
}

/**
 * Deserializes a v2 envelope. A legacy ProviderSnapshot[] or QuerySnapshot is
 * accepted as v1 evidence and upgraded in memory; original data is never rewritten.
 */
export function deserializeSnapshot(input: string | unknown): EvaluationSnapshot {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (Array.isArray(value)) {
    return parseEnvelope({
      schemaVersion: 2,
      queryId: "legacy-v1",
      query: "[legacy provider snapshot]",
      category: "general",
      language: "und",
      capturedAt: "1970-01-01T00:00:00.000Z",
      upstreamRequests: 0,
      cacheHits: 0,
      providers: value,
      providerFingerprints: {},
      modelArtifacts: {},
      deepRounds: [],
    });
  }
  if (isRecord(value) && value.schemaVersion === undefined) {
    return parseEnvelope({
      ...value,
      schemaVersion: 2,
      language: value.language ?? "und",
      providerFingerprints: value.providerFingerprints ?? {},
      modelArtifacts: value.modelArtifacts ?? {},
      deepRounds: value.deepRounds ?? [],
    });
  }
  return parseEnvelope(value);
}

export const parseEvaluationSnapshot = deserializeSnapshot;

export function serializeSnapshot(snapshot: EvaluationSnapshot | QuerySnapshot | readonly ProviderSnapshot[]): string {
  return canonicalJson(deserializeSnapshot(snapshot));
}

export interface RankedDeepDocument {
  documentId: string;
  url: string;
  title: string;
  deepScore: number;
  queriesContaining: number;
  bestRank: number;
  sourcesCount: number;
  queryOrigins: SearchQueryOrigin[];
}
