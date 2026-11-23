import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, openDatabaseFile } from "@search-hub/db";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { checkIntegrity, createDatabaseSnapshot, pruneStaleUploads, schemaCompatibility } from "../../apps/api/src/services/backup.js";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "backup.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
  };
}

async function createHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-backup-"));
  const ctx = createContext({ ...testConfig(dir), ...overrides });
  const app = await buildApp(ctx);
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      email: "admin@example.com",
      password: "A-very-long-password-1",
      name: "Admin",
      setupToken: ctx.setupToken.value!,
    },
  });
  expect(setup.statusCode).toBe(200);
  const cookie = setup.cookies.find((item) => item.name === "sh_session")?.value;
  expect(cookie).toBeTruthy();

  const harness: Harness = { app, ctx, dir, cookie: cookie!, csrf: setup.json().csrfToken as string };
  harnesses.push(harness);
  return harness;
}

function adminHeaders(harness: Harness) {
  return { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } };
}

function packageMultipart(payload: Buffer, passphrase: string, filename = "search-hub.shbackup"): { payload: Buffer; contentType: string } {
  const boundary = `----searchhub-package-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      payload,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="passphrase"\r\n\r\n${passphrase}\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function createMockProvider(harness: Harness, name: string): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...adminHeaders(harness),
    payload: {
      name,
      type: "mock",
      enabled: true,
      resultsPerPage: 5,
      // Deliberately tiny: this file's concurrency test must not starve the
      // timing-sensitive `concurrency.test.ts` running in a sibling fork.
      config: { resultCount: 2, latencyMs: 1, namespace: name },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().provider.id as string;
}

async function runSearch(harness: Harness, query: string): Promise<number> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { query, mode: "basic", limit: 2 },
  });
  return response.statusCode;
}

/** Writes a snapshot via the service (same code path the route uses). */
async function snapshotTo(harness: Harness, name = "snapshot.db"): Promise<string> {
  const target = join(harness.dir, "out", name);
  const info = await createDatabaseSnapshot(harness.ctx, target);
  expect(info.integrity).toBe("ok");
  return info.path;
}

function rowCount(path: string, table: string): number {
  const db = openDatabaseFile(path, { readonly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

/**
 * Copies a valid snapshot and marks it as having been produced by a newer
 * release (a migration name this build does not ship).
 */
function poisonAsNewerVersion(sourcePath: string, targetPath: string): string {
  writeFileSync(targetPath, readFileSync(sourcePath));
  const db = openDatabaseFile(targetPath);
  try {
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
      "9999_future.sql",
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
  return targetPath;
}

describe("SQLite snapshot consistency", () => {
  it("removes stale owned upload staging but preserves fresh requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-hub-upload-cleanup-"));
    const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = root;
    process.env.TMP = root;
    process.env.TMPDIR = root;
    try {
      const { mkdirSync, utimesSync } = await import("node:fs");
      mkdirSync(join(root, "search-hub-upload-stale"));
      mkdirSync(join(root, "search-hub-upload-fresh"));
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(join(root, "search-hub-upload-stale"), old, old);
      expect(await pruneStaleUploads()).toBe(1);
      expect(() => statSync(join(root, "search-hub-upload-stale"))).toThrow();
      expect(statSync(join(root, "search-hub-upload-fresh")).isDirectory()).toBe(true);
    } finally {
      if (previous.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = previous.TEMP;
      if (previous.TMP === undefined) delete process.env.TMP; else process.env.TMP = previous.TMP;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.TMPDIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("produces a self-contained, integrity-checked file under concurrent writes", async () => {
    const harness = await createHarness();
    // One provider on purpose: this test is about SQLite write concurrency, and
    // a second provider only doubles CPU use for the whole suite.
    await createMockProvider(harness, "a");

    // 50 concurrent writes (searches) while 5 snapshots are taken mid-flight.
    const writes = Array.from({ length: 50 }, (_, index) => runSearch(harness, `concurrent ${index}`));
    const snapshots: Promise<string>[] = [];
    for (let index = 0; index < 5; index += 1) {
      snapshots.push(snapshotTo(harness, `concurrent-${index}.db`));
      // Yield so the snapshot really interleaves with the write batch.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const settled = await Promise.all(writes);
    expect(settled.every((status) => status === 200)).toBe(true);

    const paths = await Promise.all(snapshots);
    let previous = 0;
    for (const path of paths) {
      expect(statSync(path).size).toBeGreaterThan(0);
      expect(checkIntegrity(path)).toEqual({ ok: true, detail: "ok" });
      // A snapshot is never empty and never loses earlier committed rows.
      const tasks = rowCount(path, "search_tasks");
      expect(tasks).toBeGreaterThan(0);
      expect(tasks).toBeGreaterThanOrEqual(previous);
      previous = tasks;

      const db = openDatabaseFile(path, { readonly: true });
      try {
        expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
        expect(db.pragma("user_version", { simple: true })).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    }

    // The final snapshot contains everything that was committed before it;
    // writes that landed after it finished may add rows but never remove them.
    expect(rowCount(paths[paths.length - 1]!, "provider_instances")).toBe(1);
    expect(rowCount(join(harness.dir, "backup.db"), "search_tasks")).toBeGreaterThanOrEqual(
      rowCount(paths[paths.length - 1]!, "search_tasks"),
    );
  });

  it("keeps API keys encrypted in the snapshot (no plaintext secrets)", async () => {
    const harness = await createHarness();
    const providerId = await createMockProvider(harness, "keyed");
    const secret = "sk-live-very-secret-value-1234567890";
    const created = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...adminHeaders(harness),
      payload: { label: "primary", key: secret },
    });
    expect(created.statusCode).toBe(200);

    const path = await snapshotTo(harness);
    const raw = readFileSync(path);
    expect(raw.includes(secret)).toBe(false);
    expect(raw.includes("sk-live")).toBe(false);
    expect(rowCount(path, "api_keys")).toBe(1);
  });

  it("never publishes a file when the destination is not writable", async () => {
    const harness = await createHarness();
    // A regular file where a directory component is required: mkdir fails, so
    // the snapshot must fail before any copy starts.
    const blocker = join(harness.dir, "blocked");
    writeFileSync(blocker, "not a directory");

    await expect(createDatabaseSnapshot(harness.ctx, join(blocker, "snap.db"))).rejects.toThrow(
      /internal|snapshot|directory/i,
    );
    // The service is still healthy afterwards: no handle was leaked.
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      cookies: { sh_session: harness.cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it("falls back to VACUUM INTO when the online backup API is unavailable", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "fallback");
    // Shadow the method on the instance: this is exactly what an older native
    // build without `sqlite3_backup_*` looks like to the snapshot code.
    const original = harness.ctx.sqlite.backup;
    (harness.ctx.sqlite as unknown as { backup?: unknown }).backup = undefined;
    try {
      const target = join(harness.dir, "out", "vacuum.db");
      const info = await createDatabaseSnapshot(harness.ctx, target);
      expect(info.method).toBe("vacuum_into");
      expect(info.integrity).toBe("ok");
      expect(checkIntegrity(target)).toEqual({ ok: true, detail: "ok" });
      expect(rowCount(target, "provider_instances")).toBe(1);
    } finally {
      (harness.ctx.sqlite as unknown as { backup: unknown }).backup = original;
    }
  });

  it("sweeps snapshots left behind by a crashed download", async () => {
    const harness = await createHarness();
    const { mkdirSync } = await import("node:fs");
    const snapshotsDir = join(harness.dir, "snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const stale = join(snapshotsDir, "search-hub-stale.db");
    writeFileSync(stale, "leftover");
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const { pruneStaleSnapshots } = await import("../../apps/api/src/services/backup.js");
    const removed = await pruneStaleSnapshots(harness.ctx);
    expect(removed).toBe(1);
    expect(() => statSync(stale)).toThrow();

    // A fresh in-flight snapshot must not be touched.
    const fresh = join(snapshotsDir, "search-hub-fresh.db");
    writeFileSync(fresh, "in flight");
    expect(await pruneStaleSnapshots(harness.ctx)).toBe(0);
    expect(statSync(fresh).size).toBeGreaterThan(0);
  });

  it("does not leave a final-named file when publishing fails", async () => {
    const harness = await createHarness();
    const outDir = join(harness.dir, "out");
    const target = join(outDir, "occupied.db");
    // A directory at the destination makes the final `rename` fail, which is
    // the last step of the publish path: exit non-zero and leave nothing behind
    // that could be mistaken for a usable backup.
    const { mkdirSync, readdirSync } = await import("node:fs");
    mkdirSync(target, { recursive: true });

    await expect(createDatabaseSnapshot(harness.ctx, target)).rejects.toThrow(/internal|snapshot/i);

    // The temp copy must be gone and the destination untouched.
    const leftovers = readdirSync(outDir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(statSync(target).isDirectory()).toBe(true);

    // A corrupt file is reported as such, never as `ok`.
    const bogus = join(harness.dir, "bogus.db");
    writeFileSync(bogus, "this is not a sqlite database");
    expect(checkIntegrity(bogus).ok).toBe(false);
  });
});

describe("GET /api/admin/backup", () => {
  it("returns a downloadable snapshot with schema headers and deletes it afterwards", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "downloadable");
    await runSearch(harness, "before backup");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/backup",
      cookies: { sh_session: harness.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/vnd.sqlite3");
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="search-hub-.*\.db"/);
    expect(response.headers["x-search-hub-schema-version"]).toMatch(/\.sql$/);
    expect(response.headers["x-search-hub-integrity"]).toBe("ok");
    expect(response.headers["cache-control"]).toBe("no-store");

    const body = Buffer.from(response.rawPayload);
    expect(body.byteLength).toBeGreaterThan(0);

    const file = join(harness.dir, "check", "download.db");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(harness.dir, "check"), { recursive: true });
    writeFileSync(file, body);
    expect(checkIntegrity(file).ok).toBe(true);
    expect(rowCount(file, "provider_instances")).toBe(1);

    // The temp snapshot directory must not accumulate files after download.
    const { readdirSync, existsSync } = await import("node:fs");
    const snapDir = join(harness.dir, "snapshots");
    if (existsSync(snapDir)) {
      expect(readdirSync(snapDir).filter((name) => name.endsWith(".db"))).toHaveLength(0);
    }
  });

  it("serves two concurrent downloads without name collisions", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "parallel");

    const [first, second] = await Promise.all([
      harness.app.inject({ method: "GET", url: "/api/admin/backup", cookies: { sh_session: harness.cookie } }),
      harness.app.inject({ method: "GET", url: "/api/admin/backup", cookies: { sh_session: harness.cookie } }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers["content-disposition"]).not.toBe(second.headers["content-disposition"]);

    const scratch = join(harness.dir, "parallel");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(scratch, { recursive: true });
    for (const [index, response] of [first, second].entries()) {
      const file = join(scratch, `parallel-${index}.db`);
      writeFileSync(file, Buffer.from(response.rawPayload));
      expect(checkIntegrity(file)).toEqual({ ok: true, detail: "ok" });
      expect(rowCount(file, "provider_instances")).toBe(1);
    }
  });

  it("requires an administrator session", async () => {
    const harness = await createHarness();
    const anonymous = await harness.app.inject({ method: "GET", url: "/api/admin/backup" });
    expect([401, 403]).toContain(anonymous.statusCode);
    expect(anonymous.headers["content-type"]).toContain("application/json");
  });
});

describe("complete backup packages", () => {
  it("reports status and downloads an age-encrypted verified package", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "package-source");
    const initial = await harness.app.inject({
      method: "GET",
      url: "/api/admin/backups/status",
      cookies: { sh_session: harness.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ keySource: "file", latestBackup: null, backupDirWritable: true });

    const short = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/package",
      ...adminHeaders(harness),
      payload: { passphrase: "short" },
    });
    expect(short.statusCode).toBe(400);

    const passphrase = "a strong backup passphrase 灾备";
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/package",
      ...adminHeaders(harness),
      payload: { passphrase },
    });
    expect(response.statusCode, response.body).toBe(200);
    const audit = openDatabaseFile(harness.ctx.config.dbPath, { readonly: true });
    try {
      const details = audit.prepare("SELECT detail_json FROM audit_logs WHERE action = 'backup.package'").all();
      expect(JSON.stringify(details)).not.toContain(passphrase);
    } finally {
      audit.close();
    }
    expect(response.headers["content-disposition"]).toMatch(/\.shbackup"$/);
    expect(response.headers["x-search-hub-backup-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(response.rawPayload.subarray(0, Buffer.byteLength("age-encryption.org/v1\n")).toString("ascii")).toBe("age-encryption.org/v1\n");
    expect(response.rawPayload.includes(Buffer.from("a strong backup passphrase"))).toBe(false);

    const status = await harness.app.inject({
      method: "GET",
      url: "/api/admin/backups/status",
      cookies: { sh_session: harness.cookie },
    });
    expect(status.json().latestBackup.verified).toBe(true);
    expect(status.json().restoreReadiness).toBe(true);
    expect(status.json().keyReadiness).toBe("verified");
  });

  it("returns the server checksum and leaves no temporary package artifacts", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/package",
      ...adminHeaders(harness),
      payload: { passphrase: "server checksum passphrase 灾备" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["x-search-hub-backup-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(harness.dir, "backups"));
    expect(files.some((name) => name.endsWith(".shbackup"))).toBe(true);
    expect(files.some((name) => name.startsWith(".shbackup-work-"))).toBe(false);
    expect(files.some((name) => name.endsWith(".shbak") || name.startsWith(".shbak-work-"))).toBe(false);
  });

  it("requires an admin session for status", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({ method: "GET", url: "/api/admin/backups/status" });
    expect([401, 403]).toContain(response.statusCode);
  });

  it("allows only one package generator under concurrent requests", async () => {
    const harness = await createHarness();
    const request = () => harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/package",
      ...adminHeaders(harness),
      payload: { passphrase: "concurrent backup passphrase 灾备" },
    });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 429]);
  });

  it("authenticates before writing an anonymous upload to disk", async () => {
    const harness = await createHarness();
    const temporary = join(harness.dir, "upload-temp");
    const { mkdirSync, readdirSync } = await import("node:fs");
    mkdirSync(temporary, { recursive: true });
    const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = temporary;
    process.env.TMP = temporary;
    process.env.TMPDIR = temporary;
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/admin/backup/verify",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.alloc(2 * 1024 * 1024, 1),
      });
      expect([401, 403]).toContain(response.statusCode);
      expect(readdirSync(temporary)).toEqual([]);
      const missingCsrf = await harness.app.inject({
        method: "POST",
        url: "/api/admin/backup/verify",
        cookies: { sh_session: harness.cookie },
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.alloc(16 * 1024, 1),
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      if (previous.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = previous.TEMP;
      if (previous.TMP === undefined) delete process.env.TMP; else process.env.TMP = previous.TMP;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.TMPDIR;
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("POST /api/admin/backup/package/verify", () => {
  it("verifies a complete package with six boolean results and removes private staging", async () => {
    const harness = await createHarness();
    const passphrase = "package verification passphrase 灾备";
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/package",
      ...adminHeaders(harness),
      payload: { passphrase },
    });
    expect(created.statusCode, created.body).toBe(200);

    const temporary = join(harness.dir, "package-upload-temp");
    const { mkdirSync, readdirSync } = await import("node:fs");
    mkdirSync(temporary, { recursive: true });
    const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = temporary;
    process.env.TMP = temporary;
    process.env.TMPDIR = temporary;
    try {
      const multipart = packageMultipart(Buffer.from(created.rawPayload), passphrase);
      const verified = await harness.app.inject({
        method: "POST",
        url: "/api/admin/backup/package/verify",
        ...adminHeaders(harness),
        headers: { "x-csrf-token": harness.csrf, "content-type": multipart.contentType },
        payload: multipart.payload,
      });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({
        format: "shbackup-v1",
        formatOk: true,
        structuralOk: true,
        schemaCompatible: true,
        keyFingerprintMatch: true,
        ciphertextSampleDecryptable: true,
        restoreReadiness: true,
        keyReadiness: "verified",
        keyProofValid: true,
      });
      expect(verified.json().sampleCount).toBeGreaterThanOrEqual(0);
      expect(typeof verified.json().restoreReadiness).toBe("boolean");
      expect(readdirSync(temporary)).toEqual([]);
      const audit = openDatabaseFile(harness.ctx.config.dbPath, { readonly: true });
      try {
        const details = audit.prepare("SELECT detail_json FROM audit_logs WHERE action = 'backup.package.verify'").all();
        expect(JSON.stringify(details)).not.toContain(passphrase);
      } finally {
        audit.close();
      }

      const statusBefore = await harness.app.inject({
        method: "GET",
        url: "/api/admin/backups/status",
        cookies: { sh_session: harness.cookie },
      });
      const latest = statusBefore.json().latestBackup;
      expect(latest.report.restoreReadiness).toBe(true);
      const published = join(harness.dir, "backups", latest.file);
      writeFileSync(published, Buffer.concat([readFileSync(published), Buffer.from("tampered")]));
      const corrupt = await harness.app.inject({
        method: "GET",
        url: "/api/admin/backups/status",
        cookies: { sh_session: harness.cookie },
      });
      expect(corrupt.json().restoreReadiness).toBe(false);
      expect(corrupt.json().latestBackup.verified).toBe(false);

      writeFileSync(published, created.rawPayload);
      const sidecarPath = `${published}.json`;
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
      sidecar.keyFingerprint = "0".repeat(64);
      sidecar.report.keyFingerprintMatch = false;
      sidecar.report.keyReadiness = "mismatch";
      writeFileSync(sidecarPath, JSON.stringify(sidecar));
      const mismatch = await harness.app.inject({
        method: "GET",
        url: "/api/admin/backups/status",
        cookies: { sh_session: harness.cookie },
      });
      expect(mismatch.json().restoreReadiness).toBe(false);
      expect(mismatch.json().keyReadiness).toBe("mismatch");
      expect(mismatch.json().latestBackup.verified).toBe(false);
    } finally {
      if (previous.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = previous.TEMP;
      if (previous.TMP === undefined) delete process.env.TMP; else process.env.TMP = previous.TMP;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.TMPDIR;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects missing CSRF, low scope and known oversize bodies before disk use", async () => {
    const harness = await createHarness();
    const temporary = join(harness.dir, "package-upload-temp");
    const { mkdirSync, readdirSync } = await import("node:fs");
    mkdirSync(temporary, { recursive: true });
    const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = temporary;
    process.env.TMP = temporary;
    process.env.TMPDIR = temporary;
    try {
      const multipart = packageMultipart(Buffer.from("not a package"), "a valid long passphrase 灾备");
      const missingCsrf = await harness.app.inject({
        method: "POST",
        url: "/api/admin/backup/package/verify",
        cookies: { sh_session: harness.cookie },
        headers: { "content-type": multipart.contentType },
        payload: multipart.payload,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(readdirSync(temporary)).toEqual([]);

      const token = await harness.app.inject({
        method: "POST",
        url: "/api/admin/tokens",
        ...adminHeaders(harness),
        payload: { name: "search-only", scopes: ["search"], rateLimitPerMin: 60 },
      });
      expect(token.statusCode).toBe(200);
      const lowScope = await harness.app.inject({
        method: "POST",
        url: "/api/admin/backup/package/verify",
        headers: { authorization: `Bearer ${token.json().token}`, "content-type": multipart.contentType },
        payload: multipart.payload,
      });
      expect(lowScope.statusCode).toBe(403);
      expect(readdirSync(temporary)).toEqual([]);

      const oversize = await harness.app.inject({
        method: "POST",
        url: "/api/admin/backup/package/verify",
        ...adminHeaders(harness),
        headers: {
          "x-csrf-token": harness.csrf,
          "content-type": multipart.contentType,
          "content-length": String(harness.ctx.config.maxBackupUploadBytes + 1024 * 1024 + 1),
        },
        payload: multipart.payload,
      });
      expect(oversize.statusCode).toBe(413);
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      if (previous.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = previous.TEMP;
      if (previous.TMP === undefined) delete process.env.TMP; else process.env.TMP = previous.TMP;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.TMPDIR;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("enforces the aggregate temporary-byte quota before creating a directory", async () => {
    const harness = await createHarness({ maxBackupVerifyTempBytes: 1024 * 1024 });
    const temporary = join(harness.dir, "package-upload-temp");
    const { mkdirSync, readdirSync } = await import("node:fs");
    mkdirSync(temporary, { recursive: true });
    const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = temporary;
    process.env.TMP = temporary;
    process.env.TMPDIR = temporary;
    try {
      const multipart = packageMultipart(Buffer.from("not a package"), "a valid long passphrase 灾备");
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/admin/backup/package/verify",
        ...adminHeaders(harness),
        headers: { "x-csrf-token": harness.csrf, "content-type": multipart.contentType },
        payload: multipart.payload,
      });
      expect(response.statusCode).toBe(429);
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      if (previous.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = previous.TEMP;
      if (previous.TMP === undefined) delete process.env.TMP; else process.env.TMP = previous.TMP;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.TMPDIR;
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("enforces the verification concurrency quota while extraction is active", async () => {
    const maxUploadBytes = loadConfig().maxBackupUploadBytes;
    const harness = await createHarness({
      maxBackupVerifyConcurrency: 1,
      maxBackupVerifyTempBytes: maxUploadBytes * 2 + 16 * 1024 * 1024,
    });
    const passphrase = "concurrent verification passphrase 灾备";
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/package",
      ...adminHeaders(harness),
      payload: { passphrase },
    });
    expect(created.statusCode, created.body).toBe(200);
    const multipart = packageMultipart(Buffer.from(created.rawPayload), passphrase);
    const request = () => harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/package/verify",
      ...adminHeaders(harness),
      headers: { "x-csrf-token": harness.csrf, "content-type": multipart.contentType },
      payload: multipart.payload,
    });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 429]);
  });

  it("applies the route rate limit before parsing an anonymous body", async () => {
    const harness = await createHarness();
    const temporary = join(harness.dir, "package-upload-temp");
    const { mkdirSync, readdirSync } = await import("node:fs");
    mkdirSync(temporary, { recursive: true });
    const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = temporary;
    process.env.TMP = temporary;
    process.env.TMPDIR = temporary;
    try {
      const multipart = packageMultipart(Buffer.from("not a package"), "a valid long passphrase 灾备");
      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const response = await harness.app.inject({
          method: "POST",
          url: "/api/admin/backup/package/verify",
          headers: { "content-type": multipart.contentType },
          payload: multipart.payload,
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([401, 401, 401, 429]);
      expect(readdirSync(temporary)).toEqual([]);
    } finally {
      if (previous.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = previous.TEMP;
      if (previous.TMP === undefined) delete process.env.TMP; else process.env.TMP = previous.TMP;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous.TMPDIR;
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

describe("POST /api/admin/backup/verify", () => {
  it("accepts a valid snapshot and reports schema/tables/rows", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "verify-me");
    const path = await snapshotTo(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/verify",
      ...adminHeaders(harness),
      headers: { "x-csrf-token": harness.csrf, "content-type": "application/octet-stream" },
      payload: readFileSync(path),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.compatible).toBe(true);
    expect(body.integrity).toBe("ok");
    expect(body.schemaVersion).toMatch(/\.sql$/);
    expect(body.tables).toContain("provider_instances");
    expect(body.rowCounts.provider_instances).toBe(1);
    expect(body.rowCounts.admin_users).toBe(1);
    expect(body.pendingMigrations).toEqual([]);
  });

  it("accepts a streaming multipart file upload for compatibility", async () => {
    const harness = await createHarness();
    const path = await snapshotTo(harness);
    const boundary = `----searchhub${Date.now()}`;
    const body = readFileSync(path);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="snapshot.db"\r\nContent-Type: application/vnd.sqlite3\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/verify",
      ...adminHeaders(harness),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-csrf-token": harness.csrf },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, format: "legacy-db", structuralOk: true });
  });

  it("flags a snapshot created by a newer release", async () => {
    const harness = await createHarness();
    const path = await snapshotTo(harness);
    const poisoned = poisonAsNewerVersion(path, join(harness.dir, "future.db"));

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/verify",
      ...adminHeaders(harness),
      headers: { "x-csrf-token": harness.csrf, "content-type": "application/octet-stream" },
      payload: readFileSync(poisoned),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.compatible).toBe(false);
    expect(body.reason).toMatch(/newer version/i);
    expect(body.integrity).toBe("ok");
  });

  it("rejects a valid SQLite file that is not a Search Hub database", async () => {
    const harness = await createHarness();
    const foreign = join(harness.dir, "foreign.db");
    const handle = createDb({ file: foreign });
    try {
      handle.sqlite.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
      handle.sqlite.prepare("INSERT INTO notes (body) VALUES (?)").run("hello");
    } finally {
      handle.close();
    }

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/verify",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf, "content-type": "application/octet-stream" },
      payload: readFileSync(foreign),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.integrity).toBe("ok");
    expect(body.isSqliteFile).toBe(true);
    expect(body.isSearchHubDatabase).toBe(false);
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/_migrations/);
  });

  it("rejects an empty body and reports a non-database payload as unusable", async () => {
    const harness = await createHarness();
    const empty = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/verify",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBe(400);

    const garbage = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/verify",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf, "content-type": "application/octet-stream" },
      payload: Buffer.from("definitely not a database"),
    });
    expect(garbage.statusCode).toBe(200);
    expect(garbage.json().ok).toBe(false);
    expect(garbage.json().compatible).toBe(false);
    expect(garbage.json().isSqliteFile).toBe(false);
    expect(garbage.json().integrity).not.toBe("ok");
  });

  it("returns 413 when the upload exceeds the configured limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-backup-limit-"));
    // 1 MB is the smallest limit the config accepts (see loadConfig clamp).
    const ctx = createContext({ ...testConfig(dir), maxBackupUploadBytes: 1024 * 1024 });
    const app = await buildApp(ctx);
    await app.ready();
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        email: "admin@example.com",
        password: "A-very-long-password-1",
        name: "Admin",
        setupToken: ctx.setupToken.value!,
      },
    });
    const cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
    const csrf = setup.json().csrfToken as string;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/backup/verify",
        cookies: { sh_session: cookie },
        headers: { "x-csrf-token": csrf, "content-type": "application/octet-stream" },
        payload: Buffer.alloc(2 * 1024 * 1024, 7),
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe("validation_error");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires an administrator session", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backup/verify",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(16),
    });
    expect([401, 403]).toContain(response.statusCode);
  });

  it("does not buffer raw binary bodies sent to any other endpoint", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(4096, 1),
    });
    // 415 keeps unrecognised binary payloads out of the JSON pipeline instead
    // of turning them into a 400 with a confusing "query is required".
    expect([400, 415]).toContain(response.statusCode);
    expect(response.body).not.toContain("query is required");
  });
});

describe("schemaCompatibility", () => {
  it("treats unknown applied migrations as incompatible and missing ones as pending", () => {
    expect(schemaCompatibility(["0001_init.sql"], ["0001_init.sql", "0002_next.sql"])).toEqual({
      compatible: true,
      unknownToBuild: [],
      pendingMigrations: ["0002_next.sql"],
    });
    const newer = schemaCompatibility(["0001_init.sql", "0009_future.sql"], ["0001_init.sql"]);
    expect(newer.compatible).toBe(false);
    expect(newer.reason).toMatch(/newer version/i);
  });
});
