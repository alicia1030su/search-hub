import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  verifyStagedFile,
  // @ts-expect-error -- the updater is a plain .mjs script without declarations
} from "../../packaging/launcher/updater-core.mjs";

/**
 * The updater is the only component that replaces files under a live install, so
 * every refusal path gets a test. A permissive updater is worse than no updater:
 * it can leave the user with no working program.
 */
let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-updater-"));
  return dir;
};

function fixtureDatabase(path: string, userVersion = 3): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO fixture(value) VALUES ('preserved');");
    db.exec(`PRAGMA user_version = ${Number.isInteger(userVersion) && userVersion >= 0 ? userVersion : 0}`);
  } finally {
    db.close();
  }
}

describe("archive safety", () => {
  it("rejects traversal, absolute and drive-qualified entries", () => {
    expect(() => assertSafeEntry("../etc/passwd")).toThrow(UpdateError);
    expect(() => assertSafeEntry("app/../../escape")).toThrow(/escapes/);
    expect(() => assertSafeEntry("/etc/passwd")).toThrow(/absolute/);
    expect(() => assertSafeEntry("C:\\Windows\\system32")).toThrow(/backslash|drive-qualified/);
    expect(() => assertSafeEntry("")).toThrow(/empty/);
  });

  it("accepts canonical relative entries and rejects backslash variants", () => {
    expect(assertSafeEntry("app/apps/api/dist/server.mjs")).toBe("app/apps/api/dist/server.mjs");
    expect(() => assertSafeEntry("app\\runtime\\node.exe")).toThrow(/backslash/);
  });

  it("detects a file that escaped the extracted tree", () => {
    const root = tmp();
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "app", "ok.txt"), "x");
    expect(() => assertTreeContained(join(root, "app"))).not.toThrow();
  });
});

describe("version and architecture guards", () => {
  it("allows a forward version and blocks a downgrade", () => {
    expect(() => assertUpgrade("0.1.5-beta.2", "0.1.5-beta.3")).not.toThrow();
    expect(() => assertUpgrade("0.2.0", "0.1.5")).toThrow(/downgrades/);
    expect(() => assertUpgrade("0.1.5-beta.2", "0.1.5-beta.2")).toThrow(/already installed/);
  });

  it("orders numeric prerelease identifiers and blocks prereleases over stable", () => {
    expect(() => assertUpgrade("0.2.0", "0.2.1-beta.1")).not.toThrow();
    expect(() => assertUpgrade("0.2.0", "0.2.0-beta.2")).toThrow(/prerelease/);
    expect(() => assertUpgrade("0.2.0-beta.2", "0.2.0-beta.10")).not.toThrow();
    expect(() => assertUpgrade("0.2.0-beta.10", "0.2.0-beta.2")).toThrow(/downgrades/);
  });

  it("refuses an asset for the wrong OS or architecture", () => {
    expect(() =>
      assertArchMatches("search-hub-v0.1.5-windows-x64.zip", "win32", "x64"),
    ).not.toThrow();
    expect(() => assertArchMatches("search-hub-v0.1.5-linux-arm64.tar.gz", "linux", "x64")).toThrow(
      /exact linux\/x64/,
    );
    expect(() => assertArchMatches("search-hub-v0.1.5-linux-x64.tar.gz", "win32", "x64")).toThrow(
      /exact windows\/x64/,
    );
  });
});

describe("staged package verification", () => {
  it("accepts a file matching the published digest", () => {
    const root = tmp();
    const file = join(root, "pkg.zip");
    writeFileSync(file, "payload");
    // sha256("payload")
    const digest = "239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5";
    expect(verifyStagedFile(file, digest, 7)).toBe(digest);
  });

  it("rejects a size mismatch before hashing", () => {
    const root = tmp();
    const file = join(root, "pkg.zip");
    writeFileSync(file, "payload");
    expect(() => verifyStagedFile(file, "irrelevant", 999)).toThrow(/expected 999/);
  });

  it("rejects a digest mismatch and a missing file", () => {
    const root = tmp();
    const file = join(root, "pkg.zip");
    writeFileSync(file, "payload");
    expect(() => verifyStagedFile(file, "0".repeat(64), 7)).toThrow(/hashes to/);
    expect(() => verifyStagedFile(join(root, "nope.zip"), "x", 1)).toThrow(/not found/);
  });
});

describe("backup and install", () => {
  it("backs up the database and the master key together", () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const appDir = join(root, "app");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(appDir, "apps"), { recursive: true });
    fixtureDatabase(join(dataDir, "search-hub.db"), 3);
    writeFileSync(join(dataDir, "master.key"), "fake-key");
    writeFileSync(join(appDir, "apps", "server.mjs"), "old");

    const { path, manifest } = backupCurrent({
      dataDir,
      appDir,
      backupRoot: join(root, "backups"),
      stamp: "2026-11-16T00:00:00.000Z",
    });
    expect(existsSync(join(path, "data", "search-hub.db"))).toBe(true);
    // Without master.key the restored database cannot decrypt stored API keys.
    expect(existsSync(join(path, "data", "master.key"))).toBe(true);
    expect(existsSync(join(path, "app", "apps", "server.mjs"))).toBe(true);
    expect(manifest.files).toContain("master.key");
    expect(manifest.snapshot.method).toBe("vacuum_into");
  });

  it("keeps the old program aside so a rollback needs no download", () => {
    const root = tmp();
    const appDir = join(root, "app");
    const staged = join(root, "staged");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(appDir, "marker.txt"), "old");
    writeFileSync(join(staged, "marker.txt"), "new");

    const { previous } = installProgram({ stagingDir: staged, appDir, stamp: 1 });
    expect(readFileSync(join(appDir, "marker.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(previous, "marker.txt"), "utf8")).toBe("old");

    rollbackProgram({ appDir, previous });
    expect(readFileSync(join(appDir, "marker.txt"), "utf8")).toBe("old");
  });

  it("refuses to install from a missing staging directory", () => {
    const root = tmp();
    expect(() => installProgram({ stagingDir: join(root, "nope"), appDir: join(root, "app") })).toThrow(
      /not found/,
    );
  });
});

describe("rollback safety", () => {
  it("allows a program-only rollback when the schema did not move", () => {
    expect(planRollback({ schemaBefore: 3, schemaAfter: 3, hasDataBackup: false })).toMatchObject({
      strategy: "program_only",
      safe: true,
    });
  });

  it("requires the pre-update backup when the schema moved forward", () => {
    expect(planRollback({ schemaBefore: 3, schemaAfter: 4, hasDataBackup: true })).toMatchObject({
      strategy: "restore_backup",
      safe: true,
    });
  });

  it("refuses an unsafe rollback when the schema moved and no backup exists", () => {
    const plan = planRollback({ schemaBefore: 3, schemaAfter: 4, hasDataBackup: false });
    expect(plan.safe).toBe(false);
    expect(plan.strategy).toBe("blocked");
    expect(plan.reason).toContain("refusing an unsafe rollback");
  });

  it("uses the consistent backup when the schema version cannot be read", () => {
    expect(planRollback({ schemaBefore: null, schemaAfter: 4, hasDataBackup: true })).toMatchObject({
      strategy: "restore_backup",
      safe: true,
    });
  });

  it("exchanges the complete data directory and retains the failed tree", () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const dbPath = join(dataDir, "search-hub.db");
    mkdirSync(dataDir, { recursive: true });
    fixtureDatabase(dbPath, 3);
    const backupPath = join(root, "backup");
    mkdirSync(join(backupPath, "data"), { recursive: true });
    fixtureDatabase(join(backupPath, "data", "search-hub.db"), 2);
    writeFileSync(join(backupPath, "data", "master.key"), "old-key");
    writeFileSync(
      join(backupPath, "backup.json"),
      JSON.stringify({ dataDir, dbPath, dbInsideDataDir: true, files: ["search-hub.db", "master.key"] }),
      "utf8",
    );
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("PRAGMA user_version = 9").run();
      db.prepare("INSERT INTO fixture(value) VALUES ('failed-write')").run();
    } finally {
      db.close();
    }

    const result = restoreData({ backupPath, dataDir, dbPath });
    const restored = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(restored.prepare("SELECT value FROM fixture").all()).toEqual([{ value: "preserved" }]);
    } finally {
      restored.close();
    }
    expect(readFileSync(join(dataDir, "master.key"), "utf8")).toBe("old-key");
    expect(existsSync(result.failed)).toBe(true);
  });

  it("backs up and restores a custom database path outside the data directory", () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const dbPath = join(root, "external", "custom.sqlite");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dirname(dbPath), { recursive: true });
    fixtureDatabase(dbPath, 3);
    writeFileSync(join(dataDir, "master.key"), "old-key");
    const backup = backupCurrent({ dataDir, dbPath, backupRoot: join(root, "backups"), stamp: "2026-11-16T00:00:00.000Z" });
    const changed = new DatabaseSync(dbPath);
    try {
      changed.exec("PRAGMA user_version = 9; INSERT INTO fixture(value) VALUES ('failed-write');");
    } finally {
      changed.close();
    }

    restoreData({ backupPath: backup.path, dataDir, dbPath });
    const restored = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(restored.prepare("SELECT value FROM fixture").all()).toEqual([{ value: "preserved" }]);
    } finally {
      restored.close();
    }
    expect(readFileSync(join(dataDir, "master.key"), "utf8")).toBe("old-key");
  });

  it("recovers an interrupted app swap from its journal", () => {
    const root = tmp();
    const appDir = join(root, "app");
    const previousApp = join(root, "app.rollback-1-2");
    mkdirSync(previousApp, { recursive: true });
    writeFileSync(join(previousApp, "marker"), "old");
    const journalPath = join(root, "transaction.json");
    writeFileSync(journalPath, JSON.stringify({
      phase: "app_swap_started",
      appDir,
      previousApp,
      dataDir: join(root, "data"),
      dbPath: join(root, "data", "search-hub.db"),
      backupPath: null,
    }));

    const recovered = recoverInterruptedUpdate(journalPath);
    expect(recovered?.phase).toBe("recovered");
    expect(readFileSync(join(appDir, "marker"), "utf8")).toBe("old");
  });

  it("reads the schema version from a real SQLite header", () => {
    const root = tmp();
    const dbPath = join(root, "fake.db");
    const header = Buffer.alloc(120);
    header.write("SQLite format 3\0", 0, "utf8");
    header.writeUInt32BE(7, 60);
    writeFileSync(dbPath, header);
    expect(readSchemaVersion(dbPath)).toBe(7);
  });

  it("returns null rather than a guess for a non-SQLite file", () => {
    const root = tmp();
    const path = join(root, "not.db");
    writeFileSync(path, "definitely not sqlite");
    expect(readSchemaVersion(path)).toBeNull();
  });
});
