#!/usr/bin/env node
/** Synthetic API fixture for isolated platform disaster-recovery drills. */
import { readFileSync, writeFileSync } from "node:fs";

const [mode, baseUrl, dataDir, fixturePath] = process.argv.slice(2);
if (!["seed", "verify"].includes(mode) || !baseUrl || !dataDir || !fixturePath) {
  process.stderr.write("usage: node api-fixture.mjs seed|verify <base-url> <data-dir> <fixture-json>\n");
  process.exit(2);
}
const email = "dr-platform@example.invalid";
const password = "Synthetic-DR-Password-1";
const providerName = "dr-platform-mock";
const keySecret = "sk-synthetic-dr-platform-only";

function cookieFrom(response) {
  if (typeof response.headers.getSetCookie === "function") {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      if (pair?.startsWith("sh_session=")) return pair;
    }
  }
  return null;
}

async function request(path, { method = "GET", cookie, csrf, json, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (csrf) requestHeaders["x-csrf-token"] = csrf;
  let payload = body;
  if (json !== undefined) {
    requestHeaders["content-type"] = "application/json";
    payload = JSON.stringify(json);
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* SSE/binary response. */ }
  return { status: response.status, headers: response.headers, text, json: parsed, cookie: cookieFrom(response) };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function login() {
  const response = await request("/api/auth/login", { method: "POST", json: { email, password } });
  assert(response.status === 200 && response.cookie && response.json?.csrfToken, `login failed: ${response.status}`);
  return { cookie: response.cookie, csrf: response.json.csrfToken };
}

async function seed() {
  const setupToken = readFileSync(`${dataDir}/setup-token`, "utf8").trim();
  const setup = await request("/api/setup", { method: "POST", json: { email, password, name: "DR Platform", setupToken } });
  assert(setup.status === 200 && setup.cookie && setup.json?.csrfToken, `setup failed: ${setup.status}`);
  const auth = { cookie: setup.cookie, csrf: setup.json.csrfToken };
  const provider = await request("/api/admin/providers", {
    ...auth,
    method: "POST",
    json: { name: providerName, type: "mock", enabled: true, resultsPerPage: 5, config: { resultCount: 3, latencyMs: 1, namespace: "dr-platform" } },
  });
  assert(provider.status === 200 && provider.json?.provider?.id, `provider create failed: ${provider.status}`);
  const providerId = provider.json.provider.id;
  const key = await request(`/api/admin/providers/${providerId}/keys`, { ...auth, method: "POST", json: { label: "dr-platform", key: keySecret } });
  assert(key.status === 200 && key.json?.id, `key create failed: ${key.status}`);
  const search = await request("/api/search", { ...auth, method: "POST", json: { query: "dr platform seed", mode: "basic", limit: 3, skipCache: true } });
  assert(search.status === 200 && Array.isArray(search.json?.results) && search.json.results.length > 0, `seed search failed: ${search.status}`);
  writeFileSync(fixturePath, `${JSON.stringify({ providerId, keyId: key.json.id, providerName }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, providerId, keyId: key.json.id })}\n`);
}

function parseMcp(text) {
  try { return JSON.parse(text); } catch { /* SSE below. */ }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data: ")) {
      try { return JSON.parse(line.slice(6)); } catch { /* Try next line. */ }
    }
  }
  throw new Error("MCP response was not JSON or SSE JSON");
}

async function verify() {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const auth = await login();
  const providers = await request("/api/admin/providers", { cookie: auth.cookie });
  assert(providers.status === 200 && providers.json?.providers?.some((provider) => provider.id === fixture.providerId && provider.name === fixture.providerName), "restored provider missing");
  const dashboard = await request("/api/admin/dashboard?range=24h", { cookie: auth.cookie });
  assert(dashboard.status === 200 && Number(dashboard.json?.keys?.total ?? 0) >= 1, "restored key count missing");
  const keyTest = await request(`/api/admin/keys/${fixture.keyId}/test`, { ...auth, method: "POST" });
  assert(keyTest.status === 200 && keyTest.json?.ok === true, `restored key decrypt/test failed: ${keyTest.status}`);
  const search = await request("/api/search", { ...auth, method: "POST", json: { query: "dr platform restored", mode: "basic", limit: 3, skipCache: true } });
  assert(search.status === 200 && Array.isArray(search.json?.results) && search.json.results.length > 0, `restored search failed: ${search.status}`);
  const token = await request("/api/admin/tokens", { ...auth, method: "POST", json: { name: "dr-platform-mcp", scopes: ["search", "mcp:use", "sources:read"], rateLimitPerMin: 120 } });
  assert(token.status === 200 && token.json?.token, `MCP token create failed: ${token.status}`);
  const mcpHeaders = { authorization: `Bearer ${token.json.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await request("/mcp", { method: "POST", headers: mcpHeaders, json: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dr-platform", version: "1" } } } });
  assert(init.status === 200 && parseMcp(init.text)?.result?.serverInfo?.name === "search-hub", `MCP initialize failed: ${init.status}`);
  const tools = await request("/mcp", { method: "POST", headers: mcpHeaders, json: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
  assert(tools.status === 200 && Array.isArray(parseMcp(tools.text)?.result?.tools), `MCP tools/list failed: ${tools.status}`);
  const call = await request("/mcp", { method: "POST", headers: mcpHeaders, json: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_web", arguments: { query: "dr platform mcp", limit: 3 } } } });
  const mcpResult = parseMcp(call.text)?.result;
  const contentText = (mcpResult?.content ?? []).find((entry) => entry.type === "text")?.text ?? "";
  const payload = JSON.parse(contentText);
  assert(call.status === 200 && mcpResult?.isError !== true && Array.isArray(payload.results) && payload.results.length > 0, `MCP search failed: ${call.status}`);
  process.stdout.write(`${JSON.stringify({ ok: true, provider: fixture.providerName, keyDecrypt: true, search: true, mcp: true })}\n`);
}

(mode === "seed" ? seed() : verify()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
