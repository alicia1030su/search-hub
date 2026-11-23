import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectSnapshot } from "./snapshot.mjs";
import { classifyPressure } from "./pressure.mjs";
import { runChildAttempt } from "./child-runner.mjs";
import { buildReport } from "./report.mjs";
import { EXIT_CODES } from "./artifacts.mjs";

export const STAGES = Object.freeze(["typecheck", "lint", "vitest", "build", "playwright"]);
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

function unavailableReading(reason) {
  return { value: null, source: "phase_runner", reason };
}

function blockedStage(stage, exitCode, reason, workers = 0) {
  const now = new Date().toISOString();
  return {
    stage,
    source: "phase_runner",
    status: exitCode === EXIT_CODES.resourceBlocked ? "blocked" : "aborted",
    exitCode,
    attempts: 0,
    workers,
    rssPeakBytes: unavailableReading("stage_not_started"),
    heapPeakBytes: unavailableReading("stage_not_started"),
    durationMs: 0,
    reason,
    startedAt: now,
    finishedAt: now,
    attemptDetails: [],
    cleanup: { ok: true, residuals: [], errors: [] },
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire a tool-owned mutex so heavy phases cannot overlap across runs. */
export async function acquireStageLock(repoRoot, timeoutMs = 30_000) {
  const lockPath = path.join(repoRoot, ".cache", "search-hub-resource", "v1", "locks", "verify-smart.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0 && Date.now() - info.mtimeMs > LOCK_STALE_MS && !processAlive(owner.pid)) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // An unreadable lock is never removed without safe ownership evidence.
      }
      if (Date.now() >= deadline) return null;
      await delay(250);
    }
  }
}

async function releaseStageLock(lockPath) {
  if (lockPath) await rm(lockPath, { recursive: true, force: true });
}

function aggregateStage(stage, attempts) {
  const first = attempts[0];
  const last = attempts.at(-1);
  const rss = attempts.map((entry) => entry.rssPeakBytes.value).filter((value) => value !== null);
  const heap = attempts.map((entry) => entry.heapPeakBytes.value).filter((value) => value !== null);
  const retried = attempts.length > 1;
  const finalSuccess = last.exitCode === 0 && last.cleanup.ok;
  return {
    stage,
    source: "phase_runner",
    status: finalSuccess ? (retried ? "passed_after_oom_retry" : "passed") : retried ? "failed_after_oom_retry" : last.resourceAborted ? "aborted" : "failed",
    exitCode: last.exitCode,
    attempts: attempts.length,
    workers: last.workers,
    rssPeakBytes: rss.length ? { value: Math.max(...rss), source: "owned_process_tree", reason: null } : unavailableReading("rss_sample_unavailable"),
    heapPeakBytes: heap.length ? { value: Math.max(...heap), source: "node_telemetry", reason: null } : unavailableReading("node_heap_sample_unavailable"),
    durationMs: attempts.reduce((sum, entry) => sum + entry.durationMs, 0),
    reason: finalSuccess ? null : last.reason ?? (last.cleanup.ok ? "child_failed" : "owned_residual_processes"),
    startedAt: first.startedAt,
    finishedAt: last.finishedAt,
    attemptDetails: attempts,
    cleanup: last.cleanup,
  };
}

/** Runs the strict five-stage gate with frozen budgets and one OOM retry. */
export class PhaseRunner {
  constructor(options) {
    this.repoRoot = options.repoRoot;
    this.artifactRun = options.artifactRun;
    this.policy = options.budget;
    this.initialSnapshot = options.snapshot;
    this.runner = options.runner ?? runChildAttempt;
    this.collect = options.collect ?? collectSnapshot;
    this.platform = options.platform ?? process.platform;
    this.stages = [];
    this.oomRetries = [];
    this.residuals = [];
    this.activeLock = null;
  }

  async runStage(stage, workers) {
    if (!STAGES.includes(stage)) throw new TypeError(`Unknown verification stage: ${stage}`);
    this.activeLock = await acquireStageLock(this.repoRoot);
    if (!this.activeLock) return blockedStage(stage, EXIT_CODES.resourceBlocked, "heavy_stage_mutex_busy", workers);
    try {
      const first = await this.runner({ stage, workers, artifactRun: this.artifactRun, attempt: 1, cwd: this.repoRoot, budget: this.policy, platform: this.platform });
      const attempts = [first];
      if (first.exitCode !== 0 && first.cleanup.ok && stage === "vitest" && workers > 1 && first.oom?.confirmed) {
        this.oomRetries.push({ stage, fromWorkers: workers, toWorkers: workers - 1, firstAttempt: 1, reason: first.oom.reason });
        attempts.push(await this.runner({ stage, workers: workers - 1, artifactRun: this.artifactRun, attempt: 2, cwd: this.repoRoot, budget: this.policy, platform: this.platform }));
      }
      return aggregateStage(stage, attempts);
    } finally {
      await releaseStageLock(this.activeLock);
      this.activeLock = null;
    }
  }

  async run() {
    if (!this.policy.safe) {
      const first = blockedStage(STAGES[0], EXIT_CODES.resourceBlocked, this.policy.reason ?? "insufficient_safe_budget");
      this.stages = [first, ...STAGES.slice(1).map((stage) => blockedStage(stage, EXIT_CODES.resourceBlocked, "previous_stage_blocked"))];
      return buildReport({ runId: this.artifactRun.artifact.runId, snapshot: this.initialSnapshot, budget: this.policy, stages: this.stages, residuals: [], exitCode: EXIT_CODES.resourceBlocked, reason: this.policy.reason });
    }
    let previousLevel = "normal";
    let recoverySamples = 0;
    let exitCode = EXIT_CODES.success;
    let stopReason = null;
    for (const stage of STAGES) {
      const current = await this.collect({ includeProcesses: false, platform: this.platform });
      const pressure = classifyPressure(this.policy, current, { previousLevel, recoverySamples });
      previousLevel = pressure.level;
      recoverySamples = pressure.recoverySamples;
      if (pressure.level === "stop" || pressure.level === "danger") {
        this.stages.push(blockedStage(stage, EXIT_CODES.resourceBlocked, pressure.reason ?? pressure.level));
        exitCode = EXIT_CODES.resourceBlocked;
        stopReason = pressure.reason ?? pressure.level;
        break;
      }
      let workers = stage === "vitest" ? this.policy.vitestWorkers : 1;
      if (pressure.level === "warn") workers = Math.max(1, workers - 1);
      if (pressure.level === "high") workers = 1;
      const result = await this.runStage(stage, workers);
      result.pressure = pressure;
      this.stages.push(result);
      this.residuals.push(...result.cleanup.residuals);
      if (!result.cleanup.ok) {
        exitCode = EXIT_CODES.childFailed;
        stopReason = "owned_residual_processes";
        break;
      }
      if (result.exitCode !== 0) {
        exitCode = result.resourceAborted || result.status === "aborted" ? EXIT_CODES.resourceBlocked : EXIT_CODES.childFailed;
        stopReason = result.reason;
        break;
      }
    }
    if (exitCode !== EXIT_CODES.success && this.stages.length < STAGES.length) {
      for (const stage of STAGES.slice(this.stages.length)) this.stages.push(blockedStage(stage, exitCode, `previous_stage_${stopReason ?? "failed"}`));
    }
    return buildReport({ runId: this.artifactRun.artifact.runId, snapshot: this.initialSnapshot, budget: this.policy, stages: this.stages, oomRetries: this.oomRetries, residuals: this.residuals, exitCode, reason: stopReason });
  }

  async cleanup() {
    if (this.activeLock) await releaseStageLock(this.activeLock);
    this.activeLock = null;
  }
}
