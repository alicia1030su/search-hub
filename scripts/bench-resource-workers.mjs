#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "./lib/resource/snapshot.mjs";
import { freezeBudget } from "./lib/resource/budget.mjs";
import { runChildAttempt } from "./lib/resource/child-runner.mjs";
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(args) {
  const options = { workers: [1, 2, 4], repeat: 3 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workers") options.workers = String(args[++index] ?? "").split(",").map(Number);
    else if (arg === "--repeat") options.repeat = Number(args[++index]);
    else throw new TypeError(`unknown_argument:${arg}`);
  }
  if (options.workers.some((value) => !Number.isInteger(value) || value < 1 || value > 8) || !Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 20) {
    throw new TypeError("workers must be 1..8 and repeat must be 1..20");
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

let parsed = false;
try {
  const options = parseArgs(process.argv.slice(2));
  parsed = true;
  const run = await createArtifactRun({ command: "bench-resource-workers" });
  const snapshot = await collectSnapshot();
  const budget = freezeBudget(snapshot);
  const rounds = [];
  let sequence = 0;
  for (const workers of options.workers) {
    const allowed = budget.stages.vitest.safe && workers <= budget.vitestWorkers;
    for (let repeat = 0; repeat < options.repeat; repeat += 1) {
      sequence += 1;
      if (!allowed) {
        rounds.push({ workers, repeat: repeat + 1, status: "blocked", reason: "unsafe_worker_budget", wallMs: null, testP50Ms: null, testP95Ms: null, rssPeakBytes: null, heapPeakBytes: null, startupFailed: null, oom: null, residuals: [] });
        continue;
      }
      const attempt = await runChildAttempt({ stage: "vitest", workers, attempt: sequence, cwd: repoRoot, artifactRun: run, budget });
      let durations = [];
      try {
        const result = JSON.parse(await readFile(`${run.rootPath}/vitest-result-attempt-${sequence}.json`, "utf8"));
        durations = (result.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).map((test) => Math.trunc(test.duration ?? 0)));
      } catch {
        durations = [];
      }
      rounds.push({
        workers,
        repeat: repeat + 1,
        status: attempt.exitCode === 0 && attempt.cleanup.ok ? "passed" : "failed",
        wallMs: attempt.durationMs,
        testP50Ms: percentile(durations, 0.50),
        testP95Ms: percentile(durations, 0.95),
        rssPeakBytes: attempt.rssPeakBytes.value,
        heapPeakBytes: attempt.heapPeakBytes.value,
        startupFailed: Boolean(attempt.spawnError),
        oom: attempt.oom.confirmed,
        residuals: attempt.cleanup.residuals,
      });
    }
  }
  const report = { snapshot, frozenBudget: budget, rounds };
  await run.writeJson("worker-curve.json", report);
  const failed = rounds.some((round) => round.status === "failed");
  const blocked = rounds.some((round) => round.status === "blocked");
  const exitCode = failed ? EXIT_CODES.childFailed : blocked ? EXIT_CODES.resourceBlocked : EXIT_CODES.success;
  await run.finish({ exitCode, reason: failed ? "worker_round_failed" : blocked ? "unsafe_worker_budget" : null, details: report });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = exitCode;
} catch (error) {
  console.error(`bench-resource-workers failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = parsed ? EXIT_CODES.internal : EXIT_CODES.usage;
}
