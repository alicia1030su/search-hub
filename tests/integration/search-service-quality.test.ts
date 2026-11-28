import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntime } from "@search-hub/core";
import type {
  SafeFetch,
  SearchProviderAdapter,
  SearchRequest,
  SearchResponse,
} from "@search-hub/shared";
import { SearchService } from "../../apps/api/src/services/search.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const unusedFetch: SafeFetch = async () => {
  throw new Error("fetch should not be called by fake adapters");
};

interface DeepRunner {
  runDeep(
    request: SearchRequest,
    runtimes: ProviderRuntime[],
    signal: AbortSignal,
    taskId: string,
  ): Promise<SearchResponse>;
}

function runtime(id: string, search: SearchProviderAdapter["search"]): ProviderRuntime {
  return {
    config: {
      id: `prv_${id}`,
      name: id,
      type: "fake",
      baseUrl: null,
      timeoutMs: 5_000,
      maxResults: 100,
      language: null,
      freshness: null,
      model: null,
      maxRetries: 0,
      breakerThreshold: 5,
      breakerCooldownMs: 1_000,
      config: {},
    },
    adapter: { type: "fake", requiresKey: false, supportsTest: false, search },
    scheduler: {} as ProviderRuntime["scheduler"],
    enabled: true,
    requiresKey: false,
    breaker: { failures: 0, openUntilMs: null },
  };
}

function serviceWith(
  models: Record<string, unknown>,
  runtimes: ProviderRuntime[],
  fetch: SafeFetch = unusedFetch,
  blocked: Map<string, { code: string; message: string; until: string }> = new Map(),
): SearchService {
  return new SearchService({
    db: {},
    providers: {
      runtimesFor: (ids: string[]) => ids.length === 0 ? runtimes : runtimes.filter((item) => ids.includes(item.config.id)),
      credentialVersion: () => "none",
      resolveKey: async () => undefined,
      redactKeyMessage: () => null,
      redactProviderMessage: () => null,
    },
    models,
    settings: {
      get: () => ({
        defaults: { mode: "basic", limit: 10, timeoutMs: 5_000 },
        cache: { enabled: false, ttlSeconds: 0 },
      }),
    },
    fetch,
    logger,
    health: { blockedProviders: () => blocked },
    cache: {},
  } as unknown as ConstructorParameters<typeof SearchService>[0]);
}

function chatReturning(queries: string[]) {
  return {
    config: { modelId: "fake-chat" },
    complete: async () => ({ text: JSON.stringify({ queries }), modelId: "fake-chat" }),
  };
}

describe("search service quality regressions", () => {
  it("returns cancelled for external cancellation instead of failed", async () => {
    const provider = runtime("cancel-status", async () => ({
      results: [{ title: "Cancel", url: "https://example.com/cancel", snippet: "body" }],
    }));
    const service = serviceWith({}, [provider]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));

    const response = await service.execute(
      { query: "cancel", mode: "basic", limit: 5, skipCache: true },
      { evaluate: true, signal: controller.signal },
    );

    expect(response.status).toBe("cancelled");
    expect(response.errors.some((error) => error.code === "cancelled")).toBe(true);
  });

  it("returns structured failed timeout when the engine deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const provider = runtime("deadline", async (_input, ctx) => new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("provider timeout")), { once: true });
      }));
      const service = serviceWith({}, [provider]);
      const pending = service.execute(
        { query: "deadline", mode: "basic", limit: 5, timeoutMs: 1_000, skipCache: true },
        { evaluate: true },
      );

      await vi.advanceTimersByTimeAsync(1_000);
      const response = await pending;
      expect(response.status).toBe("failed");
      expect(response.errors.some((error) => error.code === "timeout")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades Deep to rule expansion and original query without a chat model", async () => {
    const provider = runtime("deep-no-chat", async () => ({
      results: [{ title: "Deep", url: "https://example.com/deep", snippet: "deep body" }],
    }));
    const service = serviceWith({ findDefault: () => null }, [provider]);

    const response = await service.execute(
      { query: "machine learning tutorial", mode: "deep", limit: 5, skipCache: true },
      { evaluate: true },
    );

    expect(response.status).not.toBe("failed");
    expect(response.mode).toBe("deep");
    expect(response.queryExpansion?.queries[0]?.query).toBe("machine learning tutorial");
    expect(response.degradations).toEqual(expect.arrayContaining([
      { stage: "query_expansion", reason: "model_not_configured" },
      { stage: "summary", reason: "model_not_configured" },
    ]));
  });

  it("resolves auto strategy locally and returns its rule explanation", async () => {
    const provider = runtime("auto", async () => ({
      results: [{ title: "Auto", url: "https://example.com/auto", snippet: "body" }],
    }));
    const service = serviceWith({ findDefault: () => null }, [provider]);

    const response = await service.execute(
      { query: "https://example.com/docs", strategy: "auto", limit: 5, skipCache: true },
      { evaluate: true },
    );

    expect(response.mode).toBe("basic");
    expect(response.strategy).toBe("auto");
    expect(response.route).toMatchObject({ selectedStrategy: "fast", ruleId: "fast_intent" });
  });

  it("keeps a blocked strategy source visible as a failed source", async () => {
    const provider = runtime("blocked", async () => ({ results: [] }));
    const service = serviceWith({}, [provider], unusedFetch, new Map([
      [provider.config.id, { code: "rate_limited", message: "parked", until: "2099-01-01T00:00:00.000Z" }],
    ]));

    const response = await service.execute(
      { query: "blocked", strategy: "fast", limit: 5, skipCache: true },
      { evaluate: true },
    );

    expect(response.route?.selectedProviderIds).toContain(provider.config.id);
    expect(response.failedSources).toContainEqual({ id: provider.config.id, code: "rate_limited" });
  });

  it("maps fast strategy to basic without requiring a model", async () => {
    const provider = runtime("fast", async () => ({
      results: [{ title: "Fast", url: "https://example.com/fast", snippet: "fast body" }],
    }));
    const service = serviceWith({}, [provider]);

    const response = await service.execute(
      { query: "fast", strategy: "fast", limit: 5, skipCache: true },
      { evaluate: true },
    );

    expect(response.mode).toBe("basic");
    expect(response.strategy).toBe("fast");
    expect(response.stats.embeddingApplied).toBe(false);
    expect(response.stats.rerankApplied).toBe(false);
  });

  it("keeps quality search successful when no rerank model is configured", async () => {
    const provider = runtime("quality", async () => ({
      results: [{ title: "Quality", url: "https://example.com/quality", snippet: "quality body" }],
    }));
    const service = serviceWith({ findDefault: () => null }, [provider]);

    const response = await service.execute(
      { query: "quality", strategy: "quality", limit: 5, skipCache: true },
      { evaluate: true },
    );

    expect(response.mode).toBe("rrf");
    expect(response.strategy).toBe("quality");
    expect(response.stats.rerankApplied).toBe(false);
    expect(response.degradations).toContainEqual({ stage: "rerank", reason: "model_not_configured" });
  });

  it("emits service-level meta, provider, status and terminal events", async () => {
    const provider = runtime("events", async () => ({
      results: [{ title: "Event", url: "https://example.com/event", snippet: "event body" }],
    }));
    const service = serviceWith({}, [provider]);
    const events: string[] = [];

    await service.execute(
      { query: "events", strategy: "fast", limit: 5, skipCache: true },
      { evaluate: true, onEvent: (event) => events.push(event.type) },
    );

    expect(events).toContain("meta");
    expect(events).toContain("provider_started");
    expect(events).toContain("provider_completed");
    expect(events).toContain("results_updated");
    expect(events).toContain("status");
    expect(events.at(-1)).toBe("search_completed");
  });

  it("keeps query expansion off by default and enables it only on request", async () => {
    const calls: string[] = [];
    const provider = runtime("expand", async (input) => {
      calls.push(input.query);
      return { results: [{ title: "Expanded", url: "https://example.com/expanded", snippet: "expanded body" }] };
    });
    const service = serviceWith({ findDefault: () => null }, [provider]);

    await service.execute(
      { query: "machine learning tutorial", strategy: "balanced", limit: 5, skipCache: true },
      { evaluate: true },
    );
    expect(calls).toEqual(["machine learning tutorial"]);

    calls.length = 0;
    const response = await service.execute(
      { query: "machine learning tutorial", strategy: "balanced", queryExpansion: true, limit: 5, skipCache: true },
      { evaluate: true },
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(response.queryExpansion?.queries[0]?.query).toBe("machine learning tutorial");
  });

  it("keeps every Deep query in round one when maxRounds is one", async () => {
    const provider = runtime("rounds", async () => ({
      results: [{ title: "Shared", url: "https://example.com/shared", snippet: "shared body" }],
    }));
    const service = serviceWith({ chatModel: () => chatReturning(["q2"]) }, [provider]);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "q1", mode: "deep", maxRounds: 1, limit: 10, skipCache: true },
      [provider],
      new AbortController().signal,
      "task-deep-one-round",
    );

    expect(response.deepBudget).toMatchObject({ roundsPlanned: 1, queriesPlanned: 2 });
    expect(response.results[0]?.queryOrigins?.map((origin) => origin.round)).toEqual([1, 1]);
  });

  it("keeps an independent 400-row pool per Deep query before the bounded union", async () => {
    const providers = Array.from({ length: 5 }, (_, providerIndex) => runtime(`p${providerIndex}`, async (input) => ({
      results: Array.from({ length: input.limit }, (_, index) => ({
        title: `Provider ${providerIndex} result ${index}`,
        url: `https://example.com/${encodeURIComponent(input.query)}/${providerIndex}/${index}`,
        snippet: "body",
      })),
    })));
    const service = serviceWith({ chatModel: () => chatReturning(["q2"]) }, providers);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "q1", mode: "deep", perProviderLimit: 100, limit: 10, skipCache: true },
      providers,
      new AbortController().signal,
      "task-deep-per-query-pool",
    );

    expect(response.stats.funnel).toMatchObject({ eligible: 800, rawReceived: 800, candidateSelectedCount: 200 });
    expect(response.stats.truncationReasons).toContainEqual({ reason: "raw_pool_limit", count: 200 });
  });

  it("enforces the Deep HTTP budget before dispatching additional physical requests", async () => {
    const fetch: SafeFetch = async <T>(url: string, init?: Parameters<SafeFetch>[1]): Promise<{ status: number; headers: Headers; data: T; url: string }> => {
      init?.onRequest?.(url);
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        data: {} as T,
        url,
      };
    };
    const providers = Array.from({ length: 8 }, (_, index) => runtime(`p${index}`, async (_input, ctx) => {
      for (let request = 0; request < 3; request += 1) {
        await ctx.fetch(`https://stub.invalid/${index}/${request}`);
      }
      return { results: [{ title: `Result ${index}`, url: `https://example.com/${index}`, snippet: "body" }] };
    }));
    const service = serviceWith({ chatModel: () => chatReturning(["q2", "q3", "q4"]) }, providers, fetch);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "q1", mode: "deep", strategy: "deep", maxSubqueries: 4, limit: 10, skipCache: true },
      providers,
      new AbortController().signal,
      "task-deep-http-budget",
    );

    expect(response.deepBudget).toMatchObject({
      providerQueryCalls: 32,
      httpRequests: 64,
      budgetExhausted: true,
    });
    expect(response.stats.truncationReasons).toContainEqual({ reason: "deep_budget", count: 1 });
  });

  it("records a bounded before/after rerank comparison", async () => {
    const provider = runtime("compare-rerank", async () => ({
      results: [
        { title: "One", url: "https://example.com/1", snippet: "one" },
        { title: "Two", url: "https://example.com/2", snippet: "two" },
      ],
    }));
    const rerank = {
      config: { modelId: "fake-rerank" },
      rerank: async (_query: string, documents: Array<{ id: string }>) => ({
        modelId: "fake-rerank",
        results: [...documents].reverse().map((document, index) => ({ id: document.id, score: 1 - index / 10 })),
      }),
    };
    const service = serviceWith({
      findDefault: (kind: string) => kind === "rerank" ? rerank.config : null,
      rerankModel: () => rerank,
      resolveConfig: () => rerank.config,
    }, [provider]);

    const response = await service.execute(
      { query: "rerank", mode: "rerank", limit: 2, skipCache: true },
      { evaluate: true },
    );

    expect(response.debug?.rerankComparison?.before.map((result) => result.url)).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
    expect(response.debug?.rerankComparison?.after.map((result) => result.url)).toEqual([
      "https://example.com/2",
      "https://example.com/1",
    ]);
  });

  it("reranks the full candidate set instead of only the pre-truncated request.limit", async () => {
    const provider = runtime("recall", async (input) => ({
      results: Array.from({ length: input.limit }, (_, index) => ({
        title: `Document ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        snippet: `snippet ${index + 1}`,
      })),
    }));
    const embedding = {
      config: { modelId: "fake-embedding" },
      embed: async (texts: string[]) => ({
        vectors: texts.map((text, index) => index === 0 || text.includes("Document 11") ? [1, 0] : [0, 1]),
        modelId: "fake-embedding",
        dimensions: 2,
      }),
    };
    const service = serviceWith({
      findDefault: (kind: string) => kind === "embedding" ? embedding : null,
      embeddingModel: () => embedding,
      getEnabled: () => { throw new Error("unexpected explicit model"); },
      resolveConfig: () => null,
    }, [provider]);

    const response = await service.execute(
      { query: "semantic recall", mode: "embedding", limit: 10, skipCache: true },
      { evaluate: true },
    );

    expect(response.results[0]?.url).toBe("https://example.com/11");
  });

  it("deep-merges tracking-parameter variants across subqueries and providers by normalized URL", async () => {
    const first = runtime("first", async (input) => input.query === "q1"
      ? { results: [{ title: "Article", url: "https://example.com/article?a=1&utm_source=first", snippet: "same body" }] }
      : { results: [] });
    const second = runtime("second", async (input) => input.query === "q2"
      ? { results: [{ title: "Article", url: "https://example.com/article?utm_source=second&a=1", snippet: "same body" }] }
      : { results: [] });
    const service = serviceWith({ chatModel: () => chatReturning(["q2"]) }, [first, second]);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "q1", mode: "deep", limit: 10, skipCache: true },
      [first, second],
      new AbortController().signal,
      "task-deep-normalized-dedupe",
    );

    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.sources).toHaveLength(2);
    expect(response.results[0]?.queryOrigins?.map((origin) => origin.queryId)).toEqual(["q1", "q2"]);
    expect(response.results[0]?.queryOrigins?.map((origin) => origin.round)).toEqual([1, 2]);
    expect(response.results[0]?.queryOrigins?.every((origin) => origin.score > 0)).toBe(true);
    expect(response.deepBudget).toMatchObject({ queriesPlanned: 2, roundsPlanned: 2, providerQueryCalls: 4, httpRequests: 0 });
  });

  it("does not let a weak single-source subquery outrank a strong multi-source consensus after score normalization", async () => {
    const makeProvider = (id: string, strong: boolean) => runtime(id, async (input) => {
      if (input.query === "weak") {
        return id === "p1"
          ? { results: [{ title: "Weak winner", url: "https://example.com/weak", snippet: "single source" }] }
          : { results: [{ title: "Strong consensus", url: "https://example.com/strong", snippet: "three sources" }] };
      }
      return strong
        ? { results: [{ title: "Strong consensus", url: "https://example.com/strong", snippet: "three sources" }] }
        : { results: [] };
    });
    const providers = [makeProvider("p1", true), makeProvider("p2", true), makeProvider("p3", true)];
    const service = serviceWith({ chatModel: () => chatReturning(["strong"]) }, providers);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "weak", mode: "deep", limit: 10, skipCache: true },
      providers,
      new AbortController().signal,
      "task-deep-score-bias",
    );

    expect(response.results[0]?.url).toBe("https://example.com/strong");
  });
});
