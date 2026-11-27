import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SearchHubError } from "@search-hub/shared";
import { HttpHealthService, HttpProviderService, HttpSearchService, HttpWebpageService } from "./http-client.js";
import { createServerFactory } from "./server.js";
import { MCP_VERSION } from "./version.js";

/**
 * stdio MCP server. It proxies every tool call to the REST API so the stdio
 * and HTTP transports share one implementation and one configuration.
 *
 * Required environment:
 *   SEARCH_HUB_URL    - base URL of a running Search Hub instance
 *   SEARCH_HUB_TOKEN  - access token with the mcp:use scope
 */
export function main(): void {
  const baseUrl = process.env["SEARCH_HUB_URL"] ?? "http://127.0.0.1:8787";
  const token = process.env["SEARCH_HUB_TOKEN"];
  if (!token) {
    process.stderr.write(
      "SEARCH_HUB_TOKEN is required. Create a token with the mcp:use scope in Search Hub → Integrations.\n",
    );
    process.exit(1);
  }

  const deps = {
    search: new HttpSearchService(baseUrl, token),
    webpage: new HttpWebpageService(baseUrl, token),
    providers: new HttpProviderService(baseUrl, token),
    health: () => new HttpHealthService(baseUrl, token).snapshot(),
    version: MCP_VERSION,
  };

  serveStdio(createServerFactory(deps), {
    onerror: (error: Error) => {
      process.stderr.write(`[search-hub-mcp] ${error.message}\n`);
    },
  });
  process.stderr.write(`[search-hub-mcp] stdio server ready, proxying ${baseUrl}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    const message = error instanceof SearchHubError ? error.message : String(error);
    process.stderr.write(`[search-hub-mcp] fatal: ${message}\n`);
    process.exit(1);
  }
}
