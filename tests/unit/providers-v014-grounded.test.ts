import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type ProviderContext, type ProviderRuntimeConfig, type SafeFetch } from "@search-hub/shared";
import {
  bailianAdapter,
  geminiAdapter,
  grokAdapter,
  mimoAdapter,
  stepfunAdapter,
} from "@search-hub/providers";

/**
 * Contract tests for the v0.1.4 second batch (AI grounded adapters + StepFun).
 * Fixtures follow the vendors' official docs quoted in each adapter header.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 0, allowHttp: true },
});

interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function startServer(
  respond: () => { status?: number; body?: string },
): Promise<{ baseUrl: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const reply = respond();
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function makeCtx(type: string, baseUrl: string, apiKey = "test-key", config: Record<string, unknown> = {}): ProviderContext {
  const runtime: ProviderRuntimeConfig = {
    id: `prv_${type}`,
    name: type,
    type,
    baseUrl,
    timeoutMs: 5000,
    maxResults: 10,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config,
  };
  return {
    fetch: allowLocalFetch,
    apiKey,
    config: runtime,
    signal: AbortSignal.timeout(5000),
    logger: console as never,
  };
}

describe("gemini adapter", () => {
  const grounded = {
    candidates: [
      {
        content: { parts: [{ text: "Spain won Euro 2024." }], role: "model" },
        groundingMetadata: {
          webSearchQueries: ["UEFA Euro 2024 winner"],
          groundingChunks: [
            { web: { uri: "https://vertexaisearch.cloud.google.com/1", title: "aljazeera.com" } },
            { web: { uri: "https://vertexaisearch.cloud.google.com/2", title: "uefa.com" } },
          ],
          groundingSupports: [{ segment: { startIndex: 0, endIndex: 20 }, groundingChunkIndices: [0] }],
        },
      },
    ],
  };

  it("posts google_search tool and reads groundingChunks", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify(grounded) }));
    const ctx = makeCtx("gemini", baseUrl, "key", { model: "gemini-3.8-flash" });
    const output = await geminiAdapter.search({ query: "who won euro 2024", limit: 5, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/v1beta/models/gemini-3.8-flash:generateContent");
    expect(requests[0]!.headers["x-goog-api-key"]).toBe("key");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ tools: [{ google_search: {} }] });
    expect(output.results).toEqual([]);
    expect(output.answer).toMatchObject({ provider: "gemini" });
    expect(output.answer!.status.toolInvoked).toBe(true);
    expect(output.answer!.citations).toHaveLength(2);
    expect(output.answer!.citations[0]!.url).toContain("vertexaisearch");
  });

  it("reports unknown (not false) when groundingMetadata is absent", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "Paris." }] } }] }),
    }));
    const ctx = makeCtx("gemini", baseUrl);
    const output = await geminiAdapter.search({ query: "capital of France", limit: 5, signal: ctx.signal }, ctx);
    // Without metadata the API does not say whether a search ran.
    expect(output.answer!.status.toolInvoked).toBe("unknown");
    expect(output.answer!.citations).toEqual([]);
    expect(output.warnings?.[0]).toContain("no groundingMetadata");
  });

  it("fails on a blocked prompt instead of returning an empty answer", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
    }));
    const ctx = makeCtx("gemini", baseUrl);
    const error = await geminiAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
  });
});

describe("grok adapter", () => {
  const responseBody = {
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { sources: [{ url: "https://docs.x.ai/a", title: "docs.x.ai" }] },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "xAI shipped new tools.",
            annotations: [{ type: "url_citation", url: "https://docs.x.ai/a", title: "docs.x.ai", start_index: 0, end_index: 10 }],
          },
        ],
      },
    ],
  };

  it("sends tools:[{type:web_search}] and collects url_citation + sources", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify(responseBody) }));
    const ctx = makeCtx("grok", baseUrl, "key", { model: "grok-4.7" });
    const output = await grokAdapter.search({ query: "what shipped", limit: 5, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/v1/responses");
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body["tools"]).toEqual([{ type: "web_search" }]);
    expect(body["include"]).toEqual(["web_search_call.action.sources"]);
    expect(output.answer!.status.toolInvoked).toBe(true);
    // Both annotation and action.sources point at the same URL → deduped to one.
    expect(output.answer!.citations).toHaveLength(1);
    expect(output.answer!.text).toContain("shipped");
  });

  it("reports toolInvoked=false when a message exists without web_search_call", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: "I know this." }] }],
      }),
    }));
    const ctx = makeCtx("grok", baseUrl);
    const output = await grokAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.status.toolInvoked).toBe(false);
    expect(output.warnings?.[0]).toContain("web_search_call");
  });

  it("rejects allowed + excluded domains together", async () => {
    const ctx = makeCtx("grok", "http://127.0.0.1:9", "key", {
      allowedDomains: "a.com",
      excludedDomains: "b.com",
    });
    const error = await grokAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
  });

  it("caps domain filters at five entries", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify({ output: [] }) }));
    const ctx = makeCtx("grok", baseUrl, "key", { allowedDomains: "a.com,b.com,c.com,d.com,e.com,f.com,g.com" });
    await grokAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    const body = JSON.parse(requests[0]!.body) as { tools: Array<{ filters?: { allowed_domains?: string[] } }> };
    expect(body.tools[0]!.filters?.allowed_domains).toHaveLength(5);
  });
});

describe("mimo adapter", () => {
  it("sends type:web_search tool and reads annotations", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: "MiMo answer",
              annotations: [
                {
                  type: "web_search",
                  "web_search tool call": {
                    title: "结果标题",
                    url: "https://example.cn/a",
                    summary: "摘要",
                    site_name: "示例站",
                    publish_time: "2026-05-01T00:00:00Z",
                  },
                },
              ],
            },
          },
        ],
      }),
    }));
    const ctx = makeCtx("mimo", baseUrl, "key", { model: "mimo-v2.6-pro", forceSearch: true });
    const output = await mimoAdapter.search({ query: "小米", limit: 5, signal: ctx.signal }, ctx);

    const body = JSON.parse(requests[0]!.body) as { tools: Array<Record<string, unknown>> };
    expect(body.tools[0]).toMatchObject({ type: "web_search", force_search: true, max_keyword: 5, limit: 5 });
    expect(output.answer!.status.toolInvoked).toBe(true);
    expect(output.answer!.citations[0]).toMatchObject({ title: "结果标题", url: "https://example.cn/a" });
  });

  it("reports toolInvoked=false when annotations are absent", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ choices: [{ message: { content: "no search" } }] }),
    }));
    const ctx = makeCtx("mimo", baseUrl);
    const output = await mimoAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.status.toolInvoked).toBe(false);
  });

  it("clamps max_keyword and limit to 1..50", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ choices: [{ message: { content: "" } }] }),
    }));
    const ctx = makeCtx("mimo", baseUrl, "key", { maxKeyword: 999, searchLimit: 0 });
    await mimoAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    const body = JSON.parse(requests[0]!.body) as { tools: Array<Record<string, unknown>> };
    expect(body.tools[0]).toMatchObject({ max_keyword: 50, limit: 1 });
  });
});

describe("bailian adapter", () => {
  const okBody = {
    output: {
      choices: [{ message: { content: "杭州明天有雨 [ref_1]" }, finish_reason: "stop" }],
      search_info: {
        search_results: [
          { index: 1, title: "杭州天气", url: "https://hznews.example/a", site_name: "杭州网", icon: "" },
        ],
      },
    },
    usage: { plugins: { search: { count: 1 } } },
  };

  it("uses the DashScope native endpoint because OpenAI-compatible cannot return sources", async () => {
    const { baseUrl, requests } = await startServer(() => ({ body: JSON.stringify(okBody) }));
    const ctx = makeCtx("bailian", baseUrl, "key", { model: "qwen-plus" });
    const output = await bailianAdapter.search({ query: "杭州天气", limit: 5, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/api/v1/services/aigc/text-generation/generation");
    const body = JSON.parse(requests[0]!.body) as { parameters: Record<string, unknown> };
    expect(body.parameters["result_format"]).toBe("message");
    expect(body.parameters["enable_search"]).toBe(true);
    expect(body.parameters["search_options"]).toMatchObject({ enable_source: true, enable_citation: true });
    expect(output.answer!.status.toolInvoked).toBe(true);
    expect(output.answer!.citations[0]!.url).toBe("https://hznews.example/a");
  });

  it("requires a workspace endpoint instead of guessing a region", async () => {
    const ctx = makeCtx("bailian", "", "key");
    const error = await bailianAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
    expect((error as Error).message).toContain("workspace endpoint");
  });

  it("uses usage.plugins to decide invocation, not result count", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ output: { choices: [{ message: { content: "answer" } }], search_info: { search_results: [] } } }),
    }));
    const ctx = makeCtx("bailian", baseUrl, "key");
    const output = await bailianAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    // search_info present with zero results: the tool ran, retrieval came back empty.
    expect(output.answer!.status.toolInvoked).toBe(true);
    expect(output.answer!.status.retrievalSucceeded).toBe(false);
  });

  it("reports unknown when neither usage.plugins nor search_info is present", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ output: { choices: [{ message: { content: "answer" } }] } }),
    }));
    const ctx = makeCtx("bailian", baseUrl, "key");
    const output = await bailianAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.answer!.status.toolInvoked).toBe("unknown");
  });

  it("falls back to turbo for an unknown strategy", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ output: { choices: [{ message: { content: "" } }], search_info: { search_results: [] } } }),
    }));
    const ctx = makeCtx("bailian", baseUrl, "key", { searchStrategy: "ultra" });
    await bailianAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    const body = JSON.parse(requests[0]!.body) as { parameters: { search_options: Record<string, unknown> } };
    expect(body.parameters.search_options["search_strategy"]).toBe("turbo");
  });
});

describe("stepfun adapter", () => {
  it("maps /v1/search results and caps n at 20", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        query: "人工智能",
        category: "",
        results: [
          { url: "https://example.cn/a", position: 1, title: "标题", time: "2026-03-22T00:00:00Z", snippet: "摘要", content: "正文" },
        ],
      }),
    }));
    const ctx = makeCtx("stepfun", baseUrl, "key");
    const output = await stepfunAdapter.search({ query: "人工智能", limit: 99, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/v1/search");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ query: "人工智能", n: 20 });
    expect(output.results).toHaveLength(1);
    expect(output.results[0]!.snippet).toBe("摘要");
  });

  it("supports the documented category filter", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({ results: [] }),
    }));
    const ctx = makeCtx("stepfun", baseUrl, "key", { category: "research" });
    await stepfunAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ category: "research" });
  });

  it("fails on a malformed response instead of returning empty results", async () => {
    const { baseUrl } = await startServer(() => ({ body: JSON.stringify({ data: [] }) }));
    const ctx = makeCtx("stepfun", baseUrl, "key");
    const error = await stepfunAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
  });
});

describe("grounded capability contract", () => {
  it("declares capability per adapter instead of inferring from results", () => {
    expect(geminiAdapter.capability).toBe("grounded_answer");
    expect(grokAdapter.capability).toBe("grounded_answer");
    expect(mimoAdapter.capability).toBe("grounded_answer");
    expect(bailianAdapter.capability).toBe("grounded_answer");
    expect(stepfunAdapter.capability).toBe("raw_search");
  });
});
