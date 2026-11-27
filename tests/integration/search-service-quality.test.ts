import { describe, expect, it } from "vitest";
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

function serviceWith(models: Record<string, unknown>, runtimes: ProviderRuntime[]): SearchService {
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
    fetch: unusedFetch,
    logger,
    health: { blockedProviders: () => new Map() },
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
    expect(response.results[0]?.queryOrigins?.every((origin) => origin.score > 0)).toBe(true);
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
