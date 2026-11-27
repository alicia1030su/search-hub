import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchHubError } from "@search-hub/shared";
import { registerTools, type McpDeps } from "../../packages/mcp/src/tools.js";
import { HttpWebpageService } from "../../packages/mcp/src/http-client.js";

afterEach(() => vi.unstubAllGlobals());

type ToolContext = { http?: { authInfo?: { scopes?: string[] } } };
type ToolHandler = (args: unknown, context: ToolContext) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

function register(deps: Partial<McpDeps> = {}) {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => tools.set(name, handler),
  };
  registerTools(server as unknown as Parameters<typeof registerTools>[0], {
    search: { execute: vi.fn() },
    providers: { list: vi.fn(), status: vi.fn() },
    version: "0.1.18",
    ...deps,
  });
  return {
    call: (args: unknown, scopes = ["search"]) => tools.get("fetch_webpage")!(args, { http: { authInfo: { scopes } } }),
  };
}

const result = {
  title: "Page",
  content: "# Page",
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  contentLength: 7,
  readStatus: "ok",
  truncated: false,
  reasonCode: "ok",
};

describe("MCP fetch_webpage", () => {
  it("proxies REST 422 classification through the stdio webpage service", async () => {
    const fetchMock = vi.fn(async () => Response.json({ readStatus: "captcha", reasonCode: "captcha_detected", content: null }, { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new HttpWebpageService("https://hub.example.com", "test-token");
    await expect(service.read("https://example.com/", { maxContentChars: 50 })).resolves.toMatchObject({ readStatus: "captcha", reasonCode: "captcha_detected" });
    expect(fetchMock).toHaveBeenCalledWith("https://hub.example.com/api/web/read", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer test-token" }),
      body: JSON.stringify({ url: "https://example.com/", maxContentChars: 50 }),
    }));
    vi.unstubAllGlobals();
  });

  it("returns a classified stdio error for older REST servers without leaking details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "local /private/path?token=secret" } }, { status: 404 })));
    const service = new HttpWebpageService("https://hub.example.com", "test-token");
    await expect(service.read("https://example.com/")).rejects.toMatchObject({ code: "not_found" });
    vi.unstubAllGlobals();
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server_error"],
    [502, "server_error"],
    [504, "timeout"],
  ])("preserves HTTP %i classification as %s", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "private/path?token=secret" } }, { status })));
    const service = new HttpWebpageService("https://hub.example.com", "test-token");
    await expect(service.read("https://example.com/")).rejects.toMatchObject({ code });
  });

  it("times out a hung stdio request", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    const service = new HttpWebpageService("https://hub.example.com", "test-token", 5);
    await expect(service.read("https://example.com/")).rejects.toMatchObject({ code: "timeout" });
  });

  it("forwards caller cancellation and does not fetch when pre-cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new HttpWebpageService("https://hub.example.com", "test-token");
    await expect(service.read("https://example.com/", { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();

    const active = new AbortController();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const pending = service.read("https://example.com/", { signal: active.signal });
    active.abort(new Error("stop"));
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects oversized streamed responses", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        stream.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const service = new HttpWebpageService("https://hub.example.com", "test-token");
    await expect(service.read("https://example.com/")).rejects.toMatchObject({ code: "network" });
  });

  it("rejects invalid JSON responses instead of reporting success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const service = new HttpWebpageService("https://hub.example.com", "test-token");
    await expect(service.read("https://example.com/")).rejects.toMatchObject({ code: "network" });
  });

  it("uses the injected webpage service and forwards maxContentChars", async () => {
    const read = vi.fn(async () => result);
    const response = await register({ webpage: { read } }).call({ url: "https://example.com/", maxContentChars: 100 });
    expect(read).toHaveBeenCalledWith("https://example.com/", { maxContentChars: 100 });
    expect(response.isError).toBeFalsy();
    expect(JSON.parse(response.content[0]!.text)).toEqual(result);
  });

  it("marks unavailable pages as tool errors while preserving reasonCode", async () => {
    const unavailable = { ...result, content: null, readStatus: "captcha", reasonCode: "captcha_detected" };
    const response = await register({ webpage: { read: async () => unavailable } }).call({ url: "https://example.com/" });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ readStatus: "captcha", reasonCode: "captcha_detected", content: null });
  });

  it("degrades cleanly when older dependencies do not provide a webpage service", async () => {
    const response = await register().call({ url: "https://example.com/" });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ available: false });
  });

  it("requires the search scope", async () => {
    const read = vi.fn(async () => result);
    const response = await register({ webpage: { read } }).call({ url: "https://example.com/" }, ["sources:read"]);
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ error: { code: "webpage_forbidden" } });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthorized", "webpage_auth_required"],
    ["timeout", "webpage_timeout"],
    ["network", "webpage_network_error"],
    ["rate_limited", "webpage_rate_limited"],
    ["not_found", "webpage_endpoint_not_found"],
    ["server_error", "webpage_upstream_error"],
    ["cancelled", "webpage_cancelled"],
  ] as const)("maps %s to stable tool error %s", async (code, expected) => {
    const response = await register({ webpage: { read: async () => { throw new SearchHubError(code, "private/path?token=secret"); } } }).call({ url: "https://example.com/" });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ error: { code: expected } });
    expect(response.content[0]!.text).not.toContain("secret");
  });

  it("returns a sanitized error when the upstream read fails", async () => {
    const response = await register({ webpage: { read: async () => { throw new Error("network unavailable?token=secret"); } } }).call({ url: "https://example.com/" });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("Webpage request failed");
    expect(response.content[0]!.text).not.toContain("network unavailable");
  });
});
