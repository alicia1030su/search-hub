import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SearchHubError,
  createSafeFetch,
  type ProviderContext,
  type ProviderSearchOutput,
  type ProviderRuntimeConfig,
  type SafeFetch,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { arxivAdapter, braveAdapter, githubAdapter, wikipediaAdapter } from "@search-hub/providers";
import { executeSearch, type ProviderRuntime } from "@search-hub/core";

const servers: Server[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 0, allowHttp: true },
});

interface CapturedRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

async function startServer(
  reply: (request: CapturedRequest, index: number) => {
    status?: number;
    body?: string;
    type?: string;
    headers?: Record<string, string>;
  },
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const captured: CapturedRequest = { url: req.url ?? "", headers: req.headers };
    requests.push(captured);
    const out = reply(captured, requests.length - 1);
    res.writeHead(out.status ?? 200, {
      "content-type": out.type ?? "application/json",
      ...out.headers,
    });
    res.end(out.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function runtimeConfig(
  type: string,
  overrides: Partial<ProviderRuntimeConfig> = {},
): ProviderRuntimeConfig {
  return {
    id: `prv_${type}`,
    name: type,
    type,
    baseUrl: "https://stub.invalid",
    timeoutMs: 5_000,
    maxResults: 50,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config: {},
    search: { targetResults: 5, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 5 },
    ...overrides,
  };
}

function providerContext(
  type: string,
  baseUrl: string,
  options: { apiKey?: string; config?: Record<string, unknown>; fetch?: SafeFetch } = {},
): ProviderContext {
  return {
    fetch: options.fetch ?? allowLocalFetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    config: runtimeConfig(type, {
      baseUrl,
      config: options.config ?? {},
    }),
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

function arxivXml(entries = 1): string {
  const rows = Array.from({ length: entries }, (_, index) => `
    <entry>
      <title>Paper ${index + 1}</title>
      <id>https://arxiv.org/abs/${index + 1}</id>
      <summary>Abstract ${index + 1}</summary>
      <published>2026-01-02T00:00:00Z</published>
    </entry>`).join("");
  return `<feed xmlns="http://www.w3.org/2005/Atom">${rows}</feed>`;
}

function wikipediaPayload(pageIds: number[] = [42]): unknown {
  return {
    query: {
      search: pageIds.map((pageId) => ({
        title: `Article ${pageId}`,
        pageid: pageId,
        snippet: `<span class="searchmatch">Hello</span> world`,
        timestamp: "2026-01-02T00:00:00Z",
      })),
    },
  };
}

function githubPayload(urls: string[] = ["https://github.com/a/b"]): unknown {
  return {
    total_count: urls.length,
    incomplete_results: false,
    items: urls.map((url, index) => ({
      full_name: `a/b-${index + 1}`,
      html_url: url,
      description: `Description ${index + 1}`,
      pushed_at: "2026-01-02T00:00:00Z",
      stargazers_count: 7 + index,
      language: "TypeScript",
    })),
  };
}

function serializeBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function throughSearchEngine(
  output: ProviderSearchOutput,
  type: string,
) {
  const adapter: SearchProviderAdapter = {
    type,
    requiresKey: false,
    supportsTest: true,
    search: async () => output,
  };
  const runtime: ProviderRuntime = {
    config: runtimeConfig(type),
    adapter,
    scheduler: {} as ProviderRuntime["scheduler"],
    enabled: true,
    requiresKey: false,
    breaker: { failures: 0, openUntilMs: null },
  };
  return executeSearch(
    {
      runtimes: [runtime],
      fetch: async () => {
        throw new Error("fetch should not be called by the wrapper adapter");
      },
      credentials: { getKeyValue: async () => undefined },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
    { query: "contract", limit: 10, mode: "basic" },
    { taskId: "task_contract" },
  );
}

describe("public provider HTTP and response contracts", () => {
  it.each([
    { name: "Wikipedia", type: "wikipedia", adapter: wikipediaAdapter, body: wikipediaPayload([]), typeHeader: "application/json" },
    { name: "arXiv", type: "arxiv", adapter: arxivAdapter, body: arxivXml(0), typeHeader: "application/atom+xml" },
    { name: "GitHub", type: "github", adapter: githubAdapter, body: githubPayload([]), typeHeader: "application/json" },
  ])("$name accepts a valid empty result", async ({ type, adapter, body, typeHeader }) => {
    const { baseUrl } = await startServer(() => ({ body: serializeBody(body), type: typeHeader }));
    const ctx = providerContext(type, baseUrl);

    const output = await adapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);

    expect(output.results).toEqual([]);
  });

  it.each([
    {
      name: "Wikipedia",
      type: "wikipedia",
      adapter: wikipediaAdapter,
      body: JSON.stringify({ error: { code: "badrequest", info: "invalid query" } }),
      typeHeader: "application/json",
    },
    {
      name: "GitHub",
      type: "github",
      adapter: githubAdapter,
      body: JSON.stringify({ message: "API rate limit exceeded" }),
      typeHeader: "application/json",
    },
    {
      name: "arXiv",
      type: "arxiv",
      adapter: arxivAdapter,
      body: "<feed><error>invalid query</error></feed>",
      typeHeader: "application/atom+xml",
    },
  ])("$name rejects an HTTP 200 business error", async ({ type, adapter, body, typeHeader }) => {
    const { baseUrl } = await startServer(() => ({ body, type: typeHeader }));
    const ctx = providerContext(type, baseUrl);

    await expect(
      adapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx),
    ).rejects.toBeInstanceOf(Error);
  });

  it.each([
    {
      name: "Wikipedia",
      type: "wikipedia",
      adapter: wikipediaAdapter,
      body: JSON.stringify({ query: { search: "not-an-array" } }),
      typeHeader: "application/json",
    },
    {
      name: "GitHub",
      type: "github",
      adapter: githubAdapter,
      body: JSON.stringify({ items: "not-an-array" }),
      typeHeader: "application/json",
    },
    {
      name: "arXiv",
      type: "arxiv",
      adapter: arxivAdapter,
      body: "<html><body>not an Atom feed</body></html>",
      typeHeader: "application/html",
    },
  ])("$name rejects a structurally incompatible HTTP 200 response", async ({ type, adapter, body, typeHeader }) => {
    const { baseUrl } = await startServer(() => ({ body, type: typeHeader }));
    const ctx = providerContext(type, baseUrl);

    await expect(
      adapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it.each([
    { name: "Wikipedia", type: "wikipedia", adapter: wikipediaAdapter, body: wikipediaPayload([]), typeHeader: "application/json" },
    { name: "arXiv", type: "arxiv", adapter: arxivAdapter, body: arxivXml(0), typeHeader: "application/atom+xml" },
    { name: "GitHub", type: "github", adapter: githubAdapter, body: githubPayload([]), typeHeader: "application/json" },
  ])("$name maps HTTP 429 with Retry-After to rate_limited", async ({ type, adapter, body, typeHeader }) => {
    const { baseUrl } = await startServer(() => ({
      status: 429,
      body: serializeBody(body),
      type: typeHeader,
      headers: { "retry-after": "7" },
    }));
    const ctx = providerContext(type, baseUrl);

    await expect(
      adapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 7_000 });
  });

  it.each([
    { name: "Wikipedia", type: "wikipedia", adapter: wikipediaAdapter },
    { name: "arXiv", type: "arxiv", adapter: arxivAdapter },
    { name: "GitHub", type: "github", adapter: githubAdapter },
  ])("$name propagates timeout instead of returning an empty success", async ({ type, adapter }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch: SafeFetch = (_url, init) =>
      new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new SearchHubError("timeout", "timed out", { status: 504, retryable: true })),
          { once: true },
        );
      });
    const ctx = providerContext(type, "https://stub.invalid", { fetch });
    ctx.signal = controller.signal;

    const pending = adapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    setTimeout(() => controller.abort(), 10);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });

  it("continues Brave pagination when a full raw page contains an unmappable row", async () => {
    const { baseUrl, requests } = await startServer((_request, index) => {
      const rows = Array.from({ length: 20 }, (_, row) => ({
        title: `Page ${index + 1} row ${row + 1}`,
        url: index === 0 && row === 0 ? "" : `https://example.org/brave-${index + 1}-${row + 1}`,
        description: "stub",
      }));
      return { body: JSON.stringify({ web: { results: rows } }) };
    });
    const ctx = providerContext("brave", baseUrl, { apiKey: "sk-BRAVE-CONTRACT-0000000000" });
    ctx.config.search = { targetResults: 40, maxPages: 2, maxRequestsPerSearch: 2, pageSize: 20 };

    const output = await braveAdapter.search({ query: "x", limit: 40, signal: ctx.signal }, ctx);

    expect(requests).toHaveLength(2);
    expect(output.results).toHaveLength(39);
    expect(output.warnings ?? []).toHaveLength(0);
  });

  it("normalizes arXiv http identifiers to https", async () => {
    const { baseUrl } = await startServer(() => ({
      body: arxivXml(1).replace("https://arxiv.org/abs/1", "http://arxiv.org/abs/1"),
      type: "application/atom+xml",
    }));
    const ctx = providerContext("arxiv", baseUrl);

    const output = await arxivAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx);

    expect(output.results[0]?.url).toBe("https://arxiv.org/abs/1");
  });

  it("keeps non-paginated public providers on their documented first-page parameters", async () => {
    const wiki = await startServer(() => ({ body: JSON.stringify(wikipediaPayload()) }));
    const wikiCtx = providerContext("wikipedia", wiki.baseUrl);
    await wikipediaAdapter.search({ query: "x", limit: 5, signal: wikiCtx.signal }, wikiCtx);
    const wikiUrl = new URL(wiki.requests[0]!.url, wiki.baseUrl);
    expect(wikiUrl.searchParams.get("srlimit")).toBe("5");
    expect(wikiUrl.searchParams.get("sroffset")).toBeNull();

    const arxiv = await startServer(() => ({ body: arxivXml(), type: "application/atom+xml" }));
    const arxivCtx = providerContext("arxiv", arxiv.baseUrl);
    await arxivAdapter.search({ query: "x", limit: 5, signal: arxivCtx.signal }, arxivCtx);
    const arxivUrl = new URL(arxiv.requests[0]!.url, arxiv.baseUrl);
    expect(arxivUrl.searchParams.get("start")).toBe("0");
    expect(arxivUrl.searchParams.get("max_results")).toBe("5");

    const github = await startServer(() => ({ body: JSON.stringify(githubPayload()) }));
    const githubCtx = providerContext("github", github.baseUrl);
    await githubAdapter.search({ query: "x", limit: 5, signal: githubCtx.signal }, githubCtx);
    const githubUrl = new URL(github.requests[0]!.url, github.baseUrl);
    expect(githubUrl.searchParams.get("page")).toBe("1");
    expect(githubUrl.searchParams.get("per_page")).toBe("5");
  });

  it.each([
    {
      name: "Wikipedia",
      type: "wikipedia",
      adapter: wikipediaAdapter,
      body: JSON.stringify(wikipediaPayload([42, 42])),
      typeHeader: "application/json",
      expectedTitle: "Article 42",
      expectedUrl: /\/\?curid=42$/,
    },
    {
      name: "arXiv",
      type: "arxiv",
      adapter: arxivAdapter,
      body: arxivXml(2).replace("https://arxiv.org/abs/2", "https://arxiv.org/abs/1"),
      typeHeader: "application/atom+xml",
      expectedTitle: "Paper 1",
      expectedUrl: "https://arxiv.org/abs/1",
    },
    {
      name: "GitHub",
      type: "github",
      adapter: githubAdapter,
      body: JSON.stringify(githubPayload(["https://github.com/a/b", "https://github.com/a/b"])),
      typeHeader: "application/json",
      expectedTitle: "a/b-1",
      expectedUrl: "https://github.com/a/b",
    },
  ])("$name maps into SearchResponse and de-duplicates identical URLs", async ({ type, adapter, body, typeHeader, expectedTitle, expectedUrl }) => {
    const { baseUrl } = await startServer(() => ({ body, type: typeHeader }));
    const ctx = providerContext(type, baseUrl);
    const output = await adapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    const response = await throughSearchEngine(output, type);

    expect(output.results).toHaveLength(2);
    expect(response.stats.rawCount).toBe(2);
    expect(response.stats.dedupedCount).toBe(1);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      title: expectedTitle,
      provider: `prv_${type}`,
      providerType: type,
      providerName: type,
    });
    expect(response.results[0]!.url).toMatch(expectedUrl);
    expect(response.results[0]!.sources.length).toBeGreaterThan(0);
  });
});
