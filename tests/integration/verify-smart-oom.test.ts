import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { createArtifactRun } from "../../scripts/lib/resource/artifacts.mjs";
// @ts-expect-error -- plain ESM resource module
import { freezeBudget } from "../../scripts/lib/resource/budget.mjs";
// @ts-expect-error -- plain ESM resource module
import { PhaseRunner } from "../../scripts/lib/resource/phase-runner.mjs";

const MIB = 1024 * 1024;
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function makeSnapshot() {
  const value = (reading: number) => ({ value: reading, source: "test", reason: null });
  return {
    schemaVersion: 1,
    sampledAt: "2026-11-22T00:00:00.000Z",
    platform: { os: "test", arch: "x64", node: "v22", uptimeSeconds: 1 },
    host: { physicalBytes: value(32 * 1024 * MIB), availableBytes: value(24 * 1024 * MIB), swapTotalBytes: value(0), swapFreeBytes: value(0), pageCacheBytes: value(0) },
    cpu: { logicalCpus: value(8), utilizationPercent: value(10) },
    cgroup: { version: "none", limitBytes: { value: null, source: "test", reason: "unlimited" }, currentBytes: { value: null, source: "test", reason: "not_applicable" }, oomKills: value(0) },
    processes: [],
    containers: { docker: { detected: false, source: "test", reason: null }, wsl: { detected: false, source: "test", reason: null } },
  };
}

function result(stage: string, workers: number, number: number, exitCode: number, confirmed: boolean) {
  return {
    stage, attempt: number, workers, exitCode, signal: exitCode === 137 ? "SIGKILL" : null, durationMs: 1,
    startedAt: "2026-11-22T00:00:00.000Z", finishedAt: "2026-11-22T00:00:00.001Z",
    rssPeakBytes: { value: 10, source: "test", reason: null }, heapPeakBytes: { value: 5, source: "test", reason: null },
    cleanup: { ok: true, residuals: [], errors: [] }, resourceAborted: false,
    oom: { confirmed, reason: confirmed ? "cgroup_oom_kill_with_owned_root_death" : "insufficient_oom_evidence" },
  };
}

async function runScenario(secondExitCode: number, firstConfirmed: boolean) {
  const repoRoot = await mkdtemp(join(tmpdir(), "search-hub-oom-"));
  directories.push(repoRoot);
  const artifactRun = await createArtifactRun({ command: "test", repoRoot });
  const snapshot = makeSnapshot();
  const budget = freezeBudget(snapshot, { peakMiB: { vitest: 512 } });
  const calls: Array<{ stage: string; attempt: number; workers: number }> = [];
  const runner = new PhaseRunner({
    repoRoot,
    artifactRun,
    snapshot,
    budget,
    collect: async () => snapshot,
    runner: async (options: { stage: string; attempt: number; workers: number }) => {
      calls.push({ stage: options.stage, attempt: options.attempt, workers: options.workers });
      if (options.stage !== "vitest") return result(options.stage, 1, 1, 0, false);
      if (options.attempt === 1) return result("vitest", options.workers, 1, 137, firstConfirmed);
      return result("vitest", options.workers, 2, secondExitCode, false);
    },
  });
  const report = await runner.run();
  await runner.cleanup();
  return { report, calls };
}

describe("D08 one-time OOM retry", () => {
  it("retries Vitest once with workers-1 and preserves passed_after_oom_retry", async () => {
    const { report, calls } = await runScenario(0, true);
    const vitest = report.stages.find((stage: { stage: string }) => stage.stage === "vitest");
    expect(vitest.status).toBe("passed_after_oom_retry");
    expect(vitest.attemptDetails).toHaveLength(2);
    expect(vitest.attemptDetails[0].exitCode).toBe(137);
    expect(vitest.attemptDetails[1].workers).toBe(vitest.attemptDetails[0].workers - 1);
    expect(report.oomRetries).toHaveLength(1);
    expect(calls.filter((call) => call.stage === "vitest")).toHaveLength(2);
  });

  it("blocks on the second failure and never retries a non-OOM exit 137", async () => {
    const failed = await runScenario(1, true);
    expect(failed.report.stages.find((stage: { stage: string }) => stage.stage === "vitest").status).toBe("failed_after_oom_retry");
    expect(failed.report.exitCode).toBe(4);
    const nonOom = await runScenario(0, false);
    expect(nonOom.calls.filter((call) => call.stage === "vitest")).toHaveLength(1);
    expect(nonOom.report.oomRetries).toHaveLength(0);
  });
});
