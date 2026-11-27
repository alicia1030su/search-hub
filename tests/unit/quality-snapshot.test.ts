import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  deserializeSnapshot,
  evaluationSnapshotSchema,
  fingerprintSnapshot,
  parseEvaluationSnapshot,
  snapshotFingerprint,
  serializeSnapshot,
  type EvaluationSnapshot,
} from "../../packages/core/src/evaluation/snapshot.js";

const snapshot: EvaluationSnapshot = {
  schemaVersion: 2,
  queryId: "q1",
  query: "test",
  category: "factual",
  language: "zh",
  capturedAt: "2026-11-18T00:00:00.000Z",
  upstreamRequests: 2,
  cacheHits: 1,
  providers: [{
    providerId: "alpha",
    providerName: "Alpha",
    providerType: "fixture",
    ok: true,
    results: [{ documentId: "https://a.test/1", title: "A", url: "https://a.test/1", snippet: "", rank: 1 }],
  }],
  providerFingerprints: { alpha: "frozen" },
  modelArtifacts: {},
  deepRounds: [],
};

describe("evaluation snapshot envelope", () => {
  it("round-trips the v2 envelope with canonical key ordering", () => {
    const encoded = serializeSnapshot(snapshot);
    expect(encoded).toBe(canonicalJson(JSON.parse(encoded)));
    expect(deserializeSnapshot(encoded)).toEqual(snapshot);
    expect(parseEvaluationSnapshot).toBe(deserializeSnapshot);
    expect(snapshotFingerprint).toBe(fingerprintSnapshot);
    expect(evaluationSnapshotSchema.properties.schemaVersion.const).toBe(2);
  });

  it("parses non-secret model metadata and preserves deep budget evidence", () => {
    const enriched: EvaluationSnapshot = {
      ...snapshot,
      modelArtifacts: { chat: { modelId: "frozen", configFingerprint: "cfg", stageVersion: "v1" } },
      deepRounds: [{
        ...snapshot,
        queryIndex: 1,
        kind: "expanded",
        weight: 0.8,
        round: 2,
        providerQueryCalls: 4,
        httpRequests: 7,
        modelCalls: 1,
        budgetExhausted: true,
      }],
    };
    expect(deserializeSnapshot(serializeSnapshot(enriched))).toEqual(enriched);
    expect(serializeSnapshot(enriched)).not.toMatch(/apiKey|baseUrl|authorization/i);
  });

  it("upgrades legacy ProviderSnapshot[] to v1-compatible metadata", () => {
    const upgraded = deserializeSnapshot(snapshot.providers);
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.queryId).toBe("legacy-v1");
    expect(upgraded.language).toBe("und");
    expect(upgraded.providers).toEqual(snapshot.providers);
    expect(upgraded.providerFingerprints.alpha).toMatch(/^[a-f0-9]{64}$/);
  });

  it("upgrades a legacy QuerySnapshot without mutating it", () => {
    const legacy = { ...snapshot, schemaVersion: undefined } as unknown as EvaluationSnapshot;
    const before = JSON.stringify(legacy);
    expect(deserializeSnapshot(legacy).schemaVersion).toBe(2);
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it("fingerprints are independent of object key order", () => {
    const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
    expect(fingerprintSnapshot(reordered)).toBe(fingerprintSnapshot(snapshot));
    expect(fingerprintSnapshot(snapshot)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("redacts credentials from keys and URLs before serialization", () => {
    const dirty = {
      ...snapshot,
      apiKey: "canary-key",
      nested: { accessToken: "canary-token" },
      providers: [{
        ...snapshot.providers[0]!,
        results: [{ ...snapshot.providers[0]!.results[0]!, url: "https://user:pass@a.test/1?token=secret&key=x&q=ok" }],
      }],
    };
    const encoded = canonicalJson(dirty);
    expect(encoded).not.toContain("canary");
    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("user:pass");
    expect(encoded).toContain("[redacted]");
    expect(encoded).toContain("q=ok");
  });

  it("rejects malformed schema versions and negative request counts", () => {
    expect(() => deserializeSnapshot({ ...snapshot, schemaVersion: 1 })).toThrow("schemaVersion");
    expect(() => deserializeSnapshot({ ...snapshot, upstreamRequests: -1 })).toThrow("upstreamRequests");
  });
});
