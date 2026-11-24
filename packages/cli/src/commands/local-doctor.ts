import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { inspectSnapshotDatabase, masterKeyFingerprint, parseMasterKey, readMasterKey } from "@search-hub/backup";
import type { ParsedCliArgs } from "../args.js";
import { stringValue } from "../args.js";
import { listLocalMigrations, resolveLocalPaths } from "../local/index.js";
import { openNodeSqlite } from "../local/sqlite.js";
import { table, writeJson, writeText, type OutputFormat } from "../output/index.js";
import { CLI_VERSION } from "../version.js";

const execFileAsync = promisify(execFile);

interface LocalCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function permissionCheck(path: string): Promise<LocalCheck> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { name: "permissions", ok: false, detail: "data directory is a symlink" };
    if (process.platform === "win32") {
      const result = await execFileAsync("icacls.exe", [path], { windowsHide: true });
      const normalized = result.stdout.toLowerCase();
      const inherited = normalized.split(/\r?\n/).some((line) => line.includes("(i)"));
      return { name: "permissions", ok: !inherited, detail: inherited ? "inherited ACL entries found" : "explicit ACL entries present" };
    }
    const exposed = info.mode & 0o077;
    return { name: "permissions", ok: exposed === 0, detail: `mode=${(info.mode & 0o777).toString(8)}` };
  } catch (error) {
    return { name: "permissions", ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Offline diagnostics for the local database, key, backup and updater layout. */
export async function runLocalDoctor(args: ParsedCliArgs, format: OutputFormat): Promise<number> {
  const paths = resolveLocalPaths(stringValue(args.values, "data-dir"), stringValue(args.values, "db"), stringValue(args.values, "master-key-file"));
  const checks: LocalCheck[] = [];
  checks.push({ name: "dataDir", ok: existsSync(paths.dataDir), detail: existsSync(paths.dataDir) ? "configured directory present" : "configured directory missing" });
  checks.push({ name: "dbPath", ok: existsSync(paths.dbPath), detail: existsSync(paths.dbPath) ? "configured database present" : "configured database missing" });
  checks.push(await permissionCheck(paths.dataDir));

  let key: Buffer | null = null;
  try {
    key = process.env["SEARCH_HUB_ENCRYPTION_KEY"]?.trim()
      ? parseMasterKey(process.env["SEARCH_HUB_ENCRYPTION_KEY"] ?? "")
      : await readMasterKey(paths.masterKeyPath);
    checks.push({ name: "master_key", ok: true, detail: `available (${process.env["SEARCH_HUB_ENCRYPTION_KEY"]?.trim() ? "env" : "file"}), fingerprint ${masterKeyFingerprint(key).slice(0, 12)}…` });
  } catch (error) {
    checks.push({ name: "master_key", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  const migrations = listLocalMigrations(paths.migrationsDir);
  if (existsSync(paths.dbPath)) {
    const inspection = inspectSnapshotDatabase(paths.dbPath, openNodeSqlite, key);
    checks.push({ name: "database", ok: inspection.integrityOk && inspection.foreignKeysOk, detail: inspection.integrityDetail });
    checks.push({ name: "schema", ok: inspection.requiredSchemaOk && inspection.migrations.length === migrations.length, detail: `${inspection.migrations.length}/${migrations.length} migrations, user_version=${inspection.userVersion}` });
    checks.push({ name: "ciphertext_samples", ok: inspection.ciphertextSampleDecryptable !== false, detail: key ? `${inspection.apiKeySamples + inspection.modelSamples} sample(s) checked` : "not checked; key missing" });
    try {
      const db = openNodeSqlite(paths.dbPath, true);
      try {
        const count = (sql: string): number => Number((db.prepare(sql).get() as { count?: number } | undefined)?.count ?? 0);
        checks.push({ name: "cache", ok: true, detail: `${count("SELECT COUNT(*) AS count FROM search_cache")} entries, ${count("SELECT COALESCE(SUM(size_bytes), 0) AS count FROM search_cache")} bytes` });
        checks.push({ name: "content", ok: true, detail: `${count("SELECT COUNT(*) AS count FROM admin_users")} admins, ${count("SELECT COUNT(*) AS count FROM provider_instances")} providers, ${count("SELECT COUNT(*) AS count FROM api_keys")} keys` });
      } finally {
        db.close();
      }
    } catch (error) {
      checks.push({ name: "cache", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  } else {
    checks.push({ name: "database", ok: false, detail: "database file not found" });
    checks.push({ name: "schema", ok: false, detail: "not checked" });
  }

  const walBytes = await fileBytes(`${paths.dbPath}-wal`);
  checks.push({ name: "wal", ok: true, detail: `${walBytes} bytes` });
  try {
    const diskPath = existsSync(paths.dataDir) ? paths.dataDir : dirname(paths.dataDir);
    const disk = await statfs(diskPath);
    const available = Number(disk.bavail) * Number(disk.bsize);
    checks.push({ name: "disk", ok: available > 256 * 1024 * 1024, detail: `${Math.round(available / (1024 * 1024))} MiB available` });
  } catch (error) {
    checks.push({ name: "disk", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    const backupDir = join(paths.dataDir, "backups");
    const sidecars = (await readdir(backupDir)).filter((name) => name.endsWith(".shbackup.json")).sort().reverse();
    if (sidecars.length === 0) {
      checks.push({ name: "backup", ok: false, detail: "no verified complete backup found" });
    } else {
      const sidecar = JSON.parse(await readFile(join(backupDir, sidecars[0] ?? ""), "utf8")) as { verified?: boolean; keyFingerprint?: string; time?: string; file?: string; restoreReadiness?: boolean };
      const packageName = sidecar.file;
      const packagePresent = typeof packageName === "string" && packageName === packageName.split(/[\\/]/).pop() && packageName.endsWith(".shbackup") && existsSync(join(backupDir, packageName));
      const matches = Boolean(key && sidecar.keyFingerprint === masterKeyFingerprint(key));
      checks.push({ name: "backup", ok: packagePresent && sidecar.verified === true && sidecar.restoreReadiness === true && matches, detail: packagePresent ? `${sidecar.time ?? "unknown"}; package present; key ${matches ? "matches" : "missing/mismatch"}` : "sidecar has no corresponding complete package" });
    }
  } catch {
    checks.push({ name: "backup", ok: false, detail: "no verified complete backup found" });
  }

  const launcher = join(dirname(paths.dataDir), "launcher.json");
  const updaterInstalled = existsSync(launcher);
  checks.push({ name: "updater", ok: true, detail: updaterInstalled ? "launcher manifest present" : "source/local mode (no system launcher)" });
  checks.push({ name: "version", ok: true, detail: `shub ${CLI_VERSION}; backup compatibility 0.1.14–${CLI_VERSION}` });
  const ok = checks.every((check) => check.ok);
  const safeChecks = checks.map((check) => ({
    ...check,
    detail: check.detail.split(paths.dataDir).join("[redacted-path]").split(paths.dbPath).join("[redacted-path]")
      .split(paths.masterKeyPath).join("[redacted-path]").replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, "[redacted-path]"),
  }));
  const output = { ok, cliVersion: CLI_VERSION, checks: safeChecks };
  if (format === "json") writeJson(output);
  else if (format === "ndjson") writeJson({ type: "doctor-local", ...output });
  else writeText(table(["Check", "OK", "Detail"], safeChecks.map((check) => [check.name, check.ok, check.detail])));
  return ok ? 0 : 1;
}
