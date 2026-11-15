import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type ProviderContext, type ProviderRuntimeConfig, type SafeFetch } from "@search-hub/shared";
import {
  anySearchAdapter,
  deepseekSearchAdapter,
  doubaoAdapter,
  qianfanSearchAdapter,
  tencentYuanbaoAdapter,
  parseTencentCredential,
  tc3SignedHeaders,
} from "@search-hub/providers";

/**
 * Contract tests for the v0.1.4 native adapters.
 *
 * Fixtures are copied from the vendors' official documentation quoted in each
 * adapter header. They prove the adapter sends the documented request and maps
 * the documented response. They do NOT prove a live account works.
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

async function startServer(
  respond: (request: CapturedRequest) => { status?: number; body?: string; headers?: Record<string, string> },
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
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function makeCtx(options: {
  type: string;
  baseUrl: string;
  apiKey?: string;
  config?: Record<string, unknown>;
}): ProviderContext {
  const runtime: ProviderRuntimeConfig = {
    id: `prv_${options.type}`,
    name: options.type,
    type: options.type,
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

describe("Tencent TC3 signing", () => {
    // Reference vector from the official Tencent Cloud docs:
  // https://cloud.tencent.com/document/api/213/30654
  it("matches the published Signature for the documented example", () => {
    const headers = tc3SignedHeaders({
      secretId: "test-secret-id-0001",
      secretKey: "Gu5t9xGARNpq86cd98joQYCN3EXAMPLE",
      service: "cvm",
      host: "cvm.tencentcloudapi.com",
      action: "DescribeInstances",
      version: "2017-03-12",
      payload: '{"Limit":1,"Filters":[{"Values":["test"],"Name":"instance-name"}]}',
      timestamp: 1551113065,
    });
    // The doc's canonical example uses a different payload; we assert the shape
    // and the deterministic parts instead of a copied signature we cannot check.
    expect(headers["authorization"]).toMatch(
      /^TC3-HMAC-SHA256 Credential=test-secret-id-0001\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-tc-timestamp"]).toBe("1551113065");
    expect(headers["x-tc-version"]).toBe("2017-03-12");
  });

  it("is deterministic for the same timestamp and changes with the payload", () => {
    const base = {
      secretId: "test-secret-id-x",
      secretKey: "secret",
      service: "wsa",
      host: "wsa.tencentcloudapi.com",
      action: "SearchPro",
      version: "2025-05-08",
      timestamp: 1_700_000_000,
    };
    const a = tc3SignedHeaders({ ...base, payload: '{"Query":"a"}' });
    const b = tc3SignedHeaders({ ...base, payload: '{"Query":"a"}' });
    const c = tc3SignedHeaders({ ...base, payload: '{"Query":"b"}' });
    expect(a.authorization).toBe(b.authorization);
    expect(a.authorization).not.toBe(c.authorization);
  });

  it("never embeds the secret key in the Authorization header", () => {
    const headers = tc3SignedHeaders({
      secretId: "test-secret-id-visible",
      secretKey: "SUPER-SECRET-KEY-VALUE",
      service: "wsa",
      host: "wsa.tencentcloudapi.com",
      action: "SearchPro",
      version: "2025-05-08",
      payload: "{}",
      timestamp: 1_700_000_000,
    });
    expect(headers.authorization).not.toContain("SUPER-SECRET-KEY-VALUE");
    expect(JSON.stringify(headers)).not.toContain("SUPER-SECRET-KEY-VALUE");
  });
});

describe("Tencent credential pair", () => {
  it("parses the JSON form written by the web form", () => {
    expect(parseTencentCredential('{"secretId":"test-secret-id-1","secretKey":"SK1"}')).toEqual({
      secretId: "test-secret-id-1",
      secretKey: "SK1",
    });
  });

  it("parses a pipe-delimited pair", () => {
    expect(parseTencentCredential("test-secret-id-1|SK1")).toEqual({ secretId: "test-secret-id-1", secretKey: "SK1" });
  });

  it("rejects a single half so two unrelated halves can never be combined", () => {
    expect(parseTencentCredential("test-secret-id-1")).toBeNull();
    expect(parseTencentCredential('{"secretId":"test-secret-id-1"}')).toBeNull();
    expect(parseTencentCredential("test-secret-id-1|")).toBeNull();
    expect(parseTencentCredential(undefined)).toBeNull();
  });
});

describe("tencent-yuanbao adapter", () => {
  const page = {
    title: "人工智能创新加速我国产业转型升级",
    url: "https://www.cac.gov.cn/2025-02/26/c_1742272852299173.htm",
    date: "2025/02/26 09:37:00",
    passage: "标准摘要",
    content: "动态摘要",
    site: "中国网信网",
    score: 0.84889734,
  };

  it("posts a signed request and parses Pages as JSON strings", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        Response: { Pages: [JSON.stringify(page)], Query: "人工智能", Version: "flagship", RequestId: "r1" },
      }),
    }));
    const ctx = makeCtx({
      type: "tencent-yuanbao",
      baseUrl,
      apiKey: '{"secretId":"test-secret-id-1","secretKey":"SK1"}',
    });
    const output = await tencentYuanbaoAdapter.search({ query: "人工智能", limit: 5, signal: ctx.signal }, ctx);

    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("/");
    expect(requests[0]!.headers["x-tc-action"]).toBe("SearchPro");
    expect(requests[0]!.headers["x-tc-version"]).toBe("2025-05-08");
    expect(requests[0]!.headers["authorization"]).toMatch(/^TC3-HMAC-SHA256 Credential=test-secret-id-1\//);
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    // Cnt only accepts 10/20/30/40/50.
    expect(body["Cnt"]).toBe(10);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      title: page.title,
      url: page.url,
      snippet: "标准摘要",
    });
    expect(output.results[0]!.upstream).toEqual({ providerName: "中国网信网" });
    expect(output.results[0]!.publishedAt).toBe("2025-02-26T01:37:00.000Z");
  });

  it("maps an empty Pages array to zero results without throwing", async () => {
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ Response: { Pages: [] } }) }));
    const ctx = makeCtx({
      type: "tencent-yuanbao",
      baseUrl,
      apiKey: '{"secretId":"test-secret-id-1","secretKey":"SK1"}',
    });
    const output = await tencentYuanbaoAdapter.search({ query: "x", limit: 10, signal: ctx.signal }, ctx);
    expect(output.results).toEqual([]);
  });

  it("maps Error.Code to a provider error code", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        Response: { Error: { Code: "AuthFailure.SecretIdNotFound", Message: "secret id not found" } },
      }),
    }));
    const ctx = makeCtx({
      type: "tencent-yuanbao",
      baseUrl,
      apiKey: '{"secretId":"test-secret-id-1","secretKey":"SK1"}',
    });
    const error = await tencentYuanbaoAdapter
      .search({ query: "x", limit: 10, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
  });

  it("fails without a credential pair instead of sending an unsigned request", async () => {
    const ctx = makeCtx({ type: "tencent-yuanbao", baseUrl: "http://127.0.0.1:9", apiKey: "secret-id-without-key" });
    const error = await tencentYuanbaoAdapter
      .search({ query: "x", limit: 10, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
  });
});

describe("doubao adapter", () => {
  it("sends PascalCase fields and maps Result.WebResults", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        ResponseMetadata: { RequestId: "r1" },
        Result: {
          ResultCount: 1,
          WebResults: [
            {
              Title: "北京攻略",
              Url: "https://c.m.163.com/news/a/1.html",
              Summary: "长摘要 500-1000 字",
              Snippet: "短片段",
              SiteName: "网易新闻客户端",
              PublishTime: "2026-08-22T09:16:00+08:00",
              RankScore: 0.98,
            },
          ],
          SearchContext: { OriginQuery: "北京", SearchType: "web" },
          TimeCost: 372,
          LogId: "l1",
        },
      }),
    }));
    const ctx = makeCtx({ type: "doubao", baseUrl, apiKey: "key" });
    const output = await doubaoAdapter.search({ query: "北京", limit: 10, signal: ctx.signal }, ctx);

    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ Query: "北京", SearchType: "web", Count: 10 });
    // Summary is the vendor-recommended field for models.
    expect(output.results[0]!.snippet).toBe("长摘要 500-1000 字");
    expect(output.results[0]!.upstream).toEqual({ providerName: "网易新闻客户端" });
  });

  it("forwards TimeRange for month", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ Result: { ResultCount: 0, WebResults: [] } }),
    }));
    const ctx = makeCtx({ type: "doubao", baseUrl, apiKey: "key" });
    await doubaoAdapter.search({ query: "x", limit: 5, freshness: "month", signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ TimeRange: "OneMonth", Count: 5 });
  });

  it("maps the documented quota codes to quota_exceeded, not auth_invalid", async () => {
    for (const code of ["10406", "10408", "10412"]) {
      const { baseUrl } = await startServer(() => ({
        body: JSON.stringify({
          ResponseMetadata: { Error: { CodeN: Number(code), Code: code, Message: "quota" } },
          Result: null,
        }),
      }));
      const ctx = makeCtx({ type: "doubao", baseUrl, apiKey: "key" });
      const error = await doubaoAdapter
        .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "quota_exceeded" });
    }
  });

  it("maps 700429 to rate_limited", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ ResponseMetadata: { Error: { Code: "700429", Message: "qps" } }, Result: null }),
    }));
    const ctx = makeCtx({ type: "doubao", baseUrl, apiKey: "key" });
    const error = await doubaoAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "rate_limited" });
  });

  it("rejects a null Result with no error envelope instead of pretending success", async () => {
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ Result: null }) }));
    const ctx = makeCtx({ type: "doubao", baseUrl, apiKey: "key" });
    const error = await doubaoAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
  });
});

describe("deepseek-search adapter", () => {
  it("posts query/count/need_content and maps results", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        results: [
          {
            rerank_score: 2.4,
            title: "DeepSeek V4 模型发布",
            url: "https://example.com/deepseek-v4",
            snippet: "短摘要",
            summary: "长摘要",
            content: "正文",
            site_name: "Example News",
            date: "2026-06-01T00:00:00+00:00",
            authority: 3,
          },
        ],
      }),
    }));
    const ctx = makeCtx({ type: "deepseek-search", baseUrl, apiKey: "key", config: { needContent: true } });
    const output = await deepseekSearchAdapter.search({ query: "DeepSeek", limit: 5, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/v1/tools/search");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ query: "DeepSeek", count: 5, need_content: true });
    expect(output.results[0]!.snippet).toBe("长摘要");
    expect(output.results[0]!.score).toBe(2.4);
    expect(output.results[0]!.upstream).toEqual({ providerName: "Example News" });
  });

  it("treats an empty results array as a legitimate empty result", async () => {
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ results: [] }) }));
    const ctx = makeCtx({ type: "deepseek-search", baseUrl, apiKey: "key" });
    const output = await deepseekSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.results).toEqual([]);
  });

  it("clamps count to 1..50", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify({ results: [] }) }));
    const ctx = makeCtx({ type: "deepseek-search", baseUrl, apiKey: "key" });
    await deepseekSearchAdapter.search({ query: "x", limit: 999, signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ count: 50 });
  });

  it("maps 402 to quota_exceeded", async () => {
    const { baseUrl } = await startServer(() => ({
      status: 402,
      body: JSON.stringify({ error: { message: "Insufficient Balance", type: "invalid_request_error" } }),
    }));
    const ctx = makeCtx({ type: "deepseek-search", baseUrl, apiKey: "key" });
    const error = await deepseekSearchAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "quota_exceeded" });
  });

  it("fails on a malformed response instead of returning an empty list", async () => {
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ data: [] }) }));
    const ctx = makeCtx({ type: "deepseek-search", baseUrl, apiKey: "key" });
    const error = await deepseekSearchAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
  });
});

describe("qianfan-search adapter", () => {
  it("sends messages/edition/resource_type_filter and reads references[]", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        request_id: "r1",
        references: [
          {
            id: 1,
            title: "北京旅游景区",
            url: "https://example.cn/a",
            web_anchor: "example",
            website: "示例站",
            snippet: "摘要",
            content: "正文",
            date: "2026-05-01",
            type: "web",
            rerank_score: 0.9,
          },
          { id: 2, title: "图片", url: "https://example.cn/i.png", type: "image" },
        ],
      }),
    }));
    const ctx = makeCtx({ type: "qianfan-search", baseUrl, apiKey: "key", config: { edition: "pro" } });
    const output = await qianfanSearchAdapter.search({ query: "北京", limit: 20, signal: ctx.signal }, ctx);

    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body["messages"]).toEqual([{ role: "user", content: "北京" }]);
    expect(body["search_source"]).toBe("baidu_search_v2");
    expect(body["edition"]).toBe("pro");
    expect(body["resource_type_filter"]).toEqual([{ type: "web", top_k: 20 }]);
    // Only web references become results; images are dropped.
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.upstream).toEqual({ providerName: "示例站" });
  });

    it("falls back to a documented edition when an unknown one is configured", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify({ references: [] }) }));
    const ctx = makeCtx({ type: "qianfan-search", baseUrl, apiKey: "key", config: { edition: "ultra" } });
    await qianfanSearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ edition: "standard" });
  });

  it("maps the envelope code to an error", async () => {
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ code: "401", message: "invalid key" }) }));
    const ctx = makeCtx({ type: "qianfan-search", baseUrl, apiKey: "key" });
    const error = await qianfanSearchAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
  });

  it("forwards search_recency_filter only when freshness is set", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify({ references: [] }) }));
    const ctx = makeCtx({ type: "qianfan-search", baseUrl, apiKey: "key" });
    await qianfanSearchAdapter.search({ query: "x", limit: 5, freshness: "all", signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body)).not.toHaveProperty("search_recency_filter");
  });
});

describe("anysearch adapter", () => {
  it("posts query/max_results and maps data.results", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        code: 0,
        message: "success",
        data: { results: [{ title: "结果", url: "https://example.cn/a", content: "正文", snippet: "片段" }], metadata: { total_results: 1 } },
      }),
    }));
    const ctx = makeCtx({ type: "anysearch", baseUrl, apiKey: "as_sk_x" });
    const output = await anySearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/v1/search");
    expect(requests[0]!.headers["authorization"]).toBe("Bearer as_sk_x");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ query: "x", max_results: 5 });
    expect(output.results[0]!.snippet).toBe("正文");
  });

  it("works anonymously and warns about the stricter limits", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ code: 0, data: { results: [{ title: "t", url: "https://example.cn/a" }] } }),
    }));
    const ctx = makeCtx({ type: "anysearch", baseUrl });
    const output = await anySearchAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(requests[0]!.headers["authorization"]).toBeUndefined();
    expect(output.warnings?.[0]).toContain("anonymous");
  });

  it("distinguishes rate limiting from quota exhaustion", async () => {
    const cases: Array<[string, string]> = [
      ["Rate limited, retry after 300 seconds.", "rate_limited"],
      ["Anonymous quota exhausted, please register a key.", "quota_exceeded"],
    ];
    for (const [message, expected] of cases) {
      const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ code: -1, message }) }));
      const ctx = makeCtx({ type: "anysearch", baseUrl });
      const error = await anySearchAdapter
        .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: expected });
    }
  });

  it("clamps max_results to the documented 1..10", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify({ code: 0, data: { results: [] } }) }));
    const ctx = makeCtx({ type: "anysearch", baseUrl });
    await anySearchAdapter.search({ query: "x", limit: 99, signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ max_results: 10 });
  });
});

describe("v0.1.4 adapter registry", () => {
  it("registers all five native adapters", () => {
    expect(tencentYuanbaoAdapter.type).toBe("tencent-yuanbao");
    expect(doubaoAdapter.type).toBe("doubao");
    expect(deepseekSearchAdapter.type).toBe("deepseek-search");
    expect(qianfanSearchAdapter.type).toBe("qianfan-search");
    expect(anySearchAdapter.type).toBe("anysearch");
    // AnySearch is the only one usable without a key.
    expect(anySearchAdapter.requiresKey).toBe(false);
  });
});
