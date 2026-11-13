import { createMcpHandler, McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { registerTools, type McpDeps } from "./tools.js";

/**
 * MCP 2026-07-28 server factory.
 * A fresh McpServer is built per HTTP request; nothing is shared between
 * callers except the injected search service and provider registry.
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
