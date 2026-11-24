#!/usr/bin/env node
/**
 * Independent Search Hub disaster-recovery performance acceptance harness.
 *
 * This file deliberately does not import or modify the backup implementation.
 * It drives the public CLI, creates real SQLite fixtures, samples the owned
 * process tree and emits redacted exact-SHA evidence.
 *
 * Results are PASS, FAIL or BLOCKED only. A partial/smoke schedule is BLOCKED,
 * never PASS. Resource exhaustion is BLOCKED, never a reason to weaken the KDF.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";
import { memoryLoop } from "./backup-memory-loop.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SCRIPT), "..", "..");
const MIB = 1024 * 1024;
const REQUIRED_SIZES = [10, 64, 256];
const DEFAULT_SIZES = [10, 64, 128, 256];
const R_REQUIREMENTS = Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`);
const A_REQUIREMENTS = Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`);
const PRELOAD = `
const fs = require("node:fs");
process.on("exit", () => {
  try {
    const memory = process.memoryUsage();
    const usage = process.resourceUsage();
    fs.writeFileSync(process.env.SHUB_QA_RESOURCE_FILE, JSON.stringify({
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      rssBytes: memory.rss,
      maxRssBytes: Number(usage.maxRSS) * 1024,
      userCpuMs: Number(usage.userCPUTime),
      systemCpuMs: Number(usage.systemCPUTime),
    }));
  } catch {}
});
`;

function usage() {
  process.stdout.write(`Search Hub independent disaster-recovery performance harness

Usage:
  node ${relative(REPO, SCRIPT).replaceAll("\\", "/")} --help
  node ${relative(REPO, SCRIPT).replaceAll("\\", "/")} --self-check
  node ${relative(REPO, SCRIPT).replaceAll("\\", "/")} --run --cli <shub|shub.exe|index.mjs|index.ts> [options]

Options:
  --sizes <10,64,128,256>  Fixture sizes in MiB (default: 10,64,128,256)
  --rounds <n>             Measured repeated rounds per size (default: 5)
  --warmup <n>             Warm-up rounds per size (default: 1)
  --fresh-rounds <n>       Fresh-process control rounds per size (default: 5)
  --single-round           One 256MiB smoke round; verdict is BLOCKED, not acceptance
  --output-dir <dir>       Evidence directory; must be new or empty
  --work-dir <dir>         Optional parent for private scratch data
  --sample-ms <n>          Process/disk sample interval (default: 100)
  --timeout-ms <n>         Per-operation timeout (default: 1800000)
  --allow-dirty            Record dirty tree but do not block exact-SHA scheduling
  --keep-artifacts         Keep generated packages/restored databases (large)
  --no-memory-loop         Disable same-process verifier loop; R34 remains BLOCKED
  --passphrase-file <file> Optional 0600 file; otherwise a random synthetic secret is used

Exit codes: 0=PASS/self-check, 1=FAIL, 2=usage, 75=BLOCKED/NOT IMPLEMENTED.
`);
}

function parseArgs(argv) {
  const options = {
    sizes: DEFAULT_SIZES,
    rounds: 5,
    warmup: 1,
    freshRounds: 5,
    sampleMs: 100,
    timeoutMs: 30 * 60 * 1000,
    allowDirty: false,
    keepArtifacts: false,
    singleRound: false,
    memoryLoop: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--self-check") options.selfCheck = true;
    else if (argument === "--run") options.run = true;
    else if (argument === "--single-round") options.singleRound = true;
    else if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--keep-artifacts") options.keepArtifacts = true;
    else if (argument === "--no-memory-loop") options.memoryLoop = false;
    else if (argument.startsWith("--")) {
      const [key, inline] = argument.slice(2).split("=", 2);
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`--${key} requires a value`);
      if (key === "sizes") options.sizes = value.split(",").map(Number);
      else if (key === "rounds") options.rounds = Number(value);
      else if (key === "warmup") options.warmup = Number(value);
      else if (key === "fresh-rounds") options.freshRounds = Number(value);
      else if (key === "sample-ms") options.sampleMs = Number(value);
      else if (key === "timeout-ms") options.timeoutMs = Number(value);
      else if (key === "cli") options.cli = value;
      else if (key === "output-dir") options.outputDir = value;
      else if (key === "work-dir") options.workDir = value;
      else if (key === "passphrase-file") options.passphraseFile = value;
      else throw new Error(`Unknown option: --${key}`);
    } else throw new Error(`Unexpected argument: ${argument}`);
  }
  for (const size of options.sizes) {
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024) throw new Error("sizes must be integers in 1..1024");
  }
  for (const [name, value, minimum] of [
    ["rounds", options.rounds, 1],
    ["warmup", options.warmup, 0],
    ["fresh-rounds", options.freshRounds, 0],
    ["sample-ms", options.sampleMs, 20],
    ["timeout-ms", options.timeoutMs, 1000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  if (options.singleRound) {
    options.sizes = [256];
    options.rounds = 1;
    options.warmup = 0;
    options.freshRounds = 0;
  }
  options.sizes = [...new Set(options.sizes)].sort((left, right) => left - right);
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(path) {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readSmallText(path, limit = 2 * MIB) {
  const info = statSync(path);
  if (info.size > limit) return "";
  return readFileSync(path, "utf8");
}

function parseJsonOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function findValue(value, key) {
  if (value === null || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findValue(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sanitize(text, secrets = [], roots = []) {
  let output = String(text ?? "");
  for (const secret of secrets.filter(Boolean)) output = output.split(secret).join("[redacted]");
  for (const root of roots.filter(Boolean)) {
    output = output.split(root).join("[redacted]");
    output = output.split(root.replaceAll("\\", "/")).join("[redacted]");
    output = output.split(root.replaceAll("/", "\\")).join("[redacted]");
  }
  return output;
}

function gitInfo() {
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8", timeout: 15_000 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = run("rev-parse", "HEAD");
  const status = run("status", "--porcelain") ?? "";
  const diff = run("diff", "--binary", "HEAD");
  let releaseCodeFingerprint = null;
  try {
    if (commit) releaseCodeFingerprint = codeFingerprint(REPO, commit);
  } catch {
    // Preserve the commit and surface the missing fingerprint to the aggregator.
  }
  return {
    commit,
    releaseCodeFingerprint,
    dirty: status.length > 0,
    changedPaths: status ? status.split(/\r?\n/).length : 0,
    diffSha256: diff === null ? null : sha256(diff),
  };
}

function memoryInfo() {
  if (process.platform === "linux") {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
      if (match) return { availableBytes: Number(match[1]) * 1024, source: "/proc/meminfo" };
    } catch {
      // Fall through to the OS API.
    }
  }
  return { availableBytes: Number(requireFreemem()), source: "os.freemem" };
}

function requireFreemem() {
  // Loaded lazily so --help/self-check do not depend on platform internals.
  return globalThis.process?.getBuiltinModule?.("node:os")?.freemem?.() ?? 0;
}

function diskInfo(path) {
  const info = statfsSync(path);
  return { availableBytes: Number(info.bavail) * Number(info.bsize), blockBytes: Number(info.bsize) };
}

function inspectAgeHeader(path) {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  try {
    bytes = readSync(descriptor, buffer);
  } finally {
    closeSync(descriptor);
  }
  const header = buffer.subarray(0, bytes);
  const text = header.toString("latin1");
  if (!text.startsWith("age-encryption.org/v1\n")) throw new Error("not an age v1 file");
  const separator = text.indexOf("\n--- ");
  if (separator < 0) throw new Error("truncated age header");
  const macEnd = text.indexOf("\n", separator + 1);
  const headerEnd = macEnd < 0 ? text.length : macEnd;
  if (header.subarray(0, headerEnd).some((byte) => byte > 0x7f)) throw new Error("age header contains non-ASCII bytes");
  const lines = text.slice(0, separator).split("\n");
  const stanzas = lines.filter((line) => line.startsWith("-> "));
  const scrypt = lines.filter((line) => line.startsWith("-> scrypt "));
  if (stanzas.length !== 1 || scrypt.length !== 1) throw new Error("expected exactly one passphrase recipient");
  const parts = scrypt[0].split(" ");
  if (parts.length !== 4 || !/^\d+$/.test(parts[3])) throw new Error("invalid scrypt stanza");
  const salt = Buffer.from(parts[2], "base64");
  if (salt.length !== 16) throw new Error("scrypt salt must be exactly 16 bytes");
  return { recipient: "scrypt", workFactor: Number(parts[3]), saltBytes: salt.length };
}

function runMigrations(database, directory) {
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  database.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const file of files) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(join(directory, file), "utf8"));
      database.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.exec(`PRAGMA user_version = ${files.length}`);
  return files;
}

function encryptSample(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function databaseSummary(path, key = null) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all().length;
    const migrations = database.prepare("SELECT name FROM _migrations ORDER BY name").all().map((row) => row.name);
    const count = (table) => Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()?.count ?? 0);
    const payload = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(length(payload)), 0) AS bytes FROM _dr_payload").get();
    let sampleDecryptable = null;
    if (key) {
      const { createDecipheriv } = globalThis.process.getBuiltinModule("node:crypto");
      const row = database.prepare("SELECT key_ciphertext, key_iv, key_tag, key_version FROM api_keys ORDER BY id LIMIT 1").get();
      if (row) {
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.key_iv, "base64"));
          decipher.setAuthTag(Buffer.from(row.key_tag, "base64"));
          decipher.update(Buffer.from(row.key_ciphertext, "base64"));
          decipher.final();
          sampleDecryptable = true;
        } catch {
          sampleDecryptable = false;
        }
      }
    }
    return {
      integrity: integrity.length === 1 && integrity[0] === "ok" ? "ok" : "failed",
      foreignKeyViolations: foreignKeys,
      userVersion: Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0),
      journalMode: String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? ""),
      migrations,
      providerCount: count("provider_instances"),
      apiKeyCount: count("api_keys"),
      payloadRows: Number(payload?.count ?? 0),
      payloadBytes: Number(payload?.bytes ?? 0),
      ciphertextSampleDecryptable: sampleDecryptable,
    };
  } finally {
    database.close();
  }
}

function createFixture(root, sizeMiB, migrationsDir) {
  const dataDir = join(root, "source-data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const dbPath = join(dataDir, "search-hub.db");
  const keyPath = join(dataDir, "master.key");
  const key = randomBytes(32);
  const database = new DatabaseSync(dbPath);
  try {
    database.exec("PRAGMA page_size = 4096");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA wal_autocheckpoint = 0");
    runMigrations(database, migrationsDir);
    const now = new Date().toISOString();
    database.prepare("INSERT INTO provider_instances (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("prv_dr_perf", "DR performance fixture", "mock", now, now);
    const encrypted = encryptSample(key, "synthetic-performance-secret");
    database.prepare(`INSERT INTO api_keys
      (id, provider_id, label, key_ciphertext, key_iv, key_tag, key_version, key_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "key_dr_perf", "prv_dr_perf", "fixture", encrypted.ciphertext, encrypted.iv, encrypted.tag, 1, "syn…cret", now, now,
    );
    database.exec("CREATE TABLE _dr_payload (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)");
    const targetBytes = sizeMiB * MIB;
    let inserted = 0;
    while (statSync(dbPath).size < targetBytes) {
      const remaining = targetBytes - statSync(dbPath).size;
      const payload = randomBytes(Math.min(MIB, Math.max(64 * 1024, remaining + 64 * 1024)));
      database.prepare("INSERT INTO _dr_payload (payload) VALUES (?)").run(payload);
      inserted += 1;
      if (inserted % 16 === 0) database.exec("PRAGMA wal_checkpoint(PASSIVE)");
      if (inserted > sizeMiB * 4 + 64) throw new Error("fixture did not reach its target size");
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec("PRAGMA journal_mode = DELETE");
  } finally {
    database.close();
  }
  const descriptor = openSync(keyPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${key.toString("hex")}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(keyPath, 0o600);
  return {
    dataDir,
    dbPath,
    keyPath,
    key,
    bytes: statSync(dbPath).size,
    sha256: hashFile(dbPath),
    keyFingerprint: sha256(Buffer.concat([Buffer.from("search-hub-master-key-fingerprint-v1\0"), key])),
    summary: databaseSummary(dbPath, key),
  };
}

async function measureDisk(path) {
  let totalBytes = 0;
  let temporaryBytes = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    let info;
    try {
      info = lstatSync(current);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      for (const name of readdirSync(current)) pending.push(join(current, name));
    } else if (info.isFile()) {
      totalBytes += info.size;
      const parts = relative(path, current).split(sep);
      if (parts.some((part) => part.startsWith(".") || part.endsWith(".tmp"))) temporaryBytes += info.size;
    }
  }
  return { totalBytes, temporaryBytes };
}

function linuxProcessTree(rootPid) {
  const pids = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pids.includes(pid)) continue;
    pids.push(pid);
    try {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      if (children) pending.push(...children.split(/\s+/).map(Number));
    } catch {
      // Process exited between samples.
    }
  }
  return pids;
}

function windowsProcessTree(rootPid) {
  const script = `
$root = ${rootPid}
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
$ids = @($root)
for ($i = 0; $i -lt $ids.Count; $i++) {
  foreach ($p in $all) { if ($p.ParentProcessId -eq $ids[$i] -and $ids -notcontains $p.ProcessId) { $ids += $p.ProcessId } }
}
$processes = @(Get-Process -Id $ids -ErrorAction SilentlyContinue)
[pscustomobject]@{
  rss = [int64](($processes | Measure-Object WorkingSet64 -Sum).Sum)
  peak = [int64](($processes | Measure-Object PeakWorkingSet64 -Sum).Sum)
  private = [int64](($processes | Measure-Object PrivateMemorySize64 -Sum).Sum)
  handles = [int](($processes | Measure-Object HandleCount -Sum).Sum)
  cpu = [double]((($processes | Measure-Object UserProcessorTime -Sum).Sum.TotalMilliseconds) + (($processes | Measure-Object PrivilegedProcessorTime -Sum).Sum.TotalMilliseconds))
} | ConvertTo-Json -Compress`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: MIB,
  });
  if (result.status !== 0) throw new Error(result.stderr || `powershell exit ${result.status}`);
  return JSON.parse(result.stdout);
}

function sampleProcesses(rootPid) {
  if (process.platform === "win32") return windowsProcessTree(rootPid);
  if (process.platform !== "linux") return { rss: 0, peak: 0, private: 0, handles: 0, cpu: 0, supported: false };
  let rss = 0;
  let peak = 0;
  let handles = 0;
  let cpu = 0;
  for (const pid of linuxProcessTree(rootPid)) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      rss += Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? 0) * 1024;
      peak += Number(/^VmHWM:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? 0) * 1024;
      handles += readdirSync(`/proc/${pid}/fd`).length;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      cpu += (Number(fields[11] ?? 0) + Number(fields[12] ?? 0)) * 10;
    } catch {
      // Process exited between samples.
    }
  }
  return { rss, peak, private: rss, handles, cpu, supported: true };
}

class Sampler {
  constructor(pid, diskPaths, intervalMs) {
    this.pid = pid;
    this.diskPaths = diskPaths;
    this.intervalMs = intervalMs;
    this.samples = [];
    this.active = false;
    this.sampling = false;
    this.lastProcess = null;
    this.lastDisk = { totalBytes: 0, temporaryBytes: 0 };
    this.error = null;
  }

  async sample() {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const processes = sampleProcesses(this.pid);
      if (processes.rss > 0 || processes.handles > 0) this.lastProcess = processes;
      const disks = [];
      for (const path of this.diskPaths) disks.push(await measureDisk(path));
      this.lastDisk = {
        totalBytes: disks.reduce((sum, disk) => sum + disk.totalBytes, 0),
        temporaryBytes: disks.reduce((sum, disk) => sum + disk.temporaryBytes, 0),
      };
      this.samples.push({ at: Date.now(), processes, disk: this.lastDisk });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.sampling = false;
    }
  }

  start() {
    this.active = true;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
  }

  async stop() {
    this.active = false;
    clearInterval(this.timer);
    await this.sample();
    const valid = this.samples.filter((sample) => sample.processes.supported !== false);
    const rssValues = valid.map((sample) => sample.processes.rss);
    const peakValues = valid.map((sample) => sample.processes.peak);
    const handleValues = valid.map((sample) => sample.processes.handles);
    const cpuValues = valid.map((sample) => sample.processes.cpu);
    const temporaryValues = valid.map((sample) => sample.disk.temporaryBytes);
    const totalValues = valid.map((sample) => sample.disk.totalBytes);
    return {
      supported: valid.length > 0,
      samplerError: this.error,
      rssBytes: {
        start: rssValues[0] ?? 0,
        peak: Math.max(0, ...rssValues),
        end: this.lastProcess?.rss ?? 0,
      },
      peakRssBytes: Math.max(0, ...rssValues, ...peakValues),
      privateBytesPeak: Math.max(0, ...valid.map((sample) => sample.processes.private)),
      handles: {
        start: handleValues[0] ?? 0,
        peak: Math.max(0, ...handleValues),
        end: this.lastProcess?.handles ?? 0,
        postExit: 0,
      },
      cpuMs: Math.max(0, ...cpuValues),
      temporaryDiskBytes: {
        start: temporaryValues[0] ?? 0,
        peak: Math.max(0, ...temporaryValues),
        end: this.lastDisk.temporaryBytes,
      },
      ownedDiskBytes: {
        start: totalValues[0] ?? 0,
        peak: Math.max(0, ...totalValues),
        end: this.lastDisk.totalBytes,
      },
      sampleCount: this.samples.length,
    };
  }
}

function cliInvocation(cliPath) {
  const absolutePath = resolve(cliPath);
  if (absolutePath.endsWith(".ts")) return { command: process.execPath, prefix: ["--import", import.meta.resolve("tsx"), absolutePath], runtime: "node-tsx" };
  if (absolutePath.endsWith(".mjs") || absolutePath.endsWith(".js")) return { command: process.execPath, prefix: [absolutePath], runtime: "node" };
  return { command: absolutePath, prefix: [], runtime: "standalone" };
}

function runSimple(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 20_000,
    windowsHide: true,
    maxBuffer: 2 * MIB,
    env: options.env ?? process.env,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message ?? null };
}

function preflightCli(cliPath) {
  if (!cliPath || !existsSync(cliPath)) return { ok: false, reason: "NOT_IMPLEMENTED: CLI path is missing" };
  const invocation = cliInvocation(cliPath);
  const help = runSimple(invocation.command, [...invocation.prefix, "--help"]);
  if (help.status !== 0) return { ok: false, reason: `NOT_IMPLEMENTED: CLI --help failed: ${help.error ?? help.stderr.slice(0, 200)}` };
  const required = [".shbackup", "backup create", "backup verify", "backup restore", "--passphrase-stdin", "--master-key-file", "--legacy"];
  const missing = required.filter((token) => !help.stdout.includes(token));
  if (missing.length > 0) return { ok: false, reason: `NOT_IMPLEMENTED: CLI help lacks ${missing.join(", ")}` };
  const version = runSimple(invocation.command, [...invocation.prefix, "--version"]);
  return { ok: true, invocation, version: version.stdout.trim() || null };
}

function listOwnedProcesses(pid) {
  if (process.platform === "win32") return [];
  return linuxProcessTree(pid);
}

function killOwnedTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status !== 0 && result.error) throw result.error;
    return;
  }
  for (const child of listOwnedProcesses(pid).reverse()) {
    try { process.kill(child, "SIGKILL"); } catch { /* Already exited. */ }
  }
}

function readResourceSidecar(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeCliSummary(report) {
  if (!report || typeof report !== "object") return null;
  const verification = report.verification && typeof report.verification === "object" ? report.verification : null;
  const timings = report.timings && typeof report.timings === "object" ? report.timings : report.verification?.timings;
  const safeTimings = {};
  if (timings && typeof timings === "object") {
    for (const key of ["capture", "encrypt", "verify", "extract", "migrate", "publish", "rename", "kdf"]) {
      if (typeof timings[key] === "number") safeTimings[key] = timings[key];
    }
  }
  return {
    operation: typeof report.operation === "string" ? report.operation : null,
    result: typeof report.result === "string" ? report.result : null,
    durationMs: typeof report.durationMs === "number" ? report.durationMs : null,
    peakRssBytes: typeof report.peakRssBytes === "number" ? report.peakRssBytes : null,
    temporaryDiskBytes: typeof report.temporaryDiskBytes === "number" ? report.temporaryDiskBytes : null,
    restoreReadiness: findValue(report, "restoreReadiness") ?? null,
    keyReadiness: findValue(report, "keyReadiness") ?? null,
    pendingMigrations: Array.isArray(verification?.pendingMigrations) ? verification.pendingMigrations : [],
    migrations: Array.isArray(verification?.migrations) ? verification.migrations : [],
    timings: safeTimings,
  };
}

async function runOperation({ action, cli, fixture, packagePath, opRoot, passphrase, sampleMs, timeoutMs, secrets, roots, evidenceDir, label }) {
  const opDir = join(opRoot, label);
  const tempRoot = join(opDir, "temp");
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  chmodSync(tempRoot, 0o700);
  const outputPath = action === "create" ? join(opDir, "backup.shbackup") : null;
  const targetPath = action === "dry-run" || action === "apply" ? join(opDir, "restored") : null;
  const resourcePath = join(opDir, "resource.json");
  const rawStdout = join(opDir, "stdout.raw");
  const rawStderr = join(opDir, "stderr.raw");
  const preloadPath = join(opRoot, "resource-preload.cjs");
  writeFileSync(preloadPath, PRELOAD, { mode: 0o600 });
  const args = [];
  if (action === "create") args.push("backup", "create", "--data-dir", fixture.dataDir, "--db", fixture.dbPath, "--output", outputPath, "--passphrase-stdin", "--json");
  if (action === "verify") args.push("backup", "verify", packagePath, "--passphrase-stdin", "--json");
  if (action === "dry-run") args.push("backup", "restore", packagePath, "--data-dir", targetPath, "--passphrase-stdin", "--json");
  if (action === "apply") args.push("backup", "restore", packagePath, "--data-dir", targetPath, "--apply", "--passphrase-stdin", "--json");
  const env = {
    ...process.env,
    SEARCH_HUB_DATA_DIR: fixture.dataDir,
    SEARCH_HUB_DB_PATH: fixture.dbPath,
    SEARCH_HUB_INSTALL_DIR: REPO,
    SEARCH_HUB_MIGRATIONS_DIR: join(REPO, "packages", "db", "migrations"),
    SEARCH_HUB_CLI_CONFIG_DIR: join(opDir, "cli-config"),
    SEARCH_HUB_APP_ENTRY: join(REPO, "apps", "api", "dist", "server.mjs"),
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    SHUB_QA_RESOURCE_FILE: resourcePath,
  };
  for (const key of ["SEARCH_HUB_URL", "SEARCH_HUB_TOKEN", "SEARCH_HUB_BACKUP_PASSWORD", "SEARCH_HUB_ENCRYPTION_KEY"]) delete env[key];
  if (cli.invocation.runtime === "standalone") env.PATH = "";
  const nodePrefix = cli.invocation.runtime === "node" || cli.invocation.runtime === "node-tsx";
  const invocationPrefix = [...cli.invocation.prefix];
  if (nodePrefix) {
    invocationPrefix.unshift("--require", preloadPath);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preloadPath)}`.trim();
  }
  const outDescriptor = openSync(rawStdout, "wx", 0o600);
  const errDescriptor = openSync(rawStderr, "wx", 0o600);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawn(cli.invocation.command, [...invocationPrefix, ...args], {
    cwd: opDir,
    env,
    stdio: ["pipe", outDescriptor, errDescriptor],
    windowsHide: true,
  });
  const sampler = new Sampler(child.pid, [opDir], sampleMs);
  sampler.start();
  child.stdin.on("error", () => {});
  child.stdin.end(`${passphrase}\n`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { killOwnedTree(child.pid); } catch { /* Preserve timeout evidence. */ }
  }, timeoutMs);
  const exit = await new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolveExit({ code, signal, error: null }));
  });
  clearTimeout(timer);
  const sampling = await sampler.stop();
  closeSync(outDescriptor);
  closeSync(errDescriptor);
  const stdout = sanitize(readSmallText(rawStdout), secrets, roots);
  const stderr = sanitize(readSmallText(rawStderr), secrets, roots);
  const stdoutName = `${label}.stdout.log`;
  const stderrName = `${label}.stderr.log`;
  writeFileSync(join(evidenceDir, "logs", stdoutName), stdout || "(empty)\n", { mode: 0o600 });
  writeFileSync(join(evidenceDir, "logs", stderrName), stderr || "(empty)\n", { mode: 0o600 });
  const report = parseJsonOutput(stdout);
  const resource = readResourceSidecar(resourcePath);
  const durationMs = Date.now() - started;
  const result = {
    action,
    phase: {
      create: "capture+encrypt",
      verify: "decrypt+verify+extract",
      "dry-run": "stage+validate",
      apply: "stage+migrate+publish",
    }[action],
    startedAt,
    durationMs,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    sampling,
    processResource: resource,
    cliReport: safeCliSummary(report),
    stdoutLog: `logs/${stdoutName}`,
    stderrLog: `logs/${stderrName}`,
    rawStdoutSha256: hashFile(rawStdout),
    rawStderrSha256: hashFile(rawStderr),
    reason: stderr.trim() ? stderr.trim().slice(0, 1000) : null,
  };
  if (!sampling.supported) return { ...result, result: "BLOCKED", reasonCode: "resource_sampler_unsupported", reason: sampling.samplerError ?? "process telemetry is unavailable on this platform" };
  if (timedOut) return { ...result, result: "BLOCKED", reasonCode: "operation_timeout" };
  if (exit.code !== 0 || exit.error) return { ...result, result: "FAIL", reasonCode: "cli_nonzero" };
  const readiness = findValue(report, "restoreReadiness");
  if (action !== "dry-run" && readiness !== true) return { ...result, result: "FAIL", reasonCode: "restore_not_ready" };
  if (action === "create") {
    if (!existsSync(outputPath)) return { ...result, result: "FAIL", reasonCode: "package_missing" };
    try {
      result.kdf = inspectAgeHeader(outputPath);
      if (result.kdf.workFactor !== 18) return { ...result, result: "FAIL", reasonCode: "non_default_kdf" };
    } catch (error) {
      return { ...result, result: "FAIL", reasonCode: "invalid_age_header", reason: error.message };
    }
    result.packageBytes = statSync(outputPath).size;
    result.packageSha256 = hashFile(outputPath);
  }
  if (action === "dry-run" && existsSync(targetPath)) return { ...result, result: "FAIL", reasonCode: "dry_run_wrote_target" };
  if (action === "apply") {
    const restoredDb = join(targetPath, "search-hub.db");
    const restoredKey = join(targetPath, "master.key");
    if (!existsSync(restoredDb) || !existsSync(restoredKey)) return { ...result, result: "FAIL", reasonCode: "restore_incomplete" };
    if (existsSync(`${restoredDb}-wal`) || existsSync(`${restoredDb}-shm`)) return { ...result, result: "FAIL", reasonCode: "restore_sidecar_left" };
    const key = Buffer.from(readFileSync(restoredKey, "utf8").trim(), "hex");
    result.restoredDbBytes = statSync(restoredDb).size;
    result.restoredDbSha256 = hashFile(restoredDb);
    result.restoredSummary = databaseSummary(restoredDb, key);
    if (result.restoredSummary.integrity !== "ok" || result.restoredSummary.foreignKeyViolations !== 0 || result.restoredSummary.ciphertextSampleDecryptable !== true) {
      return { ...result, result: "FAIL", reasonCode: "restored_database_invalid" };
    }
  }
  const tempAfter = await measureDisk(tempRoot);
  const stagingLeft = readdirSync(opDir).filter((name) => name.startsWith(".") && /shub|shbak|restore|backup/i.test(name));
  const tempEntries = readdirSync(tempRoot, { recursive: true }).slice(0, 50);
  const harnessCacheOnly = tempEntries.length > 0 && tempEntries.every((entry) => String(entry).split(/[\\/]/)[0].startsWith("tsx-"));
  result.tempAfter = { bytes: tempAfter.totalBytes, stagingLeft, harnessCacheOnly, entries: tempEntries };
  if ((tempAfter.totalBytes !== 0 && !harnessCacheOnly) || stagingLeft.length > 0) return { ...result, result: "FAIL", reasonCode: "temporary_cleanup_failed" };
  return { ...result, result: "PASS" };
}

function assessGrowth(operations) {
  const allVerify = operations.filter((operation) => operation.action === "verify");
  const verify = allVerify.filter((operation) => operation.result === "PASS");
  const samplingRssEndBytes = verify.map((operation) => operation.sampling?.rssBytes?.end ?? null);
  const handles = verify.map((operation) => operation.sampling?.handles?.end ?? null);
  const rss = verify.map((operation) => operation.processResource?.rssBytes ?? null);
  const metadata = { rssSource: "process-sidecar", rssEndBytes: rss, samplingRssEndBytes, handlesEnd: handles };
  if (verify.length < 5) return { ...metadata, result: "BLOCKED", reason: "fewer than five measured verify rounds" };
  if (allVerify.some((operation) => !Number.isFinite(operation.processResource?.rssBytes) || operation.processResource.rssBytes <= 0)) {
    return { ...metadata, result: "BLOCKED", reason: "process sidecar rssBytes is missing or invalid for a verify operation" };
  }
  const rssPositive = rss.slice(1).filter((value, index) => value > rss[index]).length;
  const handlesPositive = handles.slice(1).filter((value, index) => value > handles[index]).length;
  const sustained = (rssPositive >= 4 && rss.at(-1) > Math.max(...rss.slice(0, -1))) ||
    (handlesPositive >= 4 && handles.at(-1) > Math.max(...handles.slice(0, -1)));
  return {
    ...metadata,
    result: sustained ? "FAIL" : "PASS",
    sustainedGrowth: sustained,
    note: "No fixed RSS threshold; sustained monotonic growth is a failure, noise/insufficient data is BLOCKED.",
  };
}

async function runIntegratedMemoryLoop({ sizeMiB, fixture, packagePath, passphrase, verifier, source, evidenceDir, workRoot, ownerRoot, options }) {
  const memoryDir = join(evidenceDir, "reports", `memory-loop-${sizeMiB}`);
  mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
  const memoryTemp = join(workRoot, `memory-loop-${sizeMiB}-temp`);
  mkdirSync(memoryTemp, { recursive: true, mode: 0o700 });
  const packageSha256 = hashFile(packagePath);
  const sourceSha256 = hashFile(fixture.dbPath);
  const loop = await memoryLoop({
    verifier,
    mode: "final",
    packagePath,
    passphrase,
    expectedMasterKey: null,
    tempRoot: memoryTemp,
    ownerRoot,
    rounds: Math.max(5, options.rounds),
    warmup: Math.max(2, options.warmup),
  });
  const unchanged = hashFile(packagePath) === packageSha256 && hashFile(fixture.dbPath) === sourceSha256;
  const verdict = !unchanged || loop.result === "FAIL" ? "FAIL" : source.dirty ? "BLOCKED" : loop.result;
  const requirements = initialRequirements();
  requirements.R34 = verdict;
  const manifest = {
    schemaVersion: 1,
    kind: "search-hub-disaster-recovery-memory-loop",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    source,
    tool: { script: "tests/disaster-recovery/backup-memory-loop.mjs", node: process.version, platform: process.platform, arch: process.arch, gcAvailable: typeof globalThis.gc === "function", integratedFrom: "backup-performance.mjs" },
    schedule: { rounds: Math.max(5, options.rounds), warmup: Math.max(2, options.warmup), adapterMode: "final", serial: true, sameProcess: true, sizeMiB },
    preflight: {
      package: { bytes: statSync(packagePath).size, sha256: packageSha256, kdf: inspectAgeHeader(packagePath) },
      sourceDb: { bytes: statSync(fixture.dbPath).size, sha256: sourceSha256 },
    },
    loop,
    requirements,
    requirementEvidence: {
      R34: { scope: "same-process-core-verifier", sizeMiB, developmentSubset: loop.result, result: verdict },
      A11: { scope: "partial-performance-sub-evidence-only", performanceSubset: loop.result, m04Regression: "NOT TESTED", faultInjection: "NOT TESTED", fullRegressionAndPlatformPackages: "NOT TESTED", result: "BLOCKED" },
    },
    statusVocabulary: ["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT IMPLEMENTED"],
    scope: "same-process verifier memory subevidence; not a full R/A gate",
    verdict,
  };
  if (source.dirty && verdict === "BLOCKED") manifest.blockers = ["dirty development tree: same-process subset ran but exact-SHA acceptance is BLOCKED"];
  if (!unchanged) manifest.blockers = ["source or package hash changed during verification"];
  writeEvidenceManifest(memoryDir, manifest);
  writeSums(memoryDir);
  return { path: relative(evidenceDir, memoryDir).replaceAll("\\", "/"), verdict, loopResult: loop.result, manifestSha256: hashFile(join(memoryDir, "manifest.json")) };
}

async function runCycle({ mode, round, sizeMiB, fixture, cli, options, secrets, roots, evidenceDir, workRoot, ownerRoot, memoryVerifier, source }) {
  const label = `${sizeMiB}mib-${mode}-r${round}`;
  const opRoot = join(workRoot, label);
  mkdirSync(opRoot, { recursive: true, mode: 0o700 });
  const operations = [];
  let packagePath = null;
  for (const action of ["create", "verify", "dry-run", "apply"]) {
    const operation = await runOperation({
      action,
      cli,
      fixture,
      packagePath,
      opRoot,
      passphrase: secrets.passphrase,
      sampleMs: options.sampleMs,
      timeoutMs: options.timeoutMs,
      secrets: [secrets.passphrase, fixture.key.toString("hex")],
      roots,
      evidenceDir,
      label: `${label}-${action}`,
    });
    operations.push(operation);
    if (action === "create") packagePath = join(opRoot, `${label}-create`, "backup.shbackup");
    if (operation.result !== "PASS") break;
  }
  let integratedMemory = null;
  if (memoryVerifier && options.memoryLoop && mode === "repeated" && round === 1 && REQUIRED_SIZES.includes(sizeMiB) && packagePath && existsSync(packagePath)) {
    try {
      integratedMemory = await runIntegratedMemoryLoop({ sizeMiB, fixture, packagePath, passphrase: secrets.passphrase, verifier: memoryVerifier, source, evidenceDir, workRoot, ownerRoot, options });
    } catch (error) {
      integratedMemory = { verdict: "BLOCKED", error: sanitize(error instanceof Error ? error.message : String(error), [secrets.passphrase], roots).slice(0, 1000) };
    }
  }
  const growth = assessGrowth(operations);
  let result = operations.some((operation) => operation.result === "FAIL") || growth.result === "FAIL" || integratedMemory?.verdict === "FAIL"
    ? "FAIL"
    : operations.every((operation) => operation.result === "PASS") && operations.length === 4 && integratedMemory?.verdict !== "BLOCKED" ? "PASS" : "BLOCKED";
  let cleanup = { ok: true, removed: true, path: opRoot };
  if (!options.keepArtifacts) cleanup = removeOwned(opRoot, ownerRoot);
  if (!cleanup.ok) {
    result = "BLOCKED";
    process.stderr.write(`owned temporary cleanup failed; preserved path: ${cleanup.path}\n`);
  }
  return { label, mode, round, sizeMiB, result, operations, growth, integratedMemory, cleanup: { ok: cleanup.ok, removed: cleanup.removed, error: cleanup.error ?? null } };
}

function writeEvidenceManifest(outputDir, manifest) {
  const manifestPath = join(outputDir, "manifest.json");
  const temporary = join(outputDir, ".manifest.tmp");
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, manifestPath);
}

function writeSums(outputDir) {
  const files = [];
  const pending = [outputDir];
  while (pending.length > 0) {
    const current = pending.shift();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(path);
    }
  }
  const lines = files.sort().map((path) => `${hashFile(path)}  ${relative(outputDir, path).replaceAll("\\", "/")}`);
  writeFileSync(join(outputDir, "SHA256SUMS"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

function createOutputDirectory(requested) {
  const path = requested ? resolve(requested) : join(REPO, "artifacts", "disaster-recovery", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("output directory must be a real directory");
    if (readdirSync(path).length > 0) throw new Error("output directory must be empty");
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
  mkdirSync(join(path, "logs"), { mode: 0o700 });
  return path;
}

function normalizedPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Remove only a recorded owned path whose current realpath remains under its owner. */
function removeOwned(path, ownerRoot) {
  const target = resolve(path);
  const owner = normalizedPath(ownerRoot);
  if (!existsSync(target)) return { ok: true, removed: false, path: target };
  let actual;
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error("owned path became a symlink");
    actual = normalizedPath(realpathSync(target));
  } catch (error) {
    return { ok: false, removed: false, path: target, error: error instanceof Error ? error.message : String(error) };
  }
  if (actual !== owner && !actual.startsWith(`${owner}${sep}`)) {
    return { ok: false, removed: false, path: target, error: "owned path no longer resolves under its recorded owner" };
  }
  try {
    rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 10 : 3,
      retryDelay: 200,
    });
    return { ok: !existsSync(target), removed: !existsSync(target), path: target };
  } catch (error) {
    return { ok: false, removed: false, path: target, error: error instanceof Error ? error.message : String(error) };
  }
}

async function selfCheck() {
  const root = mkdtempSync(join(tmpdir(), "sh-dr-self-check-"));
  const ownerRoot = realpathSync(root);
  const checks = [];
  let cleanup = { ok: true, removed: true, path: root };
  try {
    checks.push({ name: "sha256", ok: sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    checks.push({ name: "requirement_status_schema", ok: Object.keys(initialRequirements()).length === 50 && initialRequirements().R20 === "NOT TESTED" });
    const source = gitInfo();
    checks.push({ name: "exact_sha_fingerprint", ok: /^[0-9a-f]{40}$/.test(source.commit ?? "") && /^[0-9a-f]{64}$/.test(source.releaseCodeFingerprint ?? "") });
    const mockResults = [10, 64, 128, 256].map((sizeMiB) => ({
      sizeMiB,
      result: "PASS",
      growth: { result: "PASS" },
      resourceComplete: true,
      rounds: [{ operations: [{ action: "verify", result: "PASS" }] }],
      freshProcessRounds: [{ operations: [{ action: "verify", result: "PASS" }] }],
    }));
    const derived = deriveRequirementStatuses({ preflight: { cli: { runtime: "standalone" } }, results: mockResults }, { sizes: [10, 64, 128, 256], rounds: 5, freshRounds: 1, singleRound: false });
    checks.push({ name: "requirement_derivation", ok: derived.requirements.R20 === "PASS" && derived.requirements.R34 === "BLOCKED" && derived.evidence.R34.performanceSubset === "PASS" && derived.requirements.A04 === "BLOCKED" && derived.requirements.A11 === "BLOCKED" });
    const relativeCli = "packages/cli/dist/index.mjs";
    const invocation = cliInvocation(relativeCli);
    checks.push({ name: "cli_path_absolute", ok: invocation.runtime === "node" && invocation.prefix[0] === resolve(relativeCli) });
    const growthOperations = (sidecarRss, samplingRss) => sidecarRss.map((rssBytes, index) => ({
      action: "verify",
      result: "PASS",
      processResource: rssBytes === null ? null : { rssBytes },
      sampling: { rssBytes: { end: samplingRss[index] }, handles: { end: 10 } },
    }));
    const stableGrowth = assessGrowth(growthOperations([400, 401, 399, 402, 400], [500, 300, 600, 200, 700]));
    checks.push({ name: "growth_uses_stable_process_sidecar", ok: stableGrowth.result === "PASS" && stableGrowth.rssSource === "process-sidecar" && stableGrowth.samplingRssEndBytes.at(-1) === 700 });
    checks.push({ name: "growth_detects_sidecar_sustained_increase", ok: assessGrowth(growthOperations([400, 410, 420, 430, 440], [100, 100, 100, 100, 100])).result === "FAIL" });
    checks.push({ name: "growth_blocks_missing_sidecar", ok: assessGrowth(growthOperations([400, 401, null, 402, 400], [100, 100, 100, 100, 100])).result === "BLOCKED" });
    const header = join(root, "valid.age");
    writeFileSync(header, Buffer.from(`age-encryption.org/v1\n-> scrypt ${Buffer.alloc(16, 7).toString("base64")} 18\n--- ${"A".repeat(43)}\n`, "ascii"));
    checks.push({ name: "age_header", ok: inspectAgeHeader(header).workFactor === 18 });
    const fixture = createFixture(join(root, "fixture"), 1, join(REPO, "packages", "db", "migrations"));
    checks.push({ name: "real_sqlite_fixture", ok: fixture.bytes >= MIB && fixture.summary.integrity === "ok" && fixture.summary.apiKeyCount === 1 });
    checks.push({ name: "key_sample", ok: fixture.summary.ciphertextSampleDecryptable === true });
    const disk = await measureDisk(root);
    checks.push({ name: "disk_sampler", ok: disk.totalBytes >= fixture.bytes });
    const output = join(root, "evidence");
    createOutputDirectory(output);
    writeEvidenceManifest(output, { schemaVersion: 1, selfCheck: true });
    writeSums(output);
    checks.push({ name: "evidence_sums", ok: readFileSync(join(output, "SHA256SUMS"), "utf8").includes("manifest.json") });
    const preloadPath = join(root, "resource-preload.cjs");
    const resourcePath = join(root, "resource.json");
    writeFileSync(preloadPath, PRELOAD, { mode: 0o600 });
    const sidecarRun = spawnSync(process.execPath, ["--require", preloadPath, "-e", "process.stdout.write('sidecar-ok')"], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: "", SHUB_QA_RESOURCE_FILE: resourcePath },
      encoding: "utf8",
      timeout: 15_000,
    });
    let sidecar = null;
    try { sidecar = JSON.parse(readFileSync(resourcePath, "utf8")); } catch { /* Reported as a failed check. */ }
    const sidecarFields = ["heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes", "rssBytes", "maxRssBytes", "userCpuMs", "systemCpuMs"];
    checks.push({
      name: "resource_preload_sidecar",
      ok: sidecarRun.status === 0 && sidecarFields.every((field) => Number.isFinite(sidecar?.[field])) &&
        sidecarFields.slice(0, 6).every((field) => sidecar[field] > 0) && sidecar.userCpuMs >= 0 && sidecar.systemCpuMs >= 0,
    });
  } finally {
    cleanup = removeOwned(root, ownerRoot);
    checks.push({ name: "owned_cleanup", ok: cleanup.ok && !existsSync(root) });
    if (!cleanup.ok) process.stderr.write(`owned temporary cleanup failed; preserved path: ${cleanup.path}\n`);
  }
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, checks, tempCleaned: cleanup.ok && !existsSync(root), cleanupError: cleanup.error ?? null }, null, 2)}\n`);
  return ok ? 0 : 1;
}

function initialRequirements() {
  return Object.fromEntries([...R_REQUIREMENTS, ...A_REQUIREMENTS].map((id) => [id, "NOT TESTED"]));
}

function deriveRequirementStatuses(manifest, options) {
  const requirements = initialRequirements();
  const evidence = {};
  const bySize = new Map(manifest.results.map((result) => [result.sizeMiB, result]));
  const result128 = bySize.get(128);
  if (result128) {
    const rounds = [...result128.rounds, ...result128.freshProcessRounds];
    const verifies = rounds.flatMap((round) => round.operations).filter((operation) => operation.action === "verify");
    requirements.R20 = verifies.some((operation) => operation.result === "FAIL") ? "FAIL" : verifies.length > 0 && verifies.every((operation) => operation.result === "PASS") ? "PASS" : "BLOCKED";
    evidence.R20 = { scope: "offline-128MiB-cli-verify", sizeMiB: 128, verifyCount: verifies.length, result: requirements.R20 };
  } else if (options.sizes.includes(128)) {
    requirements.R20 = "BLOCKED";
    evidence.R20 = { scope: "offline-128MiB-cli-verify", result: "BLOCKED", reason: "128MiB result missing" };
  }
  const requiredResults = REQUIRED_SIZES.map((size) => bySize.get(size));
  if (requiredResults.every(Boolean)) {
    const failed = requiredResults.some((result) => result.result === "FAIL" || result.growth?.result === "FAIL");
    const complete = options.rounds >= 5 && options.freshRounds >= 1 && !options.singleRound;
    const performanceSubset = failed ? "FAIL" : complete && requiredResults.every((result) => result.result === "PASS" && result.growth?.result === "PASS") ? "PASS" : "BLOCKED";
    const sameProcessPass = requiredResults.every((result) => result.memoryLoop?.loopResult === "PASS");
    const sameProcessEvidence = !options.memoryLoop ? "NOT TESTED" : sameProcessPass ? (manifest.source.dirty ? "BLOCKED" : "PASS") : "BLOCKED";
    requirements.R34 = "BLOCKED";
    evidence.R34 = { scope: "cross-process-performance-subset-only", sizesMiB: REQUIRED_SIZES, rounds: options.rounds, freshProcessRounds: options.freshRounds, performanceSubset, sameProcessEvidence, memoryReports: requiredResults.map((result) => result.memoryLoop?.path ?? null), result: requirements.R34, reason: "fresh CLI processes cannot prove same-process retained-memory behavior; independent reports/memory-loop is required" };
  } else if (options.singleRound || REQUIRED_SIZES.some((size) => options.sizes.includes(size))) {
    requirements.R34 = "BLOCKED";
    evidence.R34 = { scope: "cross-process-performance-subset-only", performanceSubset: "BLOCKED", sameProcessEvidence: "NOT TESTED", result: "BLOCKED", reason: "full 10/64/256 multi-round schedule incomplete and same-process evidence is separate" };
  }
  const cliRuntime = manifest.preflight.cli?.runtime ?? null;
  const standalonePart = requirements.R20 === "PASS" && cliRuntime === "standalone";
  requirements.A04 = standalonePart ? "BLOCKED" : requirements.R20 === "FAIL" ? "FAIL" : "BLOCKED";
  evidence.A04 = {
    scope: "partial-performance-sub-evidence-only",
    cliRuntime,
    standaloneCreateVerify128MiB: standalonePart,
    legacyExternalKey: "NOT TESTED",
    result: requirements.A04,
    reason: standalonePart ? "standalone/128MiB subset passed; legacy external-key and full packaged-platform matrix are outside this script" : "standalone/128MiB subset not proven",
  };
  const performanceComplete = requiredResults.every(Boolean) && options.rounds >= 5 && options.freshRounds >= 1 && !options.singleRound;
  const performanceFailed = requiredResults.some((result) => result?.result === "FAIL");
  requirements.A11 = performanceFailed ? "FAIL" : performanceComplete && requiredResults.every((result) => result.result === "PASS" && result.resourceComplete && result.growth?.result === "PASS") ? "BLOCKED" : "BLOCKED";
  evidence.A11 = {
    scope: "partial-performance-sub-evidence-only",
    performanceSubset: performanceComplete && requiredResults.every((result) => result.result === "PASS" && result.resourceComplete && result.growth?.result === "PASS") ? "PASS" : performanceFailed ? "FAIL" : "BLOCKED",
    m04Regression: "NOT TESTED",
    faultInjection: "NOT TESTED",
    fullRegressionAndPlatformPackages: "NOT TESTED",
    result: requirements.A11,
    reason: "A11 also requires M04, fault injection, full regression and real packaged platform chains; this script cannot pass all of A11",
  };
  return { requirements, evidence };
}

async function runAcceptance(options) {
  const outputDir = createOutputDirectory(options.outputDir);
  const workParent = options.workDir ? resolve(options.workDir) : tmpdir();
  if (!existsSync(workParent)) mkdirSync(workParent, { recursive: true, mode: 0o700 });
  const workRoot = mkdtempSync(join(workParent, "sh-dr-perf-"));
  chmodSync(workRoot, 0o700);
  const ownerRoot = realpathSync(workRoot);
  const roots = [workRoot, REPO, tmpdir(), process.env.HOME, process.env.USERPROFILE].filter(Boolean);
  const manifest = {
    schemaVersion: 1,
    kind: "search-hub-disaster-recovery-performance",
    startedAt: new Date().toISOString(),
    source: gitInfo(),
    tool: { script: relative(REPO, SCRIPT).replaceAll("\\", "/"), node: process.version, platform: process.platform, arch: process.arch },
    schedule: {
      sizesMiB: options.sizes,
      warmupRounds: options.warmup,
      measuredRounds: options.rounds,
      freshProcessRounds: options.freshRounds,
      singleRoundSmoke: options.singleRound,
      sampleMs: options.sampleMs,
      timeoutMs: options.timeoutMs,
      serial: true,
    },
    preflight: {},
    results: [],
    requirements: initialRequirements(),
    requirementEvidence: {},
    statusVocabulary: ["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT IMPLEMENTED"],
    scope: "performance-only; requirements not listed in requirementEvidence remain NOT TESTED",
    verdict: "BLOCKED",
  };
  let passphrase = `synthetic-dr-${randomBytes(24).toString("hex")}`;
  if (options.passphraseFile) {
    const info = lstatSync(options.passphraseFile);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("passphrase file must be a regular file");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("passphrase file must not be group/other accessible");
    passphrase = readFileSync(options.passphraseFile, "utf8").replace(/\r?\n$/, "");
  }
  try {
    if (Array.from(passphrase.trim()).length < 12) {
      manifest.preflight.passphrase = { ok: false, reason: "passphrase has fewer than 12 Unicode code points after trim" };
      return 75;
    }
    const memory = memoryInfo();
    const disk = diskInfo(workParent);
    manifest.preflight.resources = { memory, disk };
    const largest = Math.max(...options.sizes);
    const estimatedMemory = Math.max(768 * MIB, largest * 3 * MIB + 512 * MIB);
    const estimatedDisk = largest * 5 * MIB + 256 * MIB;
    if (memory.availableBytes < estimatedMemory || disk.availableBytes < estimatedDisk) {
      manifest.preflight.resources.ok = false;
      manifest.preflight.resources.reason = "insufficient available memory or disk for serial fixture/KDF/staging";
      manifest.preflight.resources.estimatedMemoryBytes = estimatedMemory;
      manifest.preflight.resources.estimatedDiskBytes = estimatedDisk;
      manifest.finishedAt = new Date().toISOString();
      writeEvidenceManifest(outputDir, manifest);
      writeSums(outputDir);
      return 75;
    }
    manifest.preflight.resources.ok = true;
    if (manifest.source.dirty && !options.allowDirty) {
      manifest.preflight.source = { ok: false, reason: "working tree is dirty; exact-SHA acceptance requires a clean tree" };
      manifest.finishedAt = new Date().toISOString();
      writeEvidenceManifest(outputDir, manifest);
      writeSums(outputDir);
      return 75;
    }
    if (!manifest.source.commit || !manifest.source.releaseCodeFingerprint) {
      manifest.preflight.source = { ok: false, reason: "exact source commit or releaseCodeFingerprint is unavailable" };
      manifest.finishedAt = new Date().toISOString();
      writeEvidenceManifest(outputDir, manifest);
      writeSums(outputDir);
      return 75;
    }
    const cliPath = options.cli ? resolve(options.cli) : join(REPO, "packages", "cli", "dist", "index.mjs");
    const cli = preflightCli(cliPath);
    manifest.tool.cli = cliPath ? basename(cliPath) : null;
    manifest.tool.cliVersion = cli.version ?? null;
    if (!cli.ok) {
      manifest.preflight.cli = { ok: false, reason: cli.reason };
      manifest.finishedAt = new Date().toISOString();
      writeEvidenceManifest(outputDir, manifest);
      writeSums(outputDir);
      return 75;
    }
    manifest.preflight.cli = { ok: true, runtime: cli.invocation.runtime, version: cli.version };
    let memoryVerifier = null;
    if (options.memoryLoop) {
      try {
        const core = await import(pathToFileURL(join(REPO, "packages", "backup", "src", "index.ts")).href);
        if (typeof core.verifyDatabaseBackup !== "function") throw new Error("verifyDatabaseBackup export is missing");
        memoryVerifier = core.verifyDatabaseBackup;
        manifest.preflight.memoryLoop = { ok: true, mode: "final", export: "verifyDatabaseBackup" };
      } catch (error) {
        manifest.preflight.memoryLoop = { ok: false, reason: `NOT IMPLEMENTED/BLOCKED: ${error instanceof Error ? error.message : String(error)}` };
      }
    } else {
      manifest.preflight.memoryLoop = { ok: false, reason: "disabled by --no-memory-loop; R34 remains BLOCKED" };
    }
    const migrationsDir = join(REPO, "packages", "db", "migrations");
    for (const sizeMiB of options.sizes) {
      const fixtureStarted = Date.now();
      const fixture = createFixture(join(workRoot, `fixture-${sizeMiB}`), sizeMiB, migrationsDir);
      const fixtureDurationMs = Date.now() - fixtureStarted;
      const sizeResult = {
        sizeMiB,
        fixtureDurationMs,
        fixture: { bytes: fixture.bytes, sha256: fixture.sha256, keyFingerprint: fixture.keyFingerprint, summary: fixture.summary },
        warmup: [],
        rounds: [],
        freshProcessRounds: [],
        result: "BLOCKED",
      };
      for (let round = 1; round <= options.warmup; round += 1) {
        sizeResult.warmup.push(await runCycle({ mode: "warmup", round, sizeMiB, fixture, cli, options, secrets: { passphrase }, roots, evidenceDir: outputDir, workRoot, ownerRoot, memoryVerifier, source: manifest.source }));
      }
      for (let round = 1; round <= options.rounds; round += 1) {
        sizeResult.rounds.push(await runCycle({ mode: "repeated", round, sizeMiB, fixture, cli, options, secrets: { passphrase }, roots, evidenceDir: outputDir, workRoot, ownerRoot, memoryVerifier, source: manifest.source }));
      }
      for (let round = 1; round <= options.freshRounds; round += 1) {
        sizeResult.freshProcessRounds.push(await runCycle({ mode: "fresh-process", round, sizeMiB, fixture, cli, options, secrets: { passphrase }, roots, evidenceDir: outputDir, workRoot, ownerRoot, memoryVerifier, source: manifest.source }));
      }
      const measured = [...sizeResult.rounds, ...sizeResult.freshProcessRounds];
      sizeResult.memoryLoop = sizeResult.rounds.find((round) => round.integratedMemory)?.integratedMemory ?? null;
      sizeResult.growth = assessGrowth(measured.flatMap((round) => round.operations));
      sizeResult.resourceComplete = measured.every((round) => round.operations.every((operation) => operation.processResource !== null));
      sizeResult.result = measured.some((round) => round.result === "FAIL") || sizeResult.growth.result === "FAIL"
        ? "FAIL"
        : measured.length > 0 && measured.every((round) => round.result === "PASS") && sizeResult.growth.result === "PASS" && sizeResult.resourceComplete ? "PASS" : "BLOCKED";
      if (!sizeResult.resourceComplete) sizeResult.blockers = ["heap/external/RSS sidecar unavailable for one or more CLI operations"];
      sizeResult.sourceUnchanged = hashFile(fixture.dbPath) === fixture.sha256;
      if (!sizeResult.sourceUnchanged) sizeResult.result = "FAIL";
      manifest.results.push(sizeResult);
      if (!options.keepArtifacts) {
        const cleanup = removeOwned(join(workRoot, `fixture-${sizeMiB}`), ownerRoot);
        sizeResult.cleanup = { ok: cleanup.ok, removed: cleanup.removed, error: cleanup.error ?? null };
        if (!cleanup.ok) {
          sizeResult.result = "BLOCKED";
          sizeResult.blockers = [...(sizeResult.blockers ?? []), "owned fixture cleanup failed; path printed to stderr"];
          process.stderr.write(`owned fixture cleanup failed; preserved path: ${cleanup.path}\n`);
        }
      }
    }
    const derivedRequirements = deriveRequirementStatuses(manifest, options);
    manifest.requirements = derivedRequirements.requirements;
    manifest.requirementEvidence = derivedRequirements.evidence;
    const complete = REQUIRED_SIZES.every((size) => options.sizes.includes(size)) && options.rounds >= 5 && options.freshRounds >= 1 && !options.singleRound;
    manifest.acceptanceComplete = complete;
    if (manifest.results.some((result) => result.result === "FAIL")) manifest.verdict = "FAIL";
    else if (!complete || manifest.results.some((result) => result.result !== "PASS")) manifest.verdict = "BLOCKED";
    else manifest.verdict = "PASS";
    if (!complete) manifest.blockers = ["partial schedule is smoke evidence only, not full performance acceptance"];
    if (manifest.source.dirty && manifest.verdict === "PASS") {
      manifest.verdict = "BLOCKED";
      manifest.requirements.R20 = "BLOCKED";
      if (manifest.requirementEvidence.R20) manifest.requirementEvidence.R20.developmentSubset = "PASS";
      manifest.blockers = [...(manifest.blockers ?? []), "dirty development tree: performance subset ran but exact-SHA acceptance is BLOCKED"];
    }
  } catch (error) {
    manifest.verdict = "BLOCKED";
    manifest.blockers = [sanitize(error instanceof Error ? error.stack ?? error.message : String(error), [passphrase], roots).slice(0, 4000)];
  } finally {
    if (!options.keepArtifacts) {
      const cleanup = removeOwned(workRoot, ownerRoot);
      manifest.cleanup = { ok: cleanup.ok, removed: cleanup.removed, error: cleanup.error ?? null };
      if (!cleanup.ok) {
        if (manifest.verdict === "PASS") manifest.verdict = "BLOCKED";
        manifest.blockers = [...(manifest.blockers ?? []), "owned work-root cleanup failed; path printed to stderr"];
        process.stderr.write(`owned work-root cleanup failed; preserved path: ${cleanup.path}\n`);
      }
    } else {
      manifest.cleanup = { ok: true, removed: false, retained: true };
    }
    manifest.finishedAt = new Date().toISOString();
    writeEvidenceManifest(outputDir, manifest);
    writeSums(outputDir);
  }
  process.stdout.write(`${JSON.stringify({ result: manifest.verdict, evidenceDir: relative(REPO, outputDir).replaceAll("\\", "/"), manifestSha256: hashFile(join(outputDir, "manifest.json")) }, null, 2)}\n`);
  return manifest.verdict === "PASS" ? 0 : manifest.verdict === "FAIL" ? 1 : 75;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.run && !options.selfCheck)) {
    usage();
    return options.help ? 0 : 2;
  }
  if (options.selfCheck) return selfCheck();
  return runAcceptance(options);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
