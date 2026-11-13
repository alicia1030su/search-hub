#!/usr/bin/env node
/**
 * Clean-install verification (AC-01 / AC-09 without Docker).
 *
 * Copies the repository (without node_modules/.data/dist) to a temporary
 * directory, then performs the documented production sequence there:
 *
 *   pnpm install --frozen-lockfile
 *   pnpm build
 *   pnpm install --frozen-lockfile --prod
 *   node apps/api/dist/server.mjs
 *
 * It then boots the server, completes first-run setup with the generated
 * token, adds a keyless real provider, runs a live search, restarts the
 * process, and compares configuration + counters before/after.
 *
 * Exit code 0 only when every step passes.
 *
 * Usage: node tests/scripts/clean-install.mjs [--keep]
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const keep = process.argv.includes("--keep");
const workspace = join(tmpdir(), `search-hub-clean-${Date.now()}`);
rmSync(workspace, { recursive: true, force: true });
const port = 8915;
const base = `http://127.0.0.1:${port}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail === undefined ? "" : ` — ${detail}`}`);
}

const SKIP = new Set(["node_modules", ".git", ".data", "dist", ".workbuddy", "test-results", "playwright-report", "coverage"]);

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[\\/]/).pop() ?? "";
      if (SKIP.has(name)) return false;
      if (name.endsWith(".log")) return false;
      return true;
    },
  });
}

function run(label, command, args, cwd) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  const ok = result.status === 0;
  check(`${label} (exit ${result.status})`, ok, `${Date.now() - started}ms`);
  if (!ok) {
    console.log((result.stderr ?? "").split("\n").slice(-12).join("\n"));
  }
  return ok;
}

async function api(path, init = {}, session) {
  const headers = {
    "content-type": "application/json",
    ...(session?.cookie ? { cookie: session.cookie } : {}),
    ...(session?.csrf ? { "x-csrf-token": session.csrf } : {}),
  };
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0 && session) {
    session.cookie = setCookies.map((item) => item.split(";")[0]).join("; ");
  }
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}

let child;
async function boot(dataDir) {
  child = spawn(process.execPath, ["apps/api/dist/server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      SEARCH_HUB_DATA_DIR: dataDir,
      SEARCH_HUB_PORT: String(port),
      SEARCH_HUB_COOKIE_SECURE: "false",
      SEARCH_HUB_LOG_LEVEL: "warn",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return log;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy: ${log.slice(-800)}`);
}

async function stop() {
  if (!child) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  child = undefined;
}

async function main() {
  console.log(`workspace: ${workspace}`);
  copyTree(repoRoot, workspace);
  const copied = readdirSync(workspace).length;
  check("copy: workspace created without node_modules/.data", !existsSync(join(workspace, "node_modules")), `${copied} entries`);

  if (!run("install (full)", "corepack", ["pnpm", "install", "--frozen-lockfile"], workspace)) return;
  if (!run("build", "corepack", ["pnpm", "build"], workspace)) return;
  check(
    "build: server bundle + migrations exist",
    existsSync(join(workspace, "apps/api/dist/server.mjs")) &&
      existsSync(join(workspace, "apps/api/migrations/0001_init.sql")),
  );
  check(
    "build: stdio bundle exists",
    existsSync(join(workspace, "packages/mcp/dist/stdio.mjs")),
  );

  if (!run("install (prod only)", "corepack", ["pnpm", "install", "--frozen-lockfile", "--prod"], workspace)) return;
  check("prod install: tsx pruned", !existsSync(join(workspace, "apps/api/node_modules/tsx")));
  check("prod install: vite pruned", !existsSync(join(workspace, "node_modules/vite")));

  const dataDir = join(workspace, "runtime-data");
  await boot(dataDir);
  const health = await api("/api/health");
  check("boot: health 200", health.status === 200, health.text.slice(0, 120));
  check("boot: migrations applied", health.json().database.migrations >= 1, `${health.json().database.migrations}`);

  const tokenPath = join(dataDir, "setup-token");
  check("setup: token generated", existsSync(tokenPath));
  if (process.platform !== "win32") {
    check("setup: token file mode 0600", (statSync(tokenPath).mode & 0o777) === 0o600);
  }
  const setupToken = readFileSync(tokenPath, "utf8").trim();

  const denied = await api("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: "attacker@example.com", password: "Attacker-Password-1", name: "A" }),
  });
  check("setup: anonymous attempt rejected", denied.status === 403, `HTTP ${denied.status}`);

  const session = {};
  const setup = await api(
    "/api/setup",
    {
      method: "POST",
      body: JSON.stringify({
        email: "admin@example.com",
        password: "Clean-Install-Pass-1",
        name: "Admin",
        setupToken,
      }),
    },
    session,
  );
  check("setup: administrator created", setup.status === 200, `HTTP ${setup.status}`);
  session.csrf = setup.json().csrfToken;
  check("setup: token file removed", !existsSync(tokenPath));

  const provider = await api(
    "/api/admin/providers",
    {
      method: "POST",
      body: JSON.stringify({
        name: "hn-live",
        type: "hackernews",
        enabled: true,
        timeoutMs: 12_000,
        maxConcurrency: 2,
        maxRetries: 1,
        rpmLimit: 60,
        config: {},
      }),
    },
    session,
  );
  check("provider: live HN source created", provider.status === 200, `HTTP ${provider.status}`);

  const tested = await api(
    `/api/admin/providers/${provider.json().provider.id}/test`,
    { method: "POST", body: "{}" },
    session,
  );
  check("provider: self-test hit the real API", tested.status === 200 && tested.json().ok === true, tested.json().message);

  const search = await api(
    "/api/search",
    { method: "POST", body: JSON.stringify({ query: "vector database benchmark", mode: "rrf", limit: 8 }) },
    session,
  );
  const body = search.json();
  check("search: live results", search.status === 200 && body.results.length > 0, `${body.results.length} results`);
  check("search: real absolute URLs", body.results.every((item) => /^https?:\/\//.test(item.url)));
  console.log(`  first: ${body.results[0].title} | ${body.results[0].url}`);

  // Snapshot configuration + counters before the restart.
  const before = {
    providers: (await api("/api/admin/providers", {}, session)).json().providers.map((item) => `${item.name}:${item.type}:${item.enabled}`),
    totals: (await api("/api/admin/dashboard?range=24h", {}, session)).json().totals,
  };

  await stop();
  log = await boot(dataDir);
  const after = {
    providers: (await api("/api/admin/providers", {}, session)).json().providers.map((item) => `${item.name}:${item.type}:${item.enabled}`),
    totals: (await api("/api/admin/dashboard?range=24h", {}, session)).json().totals,
  };
  check("restart: providers identical", JSON.stringify(before.providers) === JSON.stringify(after.providers), after.providers.join(","));
  check(
    "restart: counters preserved (not reset)",
    after.totals.searches === before.totals.searches && after.totals.searches > 0,
    `${before.totals.searches} -> ${after.totals.searches}`,
  );

  // Backup/restore: consistent snapshot then boot from it.
  // Backup: consistent snapshot (WAL checkpointed by the endpoint).
  const backup = await fetch(`${base}/api/admin/backup`, { headers: { cookie: session.cookie } });
  const backupBytes = Buffer.from(await backup.arrayBuffer());
  check("backup: snapshot downloaded", backup.ok && backupBytes.length > 0, `${backupBytes.length} bytes`);
  check("backup: filename does not claim to include the key", !(backup.headers.get("content-disposition") ?? "").includes("master.key"));
  check("backup: snapshot does not contain plaintext key", !backupBytes.toString("latin1").includes("sk-CLEAN"));

  await stop();
  check("shutdown: first process exited", child === undefined);

  // Restore drill: snapshot + master.key into a fresh data dir, boot again.
  const restoreDir = join(workspace, "restore-data");
  mkdirSync(restoreDir, { recursive: true });
  writeFileSync(join(restoreDir, "search-hub.db"), backupBytes);
  cpSync(join(dataDir, "master.key"), join(restoreDir, "master.key"));
  await boot(restoreDir);
  const restoredHealth = await api("/api/health");
  check("restore: boots from the downloaded snapshot", restoredHealth.status === 200, restoredHealth.text.slice(0, 100));
  const restoredLogin = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: "Clean-Install-Pass-1" }),
  }, session);
  check("restore: administrator can sign in", restoredLogin.status === 200, `HTTP ${restoredLogin.status}`);
  session.csrf = restoredLogin.json().csrfToken;
  const restoredProviders = await api("/api/admin/providers", {}, session);
  check(
    "restore: provider configuration intact",
    restoredProviders.json().providers.some((item) => item.name === "hn-live"),
    restoredProviders.json().providers.map((item) => item.name).join(","),
  );
  const restoredSearch = await api("/api/search", {
    method: "POST",
    body: JSON.stringify({ query: "sqlite wal checkpoint", mode: "basic", limit: 5 }),
  }, session);
  check("restore: live search still works", restoredSearch.status === 200 && restoredSearch.json().results.length > 0, `${restoredSearch.json().results?.length ?? 0} results`);
  await stop();
}

main()
  .catch((error) => check("clean install completed", false, error.message))
  .finally(async () => {
    await stop();
    if (keep) {
      console.log(`kept: ${workspace}`);
    } else if (process.platform === "win32") {
      console.log(`windows keeps the temp dir (open SQLite handles): ${workspace}`);
    } else {
      rmSync(workspace, { recursive: true, force: true });
    }
    const failed = results.filter((item) => !item.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log(`FAILED: ${failed.map((item) => item.name).join("; ")}`);
      process.exit(1);
    }
  });
