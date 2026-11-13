/**
 * Real MCP client verification.
 *
 * Uses the official @modelcontextprotocol/client SDK (not a hand-rolled curl
 * call) so the test exercises the same handshake a real MCP client performs:
 *
 *   1. Streamable HTTP: initialize -> tools/list -> tools/call
 *   2. stdio: spawn `node packages/mcp/dist/stdio.mjs`, same three steps
 *   3. Cross-transport consistency: both return the same search core payload
 *
 * Usage:
 *   node tests/scripts/mcp-live.mjs --url http://127.0.0.1:8787 --token sh_xxx \
 *        [--stdio packages/mcp/dist/stdio.mjs] [--query "typescript monorepo"]
 *
 * Exit code 0 only when every assertion passes.
 */
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = arg("url", "http://127.0.0.1:8787");
const token = arg("token", process.env["SEARCH_HUB_TOKEN"] ?? "");
const stdioPath = arg("stdio", "packages/mcp/dist/stdio.mjs");
const query = arg("query", "typescript monorepo");

if (!token) {
  console.error("FAIL: --token or SEARCH_HUB_TOKEN is required");
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

async function exercise(client, label) {
  const tools = await client.listTools();
  check(`${label}: tools/list returns >= 9 tools`, tools.tools.length >= 9, `${tools.tools.length} tools`);

  const names = tools.tools.map((tool) => tool.name).sort();
  for (const required of ["search_web", "get_search_sources", "search_multi"]) {
    check(`${label}: exposes ${required}`, names.includes(required), names.join(","));
  }

  const response = await client.callTool({
    name: "search_web",
    arguments: { query, limit: 5 },
  });
  const payload = response.structuredContent ?? JSON.parse(response.content[0].text);
  check(`${label}: search_web returns structured results`, Array.isArray(payload.results) && payload.results.length > 0, `${payload.results?.length ?? 0} results`);
  const first = payload.results?.[0];
  check(
    `${label}: result has a real http(s) URL`,
    Boolean(first && typeof first.url === "string" && /^https?:\/\//.test(first.url)),
    first?.url,
  );
  check(
    `${label}: result carries provider attribution`,
    Boolean(first && typeof first.provider === "string" && first.provider.length > 0),
    first?.provider,
  );

  const sources = await client.callTool({ name: "get_search_sources", arguments: {} });
  const sourcePayload = sources.structuredContent ?? JSON.parse(sources.content[0].text);
  check(
    `${label}: get_search_sources lists configured providers`,
    Array.isArray(sourcePayload.providers ?? sourcePayload.sources),
    JSON.stringify((sourcePayload.providers ?? sourcePayload.sources ?? []).length),
  );

  // Invalid arguments must produce a readable error, not a crash.
  const invalid = await client.callTool({ name: "search_web", arguments: { query: "" } });
  check(`${label}: empty query is rejected with a readable error`, Boolean(invalid.isError), invalid.isError ? "isError=true" : "no error flag");

  return payload;
}

async function main() {
  // ---- Streamable HTTP ----
  const httpClient = new Client({ name: "search-hub-verify-http", version: "0.1.1" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${url.replace(/\/+$/, "")}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  let httpPayload;
  try {
    await httpClient.connect(httpTransport);
    httpPayload = await exercise(httpClient, "http");
  } catch (error) {
    check("http: connection and tool calls", false, error.message);
  } finally {
    await httpClient.close().catch(() => undefined);
  }

  // ---- stdio ----
  const stdioClient = new Client({ name: "search-hub-verify-stdio", version: "0.1.1" });
  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(stdioPath)],
    env: { SEARCH_HUB_URL: url, SEARCH_HUB_TOKEN: token, PATH: process.env["PATH"] ?? "" },
    stderr: "pipe",
  });
  let stdioPayload;
  try {
    await stdioClient.connect(stdioTransport);
    stdioPayload = await exercise(stdioClient, "stdio");
  } catch (error) {
    check("stdio: connection and tool calls", false, error.message);
  } finally {
    await stdioClient.close().catch(() => undefined);
  }

  // ---- parity: both transports must be the same search core ----
  if (httpPayload && stdioPayload) {
    const httpIds = new Set(httpPayload.results.map((item) => item.url));
    const stdioIds = new Set(stdioPayload.results.map((item) => item.url));
    const shared = [...httpIds].filter((id) => stdioIds.has(id));
    check(
      "parity: HTTP and stdio return the same search core output",
      httpPayload.taskId !== undefined && stdioPayload.taskId !== undefined && shared.length > 0,
      `${shared.length}/${httpIds.size} overlapping URLs`,
    );
    check(
      "parity: provider attribution matches across transports",
      httpPayload.results[0]?.provider === stdioPayload.results[0]?.provider,
      `${httpPayload.results[0]?.provider} vs ${stdioPayload.results[0]?.provider}`,
    );
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((item) => item.name).join("; ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`FAIL: unhandled ${error.stack ?? error.message}`);
  process.exit(1);
});
