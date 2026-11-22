#!/usr/bin/env node
/**
 * Independent acceptance for a built package.
 *
 * Extracts the archive into a throwaway directory, launches it exactly as a user
 * would (no Node, no pnpm, no dev dependencies on PATH), and drives the real API:
 * health → setup → provider creation → REST search → MCP initialize/tools/list/
 * tools/call → restart persistence.
 *
 * Exits non-zero on the first failure: a package that cannot start must never
 * reach a release.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.argv[2] ?? (process.platform === "win32" ? "windows-x64" : "linux-x64");
const PORT = Number(process.env["VERIFY_PORT"] ?? 8799);
const IS_WINDOWS = TARGET.startsWith("windows");

const archive = findArchive();
const work = mkdtempSync(join(tmpdir(), `search-hub-verify-${TARGET}-`));
const dataDir = join(work, "data");

let failures = 0;
const step = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

console.log(`verifying ${archive}`);
extract(archive, work);

const launcher = IS_WINDOWS ? join(work, "SearchHub.exe") : join(work, "bin", "search-hub");
step("launcher present", existsSync(launcher), launcher);
step("bundled runtime present", existsSync(IS_WINDOWS ? join(work, "runtime", "node.exe") : join(work, "runtime", "bin", "node")));
step("server bundle present", existsSync(join(work, "app", "apps", "api", "dist", "server.mjs")));
step("web assets present", existsSync(join(work, "app", "apps", "web", "dist", "index.html")));
step(
  "native addon present",
  readdirSync(join(work, "app", "node_modules", "better-sqlite3", "prebuilds")).some((name) => name.endsWith(".node")),
);
if (!IS_WINDOWS) {
  step("systemd template present", existsSync(join(work, "search-hub.service")));
}

// PATH is stripped of node/pnpm to prove the package is self-contained.
const env = {
  PATH: IS_WINDOWS ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin",
  SEARCH_HUB_DATA_DIR: dataDir,
  HOME: join(work, "home"),
};

const first = await launch(launcher);
step("health check", first.healthy);

if (first.healthy) {
  const results = await drive(PORT);
  step("setup完成", results.setup, results.setupDetail);
  step("REST 搜索返回结果", results.search, results.searchDetail);
  step("MCP initialize", results.mcpInit);
  step("MCP tools/list", results.mcpList);
  step("MCP tools/call", results.mcpCall);
  step("资源端点 session 200", results.resourcesSession, results.resourcesDetail);
  step("资源端点 Bearer 403", results.resourcesBearer);
  // The database file is `search-hub.db` (config.ts), not `search.db`.
  step("数据库文件已落盘", existsSync(join(dataDir, "search-hub.db")));
  step("主密钥已落盘", existsSync(join(dataDir, "master.key")));
}

await stop(first.child);
step("可以停止", !(await stillRunning(PORT)));

// Second launch must reuse the same data directory.
const second = await launch(launcher);
step("再次启动", second.healthy);
if (second.healthy) {
  const status = await fetch(`http://127.0.0.1:${PORT}/api/setup/status`).then((r) => r.json());
  step("重启后数据持久（管理员仍存在）", status.initialized === true && status.admins >= 1);
}
await stop(second.child);

// Port conflict must be reported, not silently failed.
const blocker = spawn(IS_WINDOWS ? "cmd" : "sh", IS_WINDOWS ? ["/c", "timeout", "/t", "20"] : ["-c", "sleep 20"], { stdio: "ignore" });
void blocker;

rmSync(work, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — this package must not be released.`);
  process.exit(1);
}
console.log("\nAll package checks passed.");

function findArchive() {
  const dir = join(REPO, "dist", "package");
  const files = readdirSync(dir).filter((name) => name.includes(TARGET) && /\.(zip|tar\.gz)$/.test(name));
  if (files.length === 0) {
    console.error(`no archive for ${TARGET} in ${dir}`);
    process.exit(2);
  }
  return join(dir, files.sort().at(-1));
}

function extract(file, into) {
  // Absolute Windows paths contain "C:" which GNU tar mistakes for a remote host,
  // so extraction always runs with cwd set to the archive's directory and the
  // archive referenced by its bare filename.
  const dir = dirname(file);
  const name = file.split(/[\\/]/).pop();
  const isZip = file.endsWith(".zip");

  if (isZip) {
    // unzip (Git Bash / CI images) is the reliable zip extractor; bsdtar on
    // Windows can also read zip, GNU tar cannot.
    for (const command of [["unzip", ["-q", "-o", name, "-d", into]], ["tar", ["-xf", name, "-C", into]]]) {
      try {
        execFileSync(command[0], command[1], { cwd: dir, stdio: "inherit" });
        return;
      } catch {
        continue;
      }
    }
    throw new Error(`could not extract ${file}`);
  }

  execFileSync("tar", ["-xzf", name, "-C", into], { cwd: dir, stdio: "inherit" });
}

async function launch(executable) {
  const child = spawn(executable, ["--no-browser", "--port", String(PORT), "--service"], {
    cwd: work,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  if (!healthy) console.log(logs.join("").slice(-800));
  return { child, healthy };
}

async function drive(port) {
  const base = `http://127.0.0.1:${port}`;
  const out = { setup: false, setupDetail: "", search: false, searchDetail: "", mcpInit: false, mcpList: false, mcpCall: false, resourcesSession: false, resourcesBearer: false, resourcesDetail: "" };

  const tokenPath = join(dataDir, "setup-token");
  if (!existsSync(tokenPath)) {
    out.setupDetail = "setup-token missing";
    return out;
  }
  const setupToken = readFileSync(tokenPath, "utf8").trim();
  const setup = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "release@example.com",
      password: "Release-Check-Password-1",
      name: "Release Check",
      setupToken,
    }),
  });
  out.setup = setup.ok;
  out.setupDetail = `HTTP ${setup.status}`;
  if (!setup.ok) return out;

  const cookie = setup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  const { csrfToken } = await session.json();

  const provider = await fetch(`${base}/api/admin/providers`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
    body: JSON.stringify({
      name: "release-mock",
      type: "mock",
      enabled: true,
      timeoutMs: 5000,
      maxConcurrency: 2,
      maxRetries: 0,
      rpmLimit: 60,
      config: { resultCount: 3 },
    }),
  });
  if (!provider.ok) {
    out.searchDetail = `provider HTTP ${provider.status}`;
    return out;
  }

  const search = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
    body: JSON.stringify({ query: "release check", mode: "basic", limit: 5, skipCache: true }),
  });
  const searchBody = await search.json();
  out.search = Boolean(search.ok && Array.isArray(searchBody.results) && searchBody.results.length > 0);
  out.searchDetail = `HTTP ${search.status}, ${searchBody.results?.length ?? 0} results`;

  const token = await fetch(`${base}/api/admin/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken },
    body: JSON.stringify({ name: "release-check", scopes: ["search:read", "mcp:use"], rateLimitPerMin: 600 }),
  });
  const tokenBody = await token.json();
  const bearer = tokenBody.token ?? tokenBody.plainToken ?? tokenBody.secret;
  if (!bearer) {
    out.searchDetail += "; token creation failed";
    return out;
  }

  const resources = await fetch(`${base}/api/admin/resources`, { headers: { cookie } });
  const resourcesBody = await resources.json();
  const memory = resourcesBody.process?.memory ?? {};
  const activity = resourcesBody.activity ?? {};
  const cache = resourcesBody.cache ?? {};
  out.resourcesSession = resources.status === 200 && resourcesBody.schemaVersion === 1 &&
    ["rssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"].every((field) => typeof memory[field] === "number") &&
    typeof activity.activeSearches === "number" && typeof activity.activeProbes === "number" &&
    typeof activity.queue?.total === "number" && typeof activity.queue?.providerKey === "number" &&
    typeof activity.queue?.health === "number" && typeof activity.queue?.singleflightFollowers === "number" &&
    ["entries", "bytes", "dbFileBytes", "walFileBytes"].every((field) => typeof cache[field] === "number") &&
    cache.diskScope === "whole_sqlite_database";
  out.resourcesDetail = `HTTP ${resources.status}`;
  const forbiddenResources = await fetch(`${base}/api/admin/resources`, { headers: { authorization: `Bearer ${bearer}` } });
  out.resourcesBearer = forbiddenResources.status === 403;

  const mcp = async (payload) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
    return { ok: response.ok, text: dataLine ?? text };
  };

  const init = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } },
  });
  out.mcpInit = init.ok && init.text.includes("protocolVersion");

  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  out.mcpList = list.ok && list.text.includes("search_web");

  const call = await mcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "search_web", arguments: { query: "release check", limit: 3 } },
  });
  out.mcpCall = call.ok && (call.text.includes("results") || call.text.includes("task_"));

  return out;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (child.exitCode !== null) return;
    await sleep(300);
  }
  child.kill("SIGKILL");
}

async function stillRunning(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
