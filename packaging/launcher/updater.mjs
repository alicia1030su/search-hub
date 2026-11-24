#!/usr/bin/env node
/** Search Hub transactional updater. All destructive work uses isolated temp dirs. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UpdateError,
  assertArchMatches,
  assertSafeEntry,
  assertTreeContained,
  assertUpgrade,
  backupCurrent,
  installProgram,
  planRollback,
  readSchemaVersion,
  recoverInterruptedUpdate,
  restoreData,
  rollbackProgram,
  systemdStateProvesStopped,
  verifyStagedFile,
  writeJsonAtomic,
} from "./updater-core.mjs";
import { resolveServiceConfig, updateWorkRoot } from "./updater-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function log(message) {
  console.log(`[updater] ${message}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveLauncher(root) {
  if (process.platform === "win32") {
    const exe = join(root, "SearchHub.exe");
    if (existsSync(exe)) return { command: exe, args: [] };
  }
  const shell = join(root, "bin", "search-hub");
  if (existsSync(shell)) return { command: shell, args: [] };
  const script = join(HERE, "launcher.mjs");
  if (existsSync(script)) return { command: process.execPath, args: [script] };
  throw new UpdateError("no_launcher", `No launcher found under ${root}`);
}

function readInstalledVersion(root) {
  for (const name of ["launcher.json", "package.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed.version === "string" && parsed.version) return parsed.version;
    } catch {
      /* try the next manifest */
    }
  }
  throw new UpdateError("unknown_version", `Cannot determine the installed version under ${root}; refusing to update without it.`);
}

function snapshotManifests(root) {
  const snapshot = [];
  for (const name of ["launcher.json", "package.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    snapshot.push({ path, bytes: readFileSync(path).toString("base64") });
  }
  return snapshot;
}

function restoreManifests(snapshot) {
  for (const entry of snapshot) {
    writeFileSync(entry.path, Buffer.from(entry.bytes, "base64"));
  }
}

function stampVersion(root, version) {
  for (const name of ["launcher.json", "package.json"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.version = version;
    writeJsonAtomic(path, parsed);
  }
}

function listArchive(archive) {
  const name = basename(archive);
  const result = name.endsWith(".zip")
    ? spawnSync("unzip", ["-Z1", name], { cwd: dirname(archive), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 })
    : spawnSync("tar", ["-tzf", name], { cwd: dirname(archive), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  if (result.status !== 0) throw new UpdateError("unsafe_archive", `Could not list archive entries: ${result.stderr?.trim() || `exit ${result.status}`}`);
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) assertSafeEntry(entry);
  if (entries.length === 0) throw new UpdateError("unsafe_archive", "Archive contains no entries");

  // Reject link/device/FIFO entries before extraction. A post-extraction walk is
  // still required, but it cannot undo a link written by a permissive extractor.
  const verbose = name.endsWith(".zip")
    ? spawnSync("unzip", ["-Z", "-v", name], { cwd: dirname(archive), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 })
    : spawnSync("tar", ["-tvzf", name], { cwd: dirname(archive), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  if (verbose.status !== 0) throw new UpdateError("unsafe_archive", `Could not inspect archive entry types: ${verbose.stderr?.trim() || `exit ${verbose.status}`}`);
  for (const line of verbose.stdout.split(/\r?\n/)) {
    const match = /^([-dlbcps])([rwxstST-]{9})/.exec(line.trim());
    if (!match) continue;
    if (!["-", "d"].includes(match[1])) throw new UpdateError("unsafe_archive", "Archive contains a link, device, FIFO, socket, or other special entry");
    if ((match[1] === "-" || match[1] === "d") && /[stST]/.test(match[2])) {
      throw new UpdateError("unsafe_archive", "Archive contains setuid/setgid/sticky permissions");
    }
  }
  return entries;
}

function extract(archive, into) {
  const entries = listArchive(archive);
  mkdirSync(into, { recursive: true, mode: 0o700 });
  const name = basename(archive);
  if (name.endsWith(".zip")) {
    try {
      execFileSync("unzip", ["-q", name, "-d", into], { cwd: dirname(archive), stdio: "inherit", timeout: 120_000 });
    } catch {
      execFileSync("tar", ["-xf", name, "-C", into], { cwd: dirname(archive), stdio: "inherit", timeout: 120_000 });
    }
  } else {
    execFileSync("tar", ["-xzf", name, "-C", into, "--no-same-owner", "--no-same-permissions"], { cwd: dirname(archive), stdio: "inherit", timeout: 120_000 });
  }
  assertTreeContained(into);
  return entries;
}

function systemctl(args) {
  return spawnSync("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsLive(dataDir) {
  const path = join(dataDir, "launcher.lock");
  if (!existsSync(path)) return false;
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    return pidAlive(lock.pid);
  } catch {
    return false;
  }
}

async function portResponds(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(750) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function waitPortFree(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portResponds(port))) return;
    sleep(250);
  }
  throw new UpdateError("stop_unproven", `Port ${port} still answers after the stop request; refusing to update a live instance`);
}

async function assertServiceStopped(config) {
  if (config.unitName) {
    const shown = systemctl(["show", config.unitName, "--property=ActiveState", "--property=SubState", "--property=MainPID"]);
    if (shown.status !== 0) throw new UpdateError("stop_unproven", `Could not prove systemd unit ${config.unitName} is stopped`);
    const properties = Object.fromEntries(shown.stdout.trim().split(/\r?\n/).map((line) => line.split("=", 2)));
    if (!systemdStateProvesStopped(properties)) {
      throw new UpdateError("stop_unproven", `systemd unit is not proven stopped: ${JSON.stringify(properties)}`);
    }
  }
  if (lockIsLive(config.dataDir)) throw new UpdateError("stop_unproven", "Launcher lock still points to a live process");
  await waitPortFree(config.port);
}

function stopService(launcher, config) {
  if (config.unitName) {
    const result = systemctl(["stop", config.unitName]);
    if (result.status !== 0) throw new UpdateError("stop_unproven", `systemctl stop ${config.unitName} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
    log(`systemctl stop ${config.unitName}: ok`);
    return;
  }
  try {
    execFileSync(launcher.command, [...launcher.args, "--stop"], {
      env: { ...process.env, SEARCH_HUB_DATA_DIR: config.dataDir, SEARCH_HUB_DB_PATH: config.dbPath, SEARCH_HUB_PORT: String(config.port) },
      stdio: "inherit",
      timeout: 60_000,
    });
  } catch (error) {
    // A missing/stale lock is acceptable only when the independent checks below
    // prove no process or service remains. Any other failure is still rechecked.
    if (!existsSync(join(config.dataDir, "launcher.lock"))) log(`launcher stop returned ${String(error)}; verifying stopped state`);
    else throw new UpdateError("stop_unproven", `Launcher stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const started = [];
function startService(launcher, config) {
  if (config.unitName) {
    const result = systemctl(["start", config.unitName]);
    if (result.status !== 0) throw new UpdateError("start_failed", `systemctl start ${config.unitName} failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
    return;
  }
  const child = spawn(launcher.command, [...launcher.args, "--service", "--no-browser"], {
    env: { ...process.env, SEARCH_HUB_DATA_DIR: config.dataDir, SEARCH_HUB_DB_PATH: config.dbPath, SEARCH_HUB_PORT: String(config.port) },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  started.push(child);
  child.unref();
}

function stopStartedServices() {
  for (const child of started.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      sleep(200);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function probeOnce(port, expectedVersion) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return "down";
    const body = await response.json();
    if (body?.version !== expectedVersion) return "stale";
    return body?.status === "ok" || body?.ok === true ? "healthy" : "down";
  } catch {
    return "down";
  }
}

async function waitHealthy(port, expectedVersion, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await probeOnce(port, expectedVersion);
    if (state === "healthy") return { ok: true, stale: false };
    if (state === "stale") return { ok: false, stale: true };
    sleep(500);
  }
  return { ok: false, stale: false };
}

function record(workRoot, value) {
  writeJsonAtomic(join(workRoot, "last-update.json"), value);
}

async function recoverPrevious({ launcher, config, currentVersion, workRoot, version, appDir, previous, manifests }) {
  if (previous && existsSync(previous)) rollbackProgram({ appDir, previous });
  if (manifests.length > 0) restoreManifests(manifests);
  stopStartedServices();
  startService(launcher, config);
  const probe = await waitHealthy(config.port, currentVersion);
  record(workRoot, { version, from: currentVersion, at: new Date().toISOString(), ok: false, rollback: "install_failed" });
  return probe.ok;
}

async function main() {
  const root = resolve(arg("root") ?? join(HERE, ".."));
  const packagePath = arg("package");
  const version = arg("version");
  const sha256 = arg("sha256");
  const size = Number(arg("size") ?? 0);
  if (!packagePath || !version || !sha256) {
    log("usage: updater.mjs --package <file> --version <v> --sha256 <hex> [--size n] [--root dir] [--data dir] [--db-path file] [--port n]");
    return 1;
  }
  const config = resolveServiceConfig({ root, dataDirArg: arg("data"), dbPathArg: arg("db-path"), portArg: arg("port") });
  const appDir = join(root, "app");
  const workRoot = updateWorkRoot(config.dataDir);
  const journalPath = join(workRoot, "transaction.json");
  const launcher = resolveLauncher(root);
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });

  if (existsSync(journalPath)) {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    if (!["complete", "refused", "recovered"].includes(journal.phase)) {
      log(`recovering interrupted update phase ${journal.phase}`);
      stopService(launcher, config);
      await assertServiceStopped(config);
      recoverInterruptedUpdate(journalPath);
      if (Array.isArray(journal.manifests)) restoreManifests(journal.manifests);
      startService(launcher, config);
      const probe = await waitHealthy(config.port, journal.fromVersion ?? journal.currentVersion);
      return probe.ok ? 3 : 4;
    }
  }

  const currentVersion = readInstalledVersion(root);
  assertUpgrade(currentVersion, version);
  assertArchMatches(basename(packagePath));
  const digest = verifyStagedFile(packagePath, sha256, size);
  log(`package verified (${digest.slice(0, 12)}...), ${currentVersion} -> ${version}`);

  const staging = join(workRoot, `staging-${Date.now()}-${process.pid}`);
  extract(packagePath, staging);
  const entries = readdirSync(staging);
  const stagedApp = entries.includes("app") ? join(staging, "app") : staging;
  log("extracted; program tree verified");

  stopService(launcher, config);
  await assertServiceStopped(config);

  const schemaBefore = readSchemaVersion(config.dbPath);
  const manifests = snapshotManifests(root);
  let backup;
  try {
    backup = backupCurrent({ dataDir: config.dataDir, dbPath: config.dbPath, appDir, backupRoot: join(workRoot, "backups") });
    log(`consistent backup written to ${backup.path} (schema ${String(schemaBefore)})`);
  } catch (error) {
    log(`pre-update backup failed: ${String(error)}`);
    const recovered = await recoverPrevious({ launcher, config, currentVersion, workRoot, version, appDir, previous: null, manifests });
    return recovered ? 3 : 4;
  }

  const journal = {
    format: "search-hub-update-journal-v2",
    phase: "prepared",
    at: new Date().toISOString(),
    root,
    appDir,
    dataDir: config.dataDir,
    dbPath: config.dbPath,
    backupPath: backup.path,
    previousApp: null,
    currentVersion,
    fromVersion: currentVersion,
    targetVersion: version,
    manifests,
  };
  writeJsonAtomic(journalPath, journal);

  let previous = null;
  try {
    const swapStamp = Date.now();
    previous = `${appDir}.rollback-${swapStamp}-${process.pid}`;
    journal.previousApp = previous;
    journal.phase = "app_swap_started";
    writeJsonAtomic(journalPath, journal);
    ({ previous } = installProgram({ stagingDir: stagedApp, appDir, stamp: swapStamp }));
    journal.previousApp = previous;
    journal.phase = "app_swapped";
    writeJsonAtomic(journalPath, journal);
    stampVersion(root, version);
    log(`program installed as ${version}; previous tree kept at ${previous}`);
  } catch (error) {
    log(`install failed: ${String(error)}`);
    const recovered = await recoverPrevious({ launcher, config, currentVersion, workRoot, version, appDir, previous, manifests });
    journal.phase = recovered ? "recovered" : "refused";
    writeJsonAtomic(journalPath, journal);
    return recovered ? 3 : 4;
  }

  try {
    startService(launcher, config);
  } catch (error) {
    log(`start failed: ${String(error)}`);
  }
  const probe = await waitHealthy(config.port, version);
  const schemaAfter = readSchemaVersion(config.dbPath);
  if (probe.ok) {
    journal.phase = "complete";
    journal.completedAt = new Date().toISOString();
    writeJsonAtomic(journalPath, journal);
    record(workRoot, { version, from: currentVersion, at: new Date().toISOString(), ok: true });
    log(`update to ${version} completed and healthy`);
    return 0;
  }

  log(probe.stale ? "a different build is answering; rolling back" : "health check failed; rolling back");
  stopStartedServices();
  try {
    stopService(launcher, config);
    await assertServiceStopped(config);
  } catch (error) {
    log(`could not prove failed service stopped: ${String(error)}`);
    return 4;
  }

  journal.phase = "rollback_started";
  writeJsonAtomic(journalPath, journal);
  try {
    rollbackProgram({ appDir, previous });
    restoreManifests(manifests);
    const restored = restoreData({ backupPath: backup.path, dataDir: config.dataDir, dbPath: config.dbPath });
    journal.failedDataDir = restored.failed;
    journal.phase = "rolled_back";
    writeJsonAtomic(journalPath, journal);
  } catch (error) {
    log(`CRITICAL: rollback failed: ${String(error)}`);
    return 4;
  }

  const plan = planRollback({ schemaBefore, schemaAfter, hasDataBackup: true });
  log(`rollback plan: ${plan.strategy} - ${plan.reason}`);
  startService(launcher, config);
  const restoredProbe = await waitHealthy(config.port, currentVersion);
  journal.phase = restoredProbe.ok ? "recovered" : "refused";
  journal.recoveredAt = new Date().toISOString();
  writeJsonAtomic(journalPath, journal);
  record(workRoot, { version, from: currentVersion, at: new Date().toISOString(), ok: false, rollback: plan.strategy });
  if (restoredProbe.ok) {
    log("rolled back and healthy on the previous version; failed data retained");
    return 3;
  }
  log("CRITICAL: rollback did not come up healthy; this instance needs manual attention");
  return 4;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof UpdateError) log(`REFUSED (${error.code}): ${error.message}`);
    else log(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
