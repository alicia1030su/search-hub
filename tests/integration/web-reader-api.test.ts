import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SearchHubError, type SafeFetch, type SafeFetchResponse } from "@search-hub/shared";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

const ARTICLE = Array.from({ length: 30 }, () => "A detailed paragraph with substantive reporting and evidence about reliable webpage reading.").join(" ");
const HTML = `<!doctype html><html><head><title>Readable page</title><meta name='author' content='Ada'></head><body><article><h1>Readable page</h1><p>${ARTICLE}</p></article></body></html>`;

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
  token: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function response(html = HTML): SafeFetchResponse<string> {
  return { status: 200, headers: new Headers({ "content-type": "text/html; charset=utf-8" }), data: html, url: "https://example.com/final" };
}

async function createHarness(fetchResult: SafeFetchResponse<string> | Error = response()): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-web-reader-"));
  const config: AppConfig = {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
  };
  const ctx = createContext(config);
  const fetch = vi.fn(async () => {
    if (fetchResult instanceof Error) throw fetchResult;
    return fetchResult;
  });
  ctx.fetch = fetch as unknown as SafeFetch;
  const app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! },
  });
  expect(setup.statusCode).toBe(200);
  const cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  const csrf = setup.json().csrfToken as string;
  const created = await app.inject({
    method: "POST",
    url: "/api/admin/tokens",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { name: "web-reader", scopes: ["mcp:use", "search"], rateLimitPerMin: 100 },
  });
  expect(created.statusCode).toBe(200);
  const harness = { app, ctx, dir, cookie, csrf, token: created.json().token as string };
  harnesses.push(harness);
  return harness;
}

async function mcpWebpageCall(harness: Harness, url: string) {
  const response = await harness.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${harness.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fetch_webpage", arguments: { url, maxContentChars: 500 } },
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.body.trim();
  const dataLines = body.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  const rpc = JSON.parse(body.startsWith("{") ? body : dataLines[dataLines.length - 1]!) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: rpc.result.isError === true, payload: JSON.parse(rpc.result.content[0]!.text) as Record<string, unknown> };
}

describe("MCP fetch_webpage integration", () => {
  it("reads a page through the injected API service", async () => {
    const harness = await createHarness();
    const result = await mcpWebpageCall(harness, "https://example.com/");
    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({ readStatus: "ok", reasonCode: "ok", title: "Readable page" });
    expect(result.payload["content"]).toContain("# Readable page");
  });

  it("preserves classified 422 results as MCP tool results", async () => {
    const harness = await createHarness(response("<html><head><title>Login</title></head><body><form action='/login'><input type='password'></form></body></html>"));
    const result = await mcpWebpageCall(harness, "https://example.com/private");
    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({ readStatus: "login_required", reasonCode: "login_required", content: null });
  });

  it("does not leak network error details through MCP", async () => {
    const harness = await createHarness(new SearchHubError("network", "failed?token=secret"));
    const result = await mcpWebpageCall(harness, "https://example.com/?token=secret");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.payload)).toContain("Webpage request failed");
    expect(JSON.stringify(result.payload)).not.toContain("secret");
  });
});

describe("POST /api/web/read", () => {
  it("requires authentication before fetching", async () => {
    const harness = await createHarness();
    const result = await harness.app.inject({ method: "POST", url: "/api/web/read", payload: { url: "https://example.com/" } });
    expect(result.statusCode).toBe(401);
    expect(harness.ctx.fetch).not.toHaveBeenCalled();
  });

  it("returns Markdown with 200 and forwards limits to SafeFetch", async () => {
    const harness = await createHarness();
    const result = await harness.app.inject({
      method: "POST",
      url: "/api/web/read",
      cookies: { sh_session: harness.cookie },
      payload: { url: "https://example.com/start", maxContentChars: 500, timeoutMs: 2000 },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ title: "Readable page", author: "Ada", readStatus: "ok", reasonCode: "ok", requestedUrl: "https://example.com/start", finalUrl: "https://example.com/final" });
    expect(result.json().content).toContain("# Readable page");
    expect(result.json().content).not.toContain("<article>");
    expect(harness.ctx.fetch).toHaveBeenCalledWith("https://example.com/start", expect.objectContaining({ timeoutMs: 2000, maxBytes: 2 * 1024 * 1024 }));
  });

  it("returns 422 with structured reasonCode for unavailable pages", async () => {
    const harness = await createHarness(response("<html><head><title>Login</title></head><body><form action='/login'><input type='password'></form></body></html>"));
    const result = await harness.app.inject({
      method: "POST",
      url: "/api/web/read",
      cookies: { sh_session: harness.cookie },
      payload: { url: "https://example.com/private" },
    });
    expect(result.statusCode).toBe(422);
    expect(result.json()).toMatchObject({ readStatus: "login_required", reasonCode: "login_required", content: null });
  });

  it("maps network errors to 502 without leaking upstream details", async () => {
    const harness = await createHarness(new SearchHubError("network", "Network error requesting https://example.com/?token=secret"));
    const result = await harness.app.inject({
      method: "POST",
      url: "/api/web/read",
      cookies: { sh_session: harness.cookie },
      payload: { url: "https://example.com/?token=secret" },
    });
    expect(result.statusCode).toBe(502);
    expect(result.json().error.code).toBe("network");
    expect(result.body).not.toContain("token=secret");
  });

  it("maps timeouts to 504", async () => {
    const harness = await createHarness(new SearchHubError("timeout", "Request timed out after 2000ms", { status: 504 }));
    const result = await harness.app.inject({
      method: "POST",
      url: "/api/web/read",
      cookies: { sh_session: harness.cookie },
      payload: { url: "https://example.com/", timeoutMs: 2000 },
    });
    expect(result.statusCode).toBe(504);
    expect(result.json().error.code).toBe("timeout");
  });

  it.each([
    {},
    { url: "file:///etc/passwd" },
    { url: "https://user:pass@example.com/" },
    { url: "https://example.com/", maxContentChars: 0 },
    { url: "https://example.com/", timeoutMs: 0 },
  ])("rejects invalid input before fetching: %j", async (payload) => {
    const harness = await createHarness();
    const result = await harness.app.inject({ method: "POST", url: "/api/web/read", cookies: { sh_session: harness.cookie }, payload });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe("validation_error");
    expect(harness.ctx.fetch).not.toHaveBeenCalled();
  });
});
