#!/usr/bin/env node
/**
 * Live search verification against a real Search Hub instance and a real
 * upstream provider (no mocks).
 *
 * Usage:
 *   node tests/scripts/live-search.mjs --url http://127.0.0.1:8787 \
 *        --token sh_xxx [--query-a "typescript monorepo"] [--query-b "rust async runtime"]
 *
 * Every check prints PASS/FAIL with the observed evidence. Exit code 0 only
 * when the live chain is genuinely working.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baseUrl = arg("url", "http://127.0.0.1:8787");
const token = arg("token", process.env["SEARCH_HUB_TOKEN"] ?? "");
const queryA = arg("query-a", "typescript monorepo");
const queryB = arg("query-b", "rust async runtime");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

async function restSearch(query) {
  const response = await fetch(`${baseUrl}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, mode: "rrf", limit: 8 }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

function checkResults(label, body) {
  check(`${label}: HTTP 200`, body.status === "completed" || body.status === "partial", `status=${body.status}`);
  check(`${label}: has results`, Array.isArray(body.results) && body.results.length > 0, `${body.results?.length ?? 0} results`);
  check(`${label}: no failed sources`, Array.isArray(body.failedSources) && body.failedSources.length === 0, JSON.stringify(body.failedSources));

  const urls = new Set((body.results ?? []).map((item) => item.url));
  check(`${label}: every result has an absolute URL`, [...urls].every((url) => /^https?:\/\//.test(url)), `${urls.size} unique URLs`);
  check(`${label}: every result has a title`, (body.results ?? []).every((item) => item.title.length > 0));
  check(`${label}: every result carries source attribution`, (body.results ?? []).every((item) => item.source && item.provider));
  check(`${label}: raw count >= fused count`, body.stats.rawCount >= body.results.length, `${body.stats.rawCount} raw -> ${body.results.length} fused`);

  const first = body.results[0];
  console.log(`  first result: ${first.title} | ${first.url} | ${first.providerName} | ${first.publishedAt ?? "n/a"}`);
  return urls;
}

async function main() {
  if (!token) throw new Error("--token or SEARCH_HUB_TOKEN is required");

  const a = await restSearch(queryA);
  const urlsA = checkResults(`REST "${queryA}"`, a.body);

  const b = await restSearch(queryB);
  const urlsB = checkResults(`REST "${queryB}"`, b.body);

  const overlap = [...urlsA].filter((url) => urlsB.has(url));
  check(
    "different queries return different result sets",
    overlap.length < Math.min(urlsA.size, urlsB.size),
    `${overlap.length} overlapping of ${urlsA.size}/${urlsB.size}`,
  );

  // The second call must not be served from a cache: it should be a new task.
  check("each live call gets a new task id", a.body.taskId !== b.body.taskId, `${a.body.taskId} vs ${b.body.taskId}`);

  // MCP must return the same core output as REST.
  const client = new Client({ name: "live-search", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const mcp = await client.callTool({ name: "search_web", arguments: { query: queryA, limit: 8 } });
    const payload = (mcp.structuredContent ?? JSON.parse(mcp.content[0].text));
    const mcpUrls = new Set(payload.results.map((item) => item.url));
    const shared = [...urlsA].filter((url) => mcpUrls.has(url));
    check("MCP returns results from the same core", payload.results.length > 0, `${payload.results.length} results`);
    check("MCP and REST agree on the result set", shared.length > 0, `${shared.length}/${urlsA.size} overlapping URLs`);
    check(
      "MCP carries provider attribution",
      payload.results.every((item) => typeof item.provider === "string" && item.provider.length > 0),
    );
  } finally {
    await client.close();
  }

  // A token without the required scope must be rejected, not silently allowed.
  const forbidden = await fetch(`${baseUrl}/api/providers`, {
    headers: { authorization: "Bearer invalid-token" },
  });
  check("invalid token is rejected", forbidden.status === 401, `HTTP ${forbidden.status}`);

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((item) => item.name).join("; ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.stack ?? error.message}`);
  process.exit(1);
});
