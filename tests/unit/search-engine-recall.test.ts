import { describe, expect, it } from "vitest";
import { executeSearch, type ProviderRuntime } from "@search-hub/core";
import { searchRequestSchema, type ProviderSearchOutput, type SafeFetch, type SearchProviderAdapter } from "@search-hub/shared";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const unusedFetch: SafeFetch = async () => {
  throw new Error("fetch should not be called by the fake adapter");
};

function runtimeReturning(
  type: string,
  search: SearchProviderAdapter["search"],
): ProviderRuntime {
  return {
    config: {
      id: `prv_${type}`,
      name: type,
      type,
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
    adapter: { type, requiresKey: false, supportsTest: false, search },
    scheduler: {} as ProviderRuntime["scheduler"],
    enabled: true,
    requiresKey: false,
    breaker: { failures: 0, openUntilMs: null },
  };
}

describe("search engine recall regressions", () => {
  it("accepts perProviderLimit through 100 and rejects 101", () => {
    expect(searchRequestSchema.parse({ query: "x", perProviderLimit: 100 }).perProviderLimit).toBe(100);
    expect(() => searchRequestSchema.parse({ query: "x", perProviderLimit: 101 })).toThrow();
  });

  it("does not cap a single-provider limit=100 request to 50 candidates", async () => {
    const runtime = runtimeReturning("many", async (input) => ({
      results: Array.from({ length: input.limit }, (_, index) => ({
        title: `Document ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        snippet: `snippet ${index + 1}`,
      })),
    } satisfies ProviderSearchOutput));

    const response = await executeSearch(
      { runtimes: [runtime], fetch: unusedFetch, credentials: { getKeyValue: async () => undefined }, logger },
      { query: "recall", mode: "basic", limit: 100 },
      { taskId: "task-recall-100" },
    );

    expect(response.results).toHaveLength(100);
    expect(response.results.at(-1)?.url).toBe("https://example.com/100");
  });

  it("keeps the full candidate pool in debug while reporting the final returned count", async () => {
    const runtime = runtimeReturning("pool", async (input) => ({
      results: Array.from({ length: input.limit }, (_, index) => ({
        title: `Document ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        snippet: `snippet ${index + 1}`,
      })),
    } satisfies ProviderSearchOutput));

    const response = await executeSearch(
      { runtimes: [runtime], fetch: unusedFetch, credentials: { getKeyValue: async () => undefined }, logger },
      { query: "pool", mode: "basic", limit: 10, perProviderLimit: 100 },
      { taskId: "task-candidate-pool" },
    );

    expect(response.results).toHaveLength(100);
    expect(response.debug?.perProviderResults?.[0]?.results).toHaveLength(100);
    expect(response.stats.funnel).toMatchObject({
      candidateSelectedCount: 100,
      rankingInputCount: 100,
      returnedCount: 10,
    });
  });

  it("reports funnel identities and deterministic truncation reasons", async () => {
    const runtime = runtimeReturning("funnel", async () => ({
      results: [
        { title: "", url: "https://example.com/invalid-title", snippet: "invalid" },
        { title: "Invalid URL", url: "not-a-url", snippet: "invalid" },
        { title: "Shared", url: "https://example.com/shared?utm_source=a", snippet: "a sufficiently long shared body for deduplication" },
        { title: "Shared", url: "https://example.com/shared?utm_source=b", snippet: "a sufficiently long shared body for deduplication" },
        { title: "TypeScript Monorepo Guide", url: "https://example.com/a", snippet: "a sufficiently long shared snippet for near duplicate detection" },
        { title: "TypeScript Monorepo Guide!", url: "https://example.com/b", snippet: "a sufficiently long shared snippet for near duplicate detection" },
      ],
    } satisfies ProviderSearchOutput));

    const response = await executeSearch(
      { runtimes: [runtime], fetch: unusedFetch, credentials: { getKeyValue: async () => undefined }, logger },
      { query: "funnel", mode: "rrf", limit: 10 },
      { taskId: "task-funnel" },
    );

    const funnel = response.stats.funnel!;
    expect(funnel.rawReceived).toBe(funnel.invalidDropped + funnel.eligible);
    expect(funnel.eligible).toBe(funnel.exactDuplicateDropped + funnel.nearDuplicateDropped + funnel.dedupedCount);
    expect(funnel.dedupedCount).toBe(funnel.candidateTruncatedCount + funnel.candidateSelectedCount);
    expect(funnel.rankingInputCount).toBe(funnel.candidateSelectedCount);
    expect(funnel.returnedCount).toBeLessThanOrEqual(Math.min(10, funnel.candidateSelectedCount));
    expect(funnel.invalidDropped).toBe(2);
    expect(funnel.exactDuplicateDropped).toBe(1);
    expect(funnel.nearDuplicateDropped).toBe(1);
  });

  it("bounds the post-dedupe ranking pool at 200 candidates", async () => {
    const runtimes = Array.from({ length: 3 }, (_, providerIndex) => runtimeReturning(`p${providerIndex}`, async (input) => ({
      results: Array.from({ length: input.limit }, (_, index) => ({
        title: `Provider ${providerIndex} document ${index + 1}`,
        url: `https://example.com/${providerIndex}/${index + 1}`,
        snippet: `body ${providerIndex}/${index + 1}`,
      })),
    } satisfies ProviderSearchOutput)));

    const response = await executeSearch(
      { runtimes, fetch: unusedFetch, credentials: { getKeyValue: async () => undefined }, logger },
      { query: "cap", mode: "rrf", limit: 100, perProviderLimit: 100 },
      { taskId: "task-candidate-cap" },
    );

    expect(response.stats.funnel).toMatchObject({
      dedupedCount: 300,
      candidateSelectedCount: 200,
      candidateTruncatedCount: 100,
      rankingInputCount: 200,
      returnedCount: 100,
    });
    expect(response.stats.truncationReasons).toContainEqual({ reason: "candidate_pool_limit", count: 100 });
  });

  it("caps selected providers at eight and records the provider truncation", async () => {
    const runtimes = Array.from({ length: 10 }, (_, index) => runtimeReturning(`p${index}`, async () => ({
      results: [{ title: `Result ${index}`, url: `https://example.com/${index}`, snippet: "body" }],
    } satisfies ProviderSearchOutput)));

    const response = await executeSearch(
      { runtimes, fetch: unusedFetch, credentials: { getKeyValue: async () => undefined }, logger },
      { query: "providers", mode: "basic", limit: 10 },
      { taskId: "task-provider-cap" },
    );

    expect(response.stats.requestedProviderCount).toBe(10);
    expect(response.stats.selectedProviderCount).toBe(8);
    expect(response.debug?.selectedProviderIds).toHaveLength(8);
    expect(response.stats.truncationReasons).toContainEqual({ reason: "provider_limit", count: 2 });
  });

  it("does not collapse same-title pages with different URLs and bodies", async () => {
    const runtime = runtimeReturning("titles", async () => ({
      results: [
        { title: "OpenAI API Documentation Guide", url: "https://example.com/docs/api", snippet: "Endpoint reference and authentication" },
        { title: "OpenAI API Documentation Guide", url: "https://example.com/guides/api", snippet: "Step-by-step migration guide with examples" },
      ],
    } satisfies ProviderSearchOutput));

    const response = await executeSearch(
      { runtimes: [runtime], fetch: unusedFetch, credentials: { getKeyValue: async () => undefined }, logger },
      { query: "api docs", mode: "basic", limit: 10 },
      { taskId: "task-title-dedupe" },
    );

    expect(response.results).toHaveLength(2);
    expect(response.stats.dedupedCount).toBe(2);
  });
});
