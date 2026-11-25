import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const releaseVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "mcp-client.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
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

beforeAll(async () => {
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
      expect(client.getServerVersion()).toMatchObject({ name: "search-hub", version: releaseVersion });
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
      expect(client.getServerVersion()).toMatchObject({ name: "search-hub", version: releaseVersion });
      const payload = await exercise(client, "stdio");
      expect(payload.taskId).toBeTruthy();
    } finally {
      await client.close();
    }
  }, 30_000);

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
