import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { McpHttpClient, type McpTool } from "../mcp-client.js";

/**
 * Generic remote MCP search source.
 *
 * Users point it at a **remote** Streamable-HTTP MCP server and pick the tool
 * that performs a search. Everything else is declarative:
 *
 * - `tool` — tool name; when empty the adapter discovers it (a tool whose name
 *   contains `search`, `query` or `find`) and reports what it found.
 * - `argumentsTemplate` — JSON with `{{query}}` / `{{limit}}` placeholders,
 *   so each server's parameter names (`q`, `query`, `search_query`, …) can be
 *   honoured without code changes.
 * - `resultsPath` — dot path to the array in the tool result.
 * - `titleField` / `urlField` / `snippetField` — per-server field names.
 *
 * Security: only HTTP(S) endpoints reached through the injected SafeFetch
 * (SSRF guard + redirect policy), credentials are sent as a header from the
 * encrypted key store, and there is **no stdio transport** — a web user cannot
 * make the server execute a local process.
 */
const DEFAULT_TOOL_HINTS = ["search", "query", "find", "lookup"];

export const genericMcpAdapter: SearchProviderAdapter = {
  type: "generic-mcp",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const url = readUrl(ctx);
    const client = new McpHttpClient(ctx, {
      url,
      headers: authHeaders(ctx),
      timeoutMs: ctx.config.timeoutMs,
    });

    const configuredTool = asString(ctx.config.config["tool"]);
    let toolName = configuredTool;
    const warnings: string[] = [];

    if (!toolName) {
      const tools = await client.listTools();
      const picked = pickSearchTool(tools);
      if (!picked) {
        throw new ProviderError(
          ctx.config.id,
          "generic-mcp",
          "bad_request",
          tools.length === 0
            ? "The MCP server exposed no tools."
            : `No search-like tool found. Available tools: ${tools.map((tool) => tool.name).join(", ")}`,
        );
      }
      toolName = picked.name;
      warnings.push(`Auto-selected MCP tool "${toolName}". Set "tool" to pin it.`);
    }

    const args = buildArguments(ctx.config.config["argumentsTemplate"], input.query, input.limit);
    const result = await client.callTool(toolName, args);

    const array = extractArray(result.data, asString(ctx.config.config["resultsPath"]));
    const titleField = asString(ctx.config.config["titleField"]) ?? "title";
    const urlField = asString(ctx.config.config["urlField"]) ?? "url";
    const snippetField = asString(ctx.config.config["snippetField"]) ?? "snippet";
    const publishedField = asString(ctx.config.config["publishedField"]) ?? "publishedAt";

    const results: RawSearchResult[] = [];
    for (const item of array) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const link = pickDeep(record, urlField);
      if (typeof link !== "string" || !/^https?:\/\//i.test(link)) continue;
      const title = pickDeep(record, titleField);
      const snippet = pickDeep(record, snippetField);
      const published = pickDeep(record, publishedField);
      results.push({
        title: typeof title === "string" && title ? title : link,
        url: link,
        snippet: typeof snippet === "string" ? snippet.slice(0, 600) : "",
        ...(typeof published === "string" ? { publishedAt: published } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const url = readUrl(ctx);
      const client = new McpHttpClient(ctx, {
        url,
        headers: authHeaders(ctx),
        timeoutMs: ctx.config.timeoutMs,
      });
      const tools = await client.listTools();
      if (tools.length === 0) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: "MCP handshake succeeded but the server exposed no tools.",
        };
      }
      const configured = asString(ctx.config.config["tool"]);
      const picked = configured ? tools.find((tool) => tool.name === configured) : pickSearchTool(tools);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        resultCount: tools.length,
        message: configured
          ? picked
            ? `MCP server reachable; tool "${configured}" exists.`
            : `MCP server reachable; tool "${configured}" was not found. Available: ${tools.map((tool) => tool.name).join(", ")}`
          : `MCP server reachable; ${tools.length} tool(s); search tool candidate: ${picked?.name ?? "none"}.`,
        sample: tools.slice(0, 5).map((tool) => ({ title: tool.name, url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `MCP probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function readUrl(ctx: ProviderContext): string {
  const configured = (ctx.config.baseUrl ?? "").trim();
  if (!configured) {
    throw new ProviderError(
      ctx.config.id,
      "generic-mcp",
      "bad_request",
      "MCP endpoint is required, e.g. https://example.com/mcp",
    );
  }
  if (!/^https?:\/\//i.test(configured)) {
    throw new ProviderError(ctx.config.id, "generic-mcp", "bad_request", "MCP endpoint must be an http(s) URL.");
  }
  return configured;
}

/**
 * Builds the auth header from the encrypted credential.
 * `authHeader` lets a server use `X-API-Key` instead of Bearer; the prefix is
 * configurable because several servers require a bare value.
 */
function authHeaders(ctx: ProviderContext): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!ctx.apiKey) return headers;
  const headerName = asString(ctx.config.config["authHeader"]) ?? "authorization";
  const prefix = ctx.config.config["authPrefix"];
  // "none" means the server wants the raw secret with no scheme prefix.
  const value =
    prefix === false || prefix === "none"
      ? ctx.apiKey
      : `${typeof prefix === "string" ? prefix : "Bearer"} ${ctx.apiKey}`;
  headers[headerName.toLowerCase()] = value;
  return headers;
}

function pickSearchTool(tools: McpTool[]): McpTool | null {
  for (const hint of DEFAULT_TOOL_HINTS) {
    const match = tools.find((tool) => tool.name.toLowerCase().includes(hint));
    if (match) return match;
  }
  // A single-tool server is unambiguous even when the name is unusual.
  return tools.length === 1 ? tools[0]! : null;
}

/**
 * Fills `{{query}}` / `{{limit}}` placeholders inside a JSON template.
 * A template is required because every MCP search tool names its arguments
 * differently; guessing would send the wrong field and get zero results.
 */
function buildArguments(template: unknown, query: string, limit: number): Record<string, unknown> {
  if (typeof template === "string" && template.trim()) {
    const filled = template
      .replaceAll("{{query}}", JSON.stringify(query).slice(1, -1))
      .replaceAll("{{limit}}", String(limit));
    try {
      const parsed = JSON.parse(filled);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw new ProviderError(
        "generic-mcp",
        "generic-mcp",
        "bad_request",
        "argumentsTemplate is not valid JSON after substituting {{query}} / {{limit}}.",
      );
    }
  }
  return { query, limit };
}

function extractArray(data: unknown, path: string | undefined): unknown[] {
  const target = path ? pickDeep(data, path) : data;
  if (Array.isArray(target)) return target;
  if (target && typeof target === "object") {
    // Common wrappers when the path is not configured.
    for (const key of ["results", "items", "data", "documents", "hits"]) {
      const candidate = (target as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

function pickDeep(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!segment) continue;
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
