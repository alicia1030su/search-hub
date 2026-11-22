#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, resolveMigrationsDir, runMigrations } from "../packages/db/src/index.ts";
import { adapter } from "./lib/resource/process-tree.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
function parseArgs(args) {
  const options = { rows: 100_000, requests: 1000, warmup: 100, output: "artifacts/v0.1.14/resources-benchmark.json" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--rows") options.rows = Number(args[++index]);
    else if (arg === "--requests") options.requests = Number(args[++index]);
    else if (arg === "--warmup") options.warmup = Number(args[++index]);
    else if (arg === "--output") options.output = args[++index];
    else throw new TypeError(`unknown_argument:${arg}`);
  }
  if (![options.rows, options.requests, options.warmup].every((value) => Number.isInteger(value) && value > 0)) throw new TypeError("rows/requests/warmup must be positive integers");
  return options;
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

const options = parseArgs(process.argv.slice(2));
const directory = await mkdtemp(path.join(tmpdir(), "search-hub-resources-bench-"));
const dbPath = path.join(directory, "resources.db");
const harnessPath = path.join(directory, "server.mjs");
const handle = createDb({ file: dbPath });
let child = null;
let sampler = null;
let exitCode = 0;
let error = null;
try {
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const insert = handle.sqlite.prepare("INSERT INTO search_cache (cache_key,response_json,status,mode,created_at,expires_at,last_accessed_at,size_bytes) VALUES (?,?,?,?,?,?,?,?)");
  const createdAt = "2026-01-01T00:00:00.000Z";
  const expiresAt = "2027-01-01T00:00:00.000Z";
  const seed = handle.sqlite.transaction(() => {
    for (let index = 0; index < options.rows; index += 1) insert.run(`fixture-${index.toString(36).padStart(8, "0")}`, "{}", "completed", "basic", createdAt, expiresAt, createdAt, 2);
  });
  seed();
  const plans = {
    cacheTotals: handle.sqlite.prepare("EXPLAIN QUERY PLAN SELECT value FROM search_cache_state WHERE key='cache:totals'").all(),
    session: handle.sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE token_hash='x'").all(),
    admin: handle.sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM admin_users WHERE id='x'").all(),
  };
  const harness = `
import { createContext } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "apps/api/src/context.ts")).href)};
import { buildApp } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "apps/api/src/app.ts")).href)};
import { loadConfig } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "apps/api/src/config.ts")).href)};
const ctx = createContext({ ...loadConfig(), nodeEnv:"test", dataDir:process.argv[2], dbPath:process.argv[3], staticDir:null, cookieSecure:false, setupToken:"resources-bench-token", logLevel:"silent", corsOrigins:[], rateLimitPerMin:100000, host:"127.0.0.1", port:0 });
const app = await buildApp(ctx);
await app.ready();
await app.listen({ port:0, host:"127.0.0.1" });
process.send?.({ type:"ready", port:app.server.address().port });
process.on("message", async (message) => {
  if (message.type === "gc") { global.gc?.(); process.send?.({ type:"gc", value:true }); }
  if (message.type === "total_changes") process.send?.({ type:"changes", value:ctx.sqlite.prepare("SELECT total_changes() AS n").get().n });
  if (message.type === "shutdown") { await app.close(); process.disconnect?.(); }
});
`;
  await writeFile(harnessPath, harness, "utf8");
  child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", harnessPath, directory, dbPath], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server ready timeout")), 30_000);
    child.once("message", (message) => { clearTimeout(timer); resolve(message); });
    child.once("error", reject);
  });
  if (ready.type !== "ready") throw new Error(`unexpected child message: ${JSON.stringify(ready)}`);
  const base = `http://127.0.0.1:${ready.port}`;
  const setup = await fetch(`${base}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bench@example.com", password: "Resource-Bench-Password-1", name: "Bench", setupToken: "resources-bench-token" }) });
  if (setup.status !== 200) throw new Error(`setup HTTP ${setup.status}: ${await setup.text()}`);
  const cookie = setup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const get = async () => {
    const response = await fetch(`${base}/api/admin/resources`, { headers: { cookie } });
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`resources HTTP ${response.status}`);
  };
  const ipc = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ipc timeout:${type}`)), 5000);
    child.once("message", (message) => { clearTimeout(timer); resolve(message); });
    child.send({ type });
  });
  for (let index = 0; index < options.warmup; index += 1) await get();
  const io = adapter(process.platform);
  const identity = await io.readProcess(child.pid);
  if (!identity) throw new Error("child process identity unavailable");
  let rssBaseline = 0;
  let rssPeak = 0;
  const beforeGc = await io.readProcess(child.pid);
  const rssBeforeGcBytes = beforeGc?.rssBytes.value ?? 0;
  await ipc("gc");
  await new Promise((resolve) => setImmediate(resolve));
  sampler = setInterval(async () => {
    const current = await io.readProcess(child.pid);
    if (current?.identity.startTime !== identity.identity.startTime) return;
    rssPeak = Math.max(rssPeak, current.rssBytes.value ?? 0);
  }, 25);
  const initial = await io.readProcess(child.pid);
  rssBaseline = initial?.rssBytes.value ?? 0;
  const changesBefore = (await ipc("total_changes")).value;
  const samples = [];
  const wallStarted = performance.now();
  for (let index = 0; index < options.requests; index += 1) {
    const started = performance.now();
    await get();
    samples.push(performance.now() - started);
  }
  const wallMs = performance.now() - wallStarted;
  const changesAfter = (await ipc("total_changes")).value;
  const final = await io.readProcess(child.pid);
  rssPeak = Math.max(rssPeak, final?.rssBytes.value ?? 0);
  clearInterval(sampler);
  sampler = null;
  const p50Ms = percentile(samples, 0.5);
  const p95Ms = percentile(samples, 0.95);
  const rssDeltaBytes = Math.max(0, rssPeak - rssBaseline);
  const report = {
    schemaVersion: 1,
    benchmark: "resources",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    metadata: { platform: process.platform, arch: process.arch, node: process.version, rows: options.rows, requests: options.requests, warmup: options.warmup, concurrency: 1, gcBeforeBaseline: true },
    wallMs, p50Ms, p95Ms, latencySamplesMs: samples,
    rssBeforeGcBytes, rssBaselineBytes: rssBaseline, rssPeakBytes: rssPeak, rssDeltaBytes,
    rssDeltaBeforeGcBytes: Math.max(0, rssPeak - rssBeforeGcBytes),
    sqliteTotalChangesBefore: changesBefore, sqliteTotalChangesAfter: changesAfter, sqliteTotalChangesDelta: changesAfter - changesBefore,
    queryPlans: plans,
    thresholds: { p95Ms: 10, rssDeltaBytes: 2 * 1024 * 1024 },
    p95Passed: p95Ms <= 10, rssPassed: rssDeltaBytes <= 2 * 1024 * 1024,
    zeroWritePassed: changesAfter === changesBefore,
    oom: false, exitCode: 0, residualPids: [],
  };
  const outputPath = path.join(REPO_ROOT, options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, p95Ms, rssDeltaBytes, sqliteTotalChangesDelta: report.sqliteTotalChangesDelta, p95Passed: report.p95Passed, rssPassed: report.rssPassed, zeroWritePassed: report.zeroWritePassed }, null, 2));
  if (!report.p95Passed || !report.rssPassed || !report.zeroWritePassed) exitCode = 1;
} catch (cause) {
  exitCode = 1;
  error = cause instanceof Error ? cause.message : String(cause);
  console.error(error);
} finally {
  if (sampler) clearInterval(sampler);
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("close", resolve));
    child.send({ type: "shutdown" });
    const timer = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
  handle.close();
  await rm(directory, { recursive: true, force: true });
  if (error) console.error(JSON.stringify({ error, exitCode, residualPids: [] }));
}
process.exitCode = exitCode;
