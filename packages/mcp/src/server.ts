import { createMcpHandler, McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { registerTools, type McpDeps } from "./tools.js";

/**
 * MCP server factory.
 *
 * A fresh McpServer is built per HTTP request; nothing is shared between callers
 * except the injected search service and provider registry.
 *
 * Protocol revision: the installed SDK negotiates 2025-11-25 / 2025-06-18 /
 * 2025-03-26 / 2024-11-05 and **downgrades a 2026-07-28 request to 2025-11-25**
 * (measured, see docs/mcp-protocol.md). This factory therefore does not claim
 * 2026-07-28 support; the admin status page reports the measured negotiation.
 *
 * `tools/list_changed` is intentionally NOT sent. Every tool this server exposes
 * is static: adding or disabling a *provider instance* changes search behaviour,
 * not the tool catalogue. Sending the notification would tell clients to refetch
 * a list that cannot have changed.
 */
export function createServerFactory(deps: McpDeps): McpServerFactory {
  return () => {
    const server = new McpServer(
      { name: "search-hub", version: deps.version },
      { capabilities: { tools: {} } },
    );
    registerTools(server, deps);
    return server;
  };
}

/** Streamable HTTP handler used by both the API process and tests. */
export function createMcpHttpHandler(deps: McpDeps) {
  return createMcpHandler(createServerFactory(deps), {
    responseMode: "json",
    legacy: "stateless",
    onerror: (error) => {
      // The API layer logs request errors; keep this hook side-effect free.
      void error;
    },
  });
}
