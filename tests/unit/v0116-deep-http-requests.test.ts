import { describe, expect, it } from "vitest";
import type { ProviderRuntime } from "@search-hub/core";
import type { SafeFetch, SearchRequest, SearchResponse } from "@search-hub/shared";
import { SearchService } from "../../apps/api/src/services/search.js";

interface DeepRunner {
  runDeep(
    request: SearchRequest,
    runtimes: ProviderRuntime[],
    signal: AbortSignal,
    taskId: string,
  ): Promise<SearchResponse>;
}

function harness(fetch: SafeFetch, failQuery?: string) {
  const adapter = {
    type: "fake",
    requiresKey: false,
    supportsTest: false,
    search: async (input: { query: string }, context: { fetch: SafeFetch }) => {
      await context.fetch("https://fake.test/a");
      await context.fetch("https://fake.test/b");
      if (failQuery === "*" || input.query === failQuery) {
        throw new Error("rewrite failed after two requests");
      }
      return { results: [{ title: "row", url: "https://example.org/row", snippet: "x" }] };
    },
  };
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
    adapter,
    scheduler: {} as ProviderRuntime["scheduler"],
    enabled: true,
    requiresKey: false,
    breaker: { failures: 0, openUntilMs: null },
  };
  const chat = {
    config: { modelId: "fake-chat" },
    complete: async () => ({
      text: JSON.stringify({ queries: ["rewrite one", "rewrite two", "rewrite three"] }),
      modelId: "fake-chat",
    }),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const service = new SearchService({
    db: {},
    providers: { resolveKey: async () => undefined, credentialVersion: () => "none" },
    models: { chatModel: () => chat },
    settings: { get: () => ({ defaults: { timeoutMs: 5_000, limit: 10 } }) },
    fetch,
    logger,
  } as unknown as ConstructorParameters<typeof SearchService>[0]);
  return { service, runtime };
}

describe("BUG-0116-02 Deep Search physical request accounting", () => {
  it("sums httpRequests across three rewrites instead of keeping the first sub-search", async () => {
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
    const { service, runtime } = harness(fetch);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "original", mode: "deep", limit: 5, skipCache: true },
      [runtime],
      new AbortController().signal,
      "task-deep-accounting",
    );
    const stat = response.stats.providers.find((item) => item.providerId === "prv_fake");

    expect(response.debug?.rewrittenQueries).toHaveLength(3);
    expect(wire).toBe(6);
    expect(stat).toMatchObject({ attempts: 3, resultCount: 3, httpRequests: 6 });
  });

  it("includes a failed rewrite's two physical requests without changing result semantics", async () => {
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
    const { service, runtime } = harness(fetch, "rewrite two");

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "original", mode: "deep", limit: 5, skipCache: true },
      [runtime],
      new AbortController().signal,
      "task-deep-failed-rewrite",
    );
    const stat = response.stats.providers.find((item) => item.providerId === "prv_fake");

    expect(wire).toBe(6);
    expect(response.status).toBe("partial");
    expect(response.results).toHaveLength(1);
    expect(response.errors.some((item) => item.query === "rewrite two")).toBe(true);
    expect(stat).toMatchObject({ attempts: 3, resultCount: 2, httpRequests: 6 });
  });

  it("counts all six physical requests when every rewrite fails and runDeep exits early", async () => {
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
    const { service, runtime } = harness(fetch, "*");

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "original", mode: "deep", limit: 5, skipCache: true },
      [runtime],
      new AbortController().signal,
      "task-deep-all-failed",
    );
    const stat = response.stats.providers[0];

    expect(response.status).toBe("failed");
    expect(response.results).toEqual([]);
    expect(wire).toBe(6);
    expect(stat).toMatchObject({
      providerId: "prv_fake",
      attempts: 3,
      resultCount: 0,
      httpRequests: 6,
    });
  });

  it("keeps a zero-request sub-search at zero when merging", async () => {
    const fetch = (async () => ({
      status: 200,
      url: "https://fake.test/unused",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({}),
      text: async () => "{}",
    })) as unknown as SafeFetch;
    const { service, runtime } = harness(fetch);

    const response = await (service as unknown as DeepRunner).runDeep(
      { query: "original", mode: "deep", limit: 5, skipCache: true },
      [runtime],
      new AbortController().signal,
      "task-deep-zero",
    );
    const stat = response.stats.providers.find((item) => item.providerId === "prv_fake");

    expect(stat).toMatchObject({ attempts: 3, resultCount: 3, httpRequests: 0 });
  });
});
