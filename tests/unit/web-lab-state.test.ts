import { describe, expect, it } from "vitest";
import { buildLabRequest, initialLabState, labReducer } from "../../apps/web/src/lib/lab-state";
import { ApiError } from "../../apps/web/src/lib/api";
import type { SearchResponse, SearchResult } from "../../apps/web/src/lib/types";

const result: SearchResult = { id: "1", title: "One", url: "https://example.test/1", snippet: "", source: "p", provider: "p", providerName: "P", providerType: "mock", retrievedAt: "", score: 1, sources: [] };
const response: SearchResponse = {
  taskId: "t1", query: "q", strategy: "balanced", status: "completed", results: [result], errors: [], failedSources: [],
  stats: { rawCount: 1, dedupedCount: 1, fusedCount: 1, providers: [], timing: { totalMs: 5, fanoutMs: 2, fusionMs: 1 }, rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false },
};
const baseInput = { query: " q ", picker: "mode:rrf" as const, limit: 20, selected: ["p"], providerMode: "manual" as const, includeRaw: false, skipCache: true, queryExpansion: true };

describe("Lab request construction", () => {
  it("defaults to legacy rrf without strategy and without new-only fields", () => {
    const request = buildLabRequest(baseInput);
    expect(request.mode).toBe("rrf");
    expect(request.strategy).toBeUndefined();
    expect(request.queryExpansion).toBeUndefined();
    expect(request.providers).toEqual(["p"]);
  });
  it("sends strategy without mode and omits providers in automatic mode", () => {
    const request = buildLabRequest({ ...baseInput, picker: "strategy:balanced", providerMode: "auto" });
    expect(request.strategy).toBe("balanced");
    expect(request.mode).toBeUndefined();
    expect(request.providers).toBeUndefined();
    expect(request.stream).toBe("sse");
    expect(request.queryExpansion).toBe(true);
  });
  it("forces expansion off for Fast and encodes legacy deep distinctly", () => {
    expect(buildLabRequest({ ...baseInput, picker: "strategy:fast", providerMode: "auto" }).queryExpansion).toBeUndefined();
    const request = buildLabRequest({ ...baseInput, picker: "mode:deep" });
    expect(request.mode).toBe("deep");
    expect(request.strategy).toBeUndefined();
  });
});

describe("Lab run reducer", () => {
  it("keeps provisional results separate and atomically replaces them on done", () => {
    const started = labReducer(initialLabState, { type: "start", request: baseInput, startedAt: 1 });
    const provisional = labReducer(started, { type: "event", event: { type: "results", data: [result] } });
    expect(provisional.provisional).toEqual([result]);
    expect(provisional.response).toBeNull();
    const done = labReducer(provisional, { type: "event", event: { type: "done", data: response } });
    expect(done.provisional).toEqual([]);
    expect(done.response).toBe(response);
    expect(done.status).toBe("completed");
  });
  it("cancel preserves provisional rows but never labels them final", () => {
    const started = labReducer(initialLabState, { type: "start", request: baseInput, startedAt: 1 });
    const provisional = labReducer(started, { type: "event", event: { type: "results", data: [result] } });
    const cancelled = labReducer(provisional, { type: "cancel" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.provisional).toEqual([result]);
    expect(cancelled.response).toBeNull();
    const lateDone = labReducer(cancelled, { type: "event", event: { type: "done", data: response } });
    expect(lateDone).toBe(cancelled);
  });
  it("stream failure preserves arrived results and a non-success terminal status", () => {
    const started = labReducer(initialLabState, { type: "start", request: baseInput, startedAt: 1 });
    const provisional = labReducer(started, { type: "event", event: { type: "results", data: [result] } });
    const failed = labReducer(provisional, { type: "error", error: new ApiError(0, "budget", "exhausted") });
    expect(failed.status).toBe("failed");
    expect(failed.provisional).toEqual([result]);
  });
  it("does not fabricate provisional rows for a cache hit", () => {
    const started = labReducer(initialLabState, { type: "start", request: baseInput, startedAt: 1 });
    const cached = labReducer(started, { type: "event", event: { type: "results", data: { results: [result], stats: { cached: true } } } });
    expect(cached.provisional).toEqual([]);
  });
  it("heartbeats have no event and unknown totals remain unknown", () => {
    const started = labReducer(initialLabState, { type: "start", request: baseInput, startedAt: 1 });
    const status = labReducer(started, { type: "event", event: { type: "status", data: { status: "fanout" } } });
    expect(status.completed).toBeNull();
    expect(status.total).toBeNull();
  });
});
