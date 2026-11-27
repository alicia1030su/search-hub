import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("returns a generic stdio error for older REST servers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "local /private/path?token=secret" } }, { status: 404 })));
    const service = new HttpWebpageService("https://hub.example.com", "test-token");
    await expect(service.read("https://example.com/")).rejects.toThrow("Webpage reading is unavailable on this Search Hub server");
    vi.unstubAllGlobals();
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
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a sanitized error when the upstream read fails", async () => {
    const response = await register({ webpage: { read: async () => { throw new Error("network unavailable?token=secret"); } } }).call({ url: "https://example.com/" });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("Webpage request failed");
    expect(response.content[0]!.text).not.toContain("network unavailable");
  });
});
