import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const benchmark = readFileSync(new URL("../../scripts/bench-resources.mjs", import.meta.url), "utf8");
const processTree = readFileSync(new URL("../../scripts/lib/resource/process-tree.mjs", import.meta.url), "utf8");

describe("resource benchmark static safety contract", () => {
  it("handles termination signals, HTTP deadlines, and dirty worktrees before heavy work", () => {
    expect(benchmark).toContain('process.once("SIGINT"');
    expect(benchmark).toContain('process.once("SIGTERM"');
    expect(benchmark).toContain("AbortSignal.timeout(HTTP_TIMEOUT_MS)");
    expect(benchmark).toContain("worktree_dirty");
    expect(benchmark).toContain('git(["status", "--porcelain"');
    expect(benchmark).toContain("metadata: { ...baseMetadata, sourceCommit: commit, cleanWorktree: dirty.length === 0 }");
  });

  it("proves warmup and measured reads are zero-write and checks each query plan", () => {
    expect(benchmark).toContain("changesBeforeWarmup");
    expect(benchmark).toContain("warmupWriteDelta");
    expect(benchmark).toContain("warmupZeroWritePassed");
    expect(benchmark).toContain("queryPlansPassed(plans)");
    expect(benchmark).toMatch(/Object\.values\(plans\)\.every/);
    expect(benchmark).toMatch(/USING \(\?:PRIMARY KEY\|INDEX\)/);
    expect(benchmark).toMatch(/!\/SCAN\/i/);
  });

  it("uses owned identity cleanup, bounded stderr, non-overlapping sampling, and full residual identities", () => {
    expect(benchmark).toContain("new OwnedProcessTree");
    expect(benchmark).toContain("await owned.sample()");
    expect(benchmark).toContain("await owned.cleanup()");
    expect(benchmark).not.toMatch(/\bchild\.kill\s*\(/);
    expect(benchmark).toContain(".slice(-8192)");
    expect(benchmark).toContain("if (sampling) return");
    expect(benchmark).toContain("residualProcesses = residuals");
    expect(processTree).toContain("current.identity.startTime !== registered.startTime");
    expect(processTree).toContain("sampleRegisteredDescendants");
  });

  it("does not fabricate cgroup OOM evidence when the counter is unavailable", () => {
    expect(benchmark).toContain("cgroupOomDelta = Number.isSafeInteger(beforeOom) && Number.isSafeInteger(afterOom)");
    expect(benchmark).toContain("? Math.max(0, afterOom - beforeOom) : null");
    expect(benchmark).toContain('reason: cgroupOomDelta === null ? "unavailable" : null');
  });
});
