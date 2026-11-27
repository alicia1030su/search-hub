import { describe, expect, it } from "vitest";
import { rankSnapshot } from "../../packages/core/src/evaluation/lab.js";
import { compareRankStrategies, rankStrategy, type DeepRankedList } from "../../packages/core/src/evaluation/strategy.js";
import type { EvaluationSnapshot } from "../../packages/core/src/evaluation/snapshot.js";
import type { FusionParameters } from "../../packages/core/src/evaluation/types.js";

const snapshot: EvaluationSnapshot = {
  schemaVersion: 2,
  queryId: "q1",
  query: "alpha",
  category: "general",
  language: "en",
  capturedAt: "2026-11-18T00:00:00.000Z",
  upstreamRequests: 2,
  cacheHits: 0,
  providerFingerprints: {},
  providers: [
    {
      providerId: "alpha", providerName: "Alpha", providerType: "fixture", ok: true,
      results: [
        { documentId: "https://a.test/1", title: "A", url: "https://a.test/1", snippet: "", rank: 1 },
        { documentId: "https://b.test/1", title: "B", url: "https://b.test/1", snippet: "", rank: 2 },
      ],
    },
    {
      providerId: "beta", providerName: "Beta", providerType: "fixture", ok: true,
      results: [
        { documentId: "https://b.test/1", title: "B", url: "https://b.test/1", snippet: "", rank: 1 },
        { documentId: "https://c.test/1", title: "C", url: "https://c.test/1", snippet: "", rank: 2 },
      ],
    },
  ],
  modelArtifacts: {},
  deepRounds: [],
};

const ids = (ranked: ReturnType<typeof rankStrategy>) => ranked.documents.map((document) => document.documentId);

describe("rankStrategy", () => {
  it.each([
    { strategy: "base" as const },
    { strategy: "rrf" as const, k: 60 },
    { strategy: "rrf" as const, k: 60, providerWeights: { alpha: 10, beta: 1 } },
  ])("keeps v0.1.17 fusion item-by-item equivalent for $strategy", (fusion: FusionParameters) => {
    expect(rankStrategy(snapshot, { strategy: "fusion", fusion })).toEqual(rankSnapshot(snapshot, fusion));
  });

  it("supports legacy provider arrays without changing ranking", () => {
    const ranked = rankStrategy(snapshot.providers, { strategy: "fusion", fusion: { strategy: "rrf" } });
    expect(ranked.documents).toEqual(rankSnapshot(snapshot, { strategy: "rrf" }).documents);
    expect(ranked.queryId).toBe("legacy-v1");
  });

  it("orders embedding results only by frozen artifact scores", () => {
    const withModel: EvaluationSnapshot = {
      ...snapshot,
      modelArtifacts: { embedding: { modelId: "frozen", configFingerprint: "cfg", stageVersion: "v1", scores: { "https://c.test/1": 0.9, "https://a.test/1": 0.8, "https://b.test/1": 0.1 } } },
    };
    expect(ids(rankStrategy(withModel, { strategy: "embedding" }))).toEqual([
      "https://c.test/1", "https://a.test/1", "https://b.test/1",
    ]);
    expect(() => rankStrategy(snapshot, { strategy: "embedding" })).toThrow("missing frozen modelArtifacts");
  });

  it("orders rerank results only by frozen artifact scores", () => {
    const withModel: EvaluationSnapshot = {
      ...snapshot,
      modelArtifacts: { rerank: { modelId: "frozen", configFingerprint: "cfg", stageVersion: "v2", scores: { "https://a.test/1": 0.4, "https://b.test/1": 0.99, "https://c.test/1": 0.2 } } },
    };
    expect(ids(rankStrategy(withModel, { strategy: "rerank", limit: 2 }))).toEqual([
      "https://b.test/1", "https://a.test/1",
    ]);
    expect(() => rankStrategy(snapshot, { strategy: "rerank" })).toThrow("missing frozen modelArtifacts");
  });

  it("uses frozen route weights without any model call", () => {
    const routed: EvaluationSnapshot = {
      ...snapshot,
      route: { version: "r1", providerWeights: { alpha: 100, beta: 1 } },
    };
    expect(ids(rankStrategy(routed, { strategy: "route" }))).toEqual(ids(rankSnapshot(snapshot, { strategy: "rrf", providerWeights: { alpha: 100, beta: 1 } })));
    expect(() => rankStrategy(snapshot, { strategy: "route" })).toThrow("missing frozen route artifact");
  });

  it("deduplicates deep queries and retains sorted queryOrigins", () => {
    const deep: EvaluationSnapshot = {
      ...snapshot,
      query: "Alpha",
      deepRounds: [{
        ...snapshot,
        queryId: "q2",
        query: " alpha ",
        queryIndex: 1,
        kind: "expanded",
        weight: 0.8,
        round: 1,
        providerQueryCalls: 1,
        httpRequests: 1,
        modelCalls: 0,
        budgetExhausted: false,
        providers: [{
          ...snapshot.providers[0]!,
          results: [{ documentId: "https://a.test/1", title: "A", url: "https://a.test/1", snippet: "", rank: 1 }],
        }],
      }],
    };
    const ranked = rankStrategy(deep, { strategy: "deep" }) as DeepRankedList;
    expect(ranked.documents).toHaveLength(3);
    expect(ranked.documents[0]!.queryOrigins).toHaveLength(2);
    expect(ranked.documents[1]!.queryOrigins).toHaveLength(1);
    expect(ranked.documents[1]!.queryOrigins![0]!.queryId).toBe("q1");
    expect(ranked.documents[1]!.queryOrigins!.map((origin) => origin.queryId)).toEqual(["q1"]);
  });

  it("applies B3 layered RRF and coverage across queries", () => {
    const deep: EvaluationSnapshot = {
      ...snapshot,
      deepRounds: [{
        ...snapshot,
        queryId: "q2",
        query: "beta",
        queryIndex: 1,
        kind: "expanded",
        weight: 0.8,
        round: 1,
        providerQueryCalls: 1,
        httpRequests: 1,
        modelCalls: 0,
        budgetExhausted: false,
        providers: [{
          ...snapshot.providers[0]!,
          results: [{ documentId: "https://d.test/1", title: "D", url: "https://d.test/1", snippet: "", rank: 1 }],
        }],
      }],
    };
    const ranked = rankStrategy(deep, { strategy: "deep" }) as DeepRankedList;
    expect(ranked.documents[0]).toMatchObject({ documentId: "https://b.test/1", queriesContaining: 1 });
    // Every query's top hit is normalized to 1, then multiplied by query weight.
    expect(ranked.documents[0]!.deepScore).toBeCloseTo(0.7 * (1 / 1.8) + 0.15, 10);
    expect(ranked.documents[1]!.queryOrigins![0]).toMatchObject({ queryId: "q2", round: 1, kind: "expanded", weight: 0.8 });
    expect(ranked.documents[1]!.queryOrigins![0]!.score).toBeCloseTo(1 / 61, 10);
  });

  it("compares replay strategies and reports rank movements", () => {
    const comparison = compareRankStrategies({
      snapshot,
      baseline: "fusion",
      candidate: "embedding",
      limit: 2,
      modelArtifacts: { embedding: { modelId: "frozen", configFingerprint: "cfg", stageVersion: "v1", scores: { "https://c.test/1": 1 } } },
    });
    expect(comparison.baseline.documents).toHaveLength(2);
    expect(comparison.entered.length + comparison.exited.length + comparison.moved.length + comparison.unchanged.length).toBe(3);
    expect(comparison.moved.every((movement) => movement.delta === movement.from! - movement.to!)).toBe(true);
  });

  it("never lets a missing deep query lose its denominator", () => {
    const ranked = rankStrategy(snapshot, { strategy: "deep" }) as DeepRankedList;
    expect(ranked.documents[0]!.deepScore).toBeCloseTo(1, 10);
    expect(ranked.documents.every((document) => document.queriesContaining === 1)).toBe(true);
  });
});
