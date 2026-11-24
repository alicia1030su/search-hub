import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertNoReparseAncestors, createBackupPackage, DEFAULT_TAR_LIMITS, openPrivateFile, parseMasterKey, publishNoOverwrite, readMasterKey,
  restrictWindowsAcl, restoreBackupPackage, validateBackupPassphrase, verifyDatabaseBackup,
  type BackupVerificationReport,
} from "@search-hub/backup";
import type { ParsedCliArgs } from "../args.js";
import { stringValue } from "../args.js";
import { usageError } from "../errors/index.js";
import { writeJson, writeText, type OutputFormat } from "../output/index.js";
import { CLI_VERSION } from "../version.js";
import { listLocalMigrations, resolveBackupPassphrase, resolveLocalPaths, type LocalPaths } from "../local/index.js";
import { createNodeSqliteSnapshot, openNodeSqlite } from "../local/sqlite.js";

interface OperationReport {
  operation: "create" | "verify" | "restore";
  result: "ok" | "dry-run" | "failed";
  startedAt: string;
  durationMs: number;
  peakRssBytes: number;
  temporaryDiskBytes: number;
  verification?: BackupVerificationReport;
  output?: string;
  startCheck?: "ok" | "failed" | "not-requested";
  reason?: string;
}

function emit(value: unknown, format: OutputFormat): void {
  if (format === "table") writeText(JSON.stringify(value, null, 2));
  else writeJson(value);
}
function passphraseFrom(args: ParsedCliArgs): Promise<string> {
  return resolveBackupPassphrase(args.values["passphrase-stdin"] === true).then((value) => validateBackupPassphrase(value ?? ""));
}
async function currentKey(paths: LocalPaths): Promise<{ key: Buffer; source: "env" | "file" }> {
  const envKey = process.env["SEARCH_HUB_ENCRYPTION_KEY"];
  if (envKey && envKey.trim()) return { key: parseMasterKey(envKey), source: "env" };
  return { key: await readMasterKey(paths.masterKeyPath, { allowPrivateParent: true }), source: "file" };
}
function localPaths(args: ParsedCliArgs): LocalPaths {
  return resolveLocalPaths(stringValue(args.values, "data-dir"), stringValue(args.values, "db"), stringValue(args.values, "master-key-file"));
}
function installDirectory(): string {
  const explicit = process.env["SEARCH_HUB_INSTALL_DIR"];
  if (explicit) return resolve(explicit);
  const candidates = [process.cwd(), dirname(process.execPath)];
  return candidates.find((candidate) => existsSync(join(candidate, "apps", "api", "dist", "server.mjs")) || existsSync(join(candidate, "app", "server.mjs"))) ?? candidates[0] ?? process.cwd();
}
function redact(value: string, paths: readonly string[] = []): string {
  let result = value;
  for (const path of paths) if (path) result = result.split(path).join("[redacted-path]");
  result = result.split(process.cwd()).join("[redacted-path]");
  result = result.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, "[redacted-path]");
  for (const secret of [process.env["SEARCH_HUB_ENCRYPTION_KEY"], process.env["SEARCH_HUB_BACKUP_PASSPHRASE"]]) {
    if (secret) result = result.split(secret).join("[redacted-secret]");
  }
  return result;
}
function safeReport(report: OperationReport, paths: readonly string[]): OperationReport {
  return { ...report, ...(report.reason ? { reason: redact(report.reason, paths) } : {}),
    ...(report.verification?.reason ? { verification: { ...report.verification, reason: redact(report.verification.reason, paths) } } : {}) };
}
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await openPrivateFile(temporary);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await publishNoOverwrite(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
function resourceReport(started: number): Pick<OperationReport, "startedAt" | "durationMs" | "peakRssBytes" | "temporaryDiskBytes"> {
  return { startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, peakRssBytes: process.resourceUsage().maxRSS * 1024, temporaryDiskBytes: 0 };
}

/** Creates a consistent local snapshot and a fully verified complete package. */
export async function runBackupCreate(args: ParsedCliArgs, format: OutputFormat): Promise<number> {
  const started = Date.now();
  const paths = localPaths(args);
  const outputValue = stringValue(args.values, "output");
  if (!outputValue) throw usageError("usage: shub backup create --output <file.shbackup> [--db <file>] [--passphrase-stdin]");
  const output = resolve(outputValue);
  if (!output.toLowerCase().endsWith(".shbackup")) throw usageError("--output must name a .shbackup file");
  if (existsSync(output) || existsSync(`${output}.json`) || existsSync(`${output}.report.json`)) throw new Error("Backup output or sidecar already exists; refusing to overwrite it");
  const passphrase = await passphraseFrom(args);
  const key = await currentKey(paths);
  await assertNoReparseAncestors(paths.dbPath);
  const sourceInfo = await lstat(paths.dbPath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Source database must be a regular file, not a link or special file");
  if (sourceInfo.size > DEFAULT_TAR_LIMITS.maxDatabaseBytes) throw new Error(`Source database exceeds the ${DEFAULT_TAR_LIMITS.maxDatabaseBytes}-byte safety limit`);
  const created = await createBackupPackage({
    snapshotAdapter: {
      createSnapshot: async (destinationPath) => {
        await createNodeSqliteSnapshot(paths.dbPath, destinationPath);
        return { method: "vacuum_into", walCheckpointed: true };
      },
      openDatabase: openNodeSqlite,
    },
    masterKeyValue: key.key, outputPath: output, passphrase, appVersion: CLI_VERSION,
    migrations: listLocalMigrations(), keySource: key.source, dataDir: paths.dataDir,
    installDir: installDirectory(), openDatabase: openNodeSqlite,
  });
  try {
    const verification = await verifyDatabaseBackup({
      path: output, passphrase, expectedMasterKey: key.key, appVersion: CLI_VERSION,
      knownMigrations: listLocalMigrations(), openDatabase: openNodeSqlite,
    });
    if (!verification.restoreReadiness) throw new Error("Generated package failed post-write verification");
    const report: OperationReport = { operation: "create", result: "ok", ...resourceReport(started), verification, output: basename(output) };
    await writePrivateJson(`${output}.report.json`, report);
    await writePrivateJson(`${output}.json`, {
      createdAt: new Date().toISOString(), bytes: created.bytes, sha256: created.sha256,
      keyFingerprint: created.manifest.key.fingerprint, verified: verification.restoreReadiness,
      restoreReadiness: verification.restoreReadiness, manifest: created.manifest, report,
    });
    emit(report, format);
    return 0;
  } catch (error) {
    await Promise.all([output, `${output}.json`, `${output}.report.json`].map((path) => rm(path, { force: true }).catch(() => undefined)));
    throw error;
  }
}

/** Streams offline verification for complete packages and explicitly selected legacy DBs. */
export async function runBackupVerify(args: ParsedCliArgs, format: OutputFormat): Promise<number> {
  const started = Date.now();
  const sourceValue = args.positionals[2];
  if (!sourceValue) throw usageError("usage: shub backup verify <file.shbackup|file.db> [--legacy] [--passphrase-stdin]");
  const source = resolve(sourceValue);
  const isPackage = source.toLowerCase().endsWith(".shbackup");
  if (isPackage && args.values["legacy"] === true) throw usageError("--legacy cannot be used with a .shbackup package");
  if (!isPackage && args.values["legacy"] !== true) throw usageError("Use --legacy to verify a plain SQLite database");
  const paths = localPaths(args);
  const passphrase = isPackage ? await passphraseFrom(args) : undefined;
  let expectedMasterKey: Buffer | undefined;
  try { expectedMasterKey = (await currentKey(paths)).key; } catch { /* legacy missing-key is a reported non-zero result */ }
  const report = await verifyDatabaseBackup({
    path: source, ...(passphrase ? { passphrase } : {}), ...(expectedMasterKey ? { expectedMasterKey } : {}),
    appVersion: CLI_VERSION, knownMigrations: listLocalMigrations(), openDatabase: openNodeSqlite,
  });
  const legacyUsable = !isPackage && report.structuralOk && report.schemaCompatible && report.keyReadiness === "unverified";
  const output: OperationReport = {
    operation: "verify", result: report.restoreReadiness || legacyUsable ? "ok" : "failed",
    ...resourceReport(started), verification: report,
  };
  const reportPath = stringValue(args.values, "report");
  if (reportPath) await writePrivateJson(resolve(reportPath), output);
  emit(safeReport(output, [source, paths.dataDir, paths.dbPath, paths.masterKeyPath]), format);
  return output.result === "ok" ? 0 : 1;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen()); });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a dynamic health-check port");
  return address.port;
}
function serverEntry(installDir: string): string {
  const explicit = process.env["SEARCH_HUB_APP_ENTRY"];
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) throw new Error("SEARCH_HUB_APP_ENTRY does not name a real Search Hub server entry");
    return resolved;
  }
  const candidates = [
    join(installDir, "app", "server.mjs"),
    join(installDir, "app", "apps", "api", "dist", "server.mjs"),
    join(installDir, "apps", "api", "dist", "server.mjs"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Could not locate the real Search Hub server entry for --start-check");
  return found;
}
export function bundledRuntime(
  installDir: string,
  platform: NodeJS.Platform = process.platform,
  executablePath: string = process.execPath,
): string {
  const explicit = process.env["SEARCH_HUB_START_CHECK_NODE"];
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) throw new Error("SEARCH_HUB_START_CHECK_NODE does not name a real Node runtime");
    return resolved;
  }
  const bundledCandidates = platform === "win32"
    ? [join(installDir, "runtime", "node.exe"), join(installDir, "node.exe")]
    : [join(installDir, "runtime", "bin", "node"), join(installDir, "runtime", "node"), join(installDir, "node")];
  const bundled = bundledCandidates.find((candidate) => existsSync(candidate));
  if (bundled) return bundled;
  if (/^node(?:\.exe)?$/i.test(basename(executablePath))) return executablePath;
  throw new Error("Bundled Node runtime is required for --start-check; refusing to spawn the SEA executable");
}
async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
  timeout.unref();
  await exited;
  clearTimeout(timeout);
}
async function startCheck(paths: LocalPaths): Promise<void> {
  const installDir = installDirectory();
  const runtime = bundledRuntime(installDir);
  const entry = serverEntry(installDir);
  const port = await freePort();
  const child = spawn(runtime, [entry], {
    env: { ...process.env, NODE_ENV: "test", SEARCH_HUB_DATA_DIR: paths.dataDir, SEARCH_HUB_DB_PATH: paths.dbPath,
      SEARCH_HUB_PORT: String(port), SEARCH_HUB_HOST: "127.0.0.1", SEARCH_HUB_ENCRYPTION_KEY: "", SEARCH_HUB_LOG_LEVEL: "silent",
      SEARCH_HUB_BACKUP_PASSPHRASE: "",
      ...(paths.migrationsDir && existsSync(paths.migrationsDir) ? { SEARCH_HUB_MIGRATIONS_DIR: paths.migrationsDir } : {}) },
    cwd: installDir, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    if (diagnostics.length >= 65_536) return;
    diagnostics += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  });
  let lastHealth = "";
  const diagnosticSuffix = (): string => {
    const detail = [diagnostics.trim().slice(-4000), lastHealth].filter(Boolean).join(" | ");
    return detail ? `: ${redact(detail, [paths.dataDir, paths.dbPath, paths.masterKeyPath])}` : "";
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Isolated Search Hub exited with code ${child.exitCode}${diagnosticSuffix()}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        const body = await response.text();
        lastHealth = `HTTP ${response.status} ${body.slice(0, 1000)}`;
        if (response.ok) {
          const health = JSON.parse(body) as { status?: string; version?: string };
          if (health.status === "ok" && health.version === CLI_VERSION) return;
        }
      } catch { /* poll the owned child until healthy or expired */ }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Isolated Search Hub health check timed out${diagnosticSuffix()}`);
  } finally { await stopOwnedChild(child); }
}
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function rollbackFailedStartCheck(target: string, originallyExisted: boolean, reason: string): Promise<void> {
  const quarantine = join(dirname(target), `.shbackup-failed-${Date.now()}-${randomBytes(6).toString("hex")}`);
  await rename(target, quarantine);
  try {
    if (originallyExisted) {
      await mkdir(target, { mode: 0o700 });
      if (process.platform === "win32") await restrictWindowsAcl(target, true);
    }
    const handle = await openPrivateFile(join(quarantine, "restore-journal.json"));
    try { await handle.writeFile(`${JSON.stringify({ operation: "restore", result: "rolled-back", reason: redact(reason), failedAt: new Date().toISOString() }, null, 2)}\n`, "utf8"); }
    finally { await handle.close(); }
  } catch (error) {
    await rename(quarantine, target).catch(() => undefined);
    throw error;
  }
}

/** Restore defaults to dry-run; only --apply may publish a target. */
export async function runBackupRestore(args: ParsedCliArgs, format: OutputFormat): Promise<number> {
  const started = Date.now();
  const sourceValue = args.positionals[2];
  const targetValue = stringValue(args.values, "data-dir");
  if (!sourceValue || !targetValue) throw usageError("usage: shub backup restore <file.shbackup> --data-dir <dir> [--apply] [--start-check]");
  if (args.values["dry-run"] === true && args.values["apply"] === true) throw usageError("--dry-run and --apply are mutually exclusive");
  const apply = args.values["apply"] === true;
  const source = resolve(sourceValue);
  const target = resolve(targetValue);
  if (!source.toLowerCase().endsWith(".shbackup") || args.values["legacy"] === true) throw usageError("restore only accepts a complete .shbackup package");
  if (args.values["start-check"] === true && !apply) throw usageError("--start-check requires --apply");
  const paths = resolveLocalPaths(target, stringValue(args.values, "db"), stringValue(args.values, "master-key-file"));
  const sourceDataDir = process.env["SEARCH_HUB_DATA_DIR"];
  const sourceInstallDir = process.env["SEARCH_HUB_INSTALL_DIR"];
  if (!sourceDataDir || !sourceInstallDir) throw usageError("Set SEARCH_HUB_DATA_DIR and SEARCH_HUB_INSTALL_DIR to the original source locations before restoring into --data-dir");
  const passphrase = await passphraseFrom(args);
  let expectedMasterKey: Buffer | undefined;
  try { expectedMasterKey = (await currentKey(paths)).key; } catch { /* the package's proven key is sufficient unless explicitly supplied */ }
  const originallyExisted = await pathExists(target);
  let startCheckResult: OperationReport["startCheck"] = "not-requested";
  let verification: BackupVerificationReport | undefined;
  try {
    const restored = await restoreBackupPackage({
      path: source, targetDir: target, sourceDataDir,
      sourceInstallDir, passphrase, apply,
      ...(expectedMasterKey ? { expectedMasterKey } : {}), openDatabase: openNodeSqlite,
      knownMigrations: listLocalMigrations(), appVersion: CLI_VERSION,
    });
    verification = restored.report;
    if (apply && args.values["start-check"] === true) {
      try { await startCheck(paths); startCheckResult = "ok"; }
      catch (error) {
        startCheckResult = "failed";
        const reason = error instanceof Error ? error.message : String(error);
        await rollbackFailedStartCheck(target, originallyExisted, reason);
        throw new Error(`Post-restore start-check failed; target was rolled back and the failed version was quarantined: ${redact(reason, [source, target, paths.dataDir])}`);
      }
    }
    const report: OperationReport = {
      operation: "restore", result: apply ? "ok" : "dry-run", ...resourceReport(started),
      verification, startCheck: startCheckResult,
    };
    const reportPath = stringValue(args.values, "report");
    if (reportPath) await writePrivateJson(resolve(reportPath), report);
    emit(report, format);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const report: OperationReport = { operation: "restore", result: "failed", ...resourceReport(started), ...(verification ? { verification } : {}), startCheck: startCheckResult, reason };
    const reportPath = stringValue(args.values, "report");
    if (reportPath) await writePrivateJson(resolve(reportPath), report).catch(() => undefined);
    throw new Error(redact(reason, [source, target, paths.dataDir, paths.dbPath, paths.masterKeyPath]));
  }
}

export async function runBackup(args: ParsedCliArgs, format: OutputFormat): Promise<number> {
  const action = args.positionals[1];
  if (action === "create") return runBackupCreate(args, format);
  if (action === "verify") return runBackupVerify(args, format);
  if (action === "restore") return runBackupRestore(args, format);
  throw usageError("usage: shub backup <create|verify|restore> ...");
}
