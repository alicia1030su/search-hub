import { describe, expect, it, vi } from "vitest";
import { startSearchStream } from "../../apps/api/src/services/search-stream.js";
import type { SearchService } from "../../apps/api/src/services/search.js";
import type { SearchRequest, SearchResponse } from "@search-hub/shared";

const request: SearchRequest = { query: "stream", mode: "basic", limit: 5 };

function responseFixture(): SearchResponse {
  return {
    taskId: "task-stream",
    query: "stream",
    mode: "basic",
    status: "completed",
    results: [],
    stats: {
      rawCount: 0,
      dedupedCount: 0,
      fusedCount: 0,
      providers: [],
      timing: { totalMs: 0, fanoutMs: 0, fusionMs: 0 },
      rerankApplied: false,
      embeddingApplied: false,
      summaryApplied: false,
      partial: false,
    },
    errors: [],
    failedSources: [],
  };
}

describe("search event stream", () => {
  it("aborts the search when a slow consumer exceeds the bounded queue", async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (_request: SearchRequest, options: { signal?: AbortSignal; onEvent?: (event: { type: "results_updated"; data: Record<string, unknown> }) => void }) => {
      signal = options.signal;
      for (let index = 0; index < 100; index += 1) {
        options.onEvent?.({ type: "results_updated", data: { index } });
      }
      return responseFixture();
    });
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "sse" },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(handle.stream.destroyed).toBe(true);
  });

  it("propagates explicit cancellation to the in-flight search", () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn((_request: SearchRequest, options: { signal?: AbortSignal }) => {
      signal = options.signal;
      return new Promise<SearchResponse>(() => undefined);
    });
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "ndjson" },
    );

    handle.cancel();
    expect(signal?.aborted).toBe(true);
    handle.stream.destroy();
  });
});
