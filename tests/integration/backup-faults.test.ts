import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, resolveMigrationsDir, runMigrations } from "@search-hub/db";
import { openBuiltInSqlite, restrictWindowsAcl, sealSnapshotDatabase } from "../../packages/backup/src/index.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const preload = join(repoRoot, "tests/integration/fixtures/backup-fault-preload.cjs");
const runner = join(repoRoot, "tests/integration/fixtures/backup-fault-runner.mjs");
const tsx = import.meta.resolve("tsx");
const passphrase = "fault injection acceptance passphrase 灾备";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  temp: string;
  outputDir: string;
  sourceDataDir: string;
  sourceInstallDir: string;
  snapshotPath: string;
  configPath: string;
  sentinelPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "search-hub-backup-faults-"));
  directories.push(root);
  if (process.platform === "win32") await restrictWindowsAcl(root, true);
  const sourceDataDir = join(root, "source-data");
  const sourceInstallDir = join(root, "install");
  const temp = join(root, "temp");
  const outputDir = join(root, "output");
  for (const directory of [sourceDataDir, sourceInstallDir, temp, outputDir]) mkdirSync(directory, { recursive: true });
  const dbPath = join(sourceDataDir, "search-hub.db");
  const handle = createDb({ file: dbPath });
  const migrations = resolveMigrationsDir();
  runMigrations(handle.sqlite, migrations);
  const now = new Date().toISOString();
  handle.sqlite.prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("prv_fault", "Fault fixture", "mock", now, now);
  const knownMigrations = handle.sqlite.prepare("SELECT name FROM _migrations ORDER BY name").all().map((row) => String((row as { name: string }).name));
  handle.close();
  const snapshotPath = join(root, "snapshot.db");
  // createDatabaseSnapshot is already covered by R04; this fixture needs a real
  // sealed source for the package-layer crash points.
  copyFileSync(dbPath, snapshotPath);
  sealSnapshotDatabase(snapshotPath, openBuiltInSqlite);
  if (process.platform === "win32") await restrictWindowsAcl(snapshotPath, false);
  else chmodSync(snapshotPath, 0o600);
  const sentinelPath = join(outputDir, "sentinel");
  writeFileSync(sentinelPath, "do not change");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    operation: "create",
    snapshotPath,
    masterKeyHex: randomBytes(32).toString("hex"),
    passphrase,
    appVersion: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version,
    migrations: knownMigrations,
    sourceDataDir,
    sourceInstallDir,
  }));
  return { root, temp, outputDir, sourceDataDir, sourceInstallDir, snapshotPath, configPath, sentinelPath };
}

function runFault(configPath: string, work: Fixture, fault: string) {
  const marker = join(work.root, `${fault || "none"}.marker`);
  const result = spawnSync(process.execPath, ["--require", preload, "--import", tsx, runner, configPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEMP: work.temp,
      TMP: work.temp,
      TMPDIR: work.temp,
      SHUB_QA_FAULT: fault,
      SHUB_QA_FAULT_MARKER: marker,
    },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { result, marker };
}

function createConfig(work: Fixture, outputPath: string): string {
  const config = JSON.parse(readFileSync(work.configPath, "utf8"));
  config.outputPath = outputPath;
  const path = join(work.root, `${outputPath.split(/[\\/]/).at(-1)}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function restoreConfig(work: Fixture, packagePath: string, targetDir: string): string {
  const config = JSON.parse(readFileSync(work.configPath, "utf8"));
  Object.assign(config, { operation: "restore", packagePath, targetDir });
  const path = join(work.root, `${targetDir.split(/[\\/]/).at(-1)}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function productTempEntries(work: Fixture): string[] {
  return readdirSync(work.temp, { recursive: true })
    .map(String)
    .filter((entry) => !entry.split(/[\\/]/)[0]?.startsWith("tsx-"));
}

describe("backup package fault boundaries", () => {
  it("R23 returns non-zero on ENOSPC, removes temporary output and never publishes a final package", async () => {
    const work = await fixture();
    const outputPath = join(work.outputDir, "enospc.shbackup");
    const { result, marker } = runFault(createConfig(work, outputPath), work, "enospc");
    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(readFileSync(marker, "utf8").trim()).toBe("enospc");
    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(work.outputDir).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(productTempEntries(work)).toEqual([]);
    expect(readFileSync(work.sentinelPath, "utf8")).toBe("do not change");
  });

  it.each(["snapshot", "encrypt", "verify", "publish"])("R24 SIGKILL at %s leaves no final package and preserves sentinel", async (stage) => {
    const work = await fixture();
    const outputPath = join(work.outputDir, `${stage}.shbackup`);
    const { result, marker } = runFault(createConfig(work, outputPath), work, stage);
    if (process.platform === "win32") expect(result.status).not.toBe(0);
    else {
      expect(result.signal).toBe("SIGKILL");
      expect(result.status).toBeNull();
    }
    expect(readFileSync(marker, "utf8").trim()).toBe(stage);
    expect(existsSync(outputPath)).toBe(false);
    expect(readFileSync(work.sentinelPath, "utf8")).toBe("do not change");
  });

  // Each stage creates a base package and then restores it, including age(scrypt=18) work.
  it.each(["restore-extract", "restore-publish"])("R25 SIGKILL at %s never partially publishes the target", async (stage) => {
    const work = await fixture();
    const packagePath = join(work.outputDir, "base.shbackup");
    const created = runFault(createConfig(work, packagePath), work, "");
    expect(created.result.status, created.result.stderr).toBe(0);
    const targetDir = join(work.root, "restored");
    const { result, marker } = runFault(restoreConfig(work, packagePath, targetDir), work, stage);
    if (process.platform === "win32") expect(result.status).not.toBe(0);
    else {
      expect(result.signal).toBe("SIGKILL");
      expect(result.status).toBeNull();
    }
    expect(readFileSync(marker, "utf8").trim()).toBe(stage);
    if (existsSync(targetDir)) {
      expect(readdirSync(targetDir)).toEqual([]);
      expect(existsSync(join(targetDir, "search-hub.db"))).toBe(false);
    }
    expect(readFileSync(work.sentinelPath, "utf8")).toBe("do not change");
  }, 120_000);
});
