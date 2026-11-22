#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, resolveMigrationsDir, runMigrations } from "../packages/db/src/index.ts";
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";
import { freezeBudget } from "./lib/resource/budget.mjs";
import { OwnedProcessTree, adapter } from "./lib/resource/process-tree.mjs";
import { createLogSanitizer } from "./lib/resource/report.mjs";
import { collectSnapshot } from "./lib/resource/snapshot.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
function parseArgs(args) {
  const options = { rows: 100_000, requests: 1000, warmup: 100 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--rows") options.rows = Number(args[++index]);
    else if (arg === "--requests") options.requests = Number(args[++index]);
    else if (arg === "--warmup") options.warmup = Number(args[++index]);
    else throw new TypeError(`unknown_argument:${arg}`);
  }
  if (![options.rows, options.requests, options.warmup].every((value) => Number.isInteger(value) && value > 0)) throw new TypeError("rows/requests/warmup must be positive integers");
  return options;
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifact = await createArtifactRun({ command: "bench-resources", repoRoot: REPO_ROOT });
  const snapshot = await collectSnapshot({ cpuDelayMs: 20 });
  const budget = freezeBudget(snapshot, { peakMiB: { vitest: 512 } });
  const baseReport = {
    schemaVersion: 1,
    benchmark: "resources",
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim(),
    metadata: { platform: process.platform, arch: process.arch, node: process.version, rows: options.rows, requests: options.requests, warmup: options.warmup, concurrency: 1, gcBeforeBaseline: true },
    resourceSnapshot: snapshot,
    frozenBudget: budget,
    oom: false,
    residualPids: [],
  };
  if (!budget.stages.vitest.safe) {
    const report = { ...baseReport, status: "resource_blocked", exitCode: EXIT_CODES.resourceBlocked, reason: budget.reason };
    const outputPath = await artifact.writeJson("resources-benchmark.json", report);
    await artifact.finish({ exitCode: EXIT_CODES.resourceBlocked, reason: budget.reason, details: { benchmark: report } });
    console.log(JSON.stringify({ outputPath, status: report.status, reason: report.reason, exitCode: report.exitCode }, null, 2));
    return EXIT_CODES.resourceBlocked;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "search-hub-resources-bench-"));
  const dbPath = path.join(directory, "resources.db");
  const harnessPath = path.join(directory, "server.mjs");
  const handle = createDb({ file: dbPath });
  let child = null;
  let owned = null;
  let sampler = null;
  let stderr = "";
  let pendingReport = null;
  let pendingReason = null;
  let exitCode = EXIT_CODES.success;
  let error = null;
  const sanitizer = createLogSanitizer();
  try {
    runMigrations(handle.sqlite, resolveMigrationsDir());
    const insert = handle.sqlite.prepare("INSERT INTO search_cache (cache_key,response_json,status,mode,created_at,expires_at,last_accessed_at,size_bytes) VALUES (?,?,?,?,?,?,?,?)");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const expiresAt = "2027-01-01T00:00:00.000Z";
    handle.sqlite.transaction(() => {
      for (let index = 0; index < options.rows; index += 1) insert.run(`fixture-${index.toString(36).padStart(8, "0")}`, "{}", "completed", "basic", createdAt, expiresAt, createdAt, 2);
    })();
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
    const io = adapter(process.platform);
    const identity = await io.readProcess(child.pid);
    if (!identity) throw new Error("child_process_identity_unavailable");
    owned = new OwnedProcessTree(child.pid, identity.identity.startTime, { consoleCtrlOwned: true });
    child.stderr.on("data", (chunk) => { stderr = (stderr + sanitizer.write(String(chunk))).slice(-8192); });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server_ready_timeout")), 30_000);
      const onMessage = (message) => { cleanup(); resolve(message); };
      const onError = (cause) => { cleanup(); reject(cause); };
      const onExit = (code) => { cleanup(); reject(new Error(`server_exited_before_ready:${code}`)); };
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.once("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    if (ready.type !== "ready") throw new Error(`unexpected_child_message:${ready.type}`);
    const base = `http://127.0.0.1:${ready.port}`;
    const setup = await fetch(`${base}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bench@example.com", password: "Resource-Bench-Password-1", name: "Bench", setupToken: "resources-bench-token" }) });
    if (setup.status !== 200) throw new Error(`setup_http_${setup.status}`);
    const cookie = setup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const get = async () => {
      const response = await fetch(`${base}/api/admin/resources`, { headers: { cookie } });
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`resources_http_${response.status}`);
    };
    const ipc = (type) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ipc_timeout:${type}`)), 5000);
      const onMessage = (message) => { clearTimeout(timer); resolve(message); };
      const onExit = (code) => { clearTimeout(timer); reject(new Error(`child_exited:${code}`)); };
      child.once("message", onMessage);
      child.once("exit", onExit);
      child.send({ type }, (cause) => {
        if (cause) { clearTimeout(timer); reject(cause); }
      });
    });
    for (let index = 0; index < options.warmup; index += 1) await get();
    const beforeGc = await io.readProcess(child.pid);
    const rssBeforeGcBytes = beforeGc?.rssBytes.value ?? 0;
    await ipc("gc");
    await new Promise((resolve) => setImmediate(resolve));
    let rssBaseline = 0;
    let rssPeak = 0;
    sampler = setInterval(async () => {
      const current = await io.readProcess(child.pid);
      if (current?.identity.startTime !== identity.identity.startTime) return;
      rssPeak = Math.max(rssPeak, current.rssBytes.value ?? 0);
    }, 25);
    rssBaseline = (await io.readProcess(child.pid))?.rssBytes.value ?? 0;
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
    rssPeak = Math.max(rssPeak, (await io.readProcess(child.pid))?.rssBytes.value ?? 0);
    await ipc("gc");
    await new Promise((resolve) => setImmediate(resolve));
    const final = await io.readProcess(child.pid);
    clearInterval(sampler);
    sampler = null;
    const p50Ms = percentile(samples, 0.5);
    const p95Ms = percentile(samples, 0.95);
    const rssDeltaBytes = Math.max(0, (final?.rssBytes.value ?? 0) - rssBaseline);
    const rssPeakDeltaBytes = Math.max(0, rssPeak - rssBaseline);
    const report = {
      ...baseReport,
      wallMs, p50Ms, p95Ms, latencySamplesMs: samples,
      rssBeforeGcBytes, rssBaselineBytes: rssBaseline, rssPeakBytes: rssPeak, rssDeltaBytes,
      rssPeakDeltaBytes, rssDeltaBeforeGcBytes: Math.max(0, rssPeak - rssBeforeGcBytes),
      sqliteTotalChangesBefore: changesBefore, sqliteTotalChangesAfter: changesAfter, sqliteTotalChangesDelta: changesAfter - changesBefore,
      queryPlans: plans,
      thresholds: { p95Ms: 10, retainedRssDeltaBytes: 2 * 1024 * 1024, rssBasis: "post_warmup_gc_to_post_run_gc" },
      p95Passed: p95Ms <= 10, rssPassed: rssDeltaBytes <= 2 * 1024 * 1024,
      zeroWritePassed: changesAfter === changesBefore,
      status: "success", exitCode: EXIT_CODES.success, reason: null,
    };
    if (!report.p95Passed || !report.rssPassed || !report.zeroWritePassed) {
      exitCode = EXIT_CODES.childFailed;
      report.status = "child_failed";
      report.exitCode = exitCode;
      report.reason = "resource_threshold_failed";
    }
    pendingReport = report;
    pendingReason = report.reason;
    await artifact.writeJson("resources-benchmark.json", report);
  } catch (cause) {
    exitCode = child ? EXIT_CODES.childFailed : EXIT_CODES.internal;
    error = cause instanceof Error ? cause.message : String(cause);
    const report = { ...baseReport, status: exitCode === EXIT_CODES.childFailed ? "child_failed" : "internal", exitCode, reason: error, stderr: stderr.slice(-8192) };
    pendingReport = report;
    pendingReason = error;
    await artifact.writeJson("resources-benchmark.json", report);
  } finally {
    if (sampler) clearInterval(sampler);
    let residuals = [];
    if (child && child.exitCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.send({ type: "shutdown" }, () => undefined);
      let timeout;
      await Promise.race([closed, new Promise((resolve) => { timeout = setTimeout(resolve, 5000); })]);
      clearTimeout(timeout);
      if (child.exitCode === null && owned) {
        const cleanup = await owned.cleanup();
        residuals = cleanup.residuals ?? [];
        if (!cleanup.ok && exitCode === EXIT_CODES.success) exitCode = EXIT_CODES.childFailed;
      }
    } else if (owned) {
      residuals = (await owned.verifiedOwnedProcesses()).map((sample) => sample.identity);
    }
    if (pendingReport) {
      pendingReport.residualPids = residuals.map((item) => item.pid);
      if (residuals.length > 0) {
        exitCode = EXIT_CODES.childFailed;
        pendingReport.exitCode = exitCode;
        pendingReport.status = "child_failed";
        pendingReport.reason = "owned_process_residual";
        pendingReason = pendingReport.reason;
      }
      const outputPath = await artifact.writeJson("resources-benchmark.json", pendingReport);
      await artifact.appendLog("raw/child-stderr.log", `${stderr}${sanitizer.end()}`);
      if (residuals.length > 0) await artifact.writeJson("residual-processes.json", { residualPids: pendingReport.residualPids });
      await artifact.finish({ exitCode, reason: pendingReason, details: { benchmark: pendingReport } });
      if (exitCode === EXIT_CODES.success) {
        console.log(JSON.stringify({ outputPath, p95Ms: pendingReport.p95Ms, rssDeltaBytes: pendingReport.rssDeltaBytes, sqliteTotalChangesDelta: pendingReport.sqliteTotalChangesDelta, p95Passed: pendingReport.p95Passed, rssPassed: pendingReport.rssPassed, zeroWritePassed: pendingReport.zeroWritePassed, exitCode }, null, 2));
      } else {
        console.error(JSON.stringify({ outputPath, reason: pendingReason, exitCode }));
      }
    }
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
  return exitCode;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = EXIT_CODES.internal;
});
