import type { ProviderContext } from "@search-hub/shared";

/**
 * Minimal MCP client for the **Streamable HTTP** transport.
 *
 * Only the three messages a search provider needs are implemented:
 * `initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
 * There is deliberately no stdio transport: a web user must never be able to
 * make the server spawn a local process.
 *
 * Every request goes through the provider's injected `SafeFetch`, so the same
 * SSRF guard, redirect policy, timeout and size cap apply as for HTTP providers.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  /** Parsed JSON payload if the tool returned one, otherwise `{ text }`. */
  data: unknown;
  /** Raw content blocks, kept for diagnostics. */
  blocks: Array<{ type?: string; text?: string }>;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly options: { url: string; headers: Record<string, string>; timeoutMs?: number },
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const result = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "search-hub", version: "0.1.4" },
    });
    if (!result || typeof result !== "object") {
      throw new Error("MCP initialize returned no result object");
    }
    // Some servers require the initialized notification before tools/list.
    await this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const result = (await this.rpc("tools/list", {})) as { tools?: unknown } | null;
    const tools = Array.isArray(result?.tools) ? result!.tools : [];
    return tools
      .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object")
      .map((tool) => ({
        name: typeof tool["name"] === "string" ? tool["name"] : "",
        ...(typeof tool["description"] === "string" ? { description: tool["description"] } : {}),
        ...(tool["inputSchema"] && typeof tool["inputSchema"] === "object"
          ? { inputSchema: tool["inputSchema"] as Record<string, unknown> }
          : {}),
      }))
      .filter((tool) => tool.name.length > 0);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.initialize();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: unknown;
    } | null;

    if (!result || typeof result !== "object") {
      throw new Error("MCP tools/call returned no result object");
    }
    if (result.isError === true) {
      throw new Error("MCP tool reported an error result");
    }

    const blocks = Array.isArray(result.content)
      ? (result.content as Array<Record<string, unknown>>).map((block) => ({
          type: typeof block["type"] === "string" ? block["type"] : undefined,
          text: typeof block["text"] === "string" ? block["text"] : undefined,
        }))
      : [];

    // `structuredContent` is the modern, lossless way to return data; the text
    // block is a JSON string by convention. Prefer the structured form.
    if (result.structuredContent !== undefined) {
      return { data: result.structuredContent, blocks };
    }
    const textBlock = blocks.find((block) => block.type === "text" && block.text);
    if (textBlock?.text) {
      try {
        return { data: JSON.parse(textBlock.text), blocks };
      } catch {
        return { data: { text: textBlock.text }, blocks };
      }
    }
    return { data: null, blocks };
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    if (!response) return null;
    if (response.error) {
      const error = response.error as Record<string, unknown>;
      const message = typeof error["message"] === "string" ? error["message"] : "MCP error";
      throw new Error(`MCP ${method} failed: ${message}`);
    }
    return response.result ?? null;
  }

  private async post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Both are required by the Streamable HTTP transport.
      accept: "application/json, text/event-stream",
      ...this.options.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const response = await this.ctx.fetch<unknown>(this.options.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      signal: this.ctx.signal,
    });

    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    // A notification has no response body by definition.
    if (response.status === 202 || response.status === 204) return null;

    const payload = parsePayload(response.data, response.headers.get("content-type"));
    if (!payload) return null;
    return payload;
  }
}

/**
 * Accepts either a plain JSON body or a single SSE event carrying JSON.
 * Servers commonly answer `text/event-stream` even for a one-shot request.
 */
function parsePayload(data: unknown, contentType: string | null): Record<string, unknown> | null {
  if (data && typeof data === "object") return data as Record<string, unknown>;
  if (typeof data !== "string") return null;

  const text = data.trim();
  if (!text) return null;

  if (contentType && contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
