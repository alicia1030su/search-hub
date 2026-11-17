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
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

/**
 * How to control the service in a *released* package.
 *
 * A released package does not ship `launcher.mjs`: on Windows the launcher is
 * `SearchHub.exe` (a Node SEA), on Linux it is `bin/search-hub`. The updater has to
 * drive whichever one exists, otherwise it can only ever work from the source tree.
 */
function resolveLauncher(root) {
  if (process.platform === "win32") {
    const exe = join(root, "SearchHub.exe");
    if (existsSync(exe)) return { command: exe, args: [] };
  }
  const shell = join(root, "bin", "search-hub");
  if (existsSync(shell)) return { command: shell, args: [] };
  // Development / test tree: run the launcher script through this Node runtime.
  const script = join(HERE, "launcher.mjs");
  if (existsSync(script)) return { command: process.execPath, args: [script] };
  throw new UpdateError("no_launcher", `No launcher found under ${root}`);
}

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

/** The installed version: `launcher.json` in a package, `package.json` in a source tree. */
function readInstalledVersion(root) {
  for (const name of ["launcher.json", "package.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      /* fall through */
    }
  }
  throw new UpdateError(
    "unknown_version",
    `Cannot determine the installed version under ${root}; refusing to update without it.`,
  );
}

/** Writes the new version into the package manifest (and package.json if present). */
function stampVersion(root, version) {
  for (const name of ["launcher.json", "package.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      parsed.version = version;
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    } catch (error) {
      throw new UpdateError("manifest_update_failed", `Could not update ${name}: ${String(error)}`);
    }
  }
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

/**
 * Detects a systemd-managed install.
 *
 * When a unit exists, the updater must drive `systemctl` instead of spawning the
 * launcher itself: systemd owns the process, restarts it on failure, and would
 * fight a second supervisor over the same port and database.
 */
function systemdUnit() {
  if (process.platform === "win32") return null;
  for (const path of [
    "/etc/systemd/system/search-hub.service",
    "/lib/systemd/system/search-hub.service",
    "/usr/lib/systemd/system/search-hub.service",
  ]) {
    if (existsSync(path)) return process.env["SEARCH_HUB_SYSTEMD_UNIT"] ?? "search-hub";
  }
  return null;
}

function systemctl(args) {
  return spawnSync("systemctl", args, { stdio: "ignore", timeout: 120_000 });
}

function stopService(launcher, dataDir, port) {
  const unit = systemdUnit();
  if (unit) {
    const result = systemctl(["stop", unit]);
    log(`systemctl stop ${unit}: ${result.status === 0 ? "ok" : `exit ${result.status}`}`);
    return;
  }
  try {
    execFileSync(launcher.command, [...launcher.args, "--stop"], {
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
/**
 * Terminates a server that the launcher no longer tracks.
 *
 * When a new build never becomes healthy, the launcher's own health timeout can
 * fire first and clear its lock, leaving a live child that still holds the
 * program files. On Windows that makes the rollback fail with EBUSY — and an
 * orphaned server on the same database is exactly the state to avoid. So the
 * updater kills the recorded pid itself and waits for it to disappear.
 */
function hardStop(dataDir) {
  // Under systemd the unit owns the process; killing its pid directly would be
  // undone by Restart=on-failure and could race a fresh start.
  if (systemdUnit()) return;
  const lockPath = join(dataDir, "launcher.lock");
  if (!existsSync(lockPath)) return;
  let pid = null;
  try {
    pid = JSON.parse(readFileSync(lockPath, "utf8")).pid ?? null;
  } catch {
    return;
  }
  if (typeof pid !== "number" || pid <= 0) return;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(pid, signal);
    } catch {
      return; // already gone
    }
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return; // exited
      }
      sleep(200);
    }
    log(`process ${pid} ignored ${signal}; escalating`);
  }
}

function startService(launcher, dataDir, port) {
  const unit = systemdUnit();
  if (unit) {
    const result = systemctl(["start", unit]);
    log(`systemctl start ${unit}: ${result.status === 0 ? "ok" : `exit ${result.status}`}`);
    return;
  }
  const child = spawn(launcher.command, [...launcher.args, "--service", "--no-browser"], {
    env: { ...process.env, SEARCH_HUB_DATA_DIR: dataDir, SEARCH_HUB_PORT: String(port) },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
}

/**
 * Health probe that also checks *which build* is answering.
 *
 * A bare HTTP 200 is not enough: if an old instance is still bound to the port
 * (a launcher that failed to stop, a manual start, a stuck child), the probe
 * would report success while the version the user asked for was never started.
 * `/api/health` returns `version`, so the updater compares it.
 */
function probeOnce(port, expectedVersion) {
  const script = `
    fetch("http://127.0.0.1:${port}/api/health")
      .then(async (r) => {
        if (!r.ok) process.exit(1);
        const body = await r.json().catch(() => ({}));
        const want = ${JSON.stringify(expectedVersion)};
        // Require an exact match. Accepting a missing version would let any
        // process on the port (a leftover stub, an older build without the field)
        // masquerade as the build we just installed.
        if (want && (!body || body.version !== want)) process.exit(2);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { stdio: "ignore", timeout: 5_000 });
  return result.status === 0 ? "healthy" : result.status === 2 ? "stale" : "down";
}

function waitHealthy(port, expectedVersion, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = probeOnce(port, expectedVersion);
    if (state === "healthy") return { ok: true, stale: false };
    if (state === "stale") {
      // A different build answers on this port: the new one never took over.
      return { ok: false, stale: true };
    }
    sleep(1_000);
  }
  return { ok: false, stale: false };
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

  const currentVersion = readInstalledVersion(root);
  const appDir = join(root, "app");
  const workRoot = join(dataDir, "updates");
  const staging = join(workRoot, `staging-${Date.now()}`);
  const launcher = resolveLauncher(root);

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
  hardStop(dataDir);

  // ---- 3. Back up, then install ---------------------------------------
  const schemaBefore = readSchemaVersion(join(dataDir, "search-hub.db"));
  const backup = backupCurrent({ dataDir, appDir, backupRoot: join(workRoot, "backups") });
  log(`backup written to ${backup.path} (schema ${String(schemaBefore)})`);

  const { previous } = installProgram({ stagingDir: stagedApp, appDir });
  // The manifest is part of the program's identity: the server reads its version
  // from launcher.json, so leaving the old value behind makes a successful
  // upgrade report the previous version — and the health check would then reject
  // the build it just installed.
  stampVersion(root, version);
  log(`program installed as ${version}; previous tree kept at ${previous}`);

  // ---- 4. Start and verify --------------------------------------------
  startService(launcher, dataDir, port);
  const probe = waitHealthy(port, version);
  const healthy = probe.ok;
  const schemaAfter = readSchemaVersion(join(dataDir, "search-hub.db"));

  if (probe.stale) {
    log(`a different build is answering on port ${port}; treating the update as failed`);
  }

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
  // The failed build may still be running with the program files open.
  hardStop(dataDir);

  // Put the previous program back BEFORE deciding about the database: the
  // decision only affects the data files, and an install with no program is the
  // one outcome that must never be left behind.
  let rollbackError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rollbackProgram({ appDir, previous });
      rollbackError = null;
      break;
    } catch (error) {
      rollbackError = error;
      sleep(700);
    }
  }
  if (rollbackError) {
    log(`rollback could not restore the program: ${String(rollbackError)}`);
    return 4;
  }

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
  const restoredProbe = waitHealthy(port, currentVersion);
  const restored = restoredProbe.ok;
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
