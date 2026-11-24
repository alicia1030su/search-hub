import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Encrypter } from "age-encryption";
import { createDb, listMigrations, openDatabaseFile, runMigrations } from "@search-hub/db";
import {
  assertNoReparseAncestors, assertPrivateWindowsAcl, createBackupPackage, createPrivateDirectory, fsyncDirectory, fsyncFile, masterKeyFingerprint, openPrivateFile,
  parseStrictJson, readAgeHeader, readMasterKey, readStrictTar, restrictWindowsAcl, sealSnapshotDatabase,
  validateBackupPassphrase, verifyBackupPackage, withBackupLock,
  DEFAULT_TAR_LIMITS, type SqliteHandle,
} from "@search-hub/backup";

const directories: string[] = [];
const passphrase = "correct horse battery staple 灾备";
const migrationsDir = join(process.cwd(), "packages", "db", "migrations");
const migrations = listMigrations(migrationsDir);

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "search-hub-backup-test-"));
  directories.push(directory);
  if (process.platform === "win32") await restrictWindowsAcl(directory, true);
  return directory;
}
async function secureFile(path: string): Promise<void> {
  await chmod(path, 0o600);
  if (process.platform === "win32") await restrictWindowsAcl(path, false);
}
function openDatabase(path: string, readonly: boolean): SqliteHandle {
  return openDatabaseFile(path, { readonly }) as unknown as SqliteHandle;
}
async function fixture(withSample = false): Promise<{ root: string; dataDir: string; db: string; key: string; output: string; keyValue: Buffer }> {
  const root = await workspace();
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const source = join(dataDir, "source.db");
  const db = join(root, "snapshot.db");
  const key = join(dataDir, "master.key");
  const output = join(root, "backup.shbackup");
  const keyValue = Buffer.alloc(32, 0x5a);
  const handle = createDb({ file: source });
  try {
    runMigrations(handle.sqlite, migrationsDir);
    if (withSample) {
      const now = new Date().toISOString();
      handle.sqlite.prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("prv_test", "Synthetic", "mock", now, now);
      handle.sqlite.prepare(`INSERT INTO api_keys
        (id, provider_id, label, key_ciphertext, key_iv, key_tag, key_version, key_hint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("key_test", "prv_test", "test", "YQ==", "YWI=", "Y2Q=", 1, "syn…cret", now, now);
    }
    await handle.sqlite.backup(db);
  } finally { handle.close(); }
  await secureFile(db);
  await writeFile(key, `${keyValue.toString("hex")}\n`, { mode: 0o600 });
  await secureFile(key);
  sealSnapshotDatabase(db, openDatabase);
  return { root, dataDir, db, key, output, keyValue };
}

function tarHeader(name: string, size: number, options: { type?: string; mode?: number; uid?: number; gid?: number; linkname?: string; devmajor?: number; devminor?: number; uname?: string } = {}): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${(options.mode ?? 0o600).toString(8).padStart(6, "0")}\0 `, 100, 8);
  header.write(`${(options.uid ?? 0).toString(8).padStart(6, "0")}\0 `, 108, 8);
  header.write(`${(options.gid ?? 0).toString(8).padStart(6, "0")}\0 `, 116, 8);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write(options.type ?? "0", 156, 1);
  if (options.linkname) header.write(options.linkname, 157, 100);
  header.write("ustar\0", 257, 6); header.write("00", 263, 2);
  if (options.uname) header.write(options.uname, 265, 32);
  if (options.devmajor !== undefined) header.write(`${options.devmajor.toString(8).padStart(7, "0")}\0`, 329, 8);
  if (options.devminor !== undefined) header.write(`${options.devminor.toString(8).padStart(7, "0")}\0`, 337, 8);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
}
function rawTar(entries: Array<{ name: string; body: Buffer; type?: string; mode?: number; uid?: number; gid?: number; linkname?: string; devmajor?: number; devminor?: number; uname?: string }>, trailing = Buffer.alloc(0)): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.name, entry.body.length, entry), entry.body);
    const padding = (512 - (entry.body.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024), trailing);
  return Buffer.concat(chunks);
}
async function consumeTar(raw: Buffer, limits = DEFAULT_TAR_LIMITS): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of readStrictTar(Readable.toWeb(Readable.from([raw])) as ReadableStream<Uint8Array>, limits)) {
    names.push(entry.name);
    for await (const _chunk of entry.body) { /* stream every member */ }
  }
  return names;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("backup passphrase and JSON policy", () => {
  it("uses trim only for code-point validation and preserves the secret", () => {
    expect(validateBackupPassphrase(`  ${"密".repeat(12)}  `)).toBe(`  ${"密".repeat(12)}  `);
    expect(() => validateBackupPassphrase("密".repeat(11))).toThrow(/12/);
    expect(() => validateBackupPassphrase(" \n\t ")).toThrow(/blank/i);
  });
  it("rejects duplicate JSON keys", () => {
    expect(() => parseStrictJson('{"format":"a","format":"b"}')).toThrow(/duplicate key/);
  });
});

describe("private staging permissions", () => {
  it("requires exact SID, protection, inheritance and FullControl rules", () => {
    const current = "S-1-5-21-3414932011-3134797172-3625386099-500";
    const allowed = [current, "S-1-5-18", "S-1-5-32-544"];
    const canonical = {
      owner: current,
      protected: true,
      rules: allowed.map((identity) => ({ type: "Allow", identity, inherited: false, flags: "CIOI", rights: "FullControl" })),
    };
    expect(() => assertPrivateWindowsAcl(canonical, current, true)).not.toThrow();
    expect(() => assertPrivateWindowsAcl({ ...canonical, rules: canonical.rules.map((rule) => ({ ...rule, flags: "" })) }, current, false)).not.toThrow();
    expect(() => assertPrivateWindowsAcl({ ...canonical, rules: canonical.rules.map((rule) => rule.identity === current ? { ...rule, identity: "LA" } : rule) }, current, true)).toThrow(/unauthorized principal/);
    expect(() => assertPrivateWindowsAcl({ ...canonical, rules: canonical.rules.filter((rule) => rule.identity !== current) }, current, true)).toThrow(/missing an allowed principal/);
    expect(() => assertPrivateWindowsAcl({ ...canonical, rules: canonical.rules.map((rule) => rule.identity === current ? { ...rule, inherited: true, flags: "CIOIID" } : rule) }, current, true)).toThrow(/deny, inherited/);
    expect(() => assertPrivateWindowsAcl({ ...canonical, rules: canonical.rules.map((rule) => rule.identity === current ? { ...rule, rights: "Read" } : rule) }, current, true)).toThrow(/FullControl/);
    expect(() => assertPrivateWindowsAcl({ ...canonical, protected: false }, current, true)).toThrow(/protected/);
    expect(() => assertPrivateWindowsAcl({ ...canonical, owner: "S-1-5-32-545" }, current, true)).toThrow(/owner/);
  });

  it("uses 0700/0600 on POSIX and explicit non-inherited SID ACLs on Windows", async () => {
    const root = await workspace();
    const directory = await createPrivateDirectory(root, "private-");
    const file = join(directory, "secret");
    const handle = await openPrivateFile(file);
    await handle.writeFile("synthetic"); await handle.close();
    await fsyncFile(file);
    await fsyncDirectory(directory);
    if (process.platform === "win32") {
      const system32 = join(process.env["SystemRoot"] ?? "C:/Windows", "System32");
      const icacls = join(system32, "icacls.exe");
      const users = "S-1-5-32-545";
      execFileSync(icacls, [directory, "/grant", `*${users}:(OI)(CI)F`], { stdio: "ignore" });
      execFileSync(icacls, [file, "/grant", `*${users}:F`], { stdio: "ignore" });
      await restrictWindowsAcl(directory, true);
      await restrictWindowsAcl(file, false);
      for (const [target, name] of [[directory, "directory"], [file, "file"]] as const) {
        const saved = join(root, `${name}.acl`);
        execFileSync(icacls, [target, "/save", saved], { stdio: "ignore" });
        const bytes = await readFile(saved);
        const acl = (bytes[1] === 0 ? bytes.toString("utf16le") : bytes.toString("utf8")).toUpperCase();
        expect(acl).toContain(";;;SY)");
        expect(acl).toContain(";;;BA)");
        expect(acl).not.toContain(users);
        expect(acl).not.toContain("(D;");
        expect(acl).not.toContain(";AI)");
        expect(acl).not.toContain(";ID)");
        expect(acl).not.toContain(";IO)");
      }
    } else {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("strict tar parser", () => {
  it("accepts only the exact ordered regular-file members", async () => {
    const raw = rawTar([
      { name: "manifest.json", body: Buffer.from("{}") },
      { name: "data/search-hub.db", body: Buffer.from("db") },
      { name: "keys/master.key", body: Buffer.from("key") },
    ]);
    expect(await consumeTar(raw)).toEqual(["manifest.json", "data/search-hub.db", "keys/master.key"]);
    expect(await consumeTar(raw, { ...DEFAULT_TAR_LIMITS, maxArchiveBytes: raw.length })).toEqual(["manifest.json", "data/search-hub.db", "keys/master.key"]);
  });
  it("rejects traversal, special entries, duplicates, metadata and trailing garbage", async () => {
    const valid = { name: "manifest.json", body: Buffer.from("{}") };
    const cases: Buffer[] = [
      rawTar([{ ...valid, name: "../manifest.json" }]),
      rawTar([{ ...valid, name: "/manifest.json" }]),
      rawTar([{ ...valid, name: "C:\\manifest.json" }]),
      rawTar([{ ...valid, name: "\\\\server\\share\\manifest.json" }]),
      rawTar([{ ...valid, name: "manifest.json:ads" }]),
      rawTar([valid, { ...valid }]),
      rawTar([{ ...valid, type: "2" }]),
      rawTar([{ ...valid, type: "5" }]),
      rawTar([{ ...valid, type: "x" }]),
      rawTar([{ ...valid, type: "1" }]),
      rawTar([{ ...valid, type: "3" }]),
      rawTar([{ ...valid, type: "4" }]),
      rawTar([{ ...valid, type: "6" }]),
      rawTar([{ ...valid, devmajor: 1 }]),
      rawTar([{ ...valid, uname: "root" }]),
      rawTar([{ ...valid, mode: 0o644 }]),
      rawTar([{ ...valid, mode: 0o4600 }]),
      rawTar([{ ...valid, mode: 0o2600 }]),
      rawTar([{ ...valid, mode: 0o1600 }]),
      rawTar([{ ...valid, uid: 1 }]),
      rawTar([{ ...valid, gid: 1 }]),
      rawTar([{ ...valid, linkname: "target" }]),
      rawTar([{ name: "data/search-hub.db", body: Buffer.from("x") }, valid]),
      rawTar([valid, { name: "data/search-hub.db", body: Buffer.from("db") }, { name: "data/master.key", body: Buffer.from("key") }]),
      rawTar([valid], Buffer.from("garbage")),
      rawTar([valid], Buffer.alloc(1)),
      rawTar([valid], Buffer.alloc(512)),
      rawTar([valid], Buffer.alloc(64 * 1024 + 512)),
    ];
    for (const raw of cases) await expect(consumeTar(raw)).rejects.toThrow();
  });
  it("requires two zero end blocks", async () => {
    const oneEnd = rawTar([
      { name: "manifest.json", body: Buffer.from("{}") },
      { name: "data/search-hub.db", body: Buffer.from("db") },
      { name: "keys/master.key", body: Buffer.from("key") },
    ]).subarray(0, -512);
    await expect(consumeTar(oneEnd)).rejects.toThrow(/two zero end blocks|Truncated/);
  });
});

describe("age header and input boundaries", () => {
  function header(
    salt = Buffer.alloc(16, 1).toString("base64").replace(/=+$/, ""),
    extra = "",
    mac = Buffer.alloc(32, 3).toString("base64").replace(/=+$/, ""),
    separator = "--- ",
  ): Buffer {
    const body = Buffer.alloc(32, 2).toString("base64").replace(/=+$/, "");
    return Buffer.from(`age-encryption.org/v1\n-> scrypt ${salt} 18\n${extra}${body}\n${separator}${mac}\n`, "ascii");
  }
  it("accepts a complete canonical header and rejects malformed recipients, salts and MAC lines", async () => {
    const root = await workspace();
    const path = join(root, "header.age");
    await writeFile(path, header()); await secureFile(path);
    expect((await readAgeHeader(path)).workFactor).toBe(18);
    const invalid = [
      header(Buffer.alloc(15, 1).toString("base64").replace(/=+$/, "")),
      header(undefined, "-> X25519 abc\n"),
      header(undefined, "", undefined, "---"),
      header(undefined, "", undefined, "---  "),
      header(undefined, "", undefined, "---\t"),
      header(undefined, "", "!!!!"),
      header(undefined, "", "AAAA="),
      Buffer.from("age-encryption.org/v1\n-> scrypt AAAAAAAAAAAAAAAAAAAAAA 18\nAAAA\n--- ", "ascii"),
      Buffer.from("age-encryption.org/v1\n-> scrypt AAAAAAAAAAAAAAAAAAAAAA 18\nAAAA\n---AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", "ascii"),
      Buffer.from("age-encryption.org/v1\n-> scrypt AAAAAAAAAAAAAAAAAAAAAA 18\nAAAA\n---  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n", "ascii"),
      Buffer.from(`age-encryption.org/v1\n-> scrypt ${String.fromCharCode(0xff)}AAAAAAAAAAAAAAAAAAAAA 18\nAAAA\n--- AAAA\n`, "latin1"),
      Buffer.concat([Buffer.from("age-encryption.org/v1\n"), Buffer.alloc(64 * 1024, 0x41)]),
    ];
    for (const value of invalid) {
      await writeFile(path, value);
      await expect(readAgeHeader(path)).rejects.toThrow();
    }
  });
  it("bounds key files and rejects insecure POSIX input modes", async () => {
    const root = await workspace();
    const path = join(root, "master.key");
    await writeFile(path, "a".repeat(1025), { mode: 0o600 }); await secureFile(path);
    await expect(readMasterKey(path)).rejects.toThrow(/safety limit/);
    if (process.platform !== "win32") {
      await writeFile(path, "ab".repeat(32), { mode: 0o644 });
      await chmod(path, 0o644);
      await expect(readMasterKey(path)).rejects.toThrow(/0600/);
    }
  });
  it("rejects reparse points at the target or any ancestor", async () => {
    const root = await workspace();
    const real = join(root, "real"); await mkdir(real);
    const link = join(root, "link");
    await symlink(real, link, process.platform === "win32" ? "junction" : "dir");
    await expect(assertNoReparseAncestors(join(link, "child"))).rejects.toThrow(/Reparse/);
  });
});

describe("complete backup package", () => {
  it("round-trips a real zero-sample SQLite database using keyProof and cleans staging", async () => {
    const { root, dataDir, db, key, output, keyValue } = await fixture();
    const created = await createBackupPackage({
      snapshotPath: db, masterKeyPath: key, outputPath: output, passphrase, appVersion: "0.1.15",
      migrations, keySource: "file", dataDir, installDir: process.cwd(),
    });
    expect(created.members).toEqual(["manifest.json", "data/search-hub.db", "keys/master.key"]);
    expect(created.manifest.database.sha256).toBe(createHash("sha256").update(await readFile(db)).digest("hex"));
    expect(created.manifest.key.fingerprint).toBe(masterKeyFingerprint(keyValue));
    const verified = await verifyBackupPackage({ path: output, passphrase, expectedMasterKey: keyValue, appVersion: "0.1.15", privateWorkDir: root });
    expect(verified).toMatchObject({
      formatOk: true, structuralOk: true, schemaCompatible: true, keyFingerprintMatch: true,
      ciphertextSampleDecryptable: true, restoreReadiness: true, keyReadiness: "verified",
      sampleCount: 0, keyProofValid: true, integrity: "ok", foreignKeys: "ok", journalMode: "delete",
    });
    expect((await readdir(root)).some((name) => name.startsWith("shbackup-verify-"))).toBe(false);
    const lease = await verifyBackupPackage({ path: output, passphrase, stage: true, privateWorkDir: root });
    try {
      expect((await readdir(lease.directory)).sort()).toEqual(["data", "keys", "manifest.json"]);
      expect(lease.keyPath.replaceAll("\\", "/").endsWith("keys/master.key")).toBe(true);
    } finally { await lease.dispose(); }
    expect((await readdir(root)).some((name) => name.startsWith("shbackup-verify-"))).toBe(false);
    await expect(verifyBackupPackage({ path: output, passphrase: "a wrong but sufficiently long passphrase", privateWorkDir: root })).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.startsWith("shbackup-verify-"))).toBe(false);
    const mismatch = await verifyBackupPackage({ path: output, passphrase, expectedMasterKey: Buffer.alloc(32, 7), privateWorkDir: root });
    expect(mismatch).toMatchObject({ keyReadiness: "mismatch", keyProofValid: false, restoreReadiness: false });
    expect((await readdir(root)).some((name) => name.startsWith("shbackup-verify-"))).toBe(false);
    expect(JSON.stringify(verified)).not.toContain(root);
    await expect(createBackupPackage({ snapshotPath: db, masterKeyPath: key, outputPath: output, passphrase, appVersion: "0.1.15", migrations, keySource: "file" })).rejects.toThrow(/already exists/i);
  }, 120_000);

  it("encrypts and decrypts the exact passphrase without trimming it", async () => {
    const { db, key, output } = await fixture();
    const padded = `  ${passphrase}  `;
    await createBackupPackage({ snapshotPath: db, masterKeyPath: key, outputPath: output, passphrase: padded, appVersion: "0.1.15", migrations, keySource: "file" });
    expect((await verifyBackupPackage({ path: output, passphrase: padded })).restoreReadiness).toBe(true);
    await expect(verifyBackupPackage({ path: output, passphrase })).rejects.toThrow();
  }, 120_000);

  it("detects ciphertext tampering and truncation", async () => {
    const { db, key, output } = await fixture();
    await createBackupPackage({ snapshotPath: db, masterKeyPath: key, outputPath: output, passphrase, appVersion: "0.1.15", migrations, keySource: "file" });
    const original = await readFile(output);
    const tampered = Buffer.from(original); tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    await writeFile(output, tampered); await secureFile(output);
    await expect(verifyBackupPackage({ path: output, passphrase })).rejects.toThrow();
    await writeFile(output, original.subarray(0, original.length - 10)); await secureFile(output);
    await expect(verifyBackupPackage({ path: output, passphrase })).rejects.toThrow();
  }, 120_000);

  it("rejects a deliberately weakened age work factor before decryption", async () => {
    const root = await workspace();
    const path = join(root, "weak.shbackup");
    const encrypter = new Encrypter(); encrypter.setPassphrase(passphrase); encrypter.setScryptWorkFactor(10);
    await writeFile(path, await encrypter.encrypt(rawTar([{ name: "manifest.json", body: Buffer.from("{}") }])), { mode: 0o600 });
    await secureFile(path);
    await expect(verifyBackupPackage({ path, passphrase })).rejects.toThrow(/work factor/i);
  });

  it("enforces the cross-process verification lock", async () => {
    const { db, key, output } = await fixture();
    await createBackupPackage({ snapshotPath: db, masterKeyPath: key, outputPath: output, passphrase, appVersion: "0.1.15", migrations, keySource: "file" });
    await withBackupLock(output, async () => {
      await expect(verifyBackupPackage({ path: output, passphrase })).rejects.toThrow(/lock/i);
    });
  }, 120_000);
});
