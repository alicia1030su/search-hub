import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSearchFingerprintV1,
  buildSearchFingerprintV2,
  canonicalSearchCacheJson,
  canReadV1,
  type SearchCacheV1Input,
  type SearchCacheV2Input,
} from "../../apps/api/src/services/search-cache-key.js";

function key(input: unknown): string {
  return createHash("sha256").update(canonicalSearchCacheJson(input)).digest("hex");
}

function legacy(overrides: Partial<SearchCacheV1Input> = {}): SearchCacheV1Input {
  return {
    query: "private query",
    mode: "basic",
    capability: null,
    providers: ["provider-a|config-a|credential-a"],
    limit: 10,
    perProviderLimit: null,
    timeoutMs: null,
    language: null,
    freshness: null,
    rerank: false,
    embedding: false,
    summarize: false,
    models: { rerank: null, embedding: null, chat: null },
    parked: [],
    ...overrides,
  };
}

function v2(overrides: Partial<SearchCacheV2Input> = {}): SearchCacheV2Input {
  return {
    query: "private query",
    effectiveMode: "basic",
    limit: 10,
    providers: [{
      id: "provider-a",
      capability: "raw_search",
      configFingerprint: "config-a",
      credentialVersion: "credential-a",
    }],
    ...overrides,
  };
}

describe("search cache fingerprint", () => {
  it("reproduces the exact legacy key shape and SHA-256", () => {
    const input = legacy({ parked: ["z", "a"], providers: ["b", "a"] });
    const fingerprint = buildSearchFingerprintV1(input);
    expect(fingerprint).toEqual({
      v: 1,
      query: "private query",
      mode: "basic",
      capability: null,
      providers: ["a", "b"],
      limit: 10,
      perProviderLimit: null,
      timeoutMs: null,
      language: null,
      freshness: null,
      includeRaw: false,
      rerank: false,
      embedding: false,
      summarize: false,
      models: { rerank: null, embedding: null, chat: null },
      parked: ["a", "z"],
    });
    expect(key(fingerprint)).toBe(key(buildSearchFingerprintV1(input)));
    expect(key(fingerprint)).toHaveLength(64);
  });

  it("uses distinct v1 and v2 keys for the same request", () => {
    const old = buildSearchFingerprintV1(legacy());
    expect(key(old)).not.toBe(key(buildSearchFingerprintV2(v2())));
    expect(buildSearchFingerprintV2(v2()).cacheFormatVersion).toBe(2);
  });

  it.each([
    ["query", { query: "different query" }],
    ["mode", { effectiveMode: "rrf" as const }],
    ["strategy", { effectiveStrategy: "balanced" as const }],
    ["limit", { limit: 11 }],
    ["perProviderLimit", { perProviderLimit: 13 }],
    ["providers", { providers: [] }],
    ["capability", { capability: "grounded_answer" }],
    ["language", { language: "en" }],
    ["freshness", { freshness: "week" }],
    ["engine", { engineVersion: "engine-next" }],
    ["pipeline", { pipelineVersion: "pipeline-next" }],
    ["route", { routeVersion: "route-next" }],
    ["expansion", { queryExpansion: true }],
    ["parked", { parked: ["provider-b"] }],
    ["credential", { providers: [{ id: "provider-a", capability: "raw_search", configFingerprint: "config-a", credentialVersion: "credential-b" }] }],
    ["provider config", { providers: [{ id: "provider-a", capability: "raw_search", configFingerprint: "config-b", credentialVersion: "credential-a" }] }],
    ["model", { models: { rerank: { fingerprint: "model-b", stageVersion: "rerank-v1" } } }],
    ["model stage", { models: { rerank: { fingerprint: "model-a", stageVersion: "rerank-v2" } } }],
    ["plan", { queryPlan: [{ queryId: "q2", query: "expanded query", kind: "expanded" as const, round: 1, weight: 0.8 }] }],
  ])("changes the v2 key when %s changes", (_name, overrides) => {
    expect(key(buildSearchFingerprintV2(v2()))).not.toBe(key(buildSearchFingerprintV2(v2(overrides))));
  });

  it("is canonical across object insertion order and provider order", () => {
    const first = v2({
      models: {
        chat: { fingerprint: "chat", stageVersion: "chat-v1" },
        rerank: { fingerprint: "rerank", stageVersion: "rerank-v1" },
      },
      providers: [
        { id: "b", capability: "raw_search", configFingerprint: "b", credentialVersion: "b" },
        { id: "a", capability: "raw_search", configFingerprint: "a", credentialVersion: "a" },
      ],
    });
    const second = v2({
      providers: [...first.providers].reverse(),
      models: {
        chat: { fingerprint: "chat", stageVersion: "chat-v1" },
        rerank: { fingerprint: "rerank", stageVersion: "rerank-v1" },
      },
    });
    expect(key(buildSearchFingerprintV2(first))).toBe(key(buildSearchFingerprintV2(second)));
    expect(canonicalSearchCacheJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("keeps queries and credential material out of serializable metadata", () => {
    const provider = {
      id: "a", capability: "raw_search", configFingerprint: "config", credentialVersion: "credential",
      apiKey: "provider-secret", authorization: "Bearer provider-secret",
    };
    const model = {
      fingerprint: "model", stageVersion: "v1", apiKey: "model-secret", keyHint: "secret-hint",
    };
    const metadata = buildSearchFingerprintV2(v2({
      query: "plaintext-query-canary",
      providers: [provider],
      models: { rerank: model },
      queryExpansion: true,
      queryPlan: [{ queryId: "q2", query: "expanded-secret-query", kind: "expanded", round: 1, weight: 0.8 }],
    }));
    const serialized = canonicalSearchCacheJson(metadata);
    for (const secret of ["plaintext-query-canary", "expanded-secret-query", "provider-secret", "model-secret", "secret-hint", "apiKey", "authorization"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("credentialVersion");
    expect(serialized).toContain("queryDigest");
  });

  it("still changes the key when only the plaintext query changes", () => {
    expect(key(buildSearchFingerprintV2(v2({ query: "query-a" })))).not.toBe(key(buildSearchFingerprintV2(v2({ query: "query-b" }))));
  });
});

describe("canReadV1 B6 compatibility matrix", () => {
  it.each(["basic", "rrf", "web", "grounded", "research"] as const)("allows unchanged %s with equivalent resolved identity", (mode) => {
    const capability = mode === "web" ? "raw_search" : mode === "grounded" ? "grounded_answer" : null;
    const old = legacy({ mode, capability });
    expect(canReadV1({ ...old, mode }, buildSearchFingerprintV1(old))).toBe(true);
  });

  it.each(["rerank", "embedding", "embedding_rerank", "rerank_summary", "deep"] as const)("rejects changed %s semantics", (mode) => {
    const old = legacy({ mode });
    expect(canReadV1({ ...old, mode }, buildSearchFingerprintV1(old))).toBe(false);
  });

  it.each(["auto", "fast", "balanced", "quality", "deep"] as const)("rejects explicit %s strategy", (strategy) => {
    const old = legacy();
    expect(canReadV1({ ...old, strategy }, buildSearchFingerprintV1(old))).toBe(false);
  });

  it.each([
    ["query", { query: "other" }],
    ["limit", { limit: 11 }],
    ["recall depth", { perProviderLimit: 20 }],
    ["provider", { providers: ["other"] }],
    ["language", { language: "en" }],
    ["freshness", { freshness: "day" }],
    ["capability", { capability: "grounded_answer" }],
    ["parked", { parked: ["b"] }],
    ["model stage", { rerank: true }],
    ["embedding stage", { embedding: true }],
    ["summary stage", { summarize: true }],
    ["timeout", { timeoutMs: 5000 }],
  ])("rejects a different effective %s", (_name, overrides) => {
    const old = legacy();
    expect(canReadV1({ ...old, ...overrides }, buildSearchFingerprintV1(old))).toBe(false);
  });

  it("rejects missing, malformed or future-format legacy fingerprints", () => {
    expect(canReadV1(legacy(), null)).toBe(false);
    expect(canReadV1(legacy(), undefined)).toBe(false);
    expect(canReadV1(legacy(), { v: 2 })).toBe(false);
    expect(canReadV1(legacy(), {})).toBe(false);
  });

  it("rejects preset capability mismatches", () => {
    expect(canReadV1(legacy({ mode: "web", capability: "grounded_answer" }), buildSearchFingerprintV1(legacy({ mode: "web", capability: "raw_search" })))).toBe(false);
    expect(canReadV1(legacy({ mode: "grounded", capability: "raw_search" }), buildSearchFingerprintV1(legacy({ mode: "grounded", capability: "grounded_answer" })))).toBe(false);
    expect(canReadV1(legacy({ mode: "research", capability: "raw_search" }), buildSearchFingerprintV1(legacy({ mode: "research", capability: null })))).toBe(false);
  });

  it.each([
    ["web", "raw_search"],
    ["grounded", "grounded_answer"],
    ["research", null],
  ] as const)("isolates %s from rrf in both directions", (mode, capability) => {
    const preset = buildSearchFingerprintV1(legacy({ mode, capability }));
    const rrf = buildSearchFingerprintV1(legacy({ mode: "rrf", capability }));
    expect(canReadV1(legacy({ mode, capability }), preset)).toBe(true);
    expect(canReadV1(legacy({ mode, capability }), rrf)).toBe(false);
    expect(canReadV1(legacy({ mode: "rrf", capability }), preset)).toBe(false);
  });

  it("rejects both quality basic conflict and quality rerank from v1", () => {
    const old = legacy();
    expect(canReadV1({ ...old, mode: "basic", strategy: "quality" }, buildSearchFingerprintV1(old))).toBe(false);
    expect(canReadV1({ ...old, mode: "rerank", strategy: "quality" }, buildSearchFingerprintV1(old))).toBe(false);
  });
});
