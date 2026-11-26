import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "./snapshot.mjs";
import { OwnedProcessTree, adapter } from "./process-tree.mjs";
import { createTelemetryServer } from "./telemetry-server.mjs";
import { classifyPressure } from "./pressure.mjs";
import { createLogSanitizer, sanitizeLog } from "./report.mjs";
import { classifyOom } from "./oom.mjs";

export function pnpmInvocation(args) {
  const cli = process.env["npm_execpath"] ?? "";
  if (/\.(?:cjs|mjs|js)$/.test(cli)) return { command: process.execPath, args: [cli, ...args] };
  if (cli) return { command: cli, args };
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args };
}

export function stageCommand(stage, workers, resultPath = null) {
  if (stage === "typecheck") return pnpmInvocation(["typecheck"]);
  if (stage === "lint") return pnpmInvocation(["lint"]);
  if (stage === "vitest") {
    const args = ["vitest", "run", `--maxWorkers=${workers}`];
    if (workers === 1) args.push("--no-file-parallelism");
    args.push("--reporter=json");
    if (resultPath) args.push(`--outputFile=${resultPath}`);
    return pnpmInvocation(args);
  }
  if (stage === "build") return pnpmInvocation(["build"]);
  if (stage === "playwright") return pnpmInvocation(["test:e2e"]);
  throw new TypeError(`Unknown verification stage: ${stage}`);
}

function exitCodeFor(code, signal) {
  if (Number.isInteger(code)) return code;
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function unknownReading(source, reason) {
  return { value: null, source, reason };
}

function createArtifactLogWriter(artifactRun, logName) {
  const filePath = path.join(artifactRun.rootPath, logName);
  const stream = createWriteStream(filePath, { flags: "w", mode: 0o600 });
  const sanitizer = createLogSanitizer();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let evidenceTail = "";
  let streamError = null;
  let stdoutPaused = false;
  let stderrPaused = false;
  stream.on("error", (error) => { streamError = error; });
  stream.on("drain", () => {
    if (stdoutPaused) { stdoutPaused = false; childStdout?.resume(); }
    if (stderrPaused) { stderrPaused = false; childStderr?.resume(); }
  });
  let childStdout = null;
  let childStderr = null;

  const append = (text) => {
    if (!text) return true;
    evidenceTail = `${evidenceTail}${text}`.slice(-16 * 1024);
    return stream.write(text);
  };
  return {
    attach(stdout, stderr) {
      childStdout = stdout;
      childStderr = stderr;
    },
    writeStdout(chunk) {
      const accepted = append(sanitizer.write(stdoutDecoder.write(chunk)));
      if (!accepted) { stdoutPaused = true; childStdout?.pause(); }
    },
    writeStderr(chunk) {
      const accepted = append(sanitizer.write(stderrDecoder.write(chunk)));
      if (!accepted) { stderrPaused = true; childStderr?.pause(); }
    },
    writeText(text) {
      append(sanitizer.write(text));
    },
    tail() {
      return evidenceTail;
    },
    async close() {
      append(sanitizer.write(stdoutDecoder.end()));
      append(sanitizer.write(stderrDecoder.end()));
      append(sanitizer.end());
      await new Promise((resolve, reject) => {
        if (streamError) { reject(streamError); return; }
        stream.once("finish", resolve);
        stream.once("error", reject);
        stream.end();
      });
      await artifactRun.appendLog(logName, "");
    },
  };
}

/**
 * Spawn and sample one stage attempt. Every return path closes telemetry and
 * cleans only the identity-verified owned process tree.
 *
 * @param {{stage: string, workers: number, artifactRun: object, attempt?: number, cwd?: string, budget?: object, platform?: NodeJS.Platform, spawnImpl?: Function, tree?: object, telemetry?: object, collect?: Function, readProcess?: Function, termGraceMs?: number, sampleIntervalMs?: number}} options
 */
export async function runChildAttempt(options) {
  const startedAt = new Date();
  const startedMs = Date.now();
  const stage = options.stage;
  const workers = options.workers;
  const attempt = options.attempt ?? 1;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? fileURLToPath(new URL("../../../", import.meta.url));
  const collect = options.collect ?? collectSnapshot;
  const sampleIntervalMs = options.sampleIntervalMs ?? 250;
  const logName = `raw/${stage}-attempt-${attempt}.log`;
  const resultPath = `${options.artifactRun.rootPath}/vitest-result-attempt-${attempt}.json`;
  const invocation = stageCommand(stage, workers, stage === "vitest" ? resultPath : null);
  let telemetry = options.telemetry ?? null;
  let ownsTelemetry = false;
  let child = null;
  let tree = options.tree ?? null;
  let sampler = null;
  let sampling = Promise.resolve();
  let logWriter = null;
  let rssPeakBytes = 0;
  let heapPeakBytes = 0;
  let hasRss = false;
  let hasHeap = false;
  let resourceAborted = false;
  let lastPressure = null;
  let spawnError = null;
  let outcomePromise = null;
  let before = null;
  let after = null;
  let finalSamples = [];

  const sample = async () => {
    if (!tree) return;
    try {
      const samples = await tree.sample(telemetry);
      rssPeakBytes = Math.max(rssPeakBytes, samples.reduce((sum, entry) => sum + (entry.rssBytes.value ?? 0), 0));
      hasRss ||= samples.some((entry) => entry.rssBytes.value !== null);
      const heapValues = samples.map((entry) => entry.v8?.heapUsedBytes?.value).filter((value) => Number.isSafeInteger(value));
      if (heapValues.length > 0) {
        heapPeakBytes = Math.max(heapPeakBytes, heapValues.reduce((sum, value) => sum + value, 0));
        hasHeap = true;
      }
      if (telemetry) {
        for (const sampleEntry of samples) {
          const peak = telemetry.peaks?.get(sampleEntry.identity.pid);
          if (peak) {
            heapPeakBytes = Math.max(heapPeakBytes, peak.heapUsedBytes);
            hasHeap = true;
          }
        }
      }
      if (options.budget && sampler) {
        const snapshot = await collect({ includeProcesses: false, platform });
        const ownedRss = samples.reduce((sum, entry) => sum + (entry.rssBytes.value ?? 0), 0);
        lastPressure = classifyPressure(options.budget, snapshot, { ownedTreeRssBytes: ownedRss, previousLevel: lastPressure?.level, recoverySamples: lastPressure?.recoverySamples });
        if (lastPressure.level === "stop" && child && child.exitCode === null) {
          resourceAborted = true;
          child.kill("SIGTERM");
        }
      }
    } catch {
      // A transient process disappearing during /proc enumeration is not fatal.
    }
  };

  try {
    logWriter = createArtifactLogWriter(options.artifactRun, logName);
    before = await collect({ includeProcesses: false, platform });
    if (!telemetry) {
      telemetry = await createTelemetryServer();
      ownsTelemetry = true;
    }
    const spawnImpl = options.spawnImpl ?? spawn;
    child = spawnImpl(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, ...telemetry.environment() },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: platform === "win32",
    });
    outcomePromise = new Promise((resolve) => {
      child.once("error", (error) => { spawnError = error; resolve({ code: null, signal: null }); });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    logWriter.attach(child.stdout, child.stderr);
    child.stdout?.on("data", (chunk) => logWriter.writeStdout(chunk));
    child.stderr?.on("data", (chunk) => logWriter.writeStderr(chunk));
    if (!tree && child.pid) {
      const io = adapter(platform);
      const root = await (options.readProcess ?? io.readProcess)(child.pid);
      if (root) {
        tree = new OwnedProcessTree(child.pid, root.identity.startTime, { platform, io, termGraceMs: options.termGraceMs, consoleCtrlOwned: platform === "win32" });
      } else if (child.exitCode === null) {
        child.kill("SIGTERM");
        throw new Error("root_process_identity_unavailable");
      }
    }
    sampler = setInterval(() => {
      sampling = sampling.then(sample);
    }, sampleIntervalMs);
    await sampling;
    const outcome = await outcomePromise;
    if (spawnError) throw spawnError;
    const code = resourceAborted ? 3 : exitCodeFor(outcome.code, outcome.signal);
    const signal = outcome.signal;
    await sampling;
    if (tree) {
      finalSamples = await tree.sample(telemetry);
      await sample();
      for (const [pid, peak] of telemetry?.peaks ?? []) {
        if (tree.records.has(pid)) {
          heapPeakBytes = Math.max(heapPeakBytes, peak.heapUsedBytes);
          hasHeap = true;
        }
      }
    }
    after = await collect({ includeProcesses: false, platform });
    const ownedRootDied = tree ? !finalSamples.some((entry) => entry.identity.pid === tree.rootPid) : false;
    const beforeOom = before.cgroup?.oomKills?.value;
    const afterOom = after.cgroup?.oomKills?.value;
    const cgroupOomDelta = Number.isSafeInteger(beforeOom) && Number.isSafeInteger(afterOom) ? Math.max(0, afterOom - beforeOom) : 0;
    const log = logWriter.tail();
    const cleanup = tree ? await tree.cleanup() : { ok: true, residuals: [], errors: [] };
    const durationMs = Math.max(0, Math.trunc(Date.now() - startedMs));
    const attemptResult = {
      stage,
      attempt,
      workers,
      exitCode: code,
      signal,
      durationMs,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      rssPeakBytes: { value: hasRss ? Math.trunc(rssPeakBytes) : null, source: "owned_process_tree", reason: hasRss ? null : "rss_sample_unavailable" },
      heapPeakBytes: { value: hasHeap ? Math.trunc(heapPeakBytes) : null, source: "node_telemetry", reason: hasHeap ? null : "node_heap_sample_unavailable" },
      cleanup,
      resourceAborted,
      pressure: lastPressure,
      cgroupOomDelta,
      ownedRootDied,
      logPath: logName,
      spawnError: spawnError ? "spawn_failed" : null,
    };
    attemptResult.oom = classifyOom({ exitCode: code, signal, log, ownedRootDied, ownedPeakBytes: rssPeakBytes, windowsExitCode: code }, { cgroupOomDelta });
    await options.artifactRun.writeJson(`attempts/${stage}-${attempt}.json`, attemptResult);
    return attemptResult;
  } catch (error) {
    let cleanup = { ok: true, residuals: [], errors: [] };
    if (tree) {
      cleanup = await tree.cleanup();
    } else if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const closed = await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (child.exitCode === null) {
        cleanup = { ok: false, residuals: [{ pid: child.pid, ppid: process.pid, startTime: "unknown", owned: true, role: "unknown" }], errors: [{ pid: child.pid, stage: "identity_unavailable", reason: "direct_child_did_not_exit" }] };
      }
      void closed;
    }
    const reason = error instanceof Error ? error.message : String(error);
    logWriter?.writeText(`\n${reason}\n`);
    const log = logWriter?.tail() ?? sanitizeLog(reason);
    const result = {
      stage,
      attempt,
      workers,
      exitCode: 5,
      signal: null,
      durationMs: Math.max(0, Math.trunc(Date.now() - startedMs)),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      rssPeakBytes: hasRss ? { value: Math.trunc(rssPeakBytes), source: "owned_process_tree", reason: null } : unknownReading("owned_process_tree", "rss_sample_unavailable"),
      heapPeakBytes: hasHeap ? { value: Math.trunc(heapPeakBytes), source: "node_telemetry", reason: null } : unknownReading("node_telemetry", "node_heap_sample_unavailable"),
      cleanup,
      resourceAborted,
      pressure: lastPressure,
      cgroupOomDelta: 0,
      ownedRootDied: false,
      logPath: logName,
      oom: classifyOom({ exitCode: 5, log }),
      reason: "child_runner_internal",
    };
    await options.artifactRun.writeJson(`attempts/${stage}-${attempt}.json`, result);
    return result;
  } finally {
    if (sampler) clearInterval(sampler);
    await sampling;
    try {
      if (logWriter) await logWriter.close();
    } finally {
      if (ownsTelemetry && telemetry) await telemetry.close();
    }
  }
}
