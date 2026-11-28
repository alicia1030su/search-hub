import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntime } from "@search-hub/core";
import { rewriteQuery } from "@search-hub/models";
import type { SafeFetch, SearchRequest, SearchResponse } from "@search-hub/shared";
import { normalizeQueryIdentity } from "@search-hub/core";
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

function harness(options: { onSearch?: (query: string, signal: AbortSignal) => Promise<void>; cacheEnabled?: boolean } = {}) {
  const calls: string[] = [];
  const cacheKeys: string[] = [];
  const cache = {
    getAny: vi.fn((keys: string[]) => {
      cacheKeys.push(...keys);
      return null;
    }),
    put: vi.fn(),
  };
  const db = {
    insert: () => ({ values: () => ({ run: vi.fn() }) }),
    update: () => ({ set: () => ({ where: () => ({ run: vi.fn() }) }) }),
  };
  const fetch = (async () => ({
    status: 200,
    url: "https://fake.test/unused",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({}),
    text: async () => "{}",
  })) as unknown as SafeFetch;
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
      search: async (input, context) => {
        calls.push(input.query);
        await options.onSearch?.(input.query, context.signal);
        return {
          results: [{
            title: "shared result",
            url: "https://example.org/shared",
            snippet: "shared snippet",
          }],
        };
      },
    },
    scheduler: {} as ProviderRuntime["scheduler"],
    enabled: true,
    requiresKey: false,
    breaker: { failures: 0, openUntilMs: null },
  };
  const chat = {
    config: { modelId: "fake-chat" },
    complete: vi.fn(async () => ({
      text: JSON.stringify({ queries: ["ＲＡＧ   retrieval architecture", "rag retrieval architecture", "RAG retrieval architecture design"] }),
      modelId: "fake-chat",
    })),
  };
  const service = new SearchService({
    db,
    providers: {
      runtimesFor: () => [runtime],
      resolveKey: async () => undefined,
      credentialVersion: () => "none",
    },
    models: {
      chatModel: () => chat,
      findDefault: (kind: string) => kind === "chat" ? chat : null,
      resolveConfig: () => null,
      getEnabled: () => chat,
    },
    settings: { get: () => ({ defaults: { timeoutMs: 5_000, limit: 10 }, cache: { enabled: options.cacheEnabled === true, ttlSeconds: 60 } }) },
    fetch,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    health: { blockedProviders: () => new Map() },
    cache,
  } as unknown as ConstructorParameters<typeof SearchService>[0]);
  return { service, runtime, calls, chat, cacheKeys };
}

async function run(service: SearchService, runtime: ProviderRuntime, request: SearchRequest, signal = new AbortController().signal) {
  return await (service as unknown as DeepRunner).runDeep(request, [runtime], signal, "task-v0118-deep-plan");
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("v0.1.18 Deep normalized query identity", () => {
  it("deduplicates legacy rewrites by NFKC + casefold + whitespace and keeps contiguous origins", async () => {
    vi.mocked(rewriteQuery).mockResolvedValueOnce([
      "ＲＡＧ   retrieval",
      "rag retrieval",
      "RAG\tretrieval",
      "RAG retrieval architecture",
      "RAG   retrieval architecture",
    ]);
    const { service, runtime, calls } = harness();
    const response = await run(service, runtime, { query: "RAG retrieval", mode: "deep", limit: 5, skipCache: true });

    expect(calls).toEqual(["RAG retrieval", "RAG retrieval architecture"]);
    expect(response.debug?.rewrittenQueries).toEqual(["RAG retrieval", "RAG retrieval architecture"]);
    expect(response.deepBudget?.queriesPlanned).toBe(2);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.queryOrigins).toEqual([
      expect.objectContaining({ queryId: "q1", query: "RAG retrieval", queryIndex: 1, kind: "original", round: 1, weight: 1 }),
      expect.objectContaining({ queryId: "q2", query: "RAG retrieval architecture", queryIndex: 2, kind: "rewrite", round: 2, weight: 0.8 }),
    ]);
    expect(new Set(response.debug?.rewrittenQueries?.map(normalizeQueryIdentity)).size).toBe(2);
  });

  it("keeps expansion metadata, executed plan and query origins on the same identities", async () => {
    const { service, runtime, calls, chat } = harness();
    const response = await run(service, runtime, {
      query: "RAG retrieval architecture",
      mode: "deep",
      queryExpansion: true,
      maxSubqueries: 3,
      limit: 5,
      skipCache: true,
    });

    expect(chat.complete).toHaveBeenCalledTimes(1);
    expect(response.queryExpansion?.queries.map((item) => item.query)).toEqual(response.debug?.rewrittenQueries);
    expect(response.debug?.rewrittenQueries?.[0]).toBe("RAG retrieval architecture");
    expect(calls).toEqual(response.debug?.rewrittenQueries);
    const origins = response.results.flatMap((result) => result.queryOrigins ?? []);
    expect(origins.map((origin) => origin.queryId)).toEqual(["q1", "q2", "q3"]);
    expect(origins.map((origin) => origin.queryIndex)).toEqual([1, 2, 3]);
    expect(origins.map((origin) => origin.kind)).toEqual(response.queryExpansion?.queries.map((item) => item.kind === "original" ? "original" : item.kind === "rewrite" ? "rewrite" : "expanded"));
    expect(origins.map((origin) => origin.query)).toEqual(response.queryExpansion?.queries.map((item) => item.query));
  });

  it("includes the actual normalized Deep plan in the cache identity", async () => {
    vi.mocked(rewriteQuery)
      .mockResolvedValueOnce(["ＲＡＧ   retrieval", "RAG retrieval architecture"])
      .mockResolvedValueOnce(["rag retrieval", "RAG retrieval design"]);
    const { service, cacheKeys } = harness({ cacheEnabled: true });

    await service.execute({ query: "RAG retrieval", mode: "deep", limit: 5 });
    await service.execute({ query: "RAG retrieval", mode: "deep", limit: 5 });

    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it("fails with timeout at the shared Deep deadline while preserving completed q1 results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(rewriteQuery).mockResolvedValueOnce(["original", "rewrite"]);
    let markSecondQueryStarted!: () => void;
    const secondQueryStarted = new Promise<void>((resolve) => { markSecondQueryStarted = resolve; });
    const { service, runtime, calls } = harness({
      onSearch: async (query, signal) => {
        if (query !== "rewrite") return;
        markSecondQueryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Search deadline exceeded")), { once: true });
        });
      },
    });

    const pending = run(service, runtime, { query: "original", mode: "deep", limit: 5, timeoutMs: 100, skipCache: true });
    await secondQueryStarted;
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;

    expect(response.status).toBe("failed");
    expect(response.errors.some((error) => error.code === "timeout")).toBe(true);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.queryOrigins).toEqual([
      expect.objectContaining({ queryId: "q1", query: "original", queryIndex: 1 }),
    ]);
    expect(calls).toEqual(["original", "rewrite"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["original", "rewrite"]);
  });
});
