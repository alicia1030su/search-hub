#!/usr/bin/env node
/**
 * Search Hub updater CLI.
 *
 * Runs **outside** the server process: on Windows the running executable is
 * locked, and on Linux systemd owns the service.
 *
 * Usage:
 *   node updater.mjs --package <file> --version <v> --sha256 <hex> [--size n]
 *                    [--root <install dir>] [--data <data dir>]
 *
 * Exit codes:
 *   0  updated and healthy
 *   3  update applied but the health check failed and the rollback succeeded
 *   4  update failed and the rollback also failed (manual intervention)
 *   1  refused before touching anything (digest, downgrade, architecture, layout)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UpdateError,
  assertArchMatches,
  assertTreeContained,
  assertUpgrade,
  backupCurrent,
  installProgram,
  planRollback,
  readSchemaVersion,
  restoreData,
  rollbackProgram,
  verifyStagedFile,
} from "./updater-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function log(message) {
  console.log(`[updater] ${message}`);
}

/** Blocking sleep, so the CLI's verdict is complete before the process exits. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function extract(archive, into) {
  mkdirSync(into, { recursive: true });
  const base = resolve(dirname(archive));
  const name = archive.split(/[\\/]/).pop();
  if (name.endsWith(".zip")) {
    try {
      execFileSync("unzip", ["-q", "-o", name, "-d", into], { cwd: base, stdio: "inherit" });
      return;
    } catch {
      execFileSync("tar", ["-xf", name, "-C", into], { cwd: base, stdio: "inherit" });
      return;
    }
  }
  execFileSync("tar", ["-xzf", name, "-C", into], { cwd: base, stdio: "inherit" });
}

function listEntries(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name);
    out.push(name);
    if (statSync(absolute).isDirectory()) out.push(...listEntries(absolute));
  }
  return out;
}

function stopService(launcher, dataDir, port) {
  try {
    execFileSync(process.execPath, [launcher, "--stop"], {
      env: { ...process.env, SEARCH_HUB_DATA_DIR: dataDir, SEARCH_HUB_PORT: String(port) },
      stdio: "inherit",
      timeout: 60_000,
    });
  } catch {
    // "not running" is a normal state before an update.
  }
}

/**
 * Starts the service and returns immediately.
 *
 * `--service` keeps the launcher in the foreground on purpose (it supervises the
 * server and forwards signals), so this must spawn it detached rather than wait:
 * waiting would block until the timeout and then kill the very process we want
 * to keep running.
 */
function startService(launcher, dataDir, port) {
  const child = spawn(process.execPath, [launcher, "--service", "--no-browser"], {
    env: { ...process.env, SEARCH_HUB_DATA_DIR: dataDir, SEARCH_HUB_PORT: String(port) },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
}

/** Synchronous health probe: spawns a tiny node process so we can block on it. */
function probeOnce(port) {
  try {
    execFileSync(
      process.execPath,
      ["-e", `fetch("http://127.0.0.1:${port}/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],
      { stdio: "ignore", timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

function waitHealthy(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeOnce(port)) return true;
    sleep(1_000);
  }
  return false;
}

async function main() {
  const root = resolve(arg("root") ?? join(HERE, ".."));
  const packagePath = arg("package");
  const version = arg("version");
  const sha256 = arg("sha256");
  const size = Number(arg("size") ?? 0);
  const dataDir = resolve(arg("data") ?? join(root, "data"));
  const port = Number(arg("port") ?? process.env["SEARCH_HUB_PORT"] ?? 8787);

  if (!packagePath || !version || !sha256) {
    log("usage: updater.mjs --package <file> --version <v> --sha256 <hex> [--size n] [--root dir] [--data dir]");
    process.exit(1);
  }

  const packageJsonPath = join(root, "package.json");
  const currentVersion = existsSync(packageJsonPath)
    ? JSON.parse(readFileSync(packageJsonPath, "utf8")).version
    : "0.0.0";
  const appDir = join(root, "app");
  const workRoot = join(dataDir, "updates");
  const staging = join(workRoot, `staging-${Date.now()}`);
  const launcher = join(HERE, "launcher.mjs");

  // ---- 1. Refuse before touching anything -------------------------------
  assertUpgrade(currentVersion, version);
  assertArchMatches(String(packagePath).split(/[\\/]/).pop());
  const digest = verifyStagedFile(packagePath, sha256, size);
  log(`package verified (${digest.slice(0, 12)}...), ${currentVersion} -> ${version}`);

  extract(packagePath, staging);
  assertTreeContained(staging);
  const entries = listEntries(staging);
  // A package may nest everything under one folder; install must copy the
  // program itself, not that wrapper.
  const stagedApp = entries.includes("app") ? join(staging, "app") : staging;
  log(`extracted; program root = ${stagedApp}`);

  // ---- 2. Stop the service ---------------------------------------------
  stopService(launcher, dataDir, port);

  // ---- 3. Back up, then install ---------------------------------------
  const schemaBefore = readSchemaVersion(join(dataDir, "search-hub.db"));
  const backup = backupCurrent({ dataDir, appDir, backupRoot: join(workRoot, "backups") });
  log(`backup written to ${backup.path} (schema ${String(schemaBefore)})`);

  const { previous } = installProgram({ stagingDir: stagedApp, appDir });
  log(`program installed; previous tree kept at ${previous}`);

  // ---- 4. Start and verify --------------------------------------------
  startService(launcher, dataDir, port);
  const healthy = waitHealthy(port);
  const schemaAfter = readSchemaVersion(join(dataDir, "search-hub.db"));

  if (healthy) {
    mkdirSync(workRoot, { recursive: true });
    writeFileSync(
      join(workRoot, "last-update.json"),
      JSON.stringify({ version, from: currentVersion, at: new Date().toISOString(), ok: true }, null, 2),
      "utf8",
    );
    log(`update to ${version} completed and healthy`);
    return 0;
  }

  // ---- 5. Roll back ---------------------------------------------------
  log("health check failed; rolling back");
  stopService(launcher, dataDir, port);
  rollbackProgram({ appDir, previous });

  const plan = planRollback({
    schemaBefore,
    schemaAfter,
    hasDataBackup: existsSync(join(backup.path, "search-hub.db")),
  });
  log(`rollback plan: ${plan.strategy} - ${plan.reason}`);
  if (plan.strategy === "restore_backup") {
    restoreData({ backupPath: backup.path, dataDir });
    log("database restored from the pre-update backup so program and schema agree");
  } else if (plan.strategy === "blocked") {
    log("WARNING: program rolled back only; the database remains at the newer schema");
  }

  startService(launcher, dataDir, port);
  const restored = waitHealthy(port);
  mkdirSync(workRoot, { recursive: true });
  writeFileSync(
    join(workRoot, "last-update.json"),
    JSON.stringify(
      { version, from: currentVersion, at: new Date().toISOString(), ok: false, rollback: plan.strategy },
      null,
      2,
    ),
    "utf8",
  );
  if (restored) {
    log("rolled back and healthy on the previous version");
    return 3;
  }
  log("CRITICAL: rollback did not come up healthy; this instance needs manual attention");
  return 4;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof UpdateError) {
      log(`REFUSED (${error.code}): ${error.message}`);
      process.exit(1);
    }
    log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(4);
  });
