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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_SLUG = "alicia1030su/search-hub";
const IS_WINDOWS = process.platform === "win32";
const OS_KEY = IS_WINDOWS ? "windows" : "linux";
const ARCH_KEY = process.arch;

const FROM = arg("from");
/**
 * A local archive/directory to use as the "old" install.
 *
 * Exists so the matrix logic itself can be exercised where the network cannot
 * fetch the published assets; CI still uses the real releases.
 */
const FROM_LOCAL = arg("from-local");
const TO = arg("to");
const KEEP = hasFlag("--keep");
let PORT_BASE = Number(arg("port") ?? 8910);

if (!FROM && !FROM_LOCAL) {
  console.error("usage: upgrade-matrix.mjs --from <tag> | --from-local <dir|archive> [--to <tag|path>] [--keep]");
  process.exit(2);
}

process.on("uncaughtException", (error) => {
  console.error(`UNCAUGHT: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exitCode = 1;
});
process.on("unhandledRejection", (error) => {
  console.error(`UNHANDLED: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exitCode = 1;
});

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const work = mkdtempSync(join(tmpdir(), `search-hub-upgrade-${FROM ?? "local"}-`));
const dataDir = join(work, "data");
mkdirSync(dataDir, { recursive: true });

/** Finds a port nothing answers on, so a foreign dev server cannot be mistaken for ours. */
async function pickPort(start) {
  for (let candidate = start; candidate < start + 40; candidate += 1) {
    try {
      await fetch(`http://127.0.0.1:${candidate}/api/health`, { signal: AbortSignal.timeout(400) });
      continue; // something answers here
    } catch {
      return candidate;
    }
  }
  throw new Error(`no free port in ${start}..${start + 40}`);
}

try {
  PORT_BASE = await pickPort(PORT_BASE);
  console.log(`using port ${PORT_BASE}`);
  const oldAsset = FROM_LOCAL
    ? localInstallSource(FROM_LOCAL)
    : await downloadReleaseAsset(FROM);
  let newAsset;
  if (TO && existsSync(TO)) {
    // A local archive: read the version out of it instead of guessing from the path.
    const probe = unpack({ path: resolve(TO) }, join(work, "probe"));
    const version = installedVersion(probe);
    if (version === "unknown") throw new Error(`cannot read a version from ${TO}`);
    newAsset = { path: resolve(TO), tag: version };
    console.log(`local package version: ${version}`);
  } else {
    newAsset = await downloadReleaseAsset(TO ?? "v0.1.6-beta.1");
  }

  const oldRoot = oldAsset.extracted ?? unpack(oldAsset, join(work, "old"));
  const install = join(work, "install");
  // The upgrade happens in place: the new program is installed over the same
  // directory the old one occupied.
  copyTree(oldRoot, install);

  console.log(`from ${oldAsset.tag} (${oldAsset.path.split(/[\\/]/).pop()})`);
  console.log(`to   ${newAsset.tag} (${newAsset.path.split("/").pop()})`);
  console.log(`install root: ${install}`);
  if (!existsSync(install)) throw new Error(`install root was not created: ${install}`);

  const versionBefore = installedVersion(install);
  // The manifest must correspond to the tag the asset came from, but the exact
  // spelling depends on when that package was built:
  //  - up to v0.1.6 the release workflow did not pass SEARCH_HUB_VERSION, so a
  //    beta package carried the bare version (`0.1.4` inside v0.1.4-beta.6);
  //  - from v0.1.7 the tag is stamped verbatim (`0.1.7-beta.3`).
  // Accept either, and print which one was found: rejecting the older form
  // would fail an upgrade that is in fact correct, and accepting *any* string
  // would make this check meaningless.
  const tagVersion = (FROM ?? "").replace(/^v/, "");
  const bareVersion = tagVersion.replace(/-(alpha|beta|rc)\.\d+$/, "");
  const versionOk = FROM
    ? versionBefore === tagVersion || versionBefore === bareVersion
    : versionBefore !== "unknown";
  const versionDetail =
    versionBefore === tagVersion
      ? `${versionBefore} (matches ${oldAsset.tag})`
      : versionBefore === bareVersion
        ? `${versionBefore} (bare form of ${oldAsset.tag})`
        : `${versionBefore} (expected ${tagVersion} or ${bareVersion}, source ${oldAsset.tag})`;
  check("old package reports its own version", versionOk, versionDetail);

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
  // Extract the new package first: its updater is the one that knows how to
  // install this version. Using the old package's updater would test a code path
  // no user runs (and v0.1.4-beta.6 shipped no updater at all).
  const newRoot = unpack(newAsset, join(work, "new"));
  const updater = join(newRoot, "bin", "updater.mjs");
  const newRuntime = IS_WINDOWS ? join(newRoot, "runtime", "node.exe") : join(newRoot, "runtime", "bin", "node");
  check("the new package contains an updater", existsSync(updater), updater);
  check("the new package contains the updater config resolver", existsSync(join(newRoot, "bin", "updater-config.mjs")), join(newRoot, "bin", "updater-config.mjs"));
  check("the new package bundles a runtime", existsSync(newRuntime));
  if (!existsSync(updater)) throw new Error("new package has no updater; cannot upgrade in place");

  const expectedSha = sha256(newAsset.path);
  const updaterRun = spawnSync(
    existsSync(newRuntime) ? newRuntime : process.execPath,
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
    { cwd: install, encoding: "utf8", timeout: 300_000 },
  );
  const updaterOutput = `${updaterRun.stdout ?? ""}${updaterRun.stderr ?? ""}`.trim();
  check(
    "updater reports the new version healthy",
    updaterRun.status === 0 && updaterOutput.includes("completed and healthy"),
    `exit=${updaterRun.status} ${updaterOutput.split("\n").slice(-2).join(" | ").slice(0, 200)}`,
  );

  const versionAfter = installedVersion(install);
  const wantAfter = newAsset.tag.replace(/^v/, "");
  check("new program version installed", versionAfter === wantAfter, `${versionBefore} → ${versionAfter}`);

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
  if (after.searchTask !== undefined) check("search task record survived", after.searchTask, after.searchTaskDetail);
  if (after.healthHistory !== undefined) check("health history survived", after.healthHistory, after.healthHistoryDetail);
  if (after.healthBudget !== undefined) check("health budget ledger survived", after.healthBudget, after.healthBudgetDetail);
  if (after.batchJob !== undefined) check("provider batch task survived", after.batchJob, after.batchJobDetail);
  if (after.cache !== undefined) check("cache entries survived", after.cache, after.cacheDetail);
  if (after.cacheHit !== undefined) check("cache remained usable after upgrade", after.cacheHit, after.cacheHitDetail);
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
process.exitCode = failures === 0 ? 0 : 1;

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

/** Read the applied migration names without creating or modifying schema. */
function readMigrationNames(dataDir) {
  const path = join(dataDir, "search-hub.db");
  if (!existsSync(path)) return null;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare("SELECT name FROM _migrations ORDER BY name").all().map((row) => row.name);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Distinguishes a real schema absence from an unreadable database. */
function readSearchCacheTableState(dataDir) {
  const path = join(dataDir, "search-hub.db");
  if (!existsSync(path)) return "unavailable";
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_cache'",
    ).get();
    return row ? "present" : "absent";
  } catch {
    return "unavailable";
  } finally {
    db?.close();
  }
}

/** Read-only cache-row evidence that works across old and new API shapes. */
function readCacheHitCounts(dataDir) {
  const path = join(dataDir, "search-hub.db");
  if (!existsSync(path)) return null;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("SELECT cache_key, hit_count FROM search_cache").all();
    if (!rows.every((row) => typeof row.cache_key === "string" && Number.isFinite(row.hit_count))) return null;
    return new Map(rows.map((row) => [row.cache_key, row.hit_count]));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Inputs that deliberately invalidate a cached response. If these are unchanged,
 * the upgrade must reuse the old row; if they changed, a new key is legitimate but
 * the new row still has to produce a real cache hit after warmup.
 */
function readCacheFingerprintInputs(dataDir, providerId) {
  if (!providerId) return null;
  const path = join(dataDir, "search-hub.db");
  if (!existsSync(path)) return null;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const provider = db.prepare(
      "SELECT id, type, base_url, results_per_page, language, freshness, config_json, search_config_json FROM provider_instances WHERE id = ?",
    ).get(providerId);
    const keys = db.prepare(
      "SELECT id, enabled, key_version, updated_at FROM api_keys WHERE provider_id = ? ORDER BY id",
    ).all(providerId);
    return provider ? { provider, keys } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
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
  // Release assets are named after package.json, which drops the prerelease
  // suffix: v0.1.4-beta.6 ships `search-hub-v0.1.4-linux-x64.tar.gz`.
  const full = tag.replace(/^v/, "");
  const bare = full.replace(/-(alpha|beta|rc)\.\d+$/, "");
  const suffix = IS_WINDOWS ? "zip" : "tar.gz";
  // Older releases drop the prerelease suffix; newer ones keep it. Try the exact
  // tag version first, then the bare one, and say which was used.
  const candidates = [...new Set([`search-hub-v${full}-${OS_KEY}-${ARCH_KEY}.${suffix}`, `search-hub-v${bare}-${OS_KEY}-${ARCH_KEY}.${suffix}`])];
  const assetName = candidates[0];
  const out = join(work, assetName);
  if (existsSync(out) && statSync(out).size > 1_000_000) return { path: out, tag };
  // gh handles auth and redirects better than a hand-rolled fetch, and it is
  // present on every GitHub runner.
  let resolved = assetName;
  for (const candidate of candidates) {
    try {
      execFileSync("gh", ["release", "download", tag, "--repo", REPO_SLUG, "--pattern", candidate, "--clobber", "--dir", work], {
        stdio: "pipe",
      });
      if (existsSync(join(work, candidate))) {
        resolved = candidate;
        break;
      }
    } catch {
      /* try the next name */
    }
  }
  const outPath = join(work, resolved);
  if (!existsSync(outPath)) throw new Error(`no asset matching ${candidates.join(" or ")} in ${tag}`);
  const size = statSync(outPath).size;
  // Compare with the size the release claims: a proxy that truncates a body is the
  // most common way an "upgrade test" silently degrades into a same-version no-op.
  const meta = JSON.parse(
    execFileSync("gh", ["api", `repos/${REPO_SLUG}/releases/tags/${tag}`, "--jq", ".assets"], {
      encoding: "utf8",
    }),
  );
  const declared = meta.find((item) => item.name === resolved)?.size;
  if (declared !== undefined && size !== declared) {
    throw new Error(`asset ${resolved} is ${size} bytes but the release says ${declared}`);
  }
  return { path: outPath, tag };
}

/** Extracts a package; the archive root is the install layout. */
/**
 * Recursive copy built on readdir + copyFile.
 *
 * `fs.cpSync` dies silently on a tree containing the 87 MB SEA executable in this
 * environment — the same failure that hit the packaging script — so the copy is
 * done explicitly and any error surfaces with a path.
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

/** Accepts an already-extracted directory or an archive, for offline runs. */
function localInstallSource(input) {
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`--from-local path not found: ${path}`);
  if (statSync(path).isDirectory()) {
    return { path, tag: `local:${installedVersion(path)}`, extracted: path };
  }
  return { path, tag: `local:${path.split(/[\\/]/).pop()}` };
}

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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

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
      if (res.ok) {
        const body = await res.json().catch(() => null);
        // An HTTP 200 is not proof this is Search Hub: any dev server on the port
        // answers. Require the shape our own health endpoint returns.
        if (body && body.status === "ok" && typeof body.version === "string") {
          return { ok: true, base, child, root, port, version: body.version, detail: "" };
        }
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return { ok: false, base, child, root, port, detail: log.join("").slice(-300) || "health endpoint did not identify itself as Search Hub" };
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

  // v0.1.12+ state that the CLI release must preserve. Older matrix entries may
  // not expose these endpoints; record only what the old version really created.
  const healthProbe = await fetch(`${base}/api/admin/provider-health/${providerId}/probe`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ kind: "connect" }),
  });
  const healthBody = healthProbe.ok ? await healthProbe.json().catch(() => ({})) : {};
  const healthHistory = await fetch(`${base}/api/admin/provider-health/history?providerId=${providerId}&limit=100`, { headers: { cookie } });
  const historyBody = healthHistory.ok ? await healthHistory.json().catch(() => ({ checks: [] })) : { checks: [] };
  const healthSettings = await fetch(`${base}/api/admin/provider-health/settings`, { headers: { cookie } });
  const settingsBody = healthSettings.ok ? await healthSettings.json().catch(() => ({})) : {};

  let batchJob = null;
  if (providerId) {
    const started = await fetch(`${base}/api/admin/provider-health/batch-test`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ kind: "connect", providerIds: [providerId], includeKeyless: true }),
    });
    const startedBody = started.ok ? await started.json().catch(() => ({})) : {};
    if (startedBody.jobId) {
      for (let i = 0; i < 40; i += 1) {
        const poll = await fetch(`${base}/api/admin/provider-health/batch-test/${startedBody.jobId}`, { headers: { cookie } });
        const body = poll.ok ? await poll.json().catch(() => ({})) : {};
        if (body.status && body.status !== "running") { batchJob = body; break; }
        await sleep(100);
      }
    }
  }

  const cacheQuery = "upgrade cache probe";
  const cacheSettings = await fetch(`${base}/api/admin/settings`, {
    method: "PUT",
    headers: h,
    body: JSON.stringify({ cache: { enabled: true, ttlSeconds: 3600 } }),
  });
  const cacheSettingsBody = cacheSettings.ok ? await cacheSettings.json().catch(() => null) : null;
  const cacheSetupOk = cacheSettings.ok && cacheSettingsBody?.cache?.enabled === true;
  // Probe even when setup failed so legacy in-memory hits remain observable and
  // persistent cache failures cannot be hidden by an unsupported API response.
  await fetch(`${base}/api/search`, { method: "POST", headers: h, body: JSON.stringify({ query: cacheQuery, mode: "basic", limit: 3 }) });
  await fetch(`${base}/api/search`, { method: "POST", headers: h, body: JSON.stringify({ query: cacheQuery, mode: "basic", limit: 3 }) });
  const cachedSearch = await fetch(`${base}/api/search`, { method: "POST", headers: h, body: JSON.stringify({ query: cacheQuery, mode: "basic", limit: 3 }) });
  const cachedBody = cachedSearch.ok ? await cachedSearch.json().catch(() => ({})) : {};
  let cacheStatsRes = null;
  let cacheApiStatus = "unavailable";
  let cacheApiErrorCode = null;
  let cacheStats = null;
  try {
    cacheStatsRes = await fetch(`${base}/api/admin/cache`, { headers: { cookie } });
    cacheApiStatus = cacheStatsRes.status;
    const cacheApiBody = await cacheStatsRes.json().catch(() => null);
    cacheApiErrorCode = cacheApiBody?.error?.code ?? null;
    cacheStats = cacheStatsRes.ok ? cacheApiBody : null;
  } catch {
    // Network failures are unavailable evidence, never proof of no cache API.
  }
  const cacheApiExplicitlyUnsupported = cacheApiStatus === 404
    || (typeof cacheApiStatus === "number" && cacheApiStatus < 500 && cacheApiErrorCode === "not_implemented");
  const cacheTableStatus = readSearchCacheTableState(dataDir);
  const cacheHitCounts = readCacheHitCounts(dataDir);
  const cacheFingerprintInputs = readCacheFingerprintInputs(dataDir, providerId);
  const cachedSearchHit = cachedSearch.ok && cachedBody.stats?.cached === true;
  const cacheEntries = cacheStatsRes?.ok && Number.isFinite(cacheStats?.entries) ? cacheStats.entries : null;
  const cacheMode = cacheTableStatus === "unavailable"
    ? "unavailable"
    : cacheTableStatus === "present"
      ? "persistent"
      : cacheApiExplicitlyUnsupported
        ? "legacy-memory-only"
        : "ambiguous";
  const cacheRequiredReason = cacheMode === "persistent"
    ? "persistent cache requires strict fingerprint and old-row reuse evidence"
    : cacheMode === "legacy-memory-only"
      ? "legacy memory cache has no persistent rows; post-upgrade persistent warmup and hit growth are still required"
      : cacheMode === "ambiguous"
        ? "search_cache is absent but the cache API did not explicitly report 404/not_implemented"
        : "search_cache table state is unavailable";

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
    searchTaskId: searchBody.taskId ?? null,
    healthCheckId: healthBody.result?.checkId ?? null,
    healthHistoryCount: Array.isArray(historyBody.checks) ? historyBody.checks.length : null,
    healthBudget: settingsBody.budget ?? null,
    batchJobId: batchJob?.jobId ?? null,
    batchStatus: batchJob?.status ?? null,
    batchCounts: batchJob?.counts ?? null,
    cacheEntries,
    cacheHits: cacheStats?.hits24h ?? cacheStats?.hits ?? null,
    cacheHitCounts,
    cacheFingerprintInputs,
    cachedSearchHit,
    cacheSetupOk,
    cacheMode,
    cacheTableStatus,
    cacheApiStatus,
    cacheApiErrorCode,
    cacheRequired: true,
    cacheRequiredReason,
    migrationNames: readMigrationNames(dataDir),
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
  const migrationNames = readMigrationNames(dataDir);
  const beforeMigrations = state.migrationNames;
  const appliedDiff = beforeMigrations && migrationNames
    ? migrationNames.filter((name) => !beforeMigrations.includes(name))
    : null;
  const preserved = beforeMigrations !== null && migrationNames !== null &&
    beforeMigrations.every((name) => migrationNames.includes(name));
  out.migrationsAppliedDiff = appliedDiff;
  out.migrations = health.ok && preserved && (FROM !== "v0.1.13" || appliedDiff.length === 0);
  out.migrationsDetail = `health ${health.status}, appliedDiff=${JSON.stringify(appliedDiff)}`;

  if (state.searchTaskId) {
    const taskRes = await fetch(`${base}/api/search/tasks/${state.searchTaskId}`, { headers: { cookie: state.cookie } });
    const task = taskRes.ok ? await taskRes.json().catch(() => ({})) : {};
    out.searchTask = taskRes.ok && task.id === state.searchTaskId;
    out.searchTaskDetail = `HTTP ${taskRes.status}, id=${task.id ?? "missing"}`;
  }
  if (state.healthHistoryCount !== null) {
    const historyRes = await fetch(`${base}/api/admin/provider-health/history?providerId=${state.providerId}&limit=100`, { headers: { cookie: state.cookie } });
    const history = historyRes.ok ? await historyRes.json().catch(() => ({ checks: [] })) : { checks: [] };
    out.healthHistory = historyRes.ok && (history.checks?.length ?? 0) >= state.healthHistoryCount;
    out.healthHistoryDetail = `${history.checks?.length ?? 0} checks (was ${state.healthHistoryCount})`;
  }
  if (state.healthBudget) {
    const settingsRes = await fetch(`${base}/api/admin/provider-health/settings`, { headers: { cookie: state.cookie } });
    const settings = settingsRes.ok ? await settingsRes.json().catch(() => ({})) : {};
    const before = state.healthBudget;
    const after = settings.budget ?? {};
    const preserved = (after.usedToday ?? 0) >= (before.usedToday ?? 0)
      && (after.connectUsedToday ?? 0) >= (before.connectUsedToday ?? 0)
      && (after.anonymousSearchUsedToday ?? 0) >= (before.anonymousSearchUsedToday ?? 0);
    out.healthBudget = settingsRes.ok && preserved;
    out.healthBudgetDetail = `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
  }
  if (state.batchJobId) {
    const batchRes = await fetch(`${base}/api/admin/provider-health/batch-test/${state.batchJobId}`, { headers: { cookie: state.cookie } });
    const batch = batchRes.ok ? await batchRes.json().catch(() => ({})) : {};
    out.batchJob = batchRes.ok && batch.jobId === state.batchJobId && batch.status === state.batchStatus;
    out.batchJobDetail = `HTTP ${batchRes.status}, status=${batch.status ?? "missing"}`;
  }
  const settingsRes = await fetch(`${base}/api/admin/settings`, { headers: { cookie: state.cookie } });
  const settings = settingsRes.ok ? await settingsRes.json().catch(() => null) : null;
  const cacheRes = await fetch(`${base}/api/admin/cache`, { headers: { cookie: state.cookie } });
  const cache = cacheRes.ok ? await cacheRes.json().catch(() => null) : null;
  const cacheEntriesBeforeWarmup = cacheRes.ok && Number.isFinite(cache?.entries) ? cache.entries : null;
  const cacheApiReady = settingsRes.ok && settings?.cache?.enabled === true && cacheRes.ok;
  const persistentRowsPreserved = state.cacheSetupOk
    && Number.isFinite(state.cacheEntries)
    && state.cacheEntries > 0
    && cacheApiReady
    && cacheEntriesBeforeWarmup !== null
    && cacheEntriesBeforeWarmup >= state.cacheEntries;
  const cacheWarmup = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie, "x-csrf-token": state.csrf },
    body: JSON.stringify({ query: "upgrade cache probe", mode: "basic", limit: 3 }),
  });
  await cacheWarmup.json().catch(() => ({}));
  let cacheEntriesAfterWarmup = null;
  let cacheAfterWarmupStatus = "not-read";
  if (state.cacheMode === "legacy-memory-only") {
    try {
      const cacheAfterWarmupRes = await fetch(`${base}/api/admin/cache`, { headers: { cookie: state.cookie } });
      cacheAfterWarmupStatus = cacheAfterWarmupRes.status;
      const cacheAfterWarmup = cacheAfterWarmupRes.ok ? await cacheAfterWarmupRes.json().catch(() => null) : null;
      cacheEntriesAfterWarmup = cacheAfterWarmupRes.ok && Number.isFinite(cacheAfterWarmup?.entries)
        ? cacheAfterWarmup.entries
        : null;
    } catch {
      cacheAfterWarmupStatus = "unavailable";
    }
  }
  const legacyPersistentCacheReady = cacheApiReady
    && cacheAfterWarmupStatus === 200
    && cacheEntriesAfterWarmup !== null
    && cacheEntriesAfterWarmup > 0;
  out.cache = state.cacheMode === "persistent"
    ? persistentRowsPreserved
    : state.cacheMode === "legacy-memory-only"
      ? legacyPersistentCacheReady
      : false;
  out.cacheDetail = `cacheMode=${state.cacheMode} table=${state.cacheTableStatus} api=${state.cacheApiStatus}${state.cacheApiErrorCode ? `,${state.cacheApiErrorCode}` : ""} afterApi=${cacheRes.status} afterWarmupApi=${cacheAfterWarmupStatus} setupOk=${state.cacheSetupOk} entriesBeforeWarmup=${cacheEntriesBeforeWarmup ?? "unavailable"} entriesAfterWarmup=${cacheEntriesAfterWarmup ?? "unavailable"} (was ${state.cacheEntries ?? "unavailable"}) cacheRequired=true`;
  const hitCountsAfterWarmup = readCacheHitCounts(dataDir);
  const cached = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie, "x-csrf-token": state.csrf },
    body: JSON.stringify({ query: "upgrade cache probe", mode: "basic", limit: 3 }),
  });
  const cachedBody = cached.ok ? await cached.json().catch(() => ({})) : {};
  const hitCountsAfter = readCacheHitCounts(dataDir);
  const fingerprintInputsAfter = readCacheFingerprintInputs(dataDir, state.providerId);
  const fingerprint = !state.cacheFingerprintInputs || !fingerprintInputsAfter
    ? "unavailable"
    : JSON.stringify(state.cacheFingerprintInputs) === JSON.stringify(fingerprintInputsAfter)
      ? "unchanged"
      : "changed";
  const rowEvidenceAvailable = state.cacheMode === "persistent"
    ? Boolean(state.cacheHitCounts && hitCountsAfterWarmup && hitCountsAfter)
    : state.cacheMode === "legacy-memory-only"
      ? Boolean(hitCountsAfterWarmup && hitCountsAfter)
      : false;
  const legacyRowReused = state.cacheMode === "persistent" && rowEvidenceAvailable
    ? [...state.cacheHitCounts.keys()].some((key) => (hitCountsAfter.get(key) ?? 0) > (hitCountsAfterWarmup.get(key) ?? 0))
    : false;
  const newRowReused = rowEvidenceAvailable
    ? [...hitCountsAfter.keys()].some((key) => (
      (state.cacheMode !== "persistent" || !state.cacheHitCounts.has(key))
      && (hitCountsAfter.get(key) ?? 0) > (hitCountsAfterWarmup.get(key) ?? 0)
    ))
    : false;
  const cachedFlag = cachedBody.stats?.cached === true;
  const rowEvidence = state.cacheMode === "persistent"
    ? fingerprint === "unchanged"
      ? legacyRowReused
      : fingerprint === "changed"
        ? legacyRowReused || newRowReused
        : false
    : state.cacheMode === "legacy-memory-only"
      ? newRowReused
      : false;
  out.cacheHit = out.cache
    && state.cachedSearchHit === true
    && rowEvidenceAvailable
    && rowEvidence
    && (state.cacheMode !== "persistent" || fingerprint !== "unavailable")
    && cacheWarmup.ok
    && cached.ok
    && cachedFlag;
  out.cacheHitDetail = `cacheMode=${state.cacheMode} table=${state.cacheTableStatus} api=${state.cacheApiStatus}${state.cacheApiErrorCode ? `,${state.cacheApiErrorCode}` : ""} cached=${cachedBody.stats?.cached ?? "unsupported"} cachedOk=${cached.ok} beforeCached=${state.cachedSearchHit} fingerprint=${fingerprint} legacyRowReused=${legacyRowReused} newRowReused=${newRowReused} rowEvidenceAvailable=${rowEvidenceAvailable} rows=${state.cacheHitCounts ? JSON.stringify([...state.cacheHitCounts.values()]) : "unavailable"}->${hitCountsAfterWarmup ? JSON.stringify([...hitCountsAfterWarmup.values()]) : "unavailable"}->${hitCountsAfter ? JSON.stringify([...hitCountsAfter.values()]) : "unavailable"} cacheRequired=true reason=${state.cacheRequiredReason}`;

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
