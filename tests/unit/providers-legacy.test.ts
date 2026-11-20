import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createSafeFetch,
  type ProviderContext,
  type ProviderRuntimeConfig,
  type SafeFetch,
} from "@search-hub/shared";
import { getAdapter, legacySearchHubAdapter } from "@search-hub/providers";

/**
 * Contract tests for the legacy Search Hub compatibility adapter.
 *
 * The "old" service is represented by a local HTTP server. Nothing here talks
 * to a real 44475 instance: the adapter is expected to be reversible and
 * read-only, and this suite pins the two properties that make that true:
 *   - it only ever issues POST to the configured path (never writes elsewhere);
 *   - it never sends Authorization when no key is configured.
 *
 * Live evidence against a real legacy instance is a separate, authorised step.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 0, allowHttp: true },
});

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

async function startServer(
  respond: (request: CapturedRequest) => MockReply,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      const reply = respond(captured);
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function makeCtx(options: {
  baseUrl: string;
  apiKey?: string;
  config?: Record<string, unknown>;
  type?: string;
}): ProviderContext {
  const runtime: ProviderRuntimeConfig = {
    id: "prv_legacy",
    name: "legacy",
    type: options.type ?? "search-hub-legacy",
    baseUrl: options.baseUrl,
    timeoutMs: 5000,
    maxResults: 10,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config: options.config ?? {},
  };
  return {
    fetch: allowLocalFetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    config: runtime,
    signal: AbortSignal.timeout(5000),
    logger: console as never,
  };
}

const RESULT = {
  title: "旧版结果",
  url: "https://example-news.cn/article/1",
  snippet: "来自旧服务的摘要",
  publishedAt: "2026-11-01T00:00:00.000Z",
  provider: "brave-legacy",
  score: 0.7,
};

describe("legacy Search Hub adapter: request shape", () => {
  it("POSTs to /api/search with query, mode, limit and forwards freshness/language", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [RESULT] }),
    }));
    const ctx = makeCtx({ baseUrl, apiKey: "sh_legacy_token" });

    const output = await legacySearchHubAdapter.search(
      { query: "量子计算", limit: 5, freshness: "month", language: "zh-CN", signal: ctx.signal },
      ctx,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("/api/search");
    expect(requests[0]!.headers["authorization"]).toBe("Bearer sh_legacy_token");
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: "量子计算",
      mode: "rrf",
      limit: 5,
      freshness: "month",
      language: "zh-CN",
    });
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.url).toBe(RESULT.url);
  });

  it("honours a custom path and mode", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [RESULT] }),
    }));
    const ctx = makeCtx({ baseUrl, config: { path: "/gateway/search", mode: "basic" } });

    await legacySearchHubAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/gateway/search");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ query: "x", mode: "basic" });
  });

  it("sends no Authorization header when no key is configured", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [RESULT] }),
    }));
    const ctx = makeCtx({ baseUrl });

    await legacySearchHubAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx);

    expect(requests[0]!.headers["authorization"]).toBeUndefined();
  });

  it("omits freshness/language when the caller did not ask for them", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [RESULT] }),
    }));
    const ctx = makeCtx({ baseUrl });

    await legacySearchHubAdapter.search(
      { query: "x", limit: 2, freshness: "all", signal: ctx.signal },
      ctx,
    );

    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("freshness");
    expect(body).not.toHaveProperty("language");
  });
});

describe("legacy Search Hub adapter: response shapes", () => {
  it("accepts {results:[]}", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ results: [RESULT, { ...RESULT, url: "https://b.test/2" }] }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 10, signal: ctx.signal },
      ctx,
    );
    expect(output.results.map((item) => item.url)).toEqual([RESULT.url, "https://b.test/2"]);
    expect(output.requestUrl).toContain("/api/search");
  });

  it("accepts {data:{results:[]}}", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ data: { results: [RESULT] } }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 10, signal: ctx.signal },
      ctx,
    );
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.title).toBe(RESULT.title);
  });

  it("maps alternative field names (name/link/content)", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        results: [{ name: "标题", link: "https://alt.test/a", content: "摘要" }],
      }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 5, signal: ctx.signal },
      ctx,
    );
    expect(output.results[0]).toMatchObject({
      title: "标题",
      url: "https://alt.test/a",
      snippet: "摘要",
    });
  });

  it("drops non-absolute URLs instead of returning junk", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ results: [{ title: "坏链接", url: "/relative" }, RESULT] }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 5, signal: ctx.signal },
      ctx,
    );
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.url).toBe(RESULT.url);
  });

  it("fails with bad_request when neither shape is present", async () => {
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ ok: true }) }));
    const ctx = makeCtx({ baseUrl });
    await expect(
      legacySearchHubAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx),
    ).rejects.toMatchObject({ code: "bad_request", providerType: "search-hub-legacy" });
  });
});

describe("legacy Search Hub adapter: error mapping", () => {
  const cases: Array<[number, string, boolean]> = [
    [401, "auth_invalid", false],
    [403, "blocked", false],
    [429, "rate_limited", true],
    [500, "server_error", true],
    [503, "server_error", true],
  ];

  for (const [status, code, retryable] of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const { baseUrl } = await startServer(() => ({
        status,
        ...(status === 429 ? { headers: { "retry-after": "30" } } : {}),
        body: JSON.stringify({ error: { message: `legacy ${status}` } }),
      }));
      const ctx = makeCtx({ baseUrl });
      const error = await legacySearchHubAdapter
        .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code, retryable });
      if (status === 429) expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
    });
  }

  it("surfaces a caller cancellation as cancelled, not a network failure", async () => {
    const server = createServer(() => {
      // Accept the request and never respond: the caller's signal must fire.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const ctx: ProviderContext = {
      ...makeCtx({ baseUrl: `http://127.0.0.1:${port}` }),
      signal: AbortSignal.timeout(150),
    };
    const error = await legacySearchHubAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "cancelled", retryable: false });
  });
});

describe("legacy Search Hub adapter: upstream status envelopes", () => {
  it("fails on status=failed even when results is an empty array", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        status: "failed",
        results: [],
        errors: [{ providerName: "brave-legacy", code: "rate_limited", message: "quota" }],
      }),
    }));
    const ctx = makeCtx({ baseUrl });
    const error = await legacySearchHubAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "rate_limited" });
    expect((error as Error).message).toContain("reported failure");
  });

  it("maps status=failed first when results[] is missing entirely", async () => {
    // Ordering regression: a failed envelope may omit results[]. Checking for
    // results[] first would turn the upstream error into a generic bad_request.
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        status: "failed",
        errors: [{ providerName: "brave-legacy", code: "auth_invalid", message: "token revoked" }],
      }),
    }));
    const ctx = makeCtx({ baseUrl });
    const error = await legacySearchHubAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
    expect((error as Error).message).toContain("reported failure");
    expect((error as Error).message).not.toContain("no results[] array");
  });

  it("maps status=failed with no errors[] at all to a retryless bad_request naming the status", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ status: "failed" }),
    }));
    const ctx = makeCtx({ baseUrl });
    const error = await legacySearchHubAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request", retryable: false });
    expect((error as Error).message).toContain("status=failed");
  });

  it("keeps results but returns a warning on status=partial", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        status: "partial",
        results: [RESULT],
        errors: [{ providerName: "bocha-legacy", code: "timeout", message: "slow" }],
      }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 5, signal: ctx.signal },
      ctx,
    );
    expect(output.results).toHaveLength(1);
    expect(output.warnings?.[0]).toContain("status=partial");
    expect(output.warnings?.[0]).toContain("bocha-legacy");
  });

  it("treats status=completed with zero results as a legitimate empty result", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ status: "completed", results: [], errors: [] }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 5, signal: ctx.signal },
      ctx,
    );
    expect(output.results).toEqual([]);
    expect(output.warnings).toBeUndefined();
  });

  it("accepts the envelope under data.* including status", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ data: { status: "failed", results: [], errors: [{ code: "server_error" }] } }),
    }));
    const ctx = makeCtx({ baseUrl });
    const error = await legacySearchHubAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "server_error", retryable: true });
  });
});

describe("legacy Search Hub adapter: upstream attribution", () => {
  it("preserves provider/providerName/source/sources verbatim", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        results: [
          {
            ...RESULT,
            provider: "brave",
            providerName: "Brave Search",
            source: "brave-web",
            sources: [{ providerName: "brave" }, "news"],
          },
        ],
      }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 5, signal: ctx.signal },
      ctx,
    );
    expect(output.results[0]!.upstream).toEqual({
      provider: "brave",
      providerName: "Brave Search",
      source: "brave-web",
      sources: ["brave", "news"],
    });
  });

  it("does not invent upstream attribution when the gateway omits it", async () => {
    const { provider: _provider, ...bare } = RESULT;
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ results: [bare] }),
    }));
    const ctx = makeCtx({ baseUrl });
    const output = await legacySearchHubAdapter.search(
      { query: "x", limit: 5, signal: ctx.signal },
      ctx,
    );
    expect(output.results[0]!.upstream).toBeUndefined();
  });
});

describe("legacy Search Hub adapter: transport extensibility", () => {
  const rejected: Array<[string, unknown]> = [
    ["a string other than rest", "mcp"],
    ["a padded unknown string", "  MCP "],
    ["an empty-ish unknown string", "graphql"],
    ["a number", 1],
    ["a boolean", true],
    ["an object", { kind: "mcp" }],
    ["an array", ["rest", "mcp"]],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label} instead of falling back to REST`, async () => {
      let calls = 0;
      const { baseUrl } = await startServer(() => {
        calls += 1;
        return { body: JSON.stringify({ results: [RESULT] }) };
      });
      const ctx = makeCtx({ baseUrl, config: { transport: value } });
      const error = await legacySearchHubAdapter
        .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "unsupported", statusCode: 501 });
      // No request may be attempted: a silent REST fallback would show up here.
      expect(calls).toBe(0);
    });
  }

  it("treats undefined, null and an empty string as the REST default", async () => {
    for (const value of [undefined, null, "", "   "]) {
      const { baseUrl, requests } = await startServer(() => ({
        body: JSON.stringify({ results: [RESULT] }),
      }));
      const ctx = makeCtx({ baseUrl, config: { transport: value } });
      const output = await legacySearchHubAdapter.search(
        { query: "x", limit: 5, signal: ctx.signal },
        ctx,
      );
      expect(output.results).toHaveLength(1);
      expect(requests[0]!.url).toBe("/api/search");
    }
  });

  it("accepts the explicit rest value", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [RESULT] }),
    }));
    const ctx = makeCtx({ baseUrl, config: { transport: "rest" } });
    await legacySearchHubAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.url).toBe("/api/search");
  });
});

describe("legacy Search Hub adapter: registry wiring", () => {
  it("is registered and listed with its honest verification status", () => {
    expect(getAdapter("search-hub-legacy")).toBe(legacySearchHubAdapter);
    expect(legacySearchHubAdapter.requiresKey).toBe(false);
    expect(legacySearchHubAdapter.supportsTest).toBe(true);
  });
});
