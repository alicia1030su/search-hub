import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;
let csrf: string;
let token: string;

function parseMcp(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) throw new Error(`Not an MCP response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(dataLines[dataLines.length - 1]!) as Record<string, unknown>;
}

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "mcp.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-mcp-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  csrf = setup.json().csrfToken as string;

  const provider = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: {
      name: "mcp-mock",
      type: "mock",
      enabled: true,
      config: { resultCount: 5, latencyMs: 5, namespace: "mcp" },
    },
  });
  expect(provider.statusCode).toBe(200);

  const created = await app.inject({
    method: "POST",
    url: "/api/admin/tokens",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { name: "mcp-client", scopes: ["mcp:use", "search"], rateLimitPerMin: 300 },
  });
  token = created.json().token as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function mcpCall(payload: unknown, extraHeaders: Record<string, string> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    payload: payload as Record<string, unknown>,
  });
  return { status: response.statusCode, body: response.body, json: response.body ? parseMcp(response.body) : null };
}

describe("MCP Streamable HTTP", () => {
  it("requires a bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("initializes and advertises tools", async () => {
    const init = await mcpCall({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    const result = init.json!.result as {
      serverInfo: { name: string };
      capabilities: { tools: unknown };
    };
    expect(result.serverInfo.name).toBe("search-hub");
    expect(result.capabilities.tools).toBeTruthy();

    const list = await mcpCall({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    const tools = (list.json!.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        // Read-only provider health (added in v0.1.5-beta.2). It must never be
        // able to trigger a paid probe, so it is part of the advertised list.
        "fetch_webpage",
        "get_provider_health",
        "get_search_sources",
        "get_search_status",
        "search_and_rerank",
        "search_and_summarize",
        "search_deep",
        "search_multi",
        "search_news",
        "search_web",
        "search_with_sources",
      ].sort(),
    );
  });

  it("executes search_web through the shared search core", async () => {
    const response = await mcpCall({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_web", arguments: { query: "mcp integration", limit: 5 } },
    });
    expect(response.status).toBe(200);
    const result = response.json!.result as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ title: string; url: string }>;
      taskId: string;
    };
    expect(payload.taskId).toMatch(/^task_/);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0]!.url).toMatch(/^https:\/\//);
  });

  it("returns a readable tool error for invalid arguments", async () => {
    const response = await mcpCall({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_web", arguments: { query: "" } },
    });
    // The SDK rejects the schema before the handler; either an error result or
    // a JSON-RPC error is acceptable, but it must not crash the server.
    expect([200, 400]).toContain(response.status);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it("never exposes API keys through status tools", async () => {
    const response = await mcpCall({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_search_status", arguments: {} },
    });
    expect(response.status).toBe(200);
    const result = response.json!.result as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("serves the 2026-07-28 modern revision with the per-request envelope", async () => {
    // The modern revision has no initialize handshake: each request carries the
    // version + method headers and the envelope keys inside params._meta.
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "vitest-modern", version: "1.0.0" },
    };
    const modernHeaders = {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    };

    const list = await mcpCall(
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: meta } },
      modernHeaders,
    );
    expect(list.status).toBe(200);
    const tools = (list.json!.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toContain("search_web");

    const call = await mcpCall(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "search_web", arguments: { query: "modern protocol", limit: 3 }, _meta: meta },
      },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "search_web" },
    );
    expect(call.status).toBe(200);
    const result = call.json!.result as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).results.length).toBeGreaterThan(0);
  });

  it("rejects a legacy initialize that claims the modern version in the header", async () => {
    // Mixing a 2025-era handshake with a 2026-era header must fail loudly
    // instead of being silently downgraded.
    const response = await mcpCall(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "mismatch", version: "1.0.0" },
        },
      },
      { "mcp-protocol-version": "2026-07-28" },
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.json)).toMatch(/disagree|mismatch/i);
  });
});
