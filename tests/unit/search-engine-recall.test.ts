import { describe, expect, it } from "vitest";
import { executeSearch, type ProviderRuntime } from "@search-hub/core";
import type { ProviderSearchOutput, SafeFetch, SearchProviderAdapter } from "@search-hub/shared";

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
