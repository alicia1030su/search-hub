import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let baseUrl = "";
let token = "";
let cookie: string;
let csrf: string;
let modelServer: Server;
let modelBaseUrl = "";

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "mcp-client.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    allowedHosts: ["localhost", "127.0.0.1", "::1"],
    corsOrigins: ["https://console.example.test"],
    logLevel: "silent",
  };
}

async function adminInit(path: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: path,
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: payload as Record<string, unknown>,
  });
}

async function addModel(kind: "chat" | "rerank", baseUrl: string): Promise<void> {
  const response = await adminInit("/api/admin/models", {
    kind,
    name: `mcp-${kind}-stub`,
    providerType: kind === "chat" ? "openai-compatible" : "cohere",
    baseUrl,
    modelId: `${kind}-test`,
    timeoutMs: 2_000,
    maxConcurrency: 2,
    enabled: true,
    isDefault: true,
    params: {},
  });
  expect(response.statusCode, response.body).toBe(200);
}

beforeAll(async () => {
  modelServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.endsWith("/v1/rerank")) {
      response.end(JSON.stringify({ results: [0, 1, 2, 3, 4].map((index) => ({ index, relevance_score: 1 - index / 10 })) }));
      return;
    }
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      model: "mcp-chat-stub",
    }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  modelBaseUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), "search-hub-mcp-client-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address !== "object" || !address) throw new Error("server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  csrf = setup.json().csrfToken as string;

  const provider = await adminInit("/api/admin/providers", {
    name: "mcp-probe",
    type: "mock",
    enabled: true,
    maxConcurrency: 4,
    rpmLimit: 1000,
    config: { resultCount: 5, latencyMs: 4, namespace: "mcp" },
  });
  expect(provider.statusCode).toBe(200);
  const security = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });
  expect(security.statusCode, security.body).toBe(200);
  await addModel("chat", `${modelBaseUrl}/v1`);
  await addModel("rerank", modelBaseUrl);

  const created = await adminInit("/api/admin/tokens", {
    name: "mcp-client-test",
    scopes: ["search", "mcp:use", "sources:read"],
    rateLimitPerMin: 600,
  });
  expect(created.statusCode).toBe(200);
  token = created.json().token;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) =>
    modelServer.close((error) => error ? reject(error) : resolve()),
  );
  rmSync(dir, { recursive: true, force: true });
});

async function exercise(client: Client, label: string) {
  const tools = await client.listTools();
  expect(tools.tools.length, `${label} tool count`).toBeGreaterThanOrEqual(9);

  const result = await client.callTool({ name: "search_web", arguments: { query: "mcp transport", limit: 5 } });
  expect(result.isError, `${label} search_web isError`).toBeFalsy();
  const payload = (result.structuredContent ??
    JSON.parse((result.content as Array<{ text: string }>)[0]!.text)) as {
    results: Array<{ url: string; provider: string }>;
    taskId: string;
  };
  expect(payload.results.length, `${label} results`).toBeGreaterThan(0);
  expect(payload.results[0]!.url).toMatch(/^https?:\/\//);
  expect(payload.results[0]!.provider).toBeTruthy();

  const sources = await client.callTool({ name: "get_search_sources", arguments: {} });
  const sourcePayload = (sources.structuredContent ??
    JSON.parse((sources.content as Array<{ text: string }>)[0]!.text)) as { providers: unknown[] };
  expect(sourcePayload.providers.length, `${label} providers`).toBeGreaterThan(0);

  const invalid = await client.callTool({ name: "search_web", arguments: { query: "" } });
  expect(invalid.isError, `${label} invalid input`).toBe(true);

  return payload;
}

describe("MCP official client (AC-07)", () => {
  it("serves tools over Streamable HTTP", async () => {
    const client = new Client({ name: "vitest-http", version: "0.1.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const payload = await exercise(client, "http");
      expect(payload.taskId).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("serves the same core over stdio and proxies to REST", async () => {
    const client = new Client({ name: "vitest-stdio", version: "0.1.1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "packages/mcp/src/stdio.ts"],
      cwd: process.cwd(),
      env: { SEARCH_HUB_URL: baseUrl, SEARCH_HUB_TOKEN: token, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      const payload = await exercise(client, "stdio");
      expect(payload.taskId).toBeTruthy();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("BUG-0116-06 HTTP and stdio advertise the same product version and core results", async () => {
    const http = new Client({ name: "vitest-http-parity", version: "0.1.1" });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await http.connect(httpTransport);
    const stdio = new Client({ name: "vitest-stdio-parity", version: "0.1.1" });
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "packages/mcp/src/stdio.ts"],
      cwd: process.cwd(),
      env: { SEARCH_HUB_URL: baseUrl, SEARCH_HUB_TOKEN: token, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    try {
      await stdio.connect(stdioTransport);
      const httpVersion = http.getServerVersion()?.version;
      const stdioVersion = stdio.getServerVersion()?.version;
      const httpPayload = await exercise(http, "http-parity");
      const stdioPayload = await exercise(stdio, "stdio-parity");

      expect(httpVersion).toBe(ctx.config.version);
      expect(stdioVersion).toBe(ctx.config.version);
      expect(stdioVersion).toBe(httpVersion);
      expect(stdioPayload.results.map((item) => item.url)).toEqual(httpPayload.results.map((item) => item.url));
    } finally {
      await stdio.close();
      await http.close();
    }
  }, 30_000);

  it("MCP-SCOPE-01 enforces every search and sources:read tool scope over HTTP and stdio", async () => {
    const created = await adminInit("/api/admin/tokens", {
      name: "mcp-use-only",
      scopes: ["mcp:use"],
      rateLimitPerMin: 600,
    });
    expect(created.statusCode).toBe(200);
    const mcpOnlyToken = created.json().token as string;
    const http = new Client({ name: "vitest-http-scope", version: "0.1.1" });
    const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpOnlyToken}` } },
    });
    await http.connect(httpTransport);
    const stdio = new Client({ name: "vitest-stdio-scope", version: "0.1.1" });
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "packages/mcp/src/stdio.ts"],
      cwd: process.cwd(),
      env: {
        SEARCH_HUB_URL: baseUrl,
        SEARCH_HUB_TOKEN: mcpOnlyToken,
        PATH: process.env["PATH"] ?? "",
      },
      stderr: "pipe",
    });
    const authorizedHttp = new Client({ name: "vitest-http-scope-control", version: "0.1.1" });
    const authorizedHttpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await authorizedHttp.connect(authorizedHttpTransport);
    const authorizedStdio = new Client({ name: "vitest-stdio-scope-control", version: "0.1.1" });
    const authorizedStdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "packages/mcp/src/stdio.ts"],
      cwd: process.cwd(),
      env: {
        SEARCH_HUB_URL: baseUrl,
        SEARCH_HUB_TOKEN: token,
        PATH: process.env["PATH"] ?? "",
      },
      stderr: "pipe",
    });
    try {
      await stdio.connect(stdioTransport);
      await authorizedStdio.connect(authorizedStdioTransport);
      const searchCases: Array<{ name: string; arguments: Record<string, unknown> }> = [
        { name: "search_web", arguments: { query: "mcp scope", limit: 3 } },
        { name: "search_multi", arguments: { queries: ["mcp scope"], limit: 3 } },
        { name: "search_deep", arguments: { query: "mcp scope", limit: 3 } },
        { name: "search_news", arguments: { query: "mcp scope", limit: 3 } },
        { name: "search_with_sources", arguments: { query: "mcp scope", limit: 3 } },
        { name: "search_and_rerank", arguments: { query: "mcp scope", limit: 3 } },
        { name: "search_and_summarize", arguments: { query: "mcp scope", limit: 3 } },
      ];
      const sourceCases: Array<{ name: string; arguments: Record<string, unknown> }> = [
        { name: "get_search_sources", arguments: {} },
        { name: "get_search_status", arguments: {} },
      ];

      // Positive controls prove a denial is caused by scope enforcement, not
      // by missing models, malformed arguments, or an unreachable fake vendor.
      for (const testCase of [...searchCases, ...sourceCases]) {
        const httpControl = await authorizedHttp.callTool(testCase);
        const stdioControl = await authorizedStdio.callTool(testCase);
        expect(httpControl.isError, `${testCase.name} authorized HTTP control`).toBeFalsy();
        expect(stdioControl.isError, `${testCase.name} authorized stdio control`).toBeFalsy();
      }
      for (const testCase of [...searchCases, ...sourceCases]) {
        const httpResult = await http.callTool(testCase);
        const stdioResult = await stdio.callTool(testCase);
        expect(httpResult.isError, `${testCase.name} HTTP must enforce its REST scope`).toBe(true);
        expect(stdioResult.isError, `${testCase.name} stdio must enforce the same scope`).toBe(true);
      }

      const httpHealth = await http.callTool({ name: "get_provider_health", arguments: {} });
      const stdioHealth = await stdio.callTool({ name: "get_provider_health", arguments: {} });
      expect(httpHealth.isError, "mcp:use alone must permit read-only health over HTTP").toBeFalsy();
      expect(stdioHealth.isError, "mcp:use alone must permit read-only health over stdio").toBeFalsy();
    } finally {
      await authorizedStdio.close();
      await authorizedHttp.close();
      await stdio.close();
      await http.close();
    }
  }, 60_000);

  it("MCP-ORIGIN-01 compares scheme and port and rejects malformed or repeated Origin values", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const request = async (origin: string) =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          origin,
        },
        body,
      });
    const rawRequest = (origin: string | string[], host?: string) =>
      new Promise<number>((resolve, reject) => {
        const url = new URL(`${baseUrl}/mcp`);
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
              origin,
              ...(host ? { host } : {}),
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end(body);
      });

    expect((await request(baseUrl)).status).toBe(200);
    expect((await request("https://console.example.test")).status).toBe(200);
    expect(await rawRequest("http://127.0.0.1", `localhost:${new URL(baseUrl).port}`)).toBe(200);

    const url = new URL(baseUrl);
    const differentScheme = new URL(url);
    differentScheme.protocol = "https:";
    const differentPort = new URL(url);
    differentPort.port = "4443";
    for (const origin of [differentScheme.origin, differentPort.origin]) {
      const response = await request(origin);
      expect(response.status, `Origin ${origin} must not inherit the Host allowlist`).toBe(403);
    }
    for (const origin of ["not a valid origin", "", "null"]) {
      expect(await rawRequest(origin), `Origin ${JSON.stringify(origin)} must be rejected`).toBe(403);
    }
    expect(await rawRequest([
      "https://console.example.test",
      "https://evil.example.com",
    ]), "repeated Origin headers must be rejected").toBe(403);
  });

  it("rejects a browser Origin that is not allowlisted", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        origin: "https://evil.example.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects a rebound Host header before authentication", async () => {
    // fetch() ignores an explicit Host header, so use the raw HTTP client.
    const url = new URL(`${baseUrl}/mcp`);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const { status, payload } = await new Promise<{ status: number; payload: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            host: "rebind.example.com",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, payload: data }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(status).toBe(403);
    expect(payload).toContain("Host");
  });

  it("requires a Bearer token instead of the admin cookie", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        cookie: `sh_session=${cookie}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(401);
  });
});
