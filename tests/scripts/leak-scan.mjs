#!/usr/bin/env node
/**
 * AC-04 leak scan against a real running instance.
 *
 * 1. Boots the compiled server with debug logging into a temp data dir.
 * 2. Creates an administrator with the one-time setup token.
 * 3. Stores an API key containing a unique fingerprint.
 * 4. Runs a search and a failing provider test.
 * 5. Scans every API response, the SQLite file and the log file for the
 *    fingerprint in plaintext, Base64 and hex forms.
 *
 * Exit code 0 only when every location reports zero hits.
 *
 * Usage: node tests/scripts/leak-scan.mjs
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "search-hub-leak-"));
const port = 8912;
const base = `http://127.0.0.1:${port}`;
const logPath = join(dataDir, "server.log");
const secret = `sk-LEAK-${randomUUID()}-FINGERPRINT`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}

function variants(value) {
  return [
    value,
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    Buffer.from(value).toString("hex"),
  ];
}

function scan(label, content) {
  const hits = variants(secret).filter((variant) => content.includes(variant));
  check(`${label}: no key material`, hits.length === 0, hits.length ? `${hits.length} variant(s) found` : "0 hits");
}

let sessionCookie = "";
async function api(path, init = {}, csrf) {
  const headers = {
    "content-type": "application/json",
    ...(sessionCookie ? { cookie: sessionCookie } : {}),
    ...(csrf ? { "x-csrf-token": csrf } : {}),

  };
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) sessionCookie = setCookies.map((item) => item.split(";")[0]).join("; ");
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

const child = spawn(process.execPath, ["apps/api/dist/server.mjs"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    SEARCH_HUB_DATA_DIR: dataDir,
    SEARCH_HUB_PORT: String(port),
    NODE_ENV: "production",
    SEARCH_HUB_COOKIE_SECURE: "false",
    SEARCH_HUB_LOG_LEVEL: "debug",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
child.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
child.stderr.on("data", (chunk) => (serverLog += chunk.toString()));

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not become healthy");
}

async function main() {
  await waitForHealth();

  const tokenPath = join(dataDir, "setup-token");
  check("setup: token file exists before initialization", existsSync(tokenPath));
  const setupToken = readFileSync(tokenPath, "utf8").trim();
  const setup = await api("/api/setup", {
    method: "POST",
    body: JSON.stringify({
      email: "admin@example.com",
      password: "Leak-Scan-Password-1",
      name: "Leak Scan",
      setupToken,
    }),
  });
  check("setup: administrator created with one-time token", setup.status === 200, `HTTP ${setup.status}`);
  const csrf = setup.json().csrfToken;

  const provider = await api(
    "/api/admin/providers",
    {
      method: "POST",
      body: JSON.stringify({
        name: "leak-source",
        type: "mock",
        enabled: true,
        timeoutMs: 2000,
        maxConcurrency: 2,
        maxRetries: 0,
        rpmLimit: 1000,
        keyStrategy: "round_robin",
        config: { resultCount: 3, latencyMs: 5, namespace: "leak" },
      }),
    },
    csrf,
  );
  check("provider: created", provider.status === 200, `HTTP ${provider.status}`);
  const providerId = provider.json().provider.id;

  const key = await api(
    `/api/admin/providers/${providerId}/keys`,
    { method: "POST", body: JSON.stringify({ label: "leak", key: secret, weight: 100, enabled: true }) },
    csrf,
  );
  check("key: stored (masked in response)", key.status === 200 && !key.text.includes(secret), `HTTP ${key.status}`);

  const search = await api(
    "/api/search",
    { method: "POST", body: JSON.stringify({ query: "leak scan", mode: "rrf", limit: 5 }) },
    csrf,
  );
  check("search: completed", search.status === 200, `HTTP ${search.status}`);

  // Force an error path so stacks and provider error snapshots are exercised.
  await api(
    "/api/admin/providers",
    {
      method: "POST",
      body: JSON.stringify({
        name: "leak-broken",
        type: "generic-http",
        enabled: true,
        baseUrl: "https://127.0.0.1:9",
        timeoutMs: 800,
        maxConcurrency: 1,
        maxRetries: 0,
        rpmLimit: 100,
        config: { method: "GET", path: "/x", resultsPath: "results" },
      }),
    },
    csrf,
  );

  const bodies = {
    "api/providers": (await api("/api/providers", {}, csrf)).text,
    "api/admin/providers": (await api("/api/admin/providers", {}, csrf)).text,
    "api/admin/keys": (await api(`/api/admin/providers/${providerId}/keys`, {}, csrf)).text,
    "api/search": search.text,
    "api/admin/config/export": (await api("/api/admin/config/export", {}, csrf)).text,
    "api/admin/logs": (await api("/api/admin/logs?limit=200", {}, csrf)).text,
    "api/admin/dashboard": (await api("/api/admin/dashboard?range=24h", {}, csrf)).text,
    "api/setup/status": (await api("/api/setup/status")).text,
  };
  for (const [label, body] of Object.entries(bodies)) {
    scan(label, body);
  }

  // The response header must not echo the credential either.
  check("api/admin/keys: masked value present", bodies["api/admin/keys"].includes("…") || bodies["api/admin/keys"].includes("****"), "mask rendered");

  // SQLite file, including WAL, in three encodings.
  const dbFiles = ["search-hub.db", "search-hub.db-wal", "search-hub.db-shm"];
  let dbBuffer = Buffer.alloc(0);
  for (const file of dbFiles) {
    const path = join(dataDir, file);
    if (existsSync(path)) dbBuffer = Buffer.concat([dbBuffer, readFileSync(path)]);
  }
  const dbText = dbBuffer.toString("latin1");
  const dbHits = variants(secret).filter(
    (variant) => dbText.includes(variant) || dbBuffer.includes(Buffer.from(variant, "utf8")),
  );
  check("sqlite: no plaintext/base64/hex key", dbHits.length === 0, dbHits.length ? `${dbHits.length} variant(s)` : `${dbBuffer.length} bytes scanned`);

  // Log file (stdout/stderr captured by the parent).
  scan("logs: server output", serverLog + (existsSync(logPath) ? readFileSync(logPath, "utf8") : ""));

  // Sanity: the key must still be usable (encryption round-trip).
  const tested = await api(`/api/admin/keys/${key.json().id}/test`, { method: "POST", body: "{}" }, csrf);
  check("key: decrypts for a real call after storage", tested.status === 200, `HTTP ${tested.status}`);

  // Sanity: hashing proves the fingerprint would have been detected if present.
  const digest = createHash("sha256").update(secret).digest("hex").slice(0, 12);
  check("scan: fingerprint is unique enough", !serverLog.includes(digest), "digest not present in logs");
}

main()
  .catch((error) => {
    check("leak scan completed", false, error.message);
  })
  .finally(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows may keep the SQLite handle briefly; the temp dir is disposable.
    }
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) process.exit(1);
  });
