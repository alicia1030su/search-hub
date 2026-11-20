import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ProviderError,
  createSafeFetch,
  type Freshness,
  type ProviderContext,
  type ProviderRuntimeConfig,
  type SafeFetch,
} from "@search-hub/shared";
import {
  PROVIDER_CATALOG,
  bochaAdapter,
  braveAdapter,
  genericHttpAdapter,
  getAdapter,
  listAdapters,
  searxngAdapter,
  tavilyAdapter,
} from "@search-hub/providers";

/**
 * Contract tests for the general-purpose web-search adapters.
 *
 * No vendor key exists in this repository, so every fixture below is built from
 * the vendors' *documented* wire format (field names quoted in the comment above
 * each fixture). These tests prove the adapter sends the documented request and
 * maps the documented response — they do NOT prove a live account works.
 * Live evidence has to come from `tests/scripts/provider-live.mjs`.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 2, allowHttp: true },
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

function runtimeConfig(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    id: "prv_test",
    name: "test provider",
    type: "tavily",
    baseUrl: null,
    timeoutMs: 5000,
    maxResults: 10,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 1,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config: {},
    ...overrides,
  };
}

function makeCtx(options: {
  type: string;
  baseUrl: string;
  apiKey?: string;
  config?: Record<string, unknown>;
  language?: string | null;
}): ProviderContext {
  return {
    fetch: allowLocalFetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    config: runtimeConfig({
      type: options.type,
      baseUrl: options.baseUrl,
      config: options.config ?? {},
      language: options.language ?? null,
    }),
    signal: AbortSignal.timeout(5000),
    logger: console as never,
  };
}

async function captureError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("Expected the adapter to throw, but it resolved");
}

function jsonReply(payload: unknown, status = 200, headers?: Record<string, string>): MockReply {
  return { status, headers, body: JSON.stringify(payload) };
}

function searchInput(overrides: Partial<{ query: string; limit: number; language: string; freshness: Freshness }> = {}) {
  return {
    query: overrides.query ?? "typescript monorepo",
    limit: overrides.limit ?? 5,
    ...(overrides.language === undefined ? {} : { language: overrides.language }),
    ...(overrides.freshness === undefined ? {} : { freshness: overrides.freshness }),
    signal: AbortSignal.timeout(5000),
  };
}

function parseBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

describe("tavily adapter", () => {
  it("sends the documented request (Bearer auth, JSON body) and maps results", async () => {
    let seen: CapturedRequest | undefined;
    const { baseUrl } = await startServer((request) => {
      seen = request;
      // Official response shape: results[].{title,url,content,score,published_date}
      // https://docs.tavily.com/documentation/api-reference/endpoint/search
      return jsonReply({
        query: "typescript monorepo",
        answer: null,
        results: [
          {
            title: "Monorepo handbook",
            url: "https://example.org/monorepo",
            content: "How to structure a TypeScript monorepo with pnpm workspaces.",
            score: 0.87,
            published_date: "2025-02-03T10:00:00Z",
          },
        ],
        response_time: 1.2,
        images: [],
      });
    });

    const result = await tavilyAdapter.search(
      searchInput({ language: "zh-CN", freshness: "week" }),
      makeCtx({ type: "tavily", baseUrl, apiKey: "tvly-test-key" }),
    );

    expect(seen).toBeDefined();
    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe("/search");
    // Bearer header, never a `api_key` body field.
    expect(seen!.headers["authorization"]).toBe("Bearer tvly-test-key");
    const body = parseBody(seen!);
    expect(body["query"]).toBe("typescript monorepo");
    expect(body["max_results"]).toBe(5);
    expect(body["search_depth"]).toBe("basic");
    expect(body["topic"]).toBe("general");
    expect(body["include_answer"]).toBe(false);
    expect(body["include_raw_content"]).toBe(false);
    expect(body["time_range"]).toBe("week");
    // `days` no longer exists in the official request schema; freshness maps to
    // `time_range` instead (an unknown body field risks a 422).
    expect(body["days"]).toBeUndefined();
    // Documented as an ISO 639-1 code / language name used as a ranking boost.
    expect(body["language"]).toBe("zh-cn");
    expect(body["api_key"]).toBeUndefined();

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe("Monorepo handbook");
    expect(result.results[0]!.url).toBe("https://example.org/monorepo");
    expect(result.results[0]!.snippet).toContain("pnpm workspaces");
    expect(result.results[0]!.score).toBe(0.87);
    expect(result.results[0]!.publishedAt).toBe("2025-02-03T10:00:00.000Z");
  });

  it("maps topic/searchDepth/domain config to documented body fields", async () => {
    let seen: CapturedRequest | undefined;
    const { baseUrl } = await startServer((request) => {
      seen = request;
      return jsonReply({ results: [] });
    });

    await tavilyAdapter.search(
      searchInput(),
      makeCtx({
        type: "tavily",
        baseUrl,
        apiKey: "k",
        config: {
          topic: "news",
          searchDepth: "advanced",
          includeDomains: ["Example.COM", "  "],
          excludeDomains: ["spam.example"],
        },
      }),
    );

    const body = parseBody(seen!);
    expect(body["topic"]).toBe("news");
    expect(body["search_depth"]).toBe("advanced");
    expect(body["include_domains"]).toEqual(["example.com"]);
    expect(body["exclude_domains"]).toEqual(["spam.example"]);
  });

  it("maps every freshness bucket to the documented time_range value", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply({ results: [] }));
    const ctx = makeCtx({ type: "tavily", baseUrl, apiKey: "k" });

    const cases: Array<[Freshness, string | undefined]> = [
      ["day", "day"],
      ["week", "week"],
      ["month", "month"],
      ["year", "year"],
      ["all", undefined],
    ];
    for (const [freshness] of cases) {
      await tavilyAdapter.search(searchInput({ freshness }), ctx);
    }

    expect(requests).toHaveLength(cases.length);
    cases.forEach(([freshness, expected], index) => {
      const body = parseBody(requests[index]!);
      expect({ freshness, time_range: body["time_range"] }).toEqual({
        freshness,
        time_range: expected,
      });
    });
  });

  it("clamps max_results to the documented 1-20 range", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply({ results: [] }));
    const ctx = makeCtx({ type: "tavily", baseUrl, apiKey: "k" });
    await tavilyAdapter.search(searchInput({ limit: 99 }), ctx);
    await tavilyAdapter.search(searchInput({ limit: 0 }), ctx);
    expect(parseBody(requests[0]!)["max_results"]).toBe(20);
    expect(parseBody(requests[1]!)["max_results"]).toBe(1);
  });

  it("fails with auth_invalid when no key is configured", async () => {
    const error = await captureError(
      tavilyAdapter.search(
        searchInput(),
        makeCtx({ type: "tavily", baseUrl: "https://api.tavily.com" }),
      ),
    );
    expect(error.code).toBe("auth_invalid");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/API key is missing/i);
  });

  it("maps 401 to auth_invalid and 403 to blocked without retrying", async () => {
    for (const status of [401, 403]) {
      const { baseUrl } = await startServer(() => jsonReply({ detail: { error: "bad key" } }, status));
      const error = await captureError(
        tavilyAdapter.search(
          searchInput(),
          makeCtx({ type: "tavily", baseUrl, apiKey: "bad" }),
        ),
      );
      expect(error.code).toBe(status === 401 ? "auth_invalid" : "blocked");
      expect(error.retryable).toBe(false);
      expect(error.statusCode).toBe(status);
      expect(error.details).toMatchObject({ upstreamStatus: status });
    }
  });

  it("maps 429 with Retry-After: 30 to retryAfterMs 30000", async () => {
    const { baseUrl } = await startServer(() =>
      jsonReply({ detail: { error: "rate limited" } }, 429, { "retry-after": "30" }),
    );
    const error = await captureError(
      tavilyAdapter.search(searchInput(), makeCtx({ type: "tavily", baseUrl, apiKey: "k" })),
    );
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(30_000);
  });

  it("maps 5xx to server_error and keeps it retryable", async () => {
    const { baseUrl } = await startServer(() => jsonReply({ detail: "boom" }, 500));
    const error = await captureError(
      tavilyAdapter.search(searchInput(), makeCtx({ type: "tavily", baseUrl, apiKey: "k" })),
    );
    expect(error.code).toBe("server_error");
    expect(error.retryable).toBe(true);
    expect(error.statusCode).toBe(500);
  });

  it("maps Tavily's own 432/433/434 capacity statuses to quota/rate codes", async () => {
    // The official endpoint reference lists these next to 400/401/422/429/500:
    // 432 = plan/quota ceiling, 433 = pay-as-you-go cap, 434 = flex-tier capacity.
    const cases: Array<[number, string, boolean]> = [
      [432, "quota_exceeded", false],
      [433, "rate_limited", true],
      [434, "rate_limited", true],
    ];
    for (const [status, expectedCode, retryable] of cases) {
      const { baseUrl } = await startServer(() => jsonReply({ detail: { error: `status ${status}` } }, status));
      const error = await captureError(
        tavilyAdapter.search(searchInput(), makeCtx({ type: "tavily", baseUrl, apiKey: "k" })),
      );
      // A capacity ceiling must never look like a bad key.
      expect({ status, code: error.code, retryable: error.retryable }).toEqual({
        status,
        code: expectedCode,
        retryable,
      });
      expect(error.code).not.toBe("auth_invalid");
    }
  });

  it("reads Tavily's nested error message from detail.error", async () => {
    const { baseUrl } = await startServer(() =>
      // Live shape observed for an invalid key:
      // {"detail":{"error":"Unauthorized: missing or invalid API key."}}
      jsonReply({ detail: { error: "Unauthorized: missing or invalid API key." } }, 401),
    );
    const error = await captureError(
      tavilyAdapter.search(searchInput(), makeCtx({ type: "tavily", baseUrl, apiKey: "bad" })),
    );
    expect(error.code).toBe("auth_invalid");
    // The extractor must reach the nested string, otherwise operators see only
    // "Upstream returned HTTP 401".
    expect(error.message).toContain("Unauthorized: missing or invalid API key.");
  });

  it("rejects a 200 response with malformed JSON as bad_request", async () => {
    const { baseUrl } = await startServer(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"results": [',
    }));
    const error = await captureError(
      tavilyAdapter.search(searchInput(), makeCtx({ type: "tavily", baseUrl, apiKey: "k" })),
    );
    expect(error.code).toBe("bad_request");
    expect(error.retryable).toBe(false);
  });

  it("rejects a 200 response whose results field is not an array", async () => {
    const { baseUrl } = await startServer(() => jsonReply({ results: "nope" }));
    const error = await captureError(
      tavilyAdapter.search(searchInput(), makeCtx({ type: "tavily", baseUrl, apiKey: "k" })),
    );
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/results/i);
  });

  it("test() performs a real request and returns a sample", async () => {
    const { baseUrl, requests } = await startServer(() =>
      jsonReply({
        results: [
          { title: "Search engine", url: "https://example.org/se", content: "x", score: 0.5 },
        ],
      }),
    );
    const result = await tavilyAdapter.test?.(
      makeCtx({ type: "tavily", baseUrl, apiKey: "k" }),
    );
    expect(requests).toHaveLength(1);
    expect(result?.ok).toBe(true);
    expect(result?.resultCount).toBe(1);
    expect(result?.sample?.[0]?.url).toBe("https://example.org/se");
    expect(tavilyAdapter.supportsTest).toBe(true);
    expect(tavilyAdapter.requiresKey).toBe(true);
  });

  it("keeps a path prefix on a custom baseUrl instead of resolving from the root", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply({ results: [] }));
    await tavilyAdapter.search(
      searchInput(),
      makeCtx({ type: "tavily", baseUrl: `${baseUrl}/gateway/tavily`, apiKey: "k" }),
    );
    // A path-mounted reverse proxy must receive /gateway/tavily/search.
    expect(requests[0]!.url).toBe("/gateway/tavily/search");
  });
});

// ---------------------------------------------------------------------------
// Bocha
// ---------------------------------------------------------------------------

/** Official Bocha response envelope (verified against the vendor's Web Search API doc):
 *  { code, log_id, msg, data: { webPages: { value: [{ name, url, snippet, summary,
 *    siteName, siteIcon, datePublished, dateLastCrawled }] } } }
 */
function bochaEnvelope(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    code: 200,
    log_id: "log_test",
    msg: null,
    data: {
      _type: "SearchResponse",
      queryContext: { originalQuery: "x" },
      webPages: { webSearchUrl: "https://bochaai.com/search", totalEstimatedMatches: 1, value: items },
      images: [],
      videos: [],
    },
    ...overrides,
  };
}

describe("bocha adapter", () => {
  it("sends Bearer auth plus the documented body and maps webPages.value", async () => {
    let seen: CapturedRequest | undefined;
    const { baseUrl } = await startServer((request) => {
      seen = request;
      return jsonReply(
        bochaEnvelope([
          {
            id: null,
            name: "博查搜索结果",
            url: "https://example.cn/article",
            displayUrl: "https://example.cn/article",
            snippet: "这是一段来自博查的摘要。",
            summary: "更长的原文摘要。",
            siteName: "示例站点",
            siteIcon: "https://example.cn/favicon.ico",
            datePublished: "2025-09-16T07:32:41+08:00",
            dateLastCrawled: "2025-09-16T07:32:41Z",
            language: "zh-CN",
          },
        ]),
      );
    });

    const result = await bochaAdapter.search(
      searchInput({ freshness: "month" }),
      makeCtx({ type: "bocha", baseUrl, apiKey: "sk-bocha-test" }),
    );

    expect(seen!.method).toBe("POST");
    expect(seen!.url).toBe("/v1/web-search");
    expect(seen!.headers["authorization"]).toBe("Bearer sk-bocha-test");
    const body = parseBody(seen!);
    expect(body["query"]).toBe("typescript monorepo");
    expect(body["freshness"]).toBe("oneMonth");
    // Bocha's `summary` is the page's own summary text (not an LLM answer), so it
    // defaults to true: some results come back with an empty `snippet`.
    expect(body["summary"]).toBe(true);
    expect(body["count"]).toBe(5);
    expect(body["page"]).toBe(1);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.title).toBe("博查搜索结果");
    expect(result.results[0]!.url).toBe("https://example.cn/article");
    expect(result.results[0]!.snippet).toBe("这是一段来自博查的摘要。");
    expect(result.results[0]!.publishedAt).toBe("2025-09-15T23:32:41.000Z");
    expect(result.results[0]!.language).toBe("zh-CN");
  });

  it("maps every freshness bucket to the documented Bocha value", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply(bochaEnvelope([])));
    const ctx = makeCtx({ type: "bocha", baseUrl, apiKey: "k" });

    const cases: Array<[Freshness, string]> = [
      ["day", "oneDay"],
      ["week", "oneWeek"],
      ["month", "oneMonth"],
      ["year", "oneYear"],
      ["all", "noLimit"],
    ];
    for (const [freshness] of cases) {
      await bochaAdapter.search(searchInput({ freshness }), ctx);
    }

    cases.forEach(([freshness, expected], index) => {
      expect({ freshness, freshnessParam: parseBody(requests[index]!)["freshness"] }).toEqual({
        freshness,
        freshnessParam: expected,
      });
    });
  });

  it("clamps count to the documented 1-50 range and honours summary=false", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply(bochaEnvelope([])));
    const ctx = makeCtx({ type: "bocha", baseUrl, apiKey: "k", config: { summary: false } });
    await bochaAdapter.search(searchInput({ limit: 500 }), ctx);
    await bochaAdapter.search(searchInput({ limit: -3 }), ctx);
    expect(parseBody(requests[0]!)["count"]).toBe(50);
    expect(parseBody(requests[0]!)["summary"]).toBe(false);
    expect(parseBody(requests[1]!)["count"]).toBe(1);
  });

  it("treats a successful envelope without webPages as zero results", async () => {
    const { baseUrl } = await startServer(() =>
      jsonReply({ code: 200, log_id: "x", msg: null, data: { _type: "SearchResponse" } }),
    );
    const result = await bochaAdapter.search(
      searchInput(),
      makeCtx({ type: "bocha", baseUrl, apiKey: "k" }),
    );
    expect(result.results).toEqual([]);
  });

  it("honours Bocha's envelope-level errors even when HTTP status is 200", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth_invalid"],
      // Bocha 403 = 余额不足, so it is a quota problem, not a bad key.
      [403, "quota_exceeded"],
      [429, "rate_limited"],
      [500, "server_error"],
      [400, "bad_request"],
    ];
    for (const [code, expected] of cases) {
      const { baseUrl } = await startServer(() =>
        // Error shape documented as { log_id, message, code } (code may be a string).
        jsonReply({ log_id: "log_x", message: `vendor error ${code}`, code }, 200, code === 429 ? { "retry-after": "30" } : undefined),
      );
      const error = await captureError(
        bochaAdapter.search(searchInput(), makeCtx({ type: "bocha", baseUrl, apiKey: "k" })),
      );
      expect({ code, mapped: error.code }).toEqual({ code, mapped: expected });
      if (code === 429) expect(error.retryAfterMs).toBe(30_000);
    }
  });

  it("accepts a string envelope code on success", async () => {
    const { baseUrl } = await startServer(() => jsonReply(bochaEnvelope([], { code: "200" })));
    const result = await bochaAdapter.search(
      searchInput(),
      makeCtx({ type: "bocha", baseUrl, apiKey: "k" }),
    );
    expect(result.results).toEqual([]);
  });

  it("maps HTTP 401 to auth_invalid, 403 to quota_exceeded, 429 to retryAfterMs, 500 to server_error", async () => {
    const matrix: Array<[number, string, number | undefined]> = [
      [401, "auth_invalid", undefined],
      // Bocha documents 403 as "insufficient balance"; suspending the key would
      // be the wrong scheduler reaction.
      [403, "quota_exceeded", undefined],
      [429, "rate_limited", 30_000],
      [500, "server_error", undefined],
    ];
    for (const [status, expected, retryAfterMs] of matrix) {
      const { baseUrl } = await startServer(() =>
        jsonReply(
          { log_id: "x", message: "err", code: String(status) },
          status,
          // Only 429 carries a Retry-After; the other statuses must not invent one.
          status === 429 ? { "retry-after": "30" } : undefined,
        ),
      );
      const error = await captureError(
        bochaAdapter.search(searchInput(), makeCtx({ type: "bocha", baseUrl, apiKey: "k" })),
      );
      expect({ status, mapped: error.code }).toEqual({ status, mapped: expected });
      expect(error.retryAfterMs).toBe(retryAfterMs);
    }
  });

  it("rejects malformed JSON and a non-array webPages.value as bad_request", async () => {
    const malformed = await startServer(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: "<html>gateway error</html>",
    }));
    const errorA = await captureError(
      bochaAdapter.search(searchInput(), makeCtx({ type: "bocha", baseUrl: malformed.baseUrl, apiKey: "k" })),
    );
    expect(errorA.code).toBe("bad_request");

    const wrongShape = await startServer(() =>
      jsonReply({ code: 200, data: { webPages: { value: "nope" } } }),
    );
    const errorB = await captureError(
      bochaAdapter.search(searchInput(), makeCtx({ type: "bocha", baseUrl: wrongShape.baseUrl, apiKey: "k" })),
    );
    expect(errorB.code).toBe("bad_request");
    expect(errorB.message).toMatch(/webPages\.value/);
  });

  it("fails with auth_invalid when no key is configured", async () => {
    const error = await captureError(
      bochaAdapter.search(searchInput(), makeCtx({ type: "bocha", baseUrl: "https://api.bochaai.com" })),
    );
    expect(error.code).toBe("auth_invalid");
    expect(error.message).toMatch(/API key is missing/i);
  });

  it("test() performs a real request and returns a sample", async () => {
    const { baseUrl, requests } = await startServer(() =>
      jsonReply(
        bochaEnvelope([
          { name: "博查命中", url: "https://example.cn/hit", snippet: "摘要" },
        ]),
      ),
    );
    const result = await bochaAdapter.test?.(makeCtx({ type: "bocha", baseUrl, apiKey: "k" }));
    expect(requests).toHaveLength(1);
    expect(result?.ok).toBe(true);
    expect(result?.sample?.[0]?.url).toBe("https://example.cn/hit");
    expect(bochaAdapter.supportsTest).toBe(true);
    expect(bochaAdapter.requiresKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

describe("brave adapter (web search contract)", () => {
  it("sends the documented query params, token header and maps web.results", async () => {
    let seen: CapturedRequest | undefined;
    const { baseUrl } = await startServer((request) => {
      seen = request;
      // Official response shape: web.results[].{title,url,description,page_age,language,extra_snippets}
      return jsonReply({
        type: "search",
        web: {
          type: "search",
          results: [
            {
              title: "Brave <strong>result</strong>",
              url: "https://example.com/brave",
              description: "A result from Brave",
              page_age: "2025-01-15T10:00:00Z",
              language: "en",
              extra_snippets: ["extra excerpt one", "extra excerpt two"],
            },
          ],
        },
      });
    });

    const result = await braveAdapter.search(
      searchInput({ freshness: "week", language: "zh-CN" }),
      makeCtx({ type: "brave", baseUrl, apiKey: "brave-token", config: { country: "DE", extraSnippets: true } }),
    );

    expect(seen!.method).toBe("GET");
    const url = new URL(seen!.url, "http://127.0.0.1");
    expect(url.pathname).toBe("/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("typescript monorepo");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("search_lang")).toBe("zh-hans");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(url.searchParams.get("country")).toBe("DE");
    expect(url.searchParams.get("extra_snippets")).toBe("true");
    // Brave authenticates with X-Subscription-Token, not Authorization.
    expect(seen!.headers["x-subscription-token"]).toBe("brave-token");
    expect(seen!.headers["authorization"]).toBeUndefined();

    expect(result.results[0]!.title).toBe("Brave result");
    expect(result.results[0]!.url).toBe("https://example.com/brave");
    expect(result.results[0]!.publishedAt).toBe("2025-01-15T10:00:00.000Z");
  });

  it("falls back to the first extra snippet when description is absent", async () => {
    const { baseUrl } = await startServer(() =>
      jsonReply({
        web: { results: [{ title: "Only extras", url: "https://example.com/e", extra_snippets: ["from extras"] }] },
      }),
    );
    const result = await braveAdapter.search(
      searchInput(),
      makeCtx({ type: "brave", baseUrl, apiKey: "k" }),
    );
    expect(result.results[0]!.snippet).toBe("from extras");
  });

  it("maps every freshness bucket to pd/pw/pm/py", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply({ web: { results: [] } }));
    const ctx = makeCtx({ type: "brave", baseUrl, apiKey: "k" });
    const cases: Array<[Freshness, string | null]> = [
      ["day", "pd"],
      ["week", "pw"],
      ["month", "pm"],
      ["year", "py"],
      ["all", null],
    ];
    for (const [freshness] of cases) {
      await braveAdapter.search(searchInput({ freshness }), ctx);
    }
    cases.forEach(([freshness, expected], index) => {
      const url = new URL(requests[index]!.url, "http://127.0.0.1");
      expect({ freshness, freshnessParam: url.searchParams.get("freshness") }).toEqual({
        freshness,
        freshnessParam: expected,
      });
    });
  });

  it("maps 429 + Retry-After to retryAfterMs and 5xx to server_error", async () => {
    const limited = await startServer(() =>
      jsonReply({ error: { message: "rate limited" } }, 429, { "retry-after": "30" }),
    );
    const errorA = await captureError(
      braveAdapter.search(searchInput(), makeCtx({ type: "brave", baseUrl: limited.baseUrl, apiKey: "k" })),
    );
    expect(errorA.code).toBe("rate_limited");
    expect(errorA.retryAfterMs).toBe(30_000);

    const broken = await startServer(() => jsonReply({ error: "boom" }, 502));
    const errorB = await captureError(
      braveAdapter.search(searchInput(), makeCtx({ type: "brave", baseUrl: broken.baseUrl, apiKey: "k" })),
    );
    expect(errorB.code).toBe("server_error");
    expect(errorB.retryable).toBe(true);
  });

  it("rejects a non-array web.results as bad_request instead of returning zero results", async () => {
    const { baseUrl } = await startServer(() => jsonReply({ web: { results: "nope" } }));
    const error = await captureError(
      braveAdapter.search(searchInput(), makeCtx({ type: "brave", baseUrl, apiKey: "k" })),
    );
    expect(error.code).toBe("bad_request");
  });

  it("rejects a 200 response with malformed JSON as bad_request", async () => {
    const { baseUrl } = await startServer(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"web": {"results": [',
    }));
    const error = await captureError(
      braveAdapter.search(searchInput(), makeCtx({ type: "brave", baseUrl, apiKey: "k" })),
    );
    expect(error.code).toBe("bad_request");
    expect(error.retryable).toBe(false);
  });

  it("fails with auth_invalid when no token is configured", async () => {
    const error = await captureError(
      braveAdapter.search(searchInput(), makeCtx({ type: "brave", baseUrl: "https://api.search.brave.com" })),
    );
    expect(error.code).toBe("auth_invalid");
    expect(error.message).toMatch(/API key is missing/i);
  });

  it("test() performs a real request and returns a sample", async () => {
    const { baseUrl, requests } = await startServer(() =>
      jsonReply({ web: { results: [{ title: "Brave hit", url: "https://example.com/hit" }] } }),
    );
    const result = await braveAdapter.test?.(makeCtx({ type: "brave", baseUrl, apiKey: "k" }));
    expect(requests).toHaveLength(1);
    expect(result?.ok).toBe(true);
    expect(result?.sample?.[0]?.url).toBe("https://example.com/hit");
    expect(braveAdapter.supportsTest).toBe(true);
    expect(braveAdapter.requiresKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SearXNG time_range / language mapping
// ---------------------------------------------------------------------------

describe("searxng adapter (time_range and language mapping)", () => {
  it("maps day/month/year 1:1 and widens week to month", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply({ results: [] }));
    const ctx = makeCtx({ type: "searxng", baseUrl });
    const cases: Array<[Freshness, string | null]> = [
      ["day", "day"],
      // SearXNG has no `week` bucket; the adapter widens to `month` on purpose.
      ["week", "month"],
      ["month", "month"],
      ["year", "year"],
      ["all", null],
    ];
    for (const [freshness] of cases) {
      await searxngAdapter.search(searchInput({ freshness }), ctx);
    }
    cases.forEach(([freshness, expected], index) => {
      const url = new URL(requests[index]!.url, "http://127.0.0.1");
      expect({ freshness, timeRange: url.searchParams.get("time_range") }).toEqual({
        freshness,
        timeRange: expected,
      });
    });
  });

  it("forwards an instance language code and normalizes zh variants", async () => {
    const { baseUrl, requests } = await startServer(() => jsonReply({ results: [] }));
    const ctx = makeCtx({ type: "searxng", baseUrl });
    await searxngAdapter.search(searchInput({ language: "zh-cn" }), ctx);
    await searxngAdapter.search(searchInput({ language: "zh-tw" }), ctx);
    await searxngAdapter.search(searchInput(), ctx);
    const first = new URL(requests[0]!.url, "http://127.0.0.1");
    const second = new URL(requests[1]!.url, "http://127.0.0.1");
    const third = new URL(requests[2]!.url, "http://127.0.0.1");
    expect(first.searchParams.get("language")).toBe("zh-CN");
    expect(second.searchParams.get("language")).toBe("zh-TW");
    expect(third.searchParams.get("language")).toBeNull();
    expect(third.searchParams.get("format")).toBe("json");
  });

  it("does not require a key but does require a base URL", async () => {
    expect(searxngAdapter.requiresKey).toBe(false);
    const ctx: ProviderContext = {
      fetch: allowLocalFetch,
      config: runtimeConfig({ type: "searxng", baseUrl: null }),
      signal: AbortSignal.timeout(5000),
      logger: console as never,
    };
    const error = await captureError(searxngAdapter.search(searchInput(), ctx));
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/base URL/i);
  });
});

// ---------------------------------------------------------------------------
// SSRF rejections keep the `blocked` code (regression: they used to be
// reported as `auth_invalid` because SearchHubError("blocked") has status 403)
// ---------------------------------------------------------------------------

describe("blocked targets are reported as blocked, never auth_invalid", () => {
  /** Default SSRF policy: no private-host allowlist. */
  const strictFetch: SafeFetch = createSafeFetch({ policy: { allowPrivateHosts: [], maxRedirects: 2, allowHttp: true } });
  /** Private hosts allowlisted on purpose — metadata endpoints stay blocked regardless. */
  const allowAllPrivateFetch: SafeFetch = createSafeFetch({
    policy: { allowPrivateHosts: ["169.254.169.254", "127.0.0.1"], maxRedirects: 2, allowHttp: true },
  });

  function genericCtx(fetchImpl: SafeFetch, baseUrl: string): ProviderContext {
    return {
      fetch: fetchImpl,
      config: runtimeConfig({
        type: "generic-http",
        baseUrl,
        config: { method: "GET", path: "/search", query: { q: "{{query}}" }, resultsPath: "results" },
      }),
      signal: AbortSignal.timeout(5000),
      logger: console as never,
    };
  }

  it("rejects a non-allowlisted loopback target with code blocked", async () => {
    const { baseUrl } = await startServer(() => jsonReply({ results: [] }));
    const error = await captureError(
      genericHttpAdapter.search(searchInput(), genericCtx(strictFetch, baseUrl)),
    );
    expect(error.code).toBe("blocked");
    expect(error.retryable).toBe(false);
    // The message must name the real reason so operators do not chase a key.
    expect(error.message).toMatch(/private or reserved address|allowlist/i);
  });

  it("rejects the cloud metadata address even when it is allowlisted", async () => {
    const error = await captureError(
      genericHttpAdapter.search(
        searchInput(),
        genericCtx(allowAllPrivateFetch, "http://169.254.169.254"),
      ),
    );
    expect(error.code).toBe("blocked");
    expect(error.message).toMatch(/metadata/i);
  });

  it("never maps a blocked rejection to auth_invalid", async () => {
    const error = await captureError(
      genericHttpAdapter.search(
        searchInput(),
        genericCtx(strictFetch, "http://127.0.0.1:9"),
      ),
    );
    expect(error.code).not.toBe("auth_invalid");
    expect(error).toBeInstanceOf(ProviderError);
  });
});

// ---------------------------------------------------------------------------
// Catalog and registry honesty
// ---------------------------------------------------------------------------

describe("provider catalog and registry", () => {
  it("registers all three general web-search adapters", () => {
    const types = listAdapters().map((adapter) => adapter.type);
    expect(types).toEqual(expect.arrayContaining(["tavily", "bocha", "brave", "searxng"]));
    expect(getAdapter("tavily")?.requiresKey).toBe(true);
    expect(getAdapter("bocha")?.requiresKey).toBe(true);
    expect(getAdapter("brave")?.requiresKey).toBe(true);
    expect(getAdapter("searxng")?.requiresKey).toBe(false);
  });

  it("never claims live_tested for providers that were not called for real", () => {
    for (const type of ["tavily", "bocha", "brave", "searxng"]) {
      const entry = PROVIDER_CATALOG.find((item) => item.type === type);
      expect(entry).toBeDefined();
      expect(entry!.implementation).toBe("builtin");
      expect(entry!.verification).toBe("documented");
      expect(entry!.notes).toMatch(/未联调|not live-tested/i);
    }
  });
});
