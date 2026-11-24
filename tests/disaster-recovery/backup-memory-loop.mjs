#!/usr/bin/env node
/**
 * Same-process disaster-recovery verifier memory-loop acceptance harness.
 *
 * Unlike backup-performance.mjs, this script never spawns a CLI per round. It
 * calls the verifier repeatedly inside one Node process so retained heap/native
 * growth and active-handle leaks are observable. The implementation is loaded
 * through a small adapter layer and is not modified by this file.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
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
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SCRIPT), "..", "..");
const MIB = 1024 * 1024;
const STATUS_VOCABULARY = ["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT IMPLEMENTED"];
const R_IDS = Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`);
const A_IDS = Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`);

function usage() {
  process.stdout.write(`Search Hub same-process backup verifier memory loop

Usage:
  node --expose-gc --import tsx ${relative(REPO, SCRIPT).replaceAll("\\", "/")} --help
  node --expose-gc --import tsx ${relative(REPO, SCRIPT).replaceAll("\\", "/")} --self-check
  node --expose-gc --import tsx ${relative(REPO, SCRIPT).replaceAll("\\", "/")} --run \\
    --package <file.shbackup> --source-db <source.db> --passphrase-file <0600-file> \\
    [--adapter <module.ts>] [--adapter-mode current|final] [options]

Options:
  --rounds <n>          Measured rounds in one process (minimum/default: 5)
  --warmup <n>          Warm-up rounds (default: 2)
  --adapter <path>      Module exporting verifyDatabaseBackup (default: packages/backup/src/index.ts)
  --adapter-mode <mode> Input-shape adapter: final (default) or current (development only)
  --temp-parent <dir>   Parent for private per-round directories (default: os.tmpdir())
  --output-dir <dir>    New/empty evidence directory
  --allow-dirty         Record dirty tree but do not block development scheduling
  --keep-temp           Preserve owned temp root after the run (large; verdict BLOCKED)

Environment fallback: SEARCH_HUB_BACKUP_PASSPHRASE. Passphrases are never argv.
Exit codes: 0=PASS/self-check, 1=FAIL, 2=usage, 75=BLOCKED/NOT IMPLEMENTED.
`);
}

function parseArgs(argv) {
  const options = { rounds: 5, warmup: 2, adapterMode: "final", allowDirty: false, keepTemp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--self-check") options.selfCheck = true;
    else if (argument === "--run") options.run = true;
    else if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--keep-temp") options.keepTemp = true;
    else if (argument.startsWith("--")) {
      const [key, inline] = argument.slice(2).split("=", 2);
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`--${key} requires a value`);
      if (key === "rounds") options.rounds = Number(value);
      else if (key === "warmup") options.warmup = Number(value);
      else if (key === "package") options.packagePath = value;
      else if (key === "source-db") options.sourceDb = value;
      else if (key === "passphrase-file") options.passphraseFile = value;
      else if (key === "adapter") options.adapter = value;
      else if (key === "adapter-mode") options.adapterMode = value;
      else if (key === "temp-parent") options.tempParent = value;
      else if (key === "output-dir") options.outputDir = value;
      else throw new Error(`Unknown option: --${key}`);
    } else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 5) throw new Error("rounds must be an integer >= 5");
  if (!Number.isSafeInteger(options.warmup) || options.warmup < 0) throw new Error("warmup must be an integer >= 0");
  if (!["current", "final"].includes(options.adapterMode)) throw new Error("adapter-mode must be current or final");
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

function gitSource() {
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
    // Aggregators reject a missing exact-SHA fingerprint.
  }
  return {
    commit,
    releaseCodeFingerprint,
    dirty: status.length > 0,
    changedPaths: status ? status.split(/\r?\n/).length : 0,
    diffSha256: diff === null ? null : sha256(diff),
  };
}

export function initialRequirements() {
  return Object.fromEntries([...R_IDS, ...A_IDS].map((id) => [id, "NOT TESTED"]));
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  const handles = process._getActiveHandles?.() ?? [];
  return {
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    rssBytes: memory.rss,
    maxRssBytes: Number(usage.maxRSS) * 1024,
    activeHandles: handles.length,
    activeHandleTypes: [...new Set(handles.map((handle) => handle?.constructor?.name ?? "unknown"))].sort(),
    fdCount: process.platform === "linux" ? readdirSync("/proc/self/fd").length : null,
  };
}

function inspectAgeHeader(path) {
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  try { bytes = readSync(descriptor, buffer); } finally { closeSync(descriptor); }
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

async function measureDirectory(path) {
  let bytes = 0;
  let files = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop();
    let info;
    try { info = lstatSync(current); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      for (const name of readdirSync(current)) pending.push(join(current, name));
    } else if (info.isFile()) {
      bytes += info.size;
      files += 1;
    }
  }
  return { bytes, files };
}

function normalizedPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

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
    rmSync(target, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 10 : 3, retryDelay: 200 });
    return { ok: !existsSync(target), removed: !existsSync(target), path: target };
  } catch (error) {
    return { ok: false, removed: false, path: target, error: error instanceof Error ? error.message : String(error) };
  }
}

function openCurrentSqlite(path, readonly) {
  const database = new DatabaseSync(path, { readOnly: readonly, fileMustExist: true });
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        all: (...params) => statement.all(...params),
        get: (...params) => statement.get(...params),
        run: (...params) => statement.run(...params),
      };
    },
    close: () => database.close(),
  };
}

function knownMigrations() {
  return readdirSync(join(REPO, "packages", "db", "migrations")).filter((name) => name.endsWith(".sql")).sort();
}

function appVersion() {
  return JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
}

async function loadVerifier(adapterPath) {
  const absolute = resolve(adapterPath);
  if (!existsSync(absolute)) throw new Error("NOT IMPLEMENTED: adapter module is missing");
  const module = await import(pathToFileURL(absolute).href);
  if (typeof module.verifyDatabaseBackup !== "function") throw new Error("NOT IMPLEMENTED: adapter does not export verifyDatabaseBackup");
  return module.verifyDatabaseBackup;
}

function verifierInput({ mode, packagePath, passphrase, expectedMasterKey, privateWorkDir }) {
  if (mode === "final") {
    return {
      path: packagePath,
      passphrase,
      privateWorkDir,
      openDatabase: openCurrentSqlite,
      appVersion: appVersion(),
      knownMigrations: knownMigrations(),
      ...(expectedMasterKey ? { expectedMasterKey } : {}),
    };
  }
  return {
    path: packagePath,
    passphrase,
    tempDir: privateWorkDir,
    appVersion: appVersion(),
    knownMigrations: knownMigrations(),
    openDatabase: openCurrentSqlite,
    ...(expectedMasterKey ? { expectedMasterKey } : {}),
  };
}

function readinessOf(report) {
  return report && typeof report === "object" ? report.restoreReadiness : undefined;
}

function sanitizeMessage(message, passphrase, roots) {
  let output = String(message ?? "");
  if (passphrase) output = output.split(passphrase).join("[redacted]");
  for (const root of roots) {
    output = output.split(root).join("[redacted]");
    output = output.split(root.replaceAll("\\", "/")).join("[redacted]");
    output = output.split(root.replaceAll("/", "\\")).join("[redacted]");
  }
  return output.slice(0, 4000);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function assessSeries(samples, warmup, resolution = 1) {
  const values = samples.map((sample) => sample.afterGc);
  const deltas = values.slice(1).map((value, index) => value - values[index]);
  const warmupValues = warmup.map((sample) => sample.afterGc);
  const warmupDeltas = warmupValues.slice(1).map((value, index) => Math.abs(value - warmupValues[index]));
  const noise = Math.max(resolution, median(warmupDeltas), median(deltas.map(Math.abs)) * 0.5);
  const positive = deltas.filter((delta) => delta > 0).length;
  const total = values.at(-1) - values[0];
  const sustained = deltas.length >= 4 && positive >= deltas.length - 1 && total > 10 * noise;
  const inconclusive = !sustained && deltas.length >= 4 && positive >= deltas.length - 2 && total > 10 * noise;
  return {
    result: sustained ? "FAIL" : inconclusive ? "BLOCKED" : "PASS",
    sustainedGrowth: sustained,
    inconclusiveNoise: inconclusive,
    values,
    deltas,
    noiseBytes: noise,
    totalDeltaBytes: total,
    positiveDeltas: positive,
    rule: "FAIL requires >=n-1 positive deltas and total growth >10x warmup/MAD noise; ambiguous high-noise positive growth is BLOCKED; no fixed RSS threshold",
  };
}

function assessGrowth(rounds, warmups) {
  const series = {};
  for (const [name, resolution] of [
    ["heapUsedBytes", 1],
    ["heapTotalBytes", 1],
    ["externalBytes", 1],
    ["arrayBuffersBytes", 1],
    ["rssBytes", 1],
    ["maxRssBytes", 1],
    ["activeHandles", 1],
  ]) {
    series[name] = assessSeries(
      rounds.map((round) => ({ afterGc: round.afterGc[name] })),
      warmups.map((round) => ({ afterGc: round.afterGc[name] })),
      resolution,
    );
  }
  const corroborated = ["heapUsedBytes", "externalBytes", "arrayBuffersBytes", "activeHandles"]
    .some((name) => series[name].result === "FAIL");
  const peakFailed = series.maxRssBytes.result === "FAIL";
  // Current RSS/heap capacity can move while V8 reuses already-committed pages.
  // Stable maxRSS plus stable used heap/external/handles is allocation noise, not a leak.
  if (!corroborated && !peakFailed) {
    if (series.rssBytes.result !== "PASS") {
      series.rssBytes.classification = "rss_movement_within_stable_peak";
      series.rssBytes.result = "PASS";
    }
    if (series.heapTotalBytes.result !== "PASS") {
      series.heapTotalBytes.classification = "heap_capacity_step_with_stable_used_heap";
      series.heapTotalBytes.result = "PASS";
    }
  }
  const failed = corroborated || peakFailed || Object.values(series).some((entry) => entry.result === "FAIL");
  const blocked = Object.values(series).some((entry) => entry.result === "BLOCKED");
  return { result: failed ? "FAIL" : blocked ? "BLOCKED" : "PASS", series };
}

function createOutputDirectory(requested) {
  const path = requested ? resolve(requested) : join(REPO, "artifacts", "disaster-recovery", "memory-loop", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("output directory must be a real directory");
    if (readdirSync(path).length > 0) throw new Error("output directory must be empty");
  } else mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeManifest(outputDir, manifest) {
  const path = join(outputDir, "manifest.json");
  const temporary = join(outputDir, ".manifest.tmp");
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
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

function resourceInfo(path) {
  const memory = process.platform === "linux"
    ? (() => {
        try {
          const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
          if (match) return { availableBytes: Number(match[1]) * 1024, source: "/proc/meminfo" };
        } catch { /* OS fallback below. */ }
        return { availableBytes: process.getBuiltinModule("node:os").freemem(), source: "os.freemem" };
      })()
    : { availableBytes: process.getBuiltinModule("node:os").freemem(), source: "os.freemem" };
  const disk = statfsSync(path);
  return { memory, disk: { availableBytes: Number(disk.bavail) * Number(disk.bsize), blockBytes: Number(disk.bsize) } };
}

async function runRound({ index, verifier, mode, packagePath, passphrase, expectedMasterKey, ownerRoot, tempParent }) {
  const roundDir = mkdtempSync(join(tempParent, "sh-dr-memory-round-"));
  chmodSync(roundDir, 0o700);
  const before = memorySnapshot();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let report = null;
  let error = null;
  try {
    report = await verifier(verifierInput({ mode, packagePath, passphrase, expectedMasterKey, privateWorkDir: roundDir }));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const immediate = memorySnapshot();
  if (typeof globalThis.gc === "function") globalThis.gc();
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  const afterGc = memorySnapshot();
  const temp = await measureDirectory(roundDir);
  const cleanup = removeOwned(roundDir, ownerRoot);
  if (!cleanup.ok) process.stderr.write(`owned memory-loop cleanup failed; preserved path: ${cleanup.path}\n`);
  return {
    index,
    pid: process.pid,
    startedAt,
    durationMs: Date.now() - started,
    before,
    immediate,
    afterGc,
    tempBeforeCleanup: temp,
    cleanup: { ok: cleanup.ok, removed: cleanup.removed, error: cleanup.error ?? null },
    restoreReadiness: readinessOf(report),
    error,
    result: error ? "FAIL" : readinessOf(report) === true ? "PASS" : "FAIL",
  };
}

export async function memoryLoop({ verifier, mode, packagePath, passphrase, expectedMasterKey, tempRoot, ownerRoot, rounds, warmup }) {
  const warmups = [];
  const measured = [];
  for (let index = 1; index <= warmup; index += 1) warmups.push(await runRound({ index, verifier, mode, packagePath, passphrase, expectedMasterKey, ownerRoot, tempParent: tempRoot }));
  for (let index = 1; index <= rounds; index += 1) measured.push(await runRound({ index, verifier, mode, packagePath, passphrase, expectedMasterKey, ownerRoot, tempParent: tempRoot }));
  const growth = assessGrowth(measured, warmups);
  const failed = [...warmups, ...measured].some((round) => round.result === "FAIL") || growth.result === "FAIL";
  const blocked = [...warmups, ...measured].some((round) => round.cleanup.ok === false) || growth.result === "BLOCKED";
  return {
    pid: process.pid,
    spawnCount: 0,
    warmups,
    measured,
    growth,
    result: failed ? "FAIL" : blocked ? "BLOCKED" : "PASS",
  };
}

async function selfCheck() {
  const root = mkdtempSync(join(tmpdir(), "sh-dr-memory-self-check-"));
  const ownerRoot = realpathSync(root);
  const checks = [];
  let cleanup = { ok: true, removed: true, path: root };
  let loop = null;
  try {
    const packagePath = join(root, "fixture.shbackup");
    writeFileSync(packagePath, Buffer.from(`age-encryption.org/v1\n-> scrypt ${Buffer.alloc(16, 9).toString("base64")} 18\n--- ${"B".repeat(43)}\n`));
    checks.push({ name: "age_header", ok: inspectAgeHeader(packagePath).workFactor === 18 });
    const packageHash = hashFile(packagePath);
    checks.push({ name: "requirement_status_schema", ok: Object.keys(initialRequirements()).length === 50 && initialRequirements().R34 === "NOT TESTED" });
    const source = gitSource();
    checks.push({ name: "exact_sha_fingerprint", ok: /^[0-9a-f]{40}$/.test(source.commit ?? "") && /^[0-9a-f]{64}$/.test(source.releaseCodeFingerprint ?? "") });
    const fakeVerifier = async () => {
      const noise = Buffer.alloc(64 * 1024, 1);
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
      if (noise[0] !== 1) throw new Error("unreachable");
      return { restoreReadiness: true };
    };
    loop = await memoryLoop({ verifier: fakeVerifier, mode: "final", packagePath, passphrase: "synthetic self check passphrase", expectedMasterKey: null, tempRoot: root, ownerRoot, rounds: 5, warmup: 2 });
    checks.push({ name: "same_process", ok: loop.spawnCount === 0 && loop.measured.every((round) => round.pid === process.pid) });
    checks.push({ name: "round_cleanup", ok: loop.measured.every((round) => round.cleanup.ok && round.tempBeforeCleanup.bytes === 0) });
    checks.push({ name: "growth_classifier", ok: ["PASS", "BLOCKED"].includes(loop.growth.result) });
    checks.push({ name: "package_hash", ok: hashFile(packagePath) === packageHash });
  } finally {
    cleanup = removeOwned(root, ownerRoot);
    checks.push({ name: "owned_cleanup", ok: cleanup.ok && !existsSync(root) });
    if (!cleanup.ok) process.stderr.write(`owned memory-loop cleanup failed; preserved path: ${cleanup.path}\n`);
  }
  const ok = checks.every((check) => check.ok);
  process.stdout.write(`${JSON.stringify({ ok, checks, growth: loop?.growth ?? null, gcAvailable: typeof globalThis.gc === "function", tempCleaned: cleanup.ok && !existsSync(root) }, null, 2)}\n`);
  return ok ? 0 : 1;
}

async function runAcceptance(options) {
  const outputDir = createOutputDirectory(options.outputDir);
  const tempParent = options.tempParent ? resolve(options.tempParent) : tmpdir();
  if (!existsSync(tempParent)) mkdirSync(tempParent, { recursive: true, mode: 0o700 });
  const tempRoot = mkdtempSync(join(tempParent, "sh-dr-memory-loop-"));
  chmodSync(tempRoot, 0o700);
  const ownerRoot = realpathSync(tempRoot);
  const manifest = {
    schemaVersion: 1,
    kind: "search-hub-disaster-recovery-memory-loop",
    startedAt: new Date().toISOString(),
    source: gitSource(),
    tool: { script: relative(REPO, SCRIPT).replaceAll("\\", "/"), node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, gcAvailable: typeof globalThis.gc === "function" },
    schedule: { rounds: options.rounds, warmup: options.warmup, adapterMode: options.adapterMode, serial: true, sameProcess: true },
    preflight: {},
    requirements: initialRequirements(),
    statusVocabulary: STATUS_VOCABULARY,
    scope: "same-process verifier memory subevidence; not a full R/A gate",
    verdict: "BLOCKED",
  };
  const roots = [tempRoot, REPO, tmpdir(), process.env.HOME, process.env.USERPROFILE].filter(Boolean);
  let passphrase = null;
  try {
    if (!options.packagePath || !options.sourceDb) throw new Error("NOT IMPLEMENTED: --package and --source-db are required");
    if (options.passphraseFile) {
      const info = lstatSync(options.passphraseFile);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("BLOCKED: passphrase file must be a regular file");
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("BLOCKED: passphrase file must not be group/other accessible");
      passphrase = readFileSync(options.passphraseFile, "utf8").replace(/\r?\n$/, "");
    } else {
      passphrase = process.env.SEARCH_HUB_BACKUP_PASSPHRASE;
    }
    if (!passphrase || Array.from(passphrase.trim()).length < 12) throw new Error("NOT IMPLEMENTED: a passphrase with >=12 trimmed Unicode code points is required");
    if (typeof globalThis.gc !== "function") throw new Error("BLOCKED: run with node --expose-gc so post-GC retained memory can be measured");
    if (!existsSync(options.packagePath) || !existsSync(options.sourceDb)) throw new Error("BLOCKED: package or source database is missing");
    for (const path of [options.packagePath, options.sourceDb]) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("BLOCKED: package and source database must be regular files, not links");
    }
    if (!options.packagePath.toLowerCase().endsWith(".shbackup")) throw new Error("NOT IMPLEMENTED: package must use the final .shbackup extension");
    if (manifest.source.dirty && !options.allowDirty) throw new Error("BLOCKED: working tree is dirty; exact-SHA acceptance requires a clean tree");
    if (!manifest.source.commit || !manifest.source.releaseCodeFingerprint) throw new Error("BLOCKED: exact source commit/fingerprint is unavailable");
    const packageInfo = statSync(options.packagePath);
    const sourceInfo = statSync(options.sourceDb);
    const kdf = inspectAgeHeader(options.packagePath);
    if (kdf.workFactor !== 18) throw new Error("FAIL: package does not use the default age work factor 18");
    const resources = resourceInfo(tempParent);
    const estimatedMemory = Math.max(768 * MIB, packageInfo.size * 2 + 512 * MIB);
    const estimatedDisk = packageInfo.size * 3 + 128 * MIB;
    manifest.preflight.resources = { ...resources, estimatedMemoryBytes: estimatedMemory, estimatedDiskBytes: estimatedDisk };
    if (resources.memory.availableBytes < estimatedMemory || resources.disk.availableBytes < estimatedDisk) throw new Error("BLOCKED: insufficient memory or disk for serial same-process verification");
    manifest.preflight.package = { bytes: packageInfo.size, sha256: hashFile(options.packagePath), kdf };
    manifest.preflight.sourceDb = { bytes: sourceInfo.size, sha256: hashFile(options.sourceDb) };
    const verifier = await loadVerifier(options.adapter ?? join(REPO, "packages", "backup", "src", "index.ts"));
    manifest.preflight.adapter = { ok: true, mode: options.adapterMode, export: "verifyDatabaseBackup" };
    const loop = await memoryLoop({
      verifier,
      mode: options.adapterMode,
      packagePath: resolve(options.packagePath),
      passphrase,
      expectedMasterKey: null,
      tempRoot,
      ownerRoot,
      rounds: options.rounds,
      warmup: options.warmup,
    });
    manifest.loop = loop;
    manifest.preflight.package.sha256After = hashFile(options.packagePath);
    manifest.preflight.sourceDb.sha256After = hashFile(options.sourceDb);
    if (manifest.preflight.package.sha256After !== manifest.preflight.package.sha256 || manifest.preflight.sourceDb.sha256After !== manifest.preflight.sourceDb.sha256) {
      manifest.verdict = "FAIL";
      manifest.blockers = ["source or package hash changed during verification"];
    } else if (manifest.source.dirty) {
      manifest.verdict = "BLOCKED";
      manifest.blockers = ["dirty development tree: same-process subset ran but exact-SHA acceptance is BLOCKED"];
    } else {
      manifest.verdict = loop.result;
    }
    manifest.requirements.R34 = manifest.verdict === "PASS" ? "PASS" : manifest.verdict;
    manifest.requirementEvidence = {
      R34: { scope: "same-process-core-verifier", rounds: options.rounds, warmup: options.warmup, pid: loop.pid, spawnCount: loop.spawnCount, developmentSubset: loop.result, result: manifest.requirements.R34 },
      A11: { scope: "partial-performance-sub-evidence-only", performanceSubset: manifest.verdict, m04Regression: "NOT TESTED", faultInjection: "NOT TESTED", fullRegressionAndPlatformPackages: "NOT TESTED", result: "BLOCKED" },
    };
  } catch (error) {
    manifest.verdict = "BLOCKED";
    const message = sanitizeMessage(error instanceof Error ? error.message : String(error), passphrase, roots);
    manifest.blockers = [message];
    if (message.startsWith("FAIL:")) manifest.verdict = "FAIL";
  } finally {
    if (!options.keepTemp) {
      const cleanup = removeOwned(tempRoot, ownerRoot);
      manifest.cleanup = { ok: cleanup.ok, removed: cleanup.removed, error: cleanup.error ?? null };
      if (!cleanup.ok) {
        if (manifest.verdict === "PASS") manifest.verdict = "BLOCKED";
        manifest.blockers = [...(manifest.blockers ?? []), "owned temp-root cleanup failed; path printed to stderr"];
        process.stderr.write(`owned memory-loop cleanup failed; preserved path: ${cleanup.path}\n`);
      }
    } else {
      manifest.cleanup = { ok: true, removed: false, retained: true };
      if (manifest.verdict === "PASS") manifest.verdict = "BLOCKED";
      manifest.blockers = [...(manifest.blockers ?? []), "--keep-temp preserves owned artifacts; acceptance verdict is BLOCKED"];
    }
    if (manifest.requirements.R34 === "PASS" && manifest.verdict !== "PASS") {
      manifest.requirements.R34 = manifest.verdict;
      if (manifest.requirementEvidence?.R34) manifest.requirementEvidence.R34.result = manifest.verdict;
    }
    manifest.finishedAt = new Date().toISOString();
    writeManifest(outputDir, manifest);
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
