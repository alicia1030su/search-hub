import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { createArtifactRun } from "../../scripts/lib/resource/artifacts.mjs";
// @ts-expect-error -- plain ESM resource module
import { freezeBudget } from "../../scripts/lib/resource/budget.mjs";
// @ts-expect-error -- plain ESM resource module
import { PhaseRunner, STAGES } from "../../scripts/lib/resource/phase-runner.mjs";

const MIB = 1024 * 1024;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function resourceSnapshot(availableBytes: number) {
  const value = (reading: number) => ({ value: reading, source: "test", reason: null });
  return {
    schemaVersion: 1,
    sampledAt: "2026-11-22T00:00:00.000Z",
    platform: { os: "test", arch: "x64", node: "v22", uptimeSeconds: 1 },
    host: { physicalBytes: value(32 * 1024 * MIB), availableBytes: value(availableBytes), swapTotalBytes: value(0), swapFreeBytes: value(0), pageCacheBytes: value(0) },
    cpu: { logicalCpus: value(8), utilizationPercent: value(10) },
    cgroup: { version: "none", limitBytes: { value: null, source: "test", reason: "unlimited" }, currentBytes: { value: null, source: "test", reason: "not_applicable" }, oomKills: value(0) },
    processes: [],
    containers: { docker: { detected: false, source: "test", reason: null }, wsl: { detected: false, source: "test", reason: null } },
  };
}

function attempt(stage: string, workers: number, exitCode = 0, oomConfirmed = false) {
  return {
    stage,
    attempt: 1,
    workers,
    exitCode,
    signal: null,
    durationMs: 1,
    startedAt: "2026-11-22T00:00:00.000Z",
    finishedAt: "2026-11-22T00:00:00.001Z",
    rssPeakBytes: { value: 10, source: "test", reason: null },
    heapPeakBytes: { value: 5, source: "test", reason: null },
    cleanup: { ok: true, residuals: [], errors: [] },
    resourceAborted: false,
    oom: { confirmed: oomConfirmed, reason: oomConfirmed ? "cgroup_oom_kill_with_owned_root_death" : "insufficient_oom_evidence" },
  };
}

async function fixture(availableBytes = 24 * 1024 * MIB) {
  const repoRoot = await mkdtemp(join(tmpdir(), "search-hub-smart-"));
  temporaryDirectories.push(repoRoot);
  const run = await createArtifactRun({ command: "test", repoRoot });
  const snapshot = resourceSnapshot(availableBytes);
  return { repoRoot, artifactRun: run, snapshot, budget: freezeBudget(snapshot) };
}

describe("D03 smart phase ordering and evidence", () => {
  it("runs the strict five stages serially with the frozen Vitest worker count", async () => {
    const context = await fixture();
    const calls: Array<{ stage: string; workers: number }> = [];
    const runner = new PhaseRunner({
      ...context,
      collect: async () => context.snapshot,
      runner: async (options: { stage: string; workers: number }) => {
        calls.push({ stage: options.stage, workers: options.workers });
        return attempt(options.stage, options.workers);
      },
    });
    const report = await runner.run();
    expect(report.exitCode).toBe(0);
    expect(calls.map((call) => call.stage)).toEqual([...STAGES]);
    expect(calls.find((call) => call.stage === "vitest")?.workers).toBe(context.budget.vitestWorkers);
    expect(report.stages.every((stage: { status: string }) => stage.status === "passed")).toBe(true);
    await runner.cleanup();
  });

  it("does not spawn any stage when the safe budget is blocked", async () => {
    const context = await fixture(512 * MIB);
    let calls = 0;
    const runner = new PhaseRunner({ ...context, runner: async () => { calls += 1; return attempt("typecheck", 1); } });
    const report = await runner.run();
    expect(calls).toBe(0);
    expect(report.exitCode).toBe(3);
    expect(report.stages[0].status).toBe("blocked");
  });

  it("stops after a child failure and records later stages as not run", async () => {
    const context = await fixture();
    const calls: string[] = [];
    const runner = new PhaseRunner({
      ...context,
      collect: async () => context.snapshot,
      runner: async (options: { stage: string; workers: number }) => {
        calls.push(options.stage);
        return attempt(options.stage, options.workers, options.stage === "lint" ? 1 : 0);
      },
    });
    const report = await runner.run();
    expect(calls).toEqual(["typecheck", "lint"]);
    expect(report.exitCode).toBe(4);
    expect(report.stages[2].attempts).toBe(0);
  });
});
