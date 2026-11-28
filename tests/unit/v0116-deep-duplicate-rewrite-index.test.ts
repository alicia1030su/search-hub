import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntime } from "@search-hub/core";
import { rewriteQuery } from "@search-hub/models";
import type { SafeFetch, SearchRequest, SearchResponse } from "@search-hub/shared";
import { SearchService } from "../../apps/api/src/services/search.js";

vi.mock("@search-hub/models", () => ({
  rewriteQuery: vi.fn(),
  rerankWithEmbeddings: vi.fn(),
  summarizeResults: vi.fn(),
}));

interface DeepRunner {
  runDeep(
    request: SearchRequest,
    runtimes: ProviderRuntime[],
    signal: AbortSignal,
    taskId: string,
  ): Promise<SearchResponse>;
}

describe("BUG-0116-02 duplicate Deep rewrite indexing", () => {
  it("executes duplicate rewrites once while preserving the original q1", async () => {
    vi.mocked(rewriteQuery).mockResolvedValueOnce(["same query", "same query", "other query"]);
    let sameQueryCalls = 0;
    let wire = 0;
    const fetch = (async (url: string, init?: { onRequest?: (target: string) => void }) => {
      wire += 1;
      init?.onRequest?.(String(url));
      return {
        status: 200,
        url: String(url),
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({}),
        text: async () => "{}",
      };
    }) as unknown as SafeFetch;
    const runtime: ProviderRuntime = {
      config: {
        id: "prv_fake",
        name: "fake",
        type: "fake",
        baseUrl: null,
        timeoutMs: 5_000,
        maxResults: 10,
        language: null,
        freshness: null,
        model: null,
        maxRetries: 0,
        breakerThreshold: 5,
        breakerCooldownMs: 1_000,
        config: {},
      },
      adapter: {
        type: "fake",
        requiresKey: false,
        supportsTest: false,
        search: async (input: { query: string }, context: { fetch: SafeFetch }) => {
          await context.fetch("https://fake.test/a");
          await context.fetch("https://fake.test/b");
          if (input.query === "same query") sameQueryCalls += 1;
          return {
            results: [{
              title: input.query,
              url: `https://example.org/${encodeURIComponent(input.query)}`,
              snippet: "x",
            }],
          };
        },
      },
      scheduler: {} as ProviderRuntime["scheduler"],
      enabled: true,
      requiresKey: false,
      breaker: { failures: 0, openUntilMs: null },
    };
    const chat = { config: { modelId: "fake-chat" } };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const service = new SearchService({
      db: {},
      providers: { resolveKey: async () => undefined, credentialVersion: () => "none" },
      models: { chatModel: () => chat },
      settings: { get: () => ({ defaults: { timeoutMs: 5_000, limit: 10 } }) },
      fetch,
      logger,
    } as unknown as ConstructorParameters<typeof SearchService>[0]);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "original", mode: "deep", limit: 5, skipCache: true },
      [runtime],
      new AbortController().signal,
      "task-deep-duplicate-index",
    );

    expect(response.debug?.rewrittenQueries).toEqual(["original", "same query", "other query"]);
    expect(sameQueryCalls).toBe(1);
    expect(wire).toBe(6);
    expect(response.status).toBe("completed");
    expect(response.results).toHaveLength(3);
    expect(response.errors).toEqual([]);
  });
});
