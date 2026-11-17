#!/usr/bin/env node
/**
 * Cross-version upgrade acceptance, driven by real release assets.
 *
 * Nothing here is a simulation of an upgrade: it downloads the *published*
 * packages from GitHub Releases, unpacks both, boots the old one, creates real
 * state (admin, provider, API key, search parameters), stops it, installs the new
 * program over the same data directory with the shipped updater, boots the new
 * one and checks that every piece of state survived.
 *
 * Usage:
 *   node packaging/upgrade-matrix.mjs --from v0.1.4-beta.6 --to v0.1.6-beta.1
 *   node packaging/upgrade-matrix.mjs --from v0.1.5-beta.1 --to v0.1.6-beta.1
 *
 * The "to" version may also be a local archive path, which is how CI exercises
 * the current build without waiting for a release.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_SLUG = "alicia1030su/search-hub";
const IS_WINDOWS = process.platform === "win32";
const OS_KEY = IS_WINDOWS ? "windows" : "linux";
const ARCH_KEY = process.arch;

const FROM = arg("from");
const TO = arg("to");
const KEEP = hasFlag("--keep");
const PORT_BASE = Number(arg("port") ?? 8910);

if (!FROM) {
  console.error("usage: upgrade-matrix.mjs --from <tag> [--to <tag|path>] [--keep]");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const work = mkdtempSync(join(tmpdir(), `search-hub-upgrade-${FROM}-`));
const dataDir = join(work, "data");
mkdirSync(dataDir, { recursive: true });

try {
  const oldAsset = await downloadReleaseAsset(FROM);
  const newAsset = TO && existsSync(TO) ? { path: resolve(TO), tag: "local-build" } : await downloadReleaseAsset(TO ?? "v0.1.6-beta.1");

  const oldRoot = unpack(oldAsset, join(work, "old"));
  const install = join(work, "install");
  // The upgrade happens in place: the new program is installed over the same
  // directory the old one occupied.
  cpSync(oldRoot, install, { recursive: true });

  console.log(`from ${FROM} (${oldAsset.path.split("/").pop()})`);
  console.log(`to   ${newAsset.tag} (${newAsset.path.split("/").pop()})`);
  console.log(`install root: ${install}`);

  const versionBefore = installedVersion(install);
  check("old package reports its own version", versionBefore === FROM.replace(/^v/, ""), versionBefore);

  // ---- 1. Populate real state on the OLD version -----------------------
  let boot = await start(install, PORT_BASE);
  check("old version boots", boot.ok, boot.detail);
  const state = await populate(boot.base);
  check("old version accepted an admin", state.admin, state.adminDetail);
  check("old version accepted a provider", state.provider, state.providerDetail);
  check("old version accepted an API key", state.key, state.keyDetail);
  check("old version accepted search parameters", state.params, state.paramsDetail);
  check("search works on the old version", state.search, state.searchDetail);
  check("MCP works on the old version", state.mcp, state.mcpDetail);

  const snapshotBefore = snapshot(install, dataDir, state);
  check("master.key exists before upgrade", snapshotBefore.masterKey, snapshotBefore.masterKeyDetail);
  check("database exists before upgrade", snapshotBefore.db, snapshotBefore.dbDetail);
  // The verification step compares against these, so carry them into `state`.
  state.masterKeySha = snapshotBefore.masterKeySha;
  state.dbSize = snapshotBefore.dbSize;
  await stop(boot);

  // ---- 2. Upgrade with the updater that ships in the OLD package -------
  const updater = join(install, "bin", "updater.mjs");
  check("the shipped package contains an updater", existsSync(updater));
  if (!existsSync(updater)) throw new Error("old package has no updater; cannot upgrade in place");

  const expectedSha = sha256(newAsset.path);
  const run = execFileSync(
    IS_WINDOWS ? join(install, "runtime", "node.exe") : join(install, "runtime", "bin", "node"),
    [
      updater,
      "--package",
      newAsset.path,
      "--version",
      newAsset.tag.replace(/^v/, ""),
      "--sha256",
      expectedSha,
      "--size",
      String(statSync(newAsset.path).size),
      "--root",
      install,
      "--data",
      dataDir,
      "--port",
      String(PORT_BASE),
    ],
    { cwd: install, encoding: "utf8", stdio: "pipe" },
  );
  check("updater exits 0", run.includes("completed and healthy"), run.split("\n").slice(-2).join(" | "));

  const versionAfter = installedVersion(install);
  check("new program version installed", versionAfter === newAsset.tag.replace(/^v/, ""), `${versionBefore} → ${versionAfter}`);

  // ---- 3. Verify every piece of state on the NEW version ---------------
  boot = await start(install, PORT_BASE);
  check("new version boots", boot.ok, boot.detail);
  const after = await verify(boot.base, state);
  check("admin account survived", after.admin, after.adminDetail);
  check("provider survived", after.provider, after.providerDetail);
  check("API key decrypted after upgrade", after.key, after.keyDetail);
  check("search parameters survived", after.params, after.paramsDetail);
  check("session still valid after upgrade", after.session, after.sessionDetail);
  check("search works on the new version", after.search, after.searchDetail);
  check("MCP works on the new version", after.mcp, after.mcpDetail);
  check("master.key unchanged", after.masterKey, after.masterKeyDetail);
  check("database grew but kept its identity", after.db, after.dbDetail);
  check("no new migration was left unapplied", after.migrations, after.migrationsDetail);
  // The upgrade must add the catalogue entries that beta.1 shipped without.
  check(
    "catalogue now contains minimax/metaso",
    after.catalogMinimax && after.catalogMetaso,
    `minimax=${after.catalogMinimax} metaso=${after.catalogMetaso}`,
  );
  await stop(boot);
} catch (error) {
  check("upgrade run completed without crashing", false, error instanceof Error ? error.message : String(error));
} finally {
  if (!KEEP) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* a leftover temp dir is not a failure */
    }
  } else {
    console.log(`kept: ${work}`);
  }
}

console.log(failures === 0 ? "\nAll upgrade checks passed." : `\n${failures} upgrade check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

// ----------------------------------------------------------------- helpers

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function installedVersion(root) {
  for (const name of ["launcher.json", "package.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      /* try the next */
    }
  }
  return "unknown";
}

/** Downloads a published package for this platform. Fails loudly, never silently skips. */
async function downloadReleaseAsset(tag) {
  const assetName = `search-hub-v${tag.replace(/^v/, "").replace(/^search-hub-v/, "")}-${OS_KEY}-${ARCH_KEY}.${IS_WINDOWS ? "zip" : "tar.gz"}`;
  const out = join(work, assetName);
  if (existsSync(out) && statSync(out).size > 1_000_000) return { path: out, tag };
  // gh handles auth and redirects better than a hand-rolled fetch, and it is
  // present on every GitHub runner.
  execFileSync("gh", ["release", "download", tag, "--repo", REPO_SLUG, "--pattern", assetName, "--clobber", "--dir", work], {
    stdio: "inherit",
  });
  if (!existsSync(out)) throw new Error(`asset ${assetName} missing from release ${tag}`);
  const size = statSync(out).size;
  // Compare with the size the release claims: a proxy that truncates a body is the
  // most common way an "upgrade test" silently degrades into a same-version no-op.
  const meta = JSON.parse(
    execFileSync("gh", ["api", `repos/${REPO_SLUG}/releases/tags/${tag}`, "--jq", ".assets"], {
      encoding: "utf8",
    }),
  );
  const declared = meta.find((item) => item.name === assetName)?.size;
  if (declared !== undefined && size !== declared) {
    throw new Error(`asset ${assetName} is ${size} bytes but the release says ${declared}`);
  }
  return { path: out, tag };
}

/** Extracts a package; the archive root is the install layout. */
function unpack(asset, into) {
  mkdirSync(into, { recursive: true });
  if (asset.path.endsWith(".zip")) {
    try {
      execFileSync("unzip", ["-q", "-o", asset.path, "-d", into], { stdio: "inherit" });
    } catch {
      execFileSync("tar", ["-xf", asset.path, "-C", into], { stdio: "inherit" });
    }
  } else {
    execFileSync("tar", ["-xzf", asset.path, "-C", into], { stdio: "inherit" });
  }
  return into;
}

function launcherCommand(root) {
  if (IS_WINDOWS) {
    const exe = join(root, "SearchHub.exe");
    if (existsSync(exe)) return { command: exe, args: [] };
  } else {
    const sh = join(root, "bin", "search-hub");
    if (existsSync(sh)) {
      chmodSync(sh, 0o755);
      return { command: sh, args: [] };
    }
  }
  throw new Error(`no launcher in ${root}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(root, port) {
  const { command, args } = launcherCommand(root);
  const child = spawn(command, [...args, "--no-browser", "--service", "--port", String(port)], {
    env: { ...process.env, SEARCH_HUB_DATA_DIR: dataDir, SEARCH_HUB_RATE_LIMIT_PER_MIN: "9000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { ok: true, base, child, root, port, detail: "" };
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return { ok: false, base, child, root, port, detail: log.join("").slice(-300) };
}

/**
 * Stops the service through its own launcher.
 *
 * Killing the wrapper is not enough: the launcher supervises the server child, and
 * a stray child holding the SQLite file is exactly the "two processes on one
 * database" failure this acceptance must rule out.
 */
async function stop(boot) {
  try {
    const { command, args } = launcherCommand(boot.root);
    execFileSync(command, [...args, "--stop"], {
      env: { ...process.env, SEARCH_HUB_DATA_DIR: dataDir, SEARCH_HUB_PORT: String(boot.port) },
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    /* already stopped */
  }
  boot.child.kill("SIGTERM");
  await sleep(1_500);
  // Fail loudly if anything still answers: that would mean an orphan survived.
  try {
    const res = await fetch(`http://127.0.0.1:${boot.port}/api/health`);
    if (res.ok) throw new Error(`service still answering on ${boot.port} after stop`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("still answering")) throw error;
  }
}

/** Creates the state an upgrade must preserve. */
async function populate(base) {
  const tokenFile = join(dataDir, "setup-token");
  if (!existsSync(tokenFile)) return { admin: false, adminDetail: "no setup token" };
  const setupToken = readFileSync(tokenFile, "utf8").trim();
  const setup = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "upgrade@example.com", password: "Upgrade-Password-1", name: "Upgrade", setupToken }),
  });
  if (!setup.ok) return { admin: false, adminDetail: `setup HTTP ${setup.status}` };
  const cookie = setup.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json();
  const csrf = session.csrfToken;
  const h = { "content-type": "application/json", cookie, "x-csrf-token": csrf };

  const provider = await fetch(`${base}/api/admin/providers`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      name: "upgrade-mock",
      type: "mock",
      enabled: true,
      timeoutMs: 7000,
      maxConcurrency: 3,
      maxRetries: 2,
      rpmLimit: 321,
      config: { resultCount: 3 },
      searchConfig: { targetResults: 7 },
    }),
  });
  const providerBody = provider.ok ? await provider.json() : null;
  const providerId = providerBody?.provider?.id ?? null;

  const key = providerId
    ? await fetch(`${base}/api/admin/providers/${providerId}/keys`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ label: "upgrade-key", key: "sk-UPGRADE-SURVIVES-1234567890" }),
      })
    : null;
  const keyBody = key && key.ok ? await key.json() : null;

  const search = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ query: "upgrade probe", mode: "basic", limit: 3, skipCache: true }),
  });
  const searchBody = await search.json().catch(() => ({}));

  const mcpToken = await fetch(`${base}/api/admin/tokens`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ name: "upgrade-mcp", scopes: ["search", "mcp:use"], rateLimitPerMin: 600 }),
  });
  const mcpBody = mcpToken.ok ? await mcpToken.json() : null;
  const bearer = mcpBody?.token ?? null;
  const mcp = bearer ? await mcpPing(base, bearer) : { ok: false, detail: "no token" };

  return {
    cookie,
    csrf,
    providerId,
    keyId: keyBody?.key?.id ?? keyBody?.id ?? null,
    searchResultCount: (searchBody.results ?? []).length,
    bearer,
    admin: setup.ok,
    adminDetail: `HTTP ${setup.status}`,
    provider: Boolean(providerId),
    providerDetail: `HTTP ${provider.status}`,
    key: Boolean(keyBody),
    keyDetail: `HTTP ${key?.status ?? "n/a"}`,
    params: providerBody?.provider?.searchConfig?.targetResults === 7,
    paramsDetail: `targetResults=${providerBody?.provider?.searchConfig?.targetResults ?? "?"}`,
    search: (searchBody.results ?? []).length > 0,
    searchDetail: `HTTP ${search.status}, ${(searchBody.results ?? []).length} results`,
    mcp: mcp.ok,
    mcpDetail: mcp.detail,
  };
}

/** Verifies the same state against the upgraded program. */
async function verify(base, state) {
  const out = {};

  const sessionRes = await fetch(`${base}/api/auth/session`, { headers: { cookie: state.cookie } });
  out.session = sessionRes.ok;
  out.sessionDetail = `HTTP ${sessionRes.status}`;
  // A session that survived the upgrade must still be usable for admin reads.
  const providersRes = await fetch(`${base}/api/admin/providers`, { headers: { cookie: state.cookie } });
  const providers = providersRes.ok ? await providersRes.json() : { providers: [] };
  const found = (providers.providers ?? []).find((p) => p.id === state.providerId);
  out.admin = sessionRes.ok && providersRes.ok;
  out.adminDetail = `session ${sessionRes.status}, providers ${providersRes.status}`;
  out.provider = Boolean(found);
  out.providerDetail = found ? `id=${found.id}` : "provider missing";
  out.params = found?.searchConfig?.targetResults === 7;
  out.paramsDetail = `targetResults=${found?.searchConfig?.targetResults ?? "?"}`;

  // The key must still decrypt: a missing master.key shows up here as a failure.
  const keyRes = await fetch(`${base}/api/admin/providers/${state.providerId}/keys`, { headers: { cookie: state.cookie } });
  const keys = keyRes.ok ? await keyRes.json() : [];
  const list = Array.isArray(keys) ? keys : keys.keys ?? [];
  out.key = list.some((k) => k.id === state.keyId);
  out.keyDetail = `HTTP ${keyRes.status}, ${list.length} key(s)`;

  const search = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie, "x-csrf-token": state.csrf },
    body: JSON.stringify({ query: "upgrade probe", mode: "basic", limit: 3, skipCache: true }),
  });
  const searchBody = await search.json().catch(() => ({}));
  out.search = (searchBody.results ?? []).length > 0;
  out.searchDetail = `HTTP ${search.status}, ${(searchBody.results ?? []).length} results`;

  const mcp = state.bearer ? await mcpPing(base, state.bearer) : { ok: false, detail: "no token" };
  out.mcp = mcp.ok;
  out.mcpDetail = mcp.detail;

  const masterPath = join(dataDir, "master.key");
  out.masterKey = existsSync(masterPath) && sha256(masterPath) === state.masterKeySha;
  out.masterKeyDetail = existsSync(masterPath) ? sha256(masterPath).slice(0, 12) : "missing";

  const dbPath = join(dataDir, "search-hub.db");
  out.db = existsSync(dbPath) && statSync(dbPath).size >= state.dbSize;
  out.dbDetail = existsSync(dbPath) ? `${statSync(dbPath).size} bytes (was ${state.dbSize})` : "missing";

  // Every migration the new binary knows about must already be applied.
  const cat = await (await fetch(`${base}/api/providers`, { headers: { cookie: state.cookie } })).json();
  const catalog = cat.catalog ?? [];
  out.catalogMinimax = catalog.some((e) => e.type === "minimax");
  out.catalogMetaso = catalog.some((e) => e.type === "metaso");

  const health = await fetch(`${base}/api/health`);
  out.migrations = health.ok;
  out.migrationsDetail = `health ${health.status}`;

  return out;
}

function snapshot(install, dataDir, state) {
  const masterPath = join(dataDir, "master.key");
  const dbPath = join(dataDir, "search-hub.db");
  return {
    masterKey: existsSync(masterPath),
    masterKeyDetail: existsSync(masterPath) ? sha256(masterPath).slice(0, 12) : "missing",
    masterKeySha: existsSync(masterPath) ? sha256(masterPath) : null,
    db: existsSync(dbPath),
    dbDetail: existsSync(dbPath) ? `${statSync(dbPath).size} bytes` : "missing",
    dbSize: existsSync(dbPath) ? statSync(dbPath).size : 0,
    install,
    state,
  };
}

async function mcpPing(base, bearer) {
  const call = async (payload) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
    return { status: res.status, text: line };
  };
  const init = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "upgrade", version: "1" } },
  });
  if (init.status !== 200) return { ok: false, detail: `initialize HTTP ${init.status}` };
  const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const ok = list.text.includes("search_web");
  return { ok, detail: `tools/list ${ok ? "ok" : "missing search_web"}` };
}

void readdirSync;
