import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, openDatabaseFile, runMigrations } from "@search-hub/db";
import { masterKeyFingerprint, restrictWindowsAcl } from "@search-hub/backup";
import { parseCliArgs } from "../../../packages/cli/src/args.js";
import { runBackup } from "../../../packages/cli/src/commands/backup.js";
import { runLocalDoctor } from "../../../packages/cli/src/commands/local-doctor.js";
import { resolveBackupPassphrase } from "../../../packages/cli/src/local/index.js";
import { SecretBox } from "../../../apps/api/src/security/crypto.js";

const directories: string[] = [];
const passphrase = "local cli backup passphrase 灾备";
const migrationsDir = join(process.cwd(), "packages", "db", "migrations");

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "search-hub-cli-backup-"));
  directories.push(directory);
  return directory;
}
async function fixture(): Promise<{ root: string; dataDir: string; dbPath: string; key: Buffer }> {
  const root = workspace();
  const dataDir = join(root, "data");
  const dbPath = join(dataDir, "search-hub.db");
  mkdirSync(dataDir, { recursive: true });
  const key = Buffer.alloc(32, 0x33);
  const handle = createDb({ file: dbPath });
  try {
    runMigrations(handle.sqlite, migrationsDir);
    const now = new Date().toISOString();
    const encrypted = SecretBox.fromKey(key).encrypt("synthetic-cli-secret");
    handle.sqlite.prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("prv_cli", "CLI fixture", "mock", now, now);
    handle.sqlite.prepare(`INSERT INTO api_keys
      (id, provider_id, label, key_ciphertext, key_iv, key_tag, key_version, key_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("key_cli", "prv_cli", "fixture", encrypted.ciphertext, encrypted.iv, encrypted.tag, 1, "syn…cret", now, now);
  } finally { handle.close(); }
  writeFileSync(join(dataDir, "master.key"), `${key.toString("hex")}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(dbPath, 0o600);
  if (process.platform === "win32") {
    await restrictWindowsAcl(dataDir, true);
    await restrictWindowsAcl(dbPath, false);
    await restrictWindowsAcl(join(dataDir, "master.key"), false);
  }
  return { root, dataDir, dbPath, key };
}
async function invoke(argv: string[]): Promise<{ code: number; output: string }> {
  let output = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
  try { return { code: await runBackup(parseCliArgs(argv), "json"), output }; }
  finally { write.mockRestore(); }
}

afterEach(() => {
  delete process.env.SEARCH_HUB_BACKUP_PASSPHRASE;
  delete process.env.SEARCH_HUB_ENCRYPTION_KEY;
  delete process.env.SEARCH_HUB_DATA_DIR;
  delete process.env.SEARCH_HUB_INSTALL_DIR;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("shub backup local maintenance", () => {
  it("creates, verifies, defaults to dry-run and restores only with --apply", async () => {
    const { root, dataDir, dbPath, key } = await fixture();
    const output = join(root, "fixture.shbackup");
    process.env.SEARCH_HUB_BACKUP_PASSPHRASE = passphrase;
    process.env.SEARCH_HUB_DATA_DIR = dataDir;
    process.env.SEARCH_HUB_INSTALL_DIR = process.cwd();
    const create = await invoke(["backup", "create", "--data-dir", dataDir, "--db", dbPath, "--master-key-file", join(dataDir, "master.key"), "--output", output]);
    expect(create.code).toBe(0);
    expect(JSON.parse(create.output).verification.restoreReadiness).toBe(true);
    expect(existsSync(`${output}.json`)).toBe(true);
    expect(existsSync(`${output}.report.json`)).toBe(true);
    expect(readFileSync(`${output}.report.json`, "utf8")).not.toContain(key.toString("hex"));
    expect(create.output).not.toContain(root);
    await expect(invoke(["backup", "create", "--data-dir", dataDir, "--db", dbPath, "--output", output])).rejects.toThrow(/already exists/i);

    const verifyReport = join(root, "verify-report.json");
    const verify = await invoke(["backup", "verify", output, "--data-dir", dataDir, "--report", verifyReport]);
    expect(verify.code).toBe(0);
    expect(JSON.parse(verify.output).verification.keyFingerprintMatch).toBe(true);
    expect(readFileSync(verifyReport, "utf8")).not.toContain(root);

    const target = join(root, "restored");
    const dryRun = await invoke(["backup", "restore", output, "--data-dir", target]);
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.output).result).toBe("dry-run");
    expect(existsSync(target)).toBe(false);

    const restore = await invoke(["backup", "restore", output, "--data-dir", target, "--apply"]);
    expect(restore.code).toBe(0);
    expect(existsSync(join(target, "search-hub.db"))).toBe(true);
    expect(existsSync(join(target, "master.key"))).toBe(true);
    expect(restore.output).not.toContain(key.toString("hex"));
    expect(restore.output).not.toContain(root);
    const db = openDatabaseFile(join(target, "search-hub.db"), { readonly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({ count: 1 }); } finally { db.close(); }
    await expect(invoke(["backup", "restore", output, "--data-dir", target, "--apply"])).rejects.toThrow(/not empty/i);
  }, 180_000);

  it("returns non-zero for legacy verification without a key", async () => {
    const { root, dbPath } = await fixture();
    const legacy = join(root, "legacy.db");
    writeFileSync(legacy, readFileSync(dbPath), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(legacy, 0o600);
    if (process.platform === "win32") await restrictWindowsAcl(legacy, false);
    const emptyDataDir = join(root, "empty"); mkdirSync(emptyDataDir);
    const result = await invoke(["backup", "verify", legacy, "--legacy", "--data-dir", emptyDataDir]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).verification.keyReadiness).toBe("missing");
    expect(JSON.parse(result.output).verification.restoreReadiness).toBe(false);
  });

  it("rejects removed password and db-path aliases", () => {
    expect(() => parseCliArgs(["backup", "verify", "backup.shbackup", "--password-stdin"])).toThrow();
    expect(() => parseCliArgs(["backup", "verify", "backup.shbackup", "--db-path", "old.db"])).toThrow();
  });

  it("reads interactive passphrases with raw mode and no echo", async () => {
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const rawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
    const setRawMode = vi.fn();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: setRawMode });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const pending = resolveBackupPassphrase(true);
      process.stdin.emit("data", Buffer.from(`${passphrase}\r`));
      await expect(pending).resolves.toBe(passphrase);
      expect(setRawMode).toHaveBeenNthCalledWith(1, true);
      expect(setRawMode).toHaveBeenNthCalledWith(2, false);
      expect(stderr).toHaveBeenCalledWith("Backup passphrase: ");
    } finally {
      stderr.mockRestore();
      if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor); else Reflect.deleteProperty(process.stdin, "isTTY");
      if (rawModeDescriptor) Object.defineProperty(process.stdin, "setRawMode", rawModeDescriptor); else Reflect.deleteProperty(process.stdin, "setRawMode");
    }
  });

  it("runs local doctor and requires the sidecar's package to exist", async () => {
    const { dataDir, dbPath, key } = await fixture();
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
    let code = 0;
    try { code = await runLocalDoctor(parseCliArgs(["doctor", "--local", "--data-dir", dataDir, "--db", dbPath, "--json"]), "json"); }
    finally { write.mockRestore(); }
    const report = JSON.parse(output);
    expect(code).toBe(1);
    expect(report.checks.map((check: { name: string }) => check.name)).toEqual(expect.arrayContaining(["dataDir", "dbPath", "database", "master_key", "cache", "wal", "disk", "permissions", "backup", "updater", "version"]));
    expect(output).not.toContain(key.toString("hex"));
    expect(output).not.toContain(dataDir);

    const backups = join(dataDir, "backups"); mkdirSync(backups);
    writeFileSync(join(backups, "missing.shbackup.json"), JSON.stringify({ verified: true, restoreReadiness: true, file: "missing.shbackup", keyFingerprint: "unknown" }));
    output = "";
    const second = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
    try { await runLocalDoctor(parseCliArgs(["doctor", "--local", "--data-dir", dataDir, "--db", dbPath, "--json"]), "json"); }
    finally { second.mockRestore(); }
    expect(JSON.parse(output).checks.find((check: { name: string }) => check.name === "backup").ok).toBe(false);

    writeFileSync(join(backups, "present.shbackup"), "synthetic package placeholder", { mode: 0o600 });
    writeFileSync(join(backups, "present.shbackup.json"), JSON.stringify({ verified: true, restoreReadiness: true, file: "present.shbackup", keyFingerprint: masterKeyFingerprint(key) }));
    output = "";
    const third = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
    try { await runLocalDoctor(parseCliArgs(["doctor", "--local", "--data-dir", dataDir, "--db", dbPath, "--json"]), "json"); }
    finally { third.mockRestore(); }
    expect(JSON.parse(output).checks.find((check: { name: string }) => check.name === "backup").ok).toBe(true);
  });

  it("rolls back and quarantines the failed version when start-check fails", async () => {
    const { root, dataDir, dbPath } = await fixture();
    const emptyInstall = join(root, "empty-install"); mkdirSync(emptyInstall);
    process.env.SEARCH_HUB_INSTALL_DIR = emptyInstall;
    process.env.SEARCH_HUB_DATA_DIR = dataDir;
    process.env.SEARCH_HUB_BACKUP_PASSPHRASE = passphrase;
    const output = join(root, "fixture.shbackup");
    expect((await invoke(["backup", "create", "--data-dir", dataDir, "--db", dbPath, "--output", output])).code).toBe(0);
    const target = join(root, "restored");
    await expect(invoke(["backup", "restore", output, "--data-dir", target, "--apply", "--start-check"])).rejects.toThrow(/rolled back.*quarantined/i);
    expect(existsSync(target)).toBe(false);
    const quarantines = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    const quarantine = quarantines.find((name) => name.startsWith(".shbackup-failed-"));
    expect(quarantine).toBeTruthy();
    expect(existsSync(join(root, quarantine ?? "", "search-hub.db"))).toBe(true);
    expect(existsSync(join(root, quarantine ?? "", "restore-journal.json"))).toBe(true);
  }, 180_000);

  it("rejects a wrong package passphrase without publishing a target", async () => {
    const { root, dataDir, dbPath } = await fixture();
    const output = join(root, "fixture.shbackup");
    process.env.SEARCH_HUB_BACKUP_PASSPHRASE = passphrase;
    process.env.SEARCH_HUB_DATA_DIR = dataDir;
    process.env.SEARCH_HUB_INSTALL_DIR = process.cwd();
    expect((await invoke(["backup", "create", "--data-dir", dataDir, "--db", dbPath, "--output", output])).code).toBe(0);
    process.env.SEARCH_HUB_BACKUP_PASSPHRASE = "a different strong passphrase";
    const target = join(root, "restored");
    await expect(invoke(["backup", "restore", output, "--data-dir", target, "--apply"])).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  }, 180_000);
});
