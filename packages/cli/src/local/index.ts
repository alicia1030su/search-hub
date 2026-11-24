import { existsSync, readdirSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EMBEDDED_MIGRATIONS } from "@search-hub/backup";
import { usageError } from "../errors/index.js";

/** Removes only old, explicitly-owned maintenance directories after a crash. */
export async function pruneStaleWorkDirectories(parent: string): Promise<number> {
  let names: string[] = [];
  try { names = await readdir(parent); } catch { return 0; }
  const cutoff = Date.now() - 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(".shub-backup-work-") && !name.startsWith(".shub-restore-work-") && !name.startsWith(".shub-restore-ready-") && !name.startsWith(".shbackup-restore-")) continue;
    const path = join(parent, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch { /* another live request may own it */ }
  }
  return removed;
}

/** SEA and local CLI use the same embedded ordered migration contract. */
export function listLocalMigrations(_directory?: string): string[] {
  return EMBEDDED_MIGRATIONS.map((migration) => migration.name);
}

export interface LocalPaths { dataDir: string; dbPath: string; masterKeyPath: string; migrationsDir: string }

/** Resolves paths without creating or modifying anything. */
export function resolveLocalPaths(dataDirOverride?: string, dbPathOverride?: string, masterKeyOverride?: string): LocalPaths {
  const dataDir = resolve(dataDirOverride ?? process.env["SEARCH_HUB_DATA_DIR"] ?? join(process.cwd(), "data"));
  const dbPath = resolve(dbPathOverride ?? process.env["SEARCH_HUB_DB_PATH"] ?? join(dataDir, "search-hub.db"));
  const configuredMigrations = process.env["SEARCH_HUB_MIGRATIONS_DIR"];
  const installDir = process.env["SEARCH_HUB_INSTALL_DIR"] ? resolve(process.env["SEARCH_HUB_INSTALL_DIR"]) : dirname(process.execPath);
  const entryDirectory = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd();
  const candidates = [
    configuredMigrations,
    join(installDir, "packages", "db", "migrations"),
    join(installDir, "app", "packages", "db", "migrations"),
    join(entryDirectory, "..", "..", "..", "db", "migrations"),
    join(entryDirectory, "..", "packages", "db", "migrations"),
    join(process.cwd(), "packages", "db", "migrations"),
    join(process.cwd(), "app", "migrations"),
    join(homedir(), ".search-hub", "migrations"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const migrationsDir = candidates.find((candidate) => existsSync(candidate) && readdirSync(candidate).some((name) => name.endsWith(".sql"))) ?? candidates[0] ?? "";
  return { dataDir, dbPath, masterKeyPath: resolve(masterKeyOverride ?? join(dataDir, "master.key")), migrationsDir };
}

async function hiddenTtyPassphrase(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") throw usageError("--passphrase-stdin requires piped input or an interactive TTY");
  process.stderr.write("Backup passphrase: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveInput, reject) => {
    const value: number[] = [];
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer | string): void => {
      for (const byte of Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) {
        if (byte === 3) { cleanup(); reject(new Error("Passphrase input cancelled")); return; }
        if (byte === 13 || byte === 10) { cleanup(); resolveInput(Buffer.from(value).toString("utf8")); return; }
        if (byte === 127 || byte === 8) { value.pop(); continue; }
        value.push(byte);
        if (value.length > 16_384) { cleanup(); reject(new Error("Passphrase input exceeds the safety limit")); return; }
      }
    };
    process.stdin.on("data", onData);
  });
}

/** Reads the exact passphrase from the new env var or stdin; never from argv. */
export async function resolveBackupPassphrase(useStdin: boolean, required = true): Promise<string | undefined> {
  const fromEnv = process.env["SEARCH_HUB_BACKUP_PASSPHRASE"];
  if (fromEnv !== undefined) return fromEnv;
  if (!useStdin) {
    if (required) throw usageError("A backup passphrase is required via --passphrase-stdin or SEARCH_HUB_BACKUP_PASSPHRASE");
    return undefined;
  }
  if (process.stdin.isTTY) return hiddenTtyPassphrase();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Passphrase input exceeds the safety limit");
    chunks.push(buffer);
  }
  const passphrase = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!passphrase) throw usageError("--passphrase-stdin received no passphrase");
  return passphrase;
}
