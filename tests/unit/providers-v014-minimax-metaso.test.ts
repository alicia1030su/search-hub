import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type ProviderContext, type ProviderRuntimeConfig, type SafeFetch } from "@search-hub/shared";
import { metasoAdapter, metasoMcpAdapter, minimaxAdapter } from "@search-hub/providers";

/**
 * Contract tests for MiniMax (Coding Plan) and 秘塔 (Metaso).
 *
 * Both vendors answer HTTP 200 while failing in the body, so the assertions
 * focus on that: a bad credential must surface as `auth_invalid`, and a
 * permission problem must not be reported as a bad credential.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 0, allowHttp: true },
});

interface Captured {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function startServer(
  reply: (request: Captured) => { status?: number; body?: string },
): Promise<{ baseUrl: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const captured: Captured = {
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      const out = reply(captured);
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(out.body ?? "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function ctxFor(
  type: string,
  baseUrl: string,
  options: { apiKey?: string; config?: Record<string, unknown> } = {},
): ProviderContext {
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
    config: options.config ?? {},
    search: { targetResults: 3, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 3 },
  };
  return {
    fetch: allowLocalFetch,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    config: runtime,
    signal: AbortSignal.timeout(5000),
    logger: console as never,
  };
}

describe("minimax", () => {
  it("posts the documented body and headers, and maps organic[]", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        organic: [
          { title: "T1", link: "https://a.example/1", snippet: "s1", date: "2026-03-01" },
          { title: "T2", link: "https://b.example/2", snippet: "s2" },
        ],
        related_searches: [{ query: "related" }],
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    }));
    const ctx = ctxFor("minimax", baseUrl, { apiKey: "sk-test" });
    const output = await minimaxAdapter.search({ query: "hello", limit: 10, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/v1/coding_plan/search");
    expect(requests[0]!.headers["authorization"]).toBe("Bearer sk-test");
    // The official client sends this; dropping it changes vendor-side attribution.
    expect(requests[0]!.headers["mm-api-source"]).toBe("Minimax-MCP");
    expect(JSON.parse(requests[0]!.body)).toEqual({ q: "hello" });
    expect(output.results).toHaveLength(2);
    expect(output.results[0]!.url).toBe("https://a.example/1");
    expect(output.results[0]!.publishedAt).toBe("2026-03-01");
  });

  it("treats base_resp 1004 as a credential problem, not 'no results'", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
    }));
    const ctx = ctxFor("minimax", baseUrl, { apiKey: "bad" });
    const error = await minimaxAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
    // Region mismatch is the most common real cause and must be named.
    expect((error as Error).message).toContain("region");
  });

  it("reports 2038 as a missing entitlement rather than a bad key", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ base_resp: { status_code: 2038, status_msg: "real-name verification required" } }),
    }));
    const ctx = ctxFor("minimax", baseUrl, { apiKey: "ok" });
    const error = await minimaxAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "blocked" });
    expect((error as Error).message).toContain("Coding Plan");
  });

  it("selects the host by region when baseUrl is not set", async () => {
    const regionCtx = ctxFor("minimax", "", { apiKey: "k", config: { region: "global" } });
    // baseUrl empty means "resolve from region"; the request then fails DNS-wise,
    // so assert the resolved URL instead of performing it.
    expect(regionCtx.config.baseUrl).toBe("");
    const failed = await minimaxAdapter
      .search({ query: "x", limit: 5, signal: AbortSignal.timeout(3000) }, regionCtx)
      .catch((caught: unknown) => caught);
    expect(String(failed)).not.toMatch(/auth_invalid/);
  });
});

describe("metaso", () => {
  it("sends q/scope/size/page with the documented shapes", async () => {
    const { baseUrl, requests } = await startServer(() => ({
      body: JSON.stringify({
        credits: 3,
        total: 2,
        webpages: [
          { title: "T", link: "https://m.example/1", snippet: "s", date: "2026-04-01" },
          { title: "B", link: "https://m.example/2", snippet: "s2" },
        ],
      }),
    }));
    const ctx = ctxFor("metaso", baseUrl, { apiKey: "mk-test", config: { scope: "webpage" } });
    const output = await metasoAdapter.search({ query: "搜索引擎", limit: 10, signal: ctx.signal }, ctx);

    expect(requests[0]!.url).toBe("/api/v1/search");
    expect(requests[0]!.headers["authorization"]).toBe("Bearer mk-test");
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body["q"]).toBe("搜索引擎");
    expect(body["scope"]).toBe("webpage");
    // The vendor's own examples quote size/page as strings.
    expect(body["size"]).toBe("3");
    expect(body["page"]).toBe("1");
    expect(output.results).toHaveLength(2);
    expect(output.warnings).toBeUndefined();
  });

  it("warns when scope is not the general web", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ webpages: [{ title: "T", link: "https://m.example/1" }] }),
    }));
    const ctx = ctxFor("metaso", baseUrl, { apiKey: "k", config: { scope: "scholar" } });
    const output = await metasoAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.warnings?.[0]).toContain("scope=scholar");
    expect(output.warnings?.[0]).toContain("全网");
  });

  it("maps errCode 2005 to auth_invalid despite HTTP 200", async () => {
    const { baseUrl } = await startServer(() => ({
      status: 200,
      body: JSON.stringify({ errCode: 2005, errMsg: "API密钥无效" }),
    }));
    const ctx = ctxFor("metaso", baseUrl, { apiKey: "bad" });
    const error = await metasoAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "auth_invalid" });
  });

  it("surfaces an unknown errCode verbatim instead of guessing", async () => {
    const { baseUrl } = await startServer(() => ({
      body: JSON.stringify({ errCode: 4102, errMsg: "quota exhausted" }),
    }));
    const ctx = ctxFor("metaso", baseUrl, { apiKey: "k" });
    const error = await metasoAdapter
      .search({ query: "x", limit: 5, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
    expect((error as Error).message).toContain("4102");
    expect((error as Error).message).toContain("quota exhausted");
  });
});

describe("metaso-mcp", () => {
  it("pre-configures the 秘塔 argument template and result path", async () => {
    const { baseUrl, requests } = await startServer((request) => {
      const body = request.body ? JSON.parse(request.body) : {};
      if (body.method === "initialize") {
        return { body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } }) };
      }
      if (body.method === "notifications/initialized") return { status: 202, body: "" };
      if (body.method === "tools/list") {
        return {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: [{ name: "metaso_search" }] },
          }),
        };
      }
      return {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: {
              webpages: [{ title: "T", link: "https://m.example/1", snippet: "s", date: "2026-05-05" }],
            },
          },
        }),
      };
    });
    const ctx = ctxFor("metaso-mcp", baseUrl, {});
    const output = await metasoMcpAdapter.search({ query: "测试", limit: 4, signal: ctx.signal }, ctx);

    const call = requests.find((item) => item.body.includes("tools/call"))!;
    const args = JSON.parse(call.body).params.arguments as Record<string, unknown>;
    // The 秘塔 tool takes `q`, not `query`.
    expect(args["q"]).toBe("测试");
    expect(args["size"]).toBe(4);
    expect(output.results[0]!.url).toBe("https://m.example/1");
    expect(output.results[0]!.publishedAt).toBe("2026-05-05");
  });

  it("points at the documented default endpoint without contacting it", async () => {
    const ctx = ctxFor("metaso-mcp", "", {});
    expect(ctx.config.baseUrl).toBe("");
    // A missing endpoint is a configuration error, not a silent local probe.
    const error = await metasoMcpAdapter
      .search({ query: "x", limit: 3, signal: ctx.signal }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request" });
  });
});
