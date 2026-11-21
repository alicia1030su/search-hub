import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ProviderError,
  createSafeFetch,
  type ProviderRuntimeConfig,
  type SafeFetch,
} from "@search-hub/shared";
import { braveAdapter, genericHttpAdapter, mockAdapter, searxngAdapter, validateGenericConfig } from "@search-hub/providers";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function startServer(handler: Parameters<typeof createServer>[1]): Promise<{ baseUrl: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, port };
}

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 2, allowHttp: true },
});

function config(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    id: "prv_test",
    name: "test",
    type: "mock",
    baseUrl: null,
    timeoutMs: 5000,
    maxResults: 10,
    language: "zh",
    freshness: null,
    model: null,
    maxRetries: 1,
    breakerThreshold: 3,
    breakerCooldownMs: 30000,
    config: {},
    ...overrides,
  };
}

describe("searxng adapter", () => {
  it("maps a real SearXNG JSON response", async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (!req.url?.includes("format=json")) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          query: "typescript",
          results: [
            {
              title: "TypeScript <b>Handbook</b>",
              url: "https://www.typescriptlang.org/docs/",
              content: "The TypeScript handbook",
              engine: "google",
              score: 1.2,
              publishedDate: "2024-05-01T00:00:00+00:00",
            },
          ],
        }),
      );
    });

    const result = await searxngAdapter.search(
      { query: "typescript", limit: 5, signal: AbortSignal.timeout(5000) },
      {
        fetch: allowLocalFetch,
        config: config({ type: "searxng", baseUrl }),
        signal: AbortSignal.timeout(5000),
        logger: console as never,
      },
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe("TypeScript Handbook");
    expect(result.results[0]!.url).toBe("https://www.typescriptlang.org/docs/");
    expect(result.results[0]!.snippet).toBe("The TypeScript handbook");
    expect(result.results[0]!.publishedAt).toBe("2024-05-01T00:00:00.000Z");
  });

  it("explains the JSON-format requirement when rejected with 403", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
    });
    await expect(
      searxngAdapter.search(
        { query: "x", limit: 3, signal: AbortSignal.timeout(3000) },
        {
          fetch: allowLocalFetch,
          config: config({ type: "searxng", baseUrl }),
          signal: AbortSignal.timeout(3000),
          logger: console as never,
        },
      ),
    ).rejects.toThrow(/JSON format/i);
  });

  it("requires a base URL", async () => {
    await expect(
      searxngAdapter.search(
        { query: "x", limit: 3, signal: AbortSignal.timeout(3000) },
        {
          fetch: allowLocalFetch,
          config: config({ type: "searxng", baseUrl: null }),
          signal: AbortSignal.timeout(3000),
          logger: console as never,
        },
      ),
    ).rejects.toThrow(/base URL/i);
  });

  it("treats a malformed payload as an error, not as zero results", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: "not-an-array" }));
    });
    await expect(
      searxngAdapter.search(
        { query: "x", limit: 3, signal: AbortSignal.timeout(3000) },
        {
          fetch: allowLocalFetch,
          config: config({ type: "searxng", baseUrl }),
          signal: AbortSignal.timeout(3000),
          logger: console as never,
        },
      ),
    ).rejects.toThrow(/results array/i);
  });
});

describe("brave adapter", () => {
  it("sends the subscription token header and maps web results", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const { baseUrl } = await startServer((req, res) => {
      seenAuth = String(req.headers["x-subscription-token"] ?? "");
      seenUrl = String(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave result",
                url: "https://example.com/brave",
                description: "A result from Brave",
                page_age: "2025-01-15T10:00:00",
                language: "en",
              },
            ],
          },
        }),
      );
    });

    const result = await braveAdapter.search(
      { query: "search engine", limit: 5, freshness: "week", language: "zh-CN", signal: AbortSignal.timeout(4000) },
      {
        fetch: allowLocalFetch,
        apiKey: "sk-test-token",
        config: config({ type: "brave", baseUrl }),
        signal: AbortSignal.timeout(4000),
        logger: console as never,
      },
    );
    expect(seenAuth).toBe("sk-test-token");
    expect(seenUrl).toContain("/res/v1/web/search");
    expect(seenUrl).toContain("freshness=pw");
    expect(seenUrl).toContain("search_lang=zh-hans");
    expect(result.results[0]!.title).toBe("Brave result");
  });

  it("fails fast without a key", async () => {
    await expect(
      braveAdapter.search(
        { query: "x", limit: 3, signal: AbortSignal.timeout(2000) },
        {
          fetch: allowLocalFetch,
          config: config({ type: "brave" }),
          signal: AbortSignal.timeout(2000),
          logger: console as never,
        },
      ),
    ).rejects.toThrow(/API key is missing/i);
  });

  it("maps 401 to auth_invalid so the scheduler can suspend the key", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid subscription token" } }));
    });
    const error = (await braveAdapter
      .search(
        { query: "x", limit: 3, signal: AbortSignal.timeout(3000) },
        {
          fetch: allowLocalFetch,
          apiKey: "bad",
          config: config({ type: "brave", baseUrl }),
          signal: AbortSignal.timeout(3000),
          logger: console as never,
        },
      )
      .catch((caught) => caught)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("auth_invalid");
    expect((error as ProviderError).retryable).toBe(false);
  });

  it("maps upstream 403 to blocked and preserves its trusted upstream status", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No entitlement" } }));
    });
    const error = (await braveAdapter
      .search(
        { query: "x", limit: 3, signal: AbortSignal.timeout(3000) },
        {
          fetch: allowLocalFetch,
          apiKey: "restricted",
          config: config({ type: "brave", baseUrl }),
          signal: AbortSignal.timeout(3000),
          logger: console as never,
        },
      )
      .catch((caught) => caught)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("blocked");
    expect(error.details).toMatchObject({ upstreamStatus: 403 });
  });

  it("maps 429 with Retry-After to rate_limited", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ error: { message: "Too many requests" } }));
    });
    const error = (await braveAdapter
      .search(
        { query: "x", limit: 3, signal: AbortSignal.timeout(3000) },
        {
          fetch: allowLocalFetch,
          apiKey: "sk",
          config: config({ type: "brave", baseUrl }),
          signal: AbortSignal.timeout(3000),
          logger: console as never,
        },
      )
      .catch((caught) => caught)) as ProviderError;
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(7000);
  });
});

describe("generic http adapter", () => {
  it("rejects unsafe or invalid declarative configs", () => {
    expect(validateGenericConfig({ method: "PUT" })[0]).toMatch(/method/);
    expect(validateGenericConfig({ resultsPath: "../../secrets" })[0]).toMatch(/safe dotted path/);
    expect(validateGenericConfig({ mapping: { title: "a;rm -rf /" } })[0]).toMatch(/safe dotted path/);
    expect(validateGenericConfig({ keyInjection: { in: "body", name: "a..b" } })[0]).toMatch(/safe dotted path/);
    expect(validateGenericConfig({})).toHaveLength(0);
  });

  it("injects the key into a header and maps nested results", async () => {
    let auth = "";
    const { baseUrl } = await startServer((req, res) => {
      auth = String(req.headers["x-api-key"] ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: { items: [{ name: "Generic hit", link: "https://example.com/g", text: "body" }] },
        }),
      );
    });

    const result = await genericHttpAdapter.search(
      { query: "hello", limit: 4, signal: AbortSignal.timeout(4000) },
      {
        fetch: allowLocalFetch,
        apiKey: "sk-generic",
        config: config({
          type: "generic-http",
          baseUrl,
          config: {
            method: "POST",
            path: "/v1/search",
            keyInjection: { in: "header", name: "x-api-key" },
            query: { q: "{{query}}", count: "{{limit}}" },
            body: { query: "{{query}}" },
            resultsPath: "data.items",
            mapping: { title: "name", url: "link", snippet: "text" },
          },
        }),
        signal: AbortSignal.timeout(4000),
        logger: console as never,
      },
    );
    expect(auth).toBe("sk-generic");
    expect(result.results[0]!.title).toBe("Generic hit");
    expect(result.results[0]!.url).toBe("https://example.com/g");
  });

  it("reports a clear error when the mapping path misses", async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ unexpected: [] }));
    });
    await expect(
      genericHttpAdapter.search(
        { query: "q", limit: 2, signal: AbortSignal.timeout(3000) },
        {
          fetch: allowLocalFetch,
          config: config({ type: "generic-http", baseUrl, config: { resultsPath: "data.items" } }),
          signal: AbortSignal.timeout(3000),
          logger: console as never,
        },
      ),
    ).rejects.toThrow(/did not resolve to an array/i);
  });
});

describe("mock adapter", () => {
  it("is deterministic for the same query", async () => {
    const ctx = {
      fetch: allowLocalFetch,
      config: config({ type: "mock", config: { resultCount: 4, latencyMs: 0, namespace: "n" } }),
      signal: AbortSignal.timeout(3000),
      logger: console as never,
    };
    const a = await mockAdapter.search({ query: "same", limit: 4, signal: AbortSignal.timeout(3000) }, ctx);
    const b = await mockAdapter.search({ query: "same", limit: 4, signal: AbortSignal.timeout(3000) }, ctx);
    expect(a.results.map((item) => item.url)).toEqual(b.results.map((item) => item.url));
  });

  it("shares a URL across instances so de-duplication is testable", async () => {
    const ctx = {
      fetch: allowLocalFetch,
      config: config({ type: "mock", config: { resultCount: 3 } }),
      signal: AbortSignal.timeout(3000),
      logger: console as never,
    };
    const result = await mockAdapter.search({ query: "shared", limit: 3, signal: AbortSignal.timeout(3000) }, ctx);
    expect(result.results.some((item) => (item.url ?? "").includes("/shared/"))).toBe(true);
  });

  it("injects failures deterministically", async () => {
    const ctx = {
      fetch: allowLocalFetch,
      config: config({ type: "mock", config: { failMode: "rate_limited" } }),
      signal: AbortSignal.timeout(3000),
      logger: console as never,
    };
    const error = (await mockAdapter
      .search({ query: "q", limit: 2, signal: AbortSignal.timeout(3000) }, ctx)
      .catch((caught) => caught)) as ProviderError;
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(2000);
  });
});
