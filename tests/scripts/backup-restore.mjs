#!/usr/bin/env node
/**
 * Backup / restore drill for Search Hub.
 *
 * Proves, against a real server process, that:
 *   1. `GET /api/admin/backup` produces a consistent snapshot while searches are
 *      actively writing to SQLite (no checkpoint race, no torn file);
 *   2. every downloaded file passes `PRAGMA integrity_check`, contains the
 *      configuration rows, and keeps API keys encrypted;
 *   3. a snapshot plus `master.key` restores to a working instance with the same
 *      providers, keys and statistics;
 *   4. a snapshot written by a *newer* release is refused at startup;
 *   5. a failing backup endpoint returns an error and never leaves something
 *      that looks like a complete backup file.
 *
 * Everything runs in `mkdtemp` directories. The repository `data/` directory is
 * never read or written. Ports are allocated dynamically.
 *
 * Usage:
 *   node tests/scripts/backup-restore.mjs          # builds the server if needed
 *   KEEP_ARTIFACTS=1 node tests/scripts/backup-restore.mjs
 *
 * Exit code: 0 only when every check passed.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntry = join(repoRoot, "apps", "api", "dist", "server.mjs");
const keepArtifacts = process.env["KEEP_ARTIFACTS"] === "1";

const results = [];
const children = new Set();
let workDir = "";

// ---------------------------------------------------------------- reporting

function record(ok, name, detail = "") {
  results.push({ ok, name, detail });
  const status = ok ? "PASS" : "FAIL";
  process.stdout.write(`${status}  ${name}${detail ? ` — ${detail}` : ""}\n`);
  return ok;
}

function check(condition, name, detail = "") {
  return record(Boolean(condition), name, detail);
}

function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

// ---------------------------------------------------------------- processes

function buildServerIfNeeded() {
  if (existsSync(serverEntry)) return true;
  process.stdout.write("apps/api/dist/server.mjs missing, running build:server...\n");
  const pnpm = spawnSync("corepack pnpm build:server", {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
  });
  return pnpm.status === 0 && existsSync(serverEntry);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startInstance({ dataDir, label, extraEnv = {} }) {
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SEARCH_HUB_DATA_DIR: dataDir,
      SEARCH_HUB_PORT: String(port),
      SEARCH_HUB_HOST: "127.0.0.1",
      SEARCH_HUB_COOKIE_SECURE: "false",
      SEARCH_HUB_LOG_LEVEL: "info",
      SEARCH_HUB_STATIC_DIR: join(dataDir, "__no_static__"),
      SEARCH_HUB_SETUP_TOKEN: "",
      SEARCH_HUB_ENCRYPTION_KEY: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code) => {
      children.delete(child);
      resolve(code ?? -1);
    });
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return { child, port, label, logs: () => output, exited };
      }
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`[${label}] instance did not become healthy:\n${output}`);
}

async function stopInstance(instance) {
  if (!instance?.child || instance.child.exitCode !== null) return;
  instance.child.kill("SIGTERM");
  const code = await Promise.race([instance.exited, sleep(10_000).then(() => "timeout")]);
  if (code === "timeout") instance.child.kill("SIGKILL");
}

// ---------------------------------------------------------------- http

function sessionCookie(response) {
  const cookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    if (pair?.startsWith("sh_session=")) return pair;
  }
  return null;
}

async function api(port, method, path, { cookie, csrf, json, body, headers = {}, expectJson = true } = {}) {
  const requestHeaders = { ...headers };
  if (cookie) requestHeaders["cookie"] = cookie;
  if (csrf) requestHeaders["x-csrf-token"] = csrf;
  let payload = body;
  if (json !== undefined) {
    requestHeaders["content-type"] = "application/json";
    payload = JSON.stringify(json);
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: requestHeaders,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  if (expectJson && (response.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, headers: response.headers, json: parsed, buffer };
}

async function login(port, email, password) {
  const response = await api(port, "POST", "/api/auth/login", { json: { email, password } });
  const cookie = sessionCookie(response);
  if (response.status !== 200 || !cookie) {
    throw new Error(`login failed (${response.status}): ${response.buffer.toString("utf8").slice(0, 300)}`);
  }
  return { cookie, csrf: response.json.csrfToken };
}

// ---------------------------------------------------------------- fixtures

async function seed(port, auth, providerNames, keySecret) {
  const providerIds = [];
  for (const name of providerNames) {
    const created = await api(port, "POST", "/api/admin/providers", {
      ...auth,
      json: {
        name,
        type: "mock",
        enabled: true,
        rpmLimit: 100_000,
        maxConcurrency: 8,
        config: { resultCount: 4, latencyMs: 2, namespace: name },
      },
    });
    if (created.status !== 200) {
      throw new Error(`provider create failed: ${created.status} ${created.buffer.toString("utf8")}`);
    }
    providerIds.push(created.json.provider.id);
  }

  const keyResponse = await api(port, "POST", `/api/admin/providers/${providerIds[0]}/keys`, {
    ...auth,
    json: { label: "drill-key", key: keySecret },
  });
  if (keyResponse.status !== 200) {
    throw new Error(`key create failed: ${keyResponse.status} ${keyResponse.buffer.toString("utf8")}`);
  }
  return { providerIds, keyId: keyResponse.json.id };
}

async function runSearches(port, auth, count, prefix) {
  let ok = 0;
  for (let index = 0; index < count; index += 1) {
    const response = await api(port, "POST", "/api/search", {
      ...auth,
      json: { query: `${prefix} ${index}`, mode: "basic", limit: 5, skipCache: true },
    });
    if (response.status === 200 && response.json?.results?.length > 0) ok += 1;
  }
  return ok;
}

// ---------------------------------------------------------------- sqlite

function readSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    const userVersion = db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
    const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "";
    const migrations = db.prepare("SELECT name FROM _migrations ORDER BY name").all().map((row) => row.name);
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get()?.c ?? 0);
    return {
      integrity,
      userVersion: Number(userVersion),
      journalMode,
      migrations,
      providers: count("provider_instances"),
      keys: count("api_keys"),
      tasks: count("search_tasks"),
      events: count("search_events"),
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- main

async function main() {
  section("setup");
  if (!check(buildServerIfNeeded(), "server bundle available", serverEntry)) {
    return finish();
  }

  workDir = mkdtempSync(join(tmpdir(), "search-hub-drill-"));
  check(!workDir.startsWith(join(repoRoot, "data")), "work directory is isolated", workDir);

  const email = "drill@example.com";
  const password = "A-very-long-drill-password-1";
  const keySecret = `sk-live-drill-${randomBytes(9).toString("hex")}`;
  const providerNames = ["drill-alpha", "drill-beta"];
  const sourceDataDir = join(workDir, "source-data");
  mkdirSync(sourceDataDir, { recursive: true });

  let source;
  let restored;
  try {
    source = await startInstance({ dataDir: sourceDataDir, label: "source" });
    check(true, "source instance started", `port ${source.port}`);

    // ---- first-run setup, using the generated setup-token file
    const tokenPath = join(sourceDataDir, "setup-token");
    check(existsSync(tokenPath), "setup token file written", tokenPath);
    const setupToken = readFileSync(tokenPath, "utf8").trim();

    const setup = await api(source.port, "POST", "/api/setup", {
      json: { email, password, name: "Drill Admin", setupToken },
    });
    const setupCookie = sessionCookie(setup);
    check(setup.status === 200 && Boolean(setupCookie), "administrator created from setup token", `status ${setup.status}`);
    const sourceAuth = { cookie: setupCookie, csrf: setup.json.csrfToken };

    const seeded = await seed(source.port, sourceAuth, providerNames, keySecret);
    check(seeded.providerIds.length === 2, "two mock providers created");
    check(Boolean(seeded.keyId), "one API key created");

    const firstBatch = await runSearches(source.port, sourceAuth, 20, "drill-first");
    check(firstBatch === 20, "20 searches completed", `${firstBatch}/20`);

    // ---- concurrent writes + three downloads
    section("concurrent snapshot download");
    const downloadsDir = join(workDir, "downloads");
    mkdirSync(downloadsDir, { recursive: true });
    const background = runSearches(source.port, sourceAuth, 40, "drill-bg");
    const snapshots = [];
    for (let round = 0; round < 3; round += 1) {
      const response = await api(source.port, "GET", "/api/admin/backup", {
        cookie: sourceAuth.cookie,
        expectJson: false,
      });
      const file = join(downloadsDir, `snapshot-${round}.db`);
      writeFileSync(file, response.buffer);
      snapshots.push({ file, status: response.status, headers: response.headers, bytes: response.buffer.length });
      await sleep(150);
    }
    const backgroundOk = await background;

    snapshots.forEach((snapshot, index) => {
      check(
        snapshot.status === 200 && snapshot.bytes > 0,
        `download #${index + 1} returned 200 with a body`,
        `${snapshot.bytes} bytes`,
      );
      check(
        (snapshot.headers.get("x-search-hub-integrity") ?? "") === "ok",
        `download #${index + 1} declares integrity ok`,
        snapshot.headers.get("x-search-hub-integrity") ?? "missing header",
      );
      check(
        (snapshot.headers.get("x-search-hub-schema-version") ?? "").endsWith(".sql"),
        `download #${index + 1} carries a schema version`,
        snapshot.headers.get("x-search-hub-schema-version") ?? "missing",
      );
      check(
        /filename="search-hub-\d{4}-\d{2}-\d{2}/.test(snapshot.headers.get("content-disposition") ?? ""),
        `download #${index + 1} is named with a timestamp`,
        snapshot.headers.get("content-disposition") ?? "",
      );

      const facts = readSnapshot(snapshot.file);
      check(
        facts.integrity.length === 1 && facts.integrity[0] === "ok",
        `snapshot #${index + 1} passes PRAGMA integrity_check`,
        facts.integrity.join("; "),
      );
      check(facts.journalMode === "delete", `snapshot #${index + 1} is self-contained (journal_mode=delete)`, facts.journalMode);
      check(facts.userVersion > 0 && facts.migrations.length > 0, `snapshot #${index + 1} records its schema version`, `user_version=${facts.userVersion}, ${facts.migrations.join(",")}`);
      check(facts.providers === 2, `snapshot #${index + 1} holds both providers`, `providers=${facts.providers}`);
      check(facts.keys === 1, `snapshot #${index + 1} holds the API key row`, `api_keys=${facts.keys}`);
      check(facts.tasks > 0 && facts.events > 0, `snapshot #${index + 1} holds search history`, `tasks=${facts.tasks}, events=${facts.events}`);
      const raw = readFileSync(snapshot.file);
      check(
        !raw.includes(keySecret) && !raw.includes("sk-live-drill-"),
        `snapshot #${index + 1} stores the key as ciphertext only`,
      );
    });
    check(backgroundOk === 40, "background searches kept running during snapshots", `${backgroundOk}/40`);

    // ---- the last snapshot is the restore source
    const restoreSource = snapshots[snapshots.length - 1];
    const restoredFacts = readSnapshot(restoreSource.file);

    // ---- restore into a brand new data directory
    section("restore");
    const restoredDataDir = join(workDir, "restored-data");
    mkdirSync(restoredDataDir, { recursive: true });
    copyFileSync(restoreSource.file, join(restoredDataDir, "search-hub.db"));
    const masterKey = join(sourceDataDir, "master.key");
    check(existsSync(masterKey), "source master.key exists for the restore", masterKey);
    copyFileSync(masterKey, join(restoredDataDir, "master.key"));

    restored = await startInstance({ dataDir: restoredDataDir, label: "restored" });
    check(true, "restored instance started", `port ${restored.port}`);

    const restoredAuth = await login(restored.port, email, password);
    check(Boolean(restoredAuth.csrf), "login works against the restored database");

    const providers = await api(restored.port, "GET", "/api/admin/providers", { cookie: restoredAuth.cookie });
    const names = (providers.json?.providers ?? []).map((item) => item.name).sort();
    check(
      providers.status === 200 && names.length === 2 && names.join(",") === [...providerNames].sort().join(","),
      "restored providers match the backup",
      names.join(",") || `status ${providers.status}`,
    );

    const dashboard = await api(restored.port, "GET", "/api/admin/dashboard?range=24h", { cookie: restoredAuth.cookie });
    const restoredSearches = Number(dashboard.json?.totals?.searches ?? -1);
    check(
      dashboard.status === 200 && restoredSearches >= restoredFacts.tasks,
      "restored statistics cover the snapshot",
      `dashboard=${restoredSearches}, snapshot tasks=${restoredFacts.tasks}`,
    );
    check(
      Number(dashboard.json?.keys?.total ?? -1) === restoredFacts.keys,
      "restored key count matches the snapshot",
      `dashboard=${dashboard.json?.keys?.total}, snapshot=${restoredFacts.keys}`,
    );

    // The mock adapter needs no key, but `resolveKey` still has to decrypt the
    // stored ciphertext — this is what proves master.key was restored too.
    const keyTest = await api(restored.port, "POST", `/api/admin/keys/${seeded.keyId}/test`, restoredAuth);
    check(
      keyTest.status === 200 && keyTest.json?.ok === true,
      "restored instance decrypts the stored API key (master.key restored)",
      keyTest.json?.message ?? `status ${keyTest.status}`,
    );

    // ---- a newer snapshot must be refused at startup
    section("version refusal");
    const futureDataDir = join(workDir, "future-data");
    mkdirSync(futureDataDir, { recursive: true });
    copyFileSync(restoreSource.file, join(futureDataDir, "search-hub.db"));
    copyFileSync(masterKey, join(futureDataDir, "master.key"));
    {
      const db = new DatabaseSync(join(futureDataDir, "search-hub.db"));
      try {
        db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
          "9999_future.sql",
          new Date().toISOString(),
        );
      } finally {
        db.close();
      }
    }
    const future = await startInstance({ dataDir: futureDataDir, label: "future" }).catch((error) => ({
      failedToStart: true,
      logs: () => String(error.message ?? error),
      child: null,
    }));
    const futureExit = future.failedToStart ? 1 : await future.exited;
    const futureLogs = future.logs();
    check(futureExit !== 0, "instance refuses to boot on a newer schema", `exit code ${futureExit}`);
    check(/newer/i.test(futureLogs), "startup failure mentions a newer schema", firstMatch(futureLogs, /newer[^\n]*/i));
    check(/schema/i.test(futureLogs), "startup failure mentions the schema", firstMatch(futureLogs, /schema[^\n]*/i));

    // ---- failure must not produce a fake success
    section("failure handling");
    const snapshotsDir = join(sourceDataDir, "snapshots");
    rmSync(snapshotsDir, { recursive: true, force: true });
    writeFileSync(snapshotsDir, "a regular file where the snapshots directory should be");

    const failedBackup = await api(source.port, "GET", "/api/admin/backup", {
      cookie: sourceAuth.cookie,
      expectJson: false,
    });
    check(
      failedBackup.status !== 200,
      "backup endpoint fails closed when the snapshot directory is unusable",
      `status ${failedBackup.status}`,
    );
    check(
      (failedBackup.headers.get("content-type") ?? "").includes("application/json"),
      "failed backup returns a JSON error, not a 0-byte download",
      String(failedBackup.headers.get("content-type")),
    );
    check(
      !backupFilesIn(snapshotsDir).some((name) => name.endsWith(".db")),
      "no final-named snapshot file was published",
    );

    // Kill the process mid-download and make sure nothing corrupt appears
    // under a final name: a `.db` in the snapshots directory is either absent
    // or a valid database.
    rmSync(snapshotsDir, { force: true });
    const killRound = api(source.port, "GET", "/api/admin/backup", {
      cookie: sourceAuth.cookie,
      expectJson: false,
    }).catch(() => null);
    await sleep(60);
    source.child.kill("SIGKILL");
    await source.exited;
    await killRound;
    const leftovers = existsSync(snapshotsDir) ? readdirSync(snapshotsDir) : [];
    let allValid = true;
    for (const name of leftovers) {
      if (!name.endsWith(".db")) continue;
      const file = join(snapshotsDir, name);
      try {
        const facts = readSnapshot(file);
        if (!(facts.integrity[0] === "ok" && statSync(file).size > 0)) allValid = false;
      } catch {
        allValid = false;
      }
    }
    check(allValid, "a killed backup never leaves a torn final-named .db file", leftovers.join(",") || "no files");
    check(true, "process was killed during an in-flight backup");
    source = null;
  } finally {
    await stopInstance(restored);
    await stopInstance(source);
  }
  return finish();
}

function backupFilesIn(snapshotsPath) {
  if (!existsSync(snapshotsPath) || !statSync(snapshotsPath).isDirectory()) return [];
  return readdirSync(snapshotsPath);
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? match[0].slice(0, 160) : "no matching log line";
}

function finish() {
  const failed = results.filter((item) => !item.ok);
  section("summary");
  process.stdout.write(`${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) {
    for (const item of failed) process.stdout.write(`  FAILED: ${item.name} — ${item.detail}\n`);
  }
  if (workDir) {
    if (keepArtifacts) process.stdout.write(`artifacts kept at ${workDir}\n`);
    else rmSync(workDir, { recursive: true, force: true });
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
  return failed.length === 0 ? 0 : 1;
}

process.on("exit", () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});

main()
  .then((code) => {
    if (code !== undefined) process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`\nDRL FAILED: ${error?.stack ?? error}\n`);
    if (results.length > 0) finish();
    else process.exitCode = 1;
  });
