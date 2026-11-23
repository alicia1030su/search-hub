import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { classifyOom } from "../../scripts/lib/resource/oom.mjs";
// @ts-expect-error -- plain ESM resource module
import { resolveTerminalState } from "../../scripts/lib/resource/terminal-state.mjs";

const benchmark = readFileSync(new URL("../../scripts/bench-resources.mjs", import.meta.url), "utf8");
const processTree = readFileSync(new URL("../../scripts/lib/resource/process-tree.mjs", import.meta.url), "utf8");
const linux = readFileSync(new URL("../../scripts/lib/resource/linux.mjs", import.meta.url), "utf8");
const windows = readFileSync(new URL("../../scripts/lib/resource/windows.mjs", import.meta.url), "utf8");

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
    expect(processTree).toContain("listProcessPidsStrict");
    expect(processTree).toContain("strict_process_listing_unavailable");
    expect(linux).toContain("export async function listProcessPidsStrict(");
    expect(linux).toContain("export async function listProcessesStrict()");
    expect(windows).toContain("export async function listProcessPidsStrict(");
    expect(windows).toContain("export async function listProcessesStrict(");
    expect(processTree).toContain("this.io.listProcessesStrict()");
    const linuxStrict = linux.slice(linux.indexOf("export async function listProcessPidsStrict("), linux.indexOf("/** Complete detailed listing"));
    const windowsStrict = windows.slice(windows.indexOf("export async function enumerateToolhelpEntries"), windows.indexOf("async function readWindowsProcess"));
    expect(linuxStrict).not.toMatch(/\bcatch\b/);
    expect(windowsStrict).not.toMatch(/\bcatch\b/);
    expect(windowsStrict).toContain("toolhelp_enumeration_failed");
  });

  it("makes abort and git-preflight failure terminal before artifact finalization", () => {
    expect(benchmark).toContain("const throwIfAborted = () =>");
    expect(benchmark).toContain("throwIfAborted();\n      const p50Ms");
    expect(benchmark).toContain("throwIfAborted();\n      pendingReport = report");
    expect(benchmark).toContain("applyTerminalState();\n        let writtenKey");
    expect(benchmark).toContain("if (terminalKey() !== writtenKey)");
    expect(benchmark).toContain("source_preflight_failed");
    expect(benchmark).toContain("preflightFailure");
    expect(benchmark).toContain("await artifact.finish");
    expect(benchmark).toContain("if (!pendingReport)");
    expect(benchmark).toContain("throwIfAborted();\n    baseReport.resourceSnapshot");
    expect(benchmark).toContain("metadata: { ...baseReport.metadata }");
    expect(benchmark.indexOf('artifact.appendLog("raw/child-stderr.log"')).toBeLessThan(benchmark.indexOf('artifact.writeJson("resources-benchmark.json"'));
    expect(benchmark.indexOf('artifact.writeJson("resources-benchmark.json"')).toBeLessThan(benchmark.indexOf("await artifact.finish"));
    expect(benchmark).toContain('pendingReport.reason = "artifact_finalization_failed"');
    expect(benchmark).toContain("resolveTerminalState({ cleanupFailure, abortedBy, threshold: pendingReport })");
    expect(benchmark).toContain("resolveTerminalState({ artifactFailed: true, cleanupFailure, abortedBy, threshold: pendingReport })");
    expect(benchmark.indexOf('process.removeListener("SIGINT"')).toBeGreaterThan(benchmark.indexOf("await artifact.finish"));
    expect(benchmark).not.toMatch(/\bsleep\s*\(/);
  });

  it("prioritizes artifact and cleanup failures over abort", () => {
    expect(resolveTerminalState({ abortedBy: "SIGTERM", cleanupFailure: "owned_process_residual" })).toMatchObject({ status: "child_failed", exitCode: 4, reason: "owned_process_residual", abortReason: "aborted_by_SIGTERM" });
    expect(resolveTerminalState({ abortedBy: "SIGTERM" })).toMatchObject({ status: "resource_blocked", exitCode: 3, reason: "aborted_by_SIGTERM" });
    expect(resolveTerminalState({ artifactFailed: true, abortedBy: "SIGINT", cleanupFailure: "local_cleanup_failed" })).toMatchObject({ status: "internal", exitCode: 5, reason: "artifact_finalization_failed" });
  });

  it("keeps an unknown owned RSS peak null instead of fabricating zero", () => {
    expect(benchmark).toContain("let rssPeakBytes = null");
    expect(benchmark).toContain("ownedPeakBytes: rssPeakBytes");
    expect(benchmark).toContain('rssPeakReason: rssPeakBytes === null ? "unavailable" : null');
    const unknown = classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: null });
    expect(unknown.confirmed).toBe(false);
    expect(unknown.reason).toBe("windows_oom_code_without_memory_log");
    expect(unknown.ownedPeakBytes).toBeNull();
    expect(unknown.ownedPeakReason).toBe("unavailable");
    const unknownWithLog = classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: null, log: "FATAL ERROR: JavaScript heap out of memory" });
    expect(unknownWithLog.confirmed).toBe(false);
    expect(unknownWithLog.reason).toBe("windows_oom_code_peak_unknown");
    expect(unknownWithLog.confirmedReasons).toEqual([]);
    expect(unknownWithLog.evidence).toContain("owned_peak_unknown");
    expect(classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: 1024 }).confirmed).toBe(false);
    expect(classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: 1024, log: "memory allocation failed" }).confirmed).toBe(true);
  });

  it("does not fabricate cgroup OOM evidence when the counter is unavailable", () => {
    expect(benchmark).toContain("cgroupOomDelta = Number.isSafeInteger(beforeOom) && Number.isSafeInteger(afterOom)");
    expect(benchmark).toContain("? Math.max(0, afterOom - beforeOom) : null");
    expect(benchmark).toContain('reason: cgroupOomDelta === null ? "unavailable" : null');
  });
});
