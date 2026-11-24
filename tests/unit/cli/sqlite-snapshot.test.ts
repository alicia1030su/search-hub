import { createHash } from "node:crypto";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSqliteSnapshot } from "../../../packages/cli/src/local/sqlite.js";

const directories: string[] = [];

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "search-hub-sqlite-snapshot-"));
  directories.push(directory);
  return directory;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function metadata(path: string): string {
  const info = statSync(path);
  return JSON.stringify({ size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, mode: info.mode });
}

function immutableDatabase(path: string): DatabaseSync {
  return new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CLI immutable SQLite snapshots", () => {
  it("snapshots a cleanly closed WAL database without source sidecars or metadata changes", async () => {
    const root = workspace();
    const source = join(root, "source.db");
    const destination = join(root, "snapshot.db");
    const writer = new DatabaseSync(source);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.prepare("INSERT INTO records (value) VALUES (?)").run("preserved");
    writer.close();

    expect(existsSync(`${source}-wal`)).toBe(false);
    expect(existsSync(`${source}-shm`)).toBe(false);
    expect(existsSync(`${source}-journal`)).toBe(false);
    const sourceBytes = digest(source);
    const sourceMetadata = metadata(source);

    await createNodeSqliteSnapshot(source, destination);

    expect(readdirSync(root).sort()).toEqual(["snapshot.db", "source.db"]);
    expect(digest(source)).toBe(sourceBytes);
    expect(metadata(source)).toBe(sourceMetadata);
    const snapshot = immutableDatabase(destination);
    try {
      expect(snapshot.prepare("SELECT value FROM records WHERE id = 1").get()).toEqual({ value: "preserved" });
    } finally { snapshot.close(); }
    if (process.platform !== "win32") expect(statSync(destination).mode & 0o777).toBe(0o600);
  });

  it("snapshots a clean DELETE-mode database successfully without changing the source", async () => {
    const root = workspace();
    const source = join(root, "source.db");
    const destination = join(root, "snapshot.db");
    const writer = new DatabaseSync(source);
    expect(writer.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.prepare("INSERT INTO records (value) VALUES (?)").run("delete-mode");
    writer.close();
    const sourceBytes = digest(source);
    const sourceMetadata = metadata(source);

    await createNodeSqliteSnapshot(source, destination);

    expect(readdirSync(root).sort()).toEqual(["snapshot.db", "source.db"]);
    expect(digest(source)).toBe(sourceBytes);
    expect(metadata(source)).toBe(sourceMetadata);
    const snapshot = immutableDatabase(destination);
    try {
      expect(snapshot.prepare("SELECT value FROM records WHERE id = 1").get()).toEqual({ value: "delete-mode" });
    } finally { snapshot.close(); }
  });

  it("snapshots live WAL-resident data without changing or deleting source files", async () => {
    const root = workspace();
    const source = join(root, "source.db");
    const destination = join(root, "snapshot.db");
    const writer = new DatabaseSync(source);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.prepare("INSERT INTO records (value) VALUES (?)").run("wal-resident");
    const walPath = `${source}-wal`;
    const shmPath = `${source}-shm`;
    expect(statSync(walPath).size).toBeGreaterThan(0);
    const sourceBytes = digest(source);
    const sourceMetadata = metadata(source);

    try {
      await createNodeSqliteSnapshot(source, destination);

      const snapshot = immutableDatabase(destination);
      try {
        expect(snapshot.prepare("SELECT value FROM records WHERE id = 1").get()).toEqual({ value: "wal-resident" });
      } finally { snapshot.close(); }
      expect(digest(source)).toBe(sourceBytes);
      expect(metadata(source)).toBe(sourceMetadata);
      expect(existsSync(walPath)).toBe(true);
      expect(existsSync(shmPath)).toBe(true);
      expect(existsSync(`${source}-journal`)).toBe(false);
      expect(readdirSync(root).sort()).toEqual(["snapshot.db", "source.db", "source.db-shm", "source.db-wal"]);
    } finally { writer.close(); }
  });

  it("rejects a non-empty rollback journal without changing source or journal bytes", async () => {
    const root = workspace();
    const source = join(root, "source.db");
    const destination = join(root, "snapshot.db");
    const writer = new DatabaseSync(source);
    writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.prepare("INSERT INTO records (value) VALUES (?)").run("rollback-journal");
    writer.close();
    const journalPath = `${source}-journal`;
    writeFileSync(journalPath, Buffer.from("uncheckpointed rollback journal"));
    const before = new Map([source, journalPath].map((path) => [path, { bytes: digest(path), metadata: metadata(path) }]));

    await expect(createNodeSqliteSnapshot(source, destination)).rejects.toThrow(/non-empty rollback journal.*stop Search Hub.*checkpoint/i);
    expect(existsSync(destination)).toBe(false);
    for (const [path, expected] of before) {
      expect(digest(path)).toBe(expected.bytes);
      expect(metadata(path)).toBe(expected.metadata);
    }
  });

  it("rejects and removes the snapshot when source metadata changes during VACUUM", async () => {
    const root = workspace();
    const source = join(root, "source.db");
    const destination = join(root, "snapshot.db");
    const writer = new DatabaseSync(source);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.prepare("INSERT INTO records (value) VALUES (?)").run("before");
    writer.close();

    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation((function (this: DatabaseSync, sql: string) {
      if (sql === "VACUUM INTO ?") {
        const mutation = new DatabaseSync(source);
        try {
          mutation.prepare("INSERT INTO records (value) VALUES (?)").run("during-snapshot");
        } finally { mutation.close(); }
      }
      return originalPrepare.call(this, sql);
    }) as typeof DatabaseSync.prototype.prepare);

    await expect(createNodeSqliteSnapshot(source, destination)).rejects.toThrow(/metadata changed during snapshot/i);
    expect(existsSync(destination)).toBe(false);
    prepare.mockRestore();
  });

  it("preserves existing empty WAL and rollback journal sidecars without deleting or changing them", async () => {
    const root = workspace();
    const source = join(root, "source.db");
    const destination = join(root, "snapshot.db");
    const writer = new DatabaseSync(source);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.prepare("INSERT INTO records (value) VALUES (?)").run("clean");
    writer.close();
    const walPath = `${source}-wal`;
    const journalPath = `${source}-journal`;
    writeFileSync(walPath, Buffer.alloc(0));
    writeFileSync(journalPath, Buffer.alloc(0));
    const beforeWal = metadata(walPath);
    const beforeJournal = metadata(journalPath);

    await createNodeSqliteSnapshot(source, destination);

    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBe(0);
    expect(metadata(walPath)).toBe(beforeWal);
    expect(existsSync(journalPath)).toBe(true);
    expect(statSync(journalPath).size).toBe(0);
    expect(metadata(journalPath)).toBe(beforeJournal);
    expect(readdirSync(root).sort()).toEqual(["snapshot.db", "source.db", "source.db-journal", "source.db-wal"]);
  });
});
