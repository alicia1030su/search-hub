#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, resolveMigrationsDir, runMigrations } from "../packages/db/src/index.ts";
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";
import { freezeBudget } from "./lib/resource/budget.mjs";
import { classifyOom } from "./lib/resource/oom.mjs";
import { OwnedProcessTree, adapter } from "./lib/resource/process-tree.mjs";
import { createLogSanitizer, sanitizeLog } from "./lib/resource/report.mjs";
import { collectSnapshot } from "./lib/resource/snapshot.mjs";
import { resolveTerminalState } from "./lib/resource/terminal-state.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HTTP_TIMEOUT_MS = 30_000;

class UsageError extends TypeError {}

function parseArgs(args) {
  const options = { rows: 100_000, requests: 1000, warmup: 100 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--rows") options.rows = Number(args[++index]);
    else if (arg === "--requests") options.requests = Number(args[++index]);
    else if (arg === "--warmup") options.warmup = Number(args[++index]);
    else throw new UsageError(`unknown_argument:${arg}`);
  }
  if (![options.rows, options.requests, options.warmup].every((value) => Number.isInteger(value) && value > 0)) {
    throw new UsageError("rows/requests/warmup must be positive integers");
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function queryPlansPassed(plans) {
  return Object.values(plans).every((plan) => {
    const serialized = JSON.stringify(plan);
    return /USING (?:PRIMARY KEY|INDEX)/i.test(serialized) && !/SCAN/i.test(serialized);
  });
}

function errorReason(error, abortedBy = null) {
  if (abortedBy) return `aborted_by_${abortedBy}`;
  const message = error instanceof Error ? error.message : String(error);
  if (error?.name === "TimeoutError" || message.includes("http_timeout")) return "http_timeout";
  if (message.includes("child_process_identity_unavailable")) return "child_process_identity_unavailable";
  if (message.includes("rss_sample_unavailable")) return "rss_sample_unavailable";
  if (/^(?:setup|resources)_http_\d+$/.test(message)) return message;
  if (message.startsWith("server_exited_before_ready:") || message.startsWith("child_exited:")) return "child_exited_before_benchmark_completed";
  return "benchmark_internal_error";
}

function waitForMessage(child, sendType, responseType, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type === responseType) finish(resolve, message);
    };
    const onError = (cause) => finish(reject, cause);
    const onClose = (code, closeSignal) => finish(reject, new Error(`child_exited:${code ?? closeSignal ?? "unknown"}`));
    const onAbort = () => finish(reject, new Error("benchmark_aborted"));
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    timer = setTimeout(() => finish(reject, new Error(`ipc_timeout:${sendType ?? "response"}`)), timeoutMs);
    if (sendType !== null) {
      try {
        child.send({ type: sendType }, (cause) => {
          if (cause) finish(reject, cause);
        });
      } catch (cause) {
        finish(reject, cause);
      }
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifact = await createArtifactRun({ command: "bench-resources", repoRoot: REPO_ROOT });
  const abortController = new AbortController();
  let abortedBy = null;
  const onSignal = (signal) => {
    if (abortedBy) return;
    abortedBy = signal;
    abortController.abort(new Error(`benchmark_aborted_by_${signal}`));
  };
  const throwIfAborted = () => {
    if (abortedBy) throw new Error(`aborted_by_${abortedBy}`);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let directory = null;
  let handle = null;
  let child = null;
  let owned = null;
  let sampler = null;
  let samplingPromise = Promise.resolve();
  let stderrTail = "";
  let pendingReport = null;
  let pendingReason = null;
  let exitCode = EXIT_CODES.success;
  let childOutcome = null;
  let spawnError = null;
  let benchmarkStarted = false;
  let rssPeakBytes = null;
  let afterSnapshot = null;
  let cleanup = { ok: true, residuals: [], errors: [] };
  const sanitizer = createLogSanitizer();
  const stderrDecoder = new StringDecoder("utf8");
  const appendStderr = (text) => {
    if (text) stderrTail = `${stderrTail}${text}`.slice(-8192);
  };
  const baseMetadata = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    rows: options.rows,
    requests: options.requests,
    warmup: options.warmup,
    concurrency: 1,
    gcBeforeBaseline: true,
    httpTimeoutMs: HTTP_TIMEOUT_MS,
  };

  let baseReport = {
    schemaVersion: 1,
    benchmark: "resources",
    metadata: { ...baseMetadata, sourceCommit: null, cleanWorktree: false },
  };
  try {
    throwIfAborted();
    let commit = null;
    let dirty = null;
    let preflightFailure = null;
    try {
      commit = git(["rev-parse", "HEAD"]);
      dirty = git(["status", "--porcelain", "--untracked-files=normal"]);
    } catch (error) {
      preflightFailure = error instanceof Error ? error.message : String(error);
    }
    baseReport = {
      ...baseReport,
      metadata: { ...baseMetadata, sourceCommit: commit, cleanWorktree: typeof dirty === "string" && dirty.length === 0 },
    };
    throwIfAborted();
    if (preflightFailure !== null) {
      exitCode = EXIT_CODES.internal;
      pendingReason = "source_preflight_failed";
      pendingReport = {
        ...baseReport,
        status: "internal",
        exitCode,
        reason: pendingReason,
        preflightDetail: sanitizeLog(preflightFailure),
        oom: false,
        oomClassification: { confirmed: false, reason: "not_started", evidence: [] },
        residualPids: [],
      };
      return exitCode;
    }
    if (!/^[0-9a-f]{40}$/i.test(commit) || dirty.length !== 0) {
      exitCode = EXIT_CODES.internal;
      pendingReason = dirty.length !== 0 ? "worktree_dirty" : "source_commit_unavailable";
      pendingReport = {
        ...baseReport,
        status: "internal",
        exitCode,
        reason: pendingReason,
        oom: false,
        oomClassification: { confirmed: false, reason: "not_started", evidence: [] },
        residualPids: [],
      };
      return exitCode;
    }

    const snapshot = await collectSnapshot({ cpuDelayMs: 20 });
    const budget = freezeBudget(snapshot, { peakMiB: { vitest: 512 } });
    throwIfAborted();
    baseReport.resourceSnapshot = snapshot;
    baseReport.frozenBudget = budget;
    if (!budget.stages.vitest.safe) {
      exitCode = EXIT_CODES.resourceBlocked;
      pendingReason = budget.reason;
      pendingReport = {
        ...baseReport,
        status: "resource_blocked",
        exitCode,
        reason: pendingReason,
        oom: false,
        oomClassification: { confirmed: false, reason: "not_started", evidence: [] },
        residualPids: [],
      };
      return exitCode;
    }

    try {
      throwIfAborted();
      directory = await mkdtemp(path.join(tmpdir(), "search-hub-resources-bench-"));
      const dbPath = path.join(directory, "resources.db");
      const harnessPath = path.join(directory, "server.mjs");
      handle = createDb({ file: dbPath });
      runMigrations(handle.sqlite, resolveMigrationsDir());
      const insert = handle.sqlite.prepare("INSERT INTO search_cache (cache_key,response_json,status,mode,created_at,expires_at,last_accessed_at,size_bytes) VALUES (?,?,?,?,?,?,?,?)");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const expiresAt = "2027-01-01T00:00:00.000Z";
      throwIfAborted();
      handle.sqlite.transaction(() => {
        for (let index = 0; index < options.rows; index += 1) {
          insert.run(`fixture-${index.toString(36).padStart(8, "0")}`, "{}", "completed", "basic", createdAt, expiresAt, createdAt, 2);
        }
      })();
      throwIfAborted();
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
      throwIfAborted();
      const platform = process.platform;
      benchmarkStarted = true;
      child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", harnessPath, directory, dbPath], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
        detached: platform === "win32",
      });
      const outcomePromise = new Promise((resolve) => {
        child.once("error", (cause) => {
          spawnError = cause;
          childOutcome = { code: null, signal: null };
          resolve(childOutcome);
        });
        child.once("close", (code, signal) => {
          childOutcome = { code, signal };
          resolve(childOutcome);
        });
      });
      child.stderr.on("data", (chunk) => appendStderr(sanitizer.write(stderrDecoder.write(chunk))));
      const readyPromise = waitForMessage(child, null, "ready", 30_000, abortController.signal);
      void readyPromise.catch(() => undefined);

      const io = adapter(platform);
      const identity = child.pid ? await io.readProcess(child.pid).catch(() => null) : null;
      if (identity) {
        owned = new OwnedProcessTree(child.pid, identity.identity.startTime, {
          platform,
          io,
          consoleCtrlOwned: platform === "win32",
        });
        await owned.sample();
      } else if (child.pid && !childOutcome) {
        throw new Error("child_process_identity_unavailable");
      }
      const ready = await readyPromise;
      throwIfAborted();
      if (spawnError) throw spawnError;
      if (ready.type !== "ready" || !Number.isInteger(ready.port)) throw new Error("server_ready_invalid");

      const base = `http://127.0.0.1:${ready.port}`;
      const httpSignal = () => AbortSignal.any([abortController.signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]);
      throwIfAborted();
      const setup = await fetch(`${base}/api/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bench@example.com", password: "Resource-Bench-Password-1", name: "Bench", setupToken: "resources-bench-token" }),
        signal: httpSignal(),
      });
      throwIfAborted();
      if (setup.status !== 200) throw new Error(`setup_http_${setup.status}`);
      const cookie = setup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      const get = async () => {
        throwIfAborted();
        const response = await fetch(`${base}/api/admin/resources`, { headers: { cookie }, signal: httpSignal() });
        const body = await response.json();
        throwIfAborted();
        if (response.status !== 200) throw new Error(`resources_http_${response.status}`);
        if (body?.schemaVersion !== 1 || body?.cache?.diskScope !== "whole_sqlite_database") throw new Error("resources_schema_invalid");
        return body;
      };
      const ipc = async (sendType, responseType) => {
        throwIfAborted();
        const message = await waitForMessage(child, sendType, responseType, 5000, abortController.signal);
        throwIfAborted();
        return message;
      };
      const readRss = async () => {
        const current = await io.readProcess(child.pid);
        if (!current || current.identity.startTime !== identity.identity.startTime) return null;
        return current.rssBytes.value;
      };

      const changesBeforeWarmup = (await ipc("total_changes", "changes")).value;
      for (let index = 0; index < options.warmup; index += 1) await get();
      const changesAfterWarmup = (await ipc("total_changes", "changes")).value;
      const warmupWriteDelta = changesAfterWarmup - changesBeforeWarmup;
      if (warmupWriteDelta !== 0) throw new Error("warmup_wrote_to_database");

      const rssBeforeGcBytes = await readRss();
      if (rssBeforeGcBytes === null) throw new Error("rss_sample_unavailable");
      await ipc("gc", "gc");
      await new Promise((resolve) => setImmediate(resolve));
      const rssBaselineBytes = await readRss();
      if (rssBaselineBytes === null) throw new Error("rss_sample_unavailable");
      rssPeakBytes = rssBaselineBytes;
      let sampling = false;
      let sampleTicks = 0;
      const sampleOnce = async () => {
        const value = await readRss();
        if (value !== null) rssPeakBytes = Math.max(rssPeakBytes, value);
        sampleTicks += 1;
        if (owned && sampleTicks % 10 === 0) await owned.sample();
      };
      sampler = setInterval(() => {
        if (sampling) return;
        sampling = true;
        samplingPromise = sampleOnce()
          .catch(() => undefined)
          .finally(() => { sampling = false; });
      }, 25);

      const changesBefore = changesAfterWarmup;
      const samples = [];
      const wallStarted = performance.now();
      for (let index = 0; index < options.requests; index += 1) {
        const started = performance.now();
        await get();
        samples.push(performance.now() - started);
      }
      const wallMs = performance.now() - wallStarted;
      const changesAfter = (await ipc("total_changes", "changes")).value;
      const beforeFinalGc = await readRss();
      throwIfAborted();
      if (beforeFinalGc === null) throw new Error("rss_sample_unavailable");
      rssPeakBytes = Math.max(rssPeakBytes, beforeFinalGc);
      await ipc("gc", "gc");
      await new Promise((resolve) => setImmediate(resolve));
      clearInterval(sampler);
      sampler = null;
      await samplingPromise;
      throwIfAborted();
      const rssFinalBytes = await readRss();
      throwIfAborted();
      if (rssFinalBytes === null) throw new Error("rss_sample_unavailable");

      throwIfAborted();
      const p50Ms = percentile(samples, 0.5);
      const p95Ms = percentile(samples, 0.95);
      const rssDeltaBytes = Math.max(0, rssFinalBytes - rssBaselineBytes);
      const rssPeakDeltaBytes = Math.max(0, rssPeakBytes - rssBaselineBytes);
      const queryPlanPassed = queryPlansPassed(plans);
      const report = {
        ...baseReport,
        wallMs,
        p50Ms,
        p95Ms,
        latencySamplesMs: samples,
        rssBeforeGcBytes,
        rssBaselineBytes,
        rssPeakBytes,
        rssFinalBytes,
        rssDeltaBytes,
        rssPeakDeltaBytes,
        rssDeltaBeforeGcBytes: Math.max(0, rssPeakBytes - rssBeforeGcBytes),
        sqliteTotalChangesBeforeWarmup: changesBeforeWarmup,
        sqliteTotalChangesAfterWarmup: changesAfterWarmup,
        warmupWriteDelta,
        sqliteTotalChangesBefore: changesBefore,
        sqliteTotalChangesAfter: changesAfter,
        sqliteTotalChangesDelta: changesAfter - changesBefore,
        queryPlans: plans,
        queryPlanPassed,
        thresholds: { p95Ms: 10, retainedRssDeltaBytes: 2 * 1024 * 1024, rssBasis: "post_warmup_gc_to_post_run_gc" },
        p95Passed: p95Ms !== null && p95Ms <= 10,
        rssPassed: rssDeltaBytes <= 2 * 1024 * 1024,
        warmupZeroWritePassed: warmupWriteDelta === 0,
        zeroWritePassed: warmupWriteDelta === 0 && changesAfter === changesBefore,
        status: "success",
        exitCode: EXIT_CODES.success,
        reason: null,
      };
      if (!report.p95Passed || !report.rssPassed || !report.zeroWritePassed || !report.queryPlanPassed) {
        exitCode = EXIT_CODES.childFailed;
        report.status = "child_failed";
        report.exitCode = exitCode;
        report.reason = "resource_threshold_failed";
      }
      throwIfAborted();
      pendingReport = report;
      pendingReason = report.reason;
    } catch (cause) {
      exitCode = abortedBy ? EXIT_CODES.resourceBlocked : child ? EXIT_CODES.childFailed : EXIT_CODES.internal;
      pendingReason = errorReason(cause, abortedBy);
      pendingReport = {
        ...baseReport,
        metadata: { ...baseReport.metadata },
        status: abortedBy ? "resource_blocked" : exitCode === EXIT_CODES.childFailed ? "child_failed" : "internal",
        exitCode,
        reason: pendingReason,
        stderr: stderrTail,
      };
    }
  } finally {
    if (sampler) clearInterval(sampler);
    await samplingPromise;
    appendStderr(sanitizer.write(stderrDecoder.end()));
    appendStderr(sanitizer.end());

    if (child && child.pid && !childOutcome) {
      try { child.send({ type: "shutdown" }, () => undefined); } catch { /* channel may already be closed */ }
      await Promise.race([delay(5000, { ref: false }), new Promise((resolve) => child.once("close", resolve))]);
    }
    if (owned) {
      try { cleanup = await owned.cleanup(); } catch (error) {
        cleanup = { ok: false, residuals: [], errors: [{ stage: "cleanup", reason: error instanceof Error ? error.message : String(error) }] };
      }
    } else if (child?.pid && !childOutcome) {
      cleanup = { ok: false, residuals: [{ pid: child.pid, reason: "identity_unavailable" }], errors: [] };
    }

    try { afterSnapshot = await collectSnapshot({ cpuDelayMs: 20 }); } catch { afterSnapshot = null; }
    const beforeOom = pendingReport?.resourceSnapshot?.cgroup?.oomKills?.value ?? null;
    const afterOom = afterSnapshot?.cgroup?.oomKills?.value ?? null;
    const cgroupOomDelta = Number.isSafeInteger(beforeOom) && Number.isSafeInteger(afterOom) ? Math.max(0, afterOom - beforeOom) : null;
    const oomClassification = benchmarkStarted
      ? classifyOom({
        exitCode: childOutcome?.code ?? null,
        signal: childOutcome?.signal ?? null,
        windowsExitCode: childOutcome?.code ?? null,
        log: stderrTail,
        ownedRootDied: Boolean(child?.pid && childOutcome),
        ownedPeakBytes: rssPeakBytes,
      }, { cgroupOomDelta })
      : pendingReport?.oomClassification ?? { confirmed: false, reason: "not_started", evidence: [] };

    const localCleanupErrors = [];
    try { handle?.close(); } catch (error) { localCleanupErrors.push({ stage: "db_close", reason: error instanceof Error ? error.message : String(error) }); }
    try { if (directory) await rm(directory, { recursive: true, force: true }); } catch (error) { localCleanupErrors.push({ stage: "temp_remove", reason: error instanceof Error ? error.message : String(error) }); }

    if (!pendingReport) {
      exitCode = abortedBy ? EXIT_CODES.resourceBlocked : EXIT_CODES.internal;
      pendingReason = abortedBy ? `aborted_by_${abortedBy}` : "benchmark_internal_error";
      pendingReport = {
        ...baseReport,
        status: abortedBy ? "resource_blocked" : "internal",
        exitCode,
        reason: pendingReason,
        oom: false,
        oomClassification: { confirmed: false, reason: "not_started", evidence: [] },
        residualPids: [],
      };
    }
    if (pendingReport) {
      const residuals = cleanup.residuals ?? [];
      pendingReport.residualPids = residuals.map((item) => item.pid);
      pendingReport.residualProcesses = residuals;
      pendingReport.oom = oomClassification.confirmed;
      pendingReport.oomClassification = oomClassification;
      pendingReport.rssPeakBytes = rssPeakBytes;
      pendingReport.rssPeakReason = rssPeakBytes === null ? "unavailable" : null;
      pendingReport.cgroupOomEvidence = {
        before: beforeOom,
        after: afterOom,
        delta: cgroupOomDelta,
        source: "cgroup",
        reason: cgroupOomDelta === null ? "unavailable" : null,
      };
      pendingReport.cleanup = {
        ok: cleanup.ok && localCleanupErrors.length === 0,
        errors: [...(cleanup.errors ?? []), ...localCleanupErrors].map((item) => ({ pid: item.pid ?? null, stage: item.stage, reason: sanitizeLog(item.reason), ...(item.identity ? { identity: item.identity } : {}) })),
      };
      const cleanupFailed = residuals.length > 0 || !cleanup.ok || localCleanupErrors.length > 0;
      pendingReport.cleanupFailed = cleanupFailed;
      const cleanupFailure = cleanupFailed
        ? residuals.length > 0 ? "owned_process_residual" : localCleanupErrors.length > 0 ? "local_cleanup_failed" : "owned_process_cleanup_failed"
        : null;
      const applyTerminalState = () => {
        const state = resolveTerminalState({ cleanupFailure, abortedBy, threshold: pendingReport });
        exitCode = state.exitCode;
        pendingReport.exitCode = state.exitCode;
        pendingReport.status = state.status;
        pendingReport.reason = state.reason;
        if (state.abortReason) pendingReport.abortReason = state.abortReason;
        pendingReason = state.reason;
      };
      const terminalKey = () => `${pendingReport.status}:${pendingReport.reason}`;
      let artifactFinished = false;
      let outputPath = null;
      try {
        applyTerminalState();
        await artifact.appendLog("raw/child-stderr.log", stderrTail);
        if (residuals.length > 0) await artifact.writeJson("residual-processes.json", residuals);
        if ((cleanup.errors ?? []).length > 0) await artifact.writeJson("cleanup-errors.json", cleanup.errors);
        applyTerminalState();
        let writtenKey = terminalKey();
        outputPath = await artifact.writeJson("resources-benchmark.json", pendingReport);
        applyTerminalState();
        if (terminalKey() !== writtenKey) {
          outputPath = await artifact.writeJson("resources-benchmark.json", pendingReport);
        }
        await artifact.finish({ exitCode, reason: pendingReason, details: { benchmark: pendingReport } });
        artifactFinished = true;
      } catch (error) {
        pendingReport.artifactError = sanitizeLog(error instanceof Error ? error.message : String(error));
        const state = resolveTerminalState({ artifactFailed: true, cleanupFailure, abortedBy, threshold: pendingReport });
        exitCode = state.exitCode;
        pendingReport.exitCode = state.exitCode;
        pendingReport.status = state.status;
        pendingReport.reason = state.reason;
        if (state.abortReason) pendingReport.abortReason = state.abortReason;
        pendingReason = state.reason;
        try { outputPath = await artifact.writeJson("resources-benchmark.json", pendingReport); } catch { /* best effort after artifact failure */ }
        if (!artifactFinished) {
          try { await artifact.finish({ exitCode, reason: pendingReason, details: { benchmark: pendingReport } }); } catch { /* terminal artifact failure is reported by process exit */ }
        }
      }
      try {
        if (outputPath && exitCode === EXIT_CODES.success) {
          console.log(JSON.stringify({ outputPath, p95Ms: pendingReport.p95Ms, rssDeltaBytes: pendingReport.rssDeltaBytes, sqliteTotalChangesDelta: pendingReport.sqliteTotalChangesDelta, p95Passed: pendingReport.p95Passed, rssPassed: pendingReport.rssPassed, zeroWritePassed: pendingReport.zeroWritePassed, queryPlanPassed: pendingReport.queryPlanPassed, exitCode }, null, 2));
        } else {
          console.error(JSON.stringify({ outputPath, reason: pendingReason, exitCode }));
        }
      } catch { /* console failures never reverse terminal evidence state */ }
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return exitCode;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof UsageError ? EXIT_CODES.usage : EXIT_CODES.internal;
});
