import { describe, expect, it, vi } from "vitest";
import type { SearchRequest, SearchResponse } from "@search-hub/shared";
import { SearchService } from "../../apps/api/src/services/search.js";

interface SearchServiceStages {
  applyEmbedding(response: SearchResponse, request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
  applyRerank(response: SearchResponse, request: SearchRequest, signal: AbortSignal): Promise<SearchResponse>;
}

function responseFixture(): SearchResponse {
  return {
    taskId: "task-cancel",
    query: "cancel",
    mode: "basic",
    status: "completed",
    results: [{
      id: "https://example.com/1",
      title: "One",
      url: "https://example.com/1",
      snippet: "snippet",
      source: "fake",
      provider: "prv_fake",
      providerType: "fake",
      providerName: "fake",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      score: 1,
      sources: [{ providerId: "prv_fake", providerName: "fake", providerType: "fake", url: "https://example.com/1", rank: 1 }],
    }],
    stats: {
      rawCount: 1,
      dedupedCount: 1,
      fusedCount: 1,
      providers: [{ providerId: "prv_fake", providerName: "fake", providerType: "fake", ok: true, attempts: 1, resultCount: 1, latencyMs: 1 }],
      rerankApplied: false,
      embeddingApplied: false,
      summaryApplied: false,
      partial: false,
      timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 },
    },
    errors: [],
    failedSources: [],
    debug: { rewrittenQueries: [] },
  };
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error("cancelled by caller"));
  return controller.signal;
}

describe("search model-stage cancellation", () => {
  it("does not invoke the embedding client after cancellation", async () => {
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => [1, 0]),
      modelId: "fake-embedding",
      dimensions: 2,
    }));
    const service = new SearchService({
      models: { embeddingModel: () => ({ config: { modelId: "fake-embedding" }, embed }) },
    } as unknown as ConstructorParameters<typeof SearchService>[0]);

    await (service as unknown as SearchServiceStages).applyEmbedding(
      responseFixture(),
      { query: "cancel", mode: "embedding", limit: 5 },
      abortedSignal(),
    );

    expect(embed).not.toHaveBeenCalled();
  });

  it("does not invoke the rerank client after cancellation", async () => {
    const rerank = vi.fn(async (_query: string, documents: Array<{ id: string }>) => ({
      results: documents.map((document) => ({ id: document.id, score: 1 })),
      modelId: "fake-rerank",
    }));
    const service = new SearchService({
      models: { rerankModel: () => ({ config: { modelId: "fake-rerank" }, rerank }) },
    } as unknown as ConstructorParameters<typeof SearchService>[0]);

    await (service as unknown as SearchServiceStages).applyRerank(
      responseFixture(),
      { query: "cancel", mode: "rerank", limit: 5 },
      abortedSignal(),
    );

    expect(rerank).not.toHaveBeenCalled();
  });
});
