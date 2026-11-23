import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { classifyOom } from "../../scripts/lib/resource/oom.mjs";
// @ts-expect-error -- plain ESM resource module
import { resolveTerminalState } from "../../scripts/lib/resource/terminal-state.mjs";
// @ts-expect-error -- plain ESM resource module
import { mergeOwnedTreeEvidence, preShutdownFailure, resolveRootExitBeforeShutdown, summarizeOwnedTreeSamples } from "../../scripts/lib/resource/owned-tree-evidence.mjs";

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
    expect(benchmark).toContain('metadata: { ...baseMetadata, sourceCommit: commit, cleanWorktree: typeof dirty === "string" && dirty.length === 0 }');
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
    expect(linux).toContain("index += 64");
    expect(linux).toContain("pids.slice(index, index + 64)");
    expect(linux).toContain("`/proc/${pid}/stat`");
    expect(windows).toContain("export async function listProcessPidsStrict(");
    expect(windows).toContain("export async function listProcessesStrict(");
    expect(windows).toContain("index += 64");
    expect(windows).toContain("entries.slice(index, index + 64)");
    expect(processTree).toContain("this.io.listProcessesStrict()");
    const linuxStrict = linux.slice(linux.indexOf("export async function listProcessPidsStrict("), linux.indexOf("/** Complete detailed listing"));
    const windowsStrict = windows.slice(windows.indexOf("export async function enumerateToolhelpEntries"), windows.indexOf("async function readWindowsProcess"));
    expect(linuxStrict).not.toMatch(/\bcatch\b/);
    expect(windowsStrict).not.toMatch(/\bcatch\b/);
    expect(windowsStrict).toContain("toolhelp_enumeration_failed");
  });

  it("keeps RSS sampling direct and excludes full-tree enumeration from the measurement loop", () => {
    expect(benchmark).toContain("rootRssSampleIntervalMs: 25");
    expect(benchmark).toContain('rootRssSampleMethod: "direct_process_memory"');
    expect(benchmark).toContain('rootRssSamplerExecution: "benchmark_parent"');
    expect(benchmark).toContain('rootRssSamplerScope: "target_child_root_process"');
    expect(benchmark).toContain('ownedTreeSamplePolicy: "initial_pre_shutdown_and_cleanup"');
    expect(benchmark).toContain('ownedTreePeakMethod: "max_initial_pre_shutdown_strict_snapshots"');
    expect(benchmark.match(/ownedTreePeakMethod:/g)).toHaveLength(1);
    expect(benchmark).toContain('command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)].join(" ")');
    expect(benchmark).toContain("io.readProcessMemory(child.pid)");
    expect(benchmark).not.toContain("sampleTicks");
    expect(benchmark).not.toContain("combineOwnedTreeEvidence");
    expect(benchmark.match(/await owned\.sample\(\)/g)).toHaveLength(2);
    expect(benchmark.indexOf("const strictSnapshot = await owned.sample()")).toBeGreaterThan(benchmark.indexOf("const rssFinalBytes = await readRss()"));
    expect(benchmark.indexOf("const strictSnapshot = await owned.sample()")).toBeLessThan(benchmark.indexOf('child.send({ type: "shutdown"'));
    expect(benchmark).toContain('rssScope: "root_process"');
    expect(benchmark).toContain("ownedTreePeakBytes: ownedTreeEvidence.peakBytes");
    expect(benchmark).toContain("ownedPeakBytes: ownedTreeEvidence.peakBytes");
    expect(benchmark).toContain("ownedRootDied: rootExitedBeforeShutdown");
    expect(benchmark).toContain("resolveRootExitBeforeShutdown({");
    expect(benchmark).toContain("root_exited_before_shutdown");
    expect(benchmark).toContain("root_identity_changed_before_shutdown");
    expect(benchmark).toContain("shutdown_ipc_failed");
    expect(benchmark).toContain("(preShutdownRootAlive || !owned)");
    expect(linux).toContain("export async function readProcessMemory(pid)");
    expect(windows).toContain("export async function readProcessMemory(pid, suppliedApi = null)");
    const windowsMemory = windows.slice(windows.indexOf("export async function readProcessMemory"), windows.indexOf("async function findToolhelpIdentity"));
    expect(windowsMemory).toContain("readWindowsProcess(pid, suppliedApi)");
    expect(windowsMemory).not.toContain("findToolhelpIdentity");
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
    expect(benchmark).toContain("pendingReport.artifactError = sanitizeLog");
    expect(benchmark).toContain("pendingReport.reason = state.reason;");
    expect(benchmark).toContain("resolveTerminalState({ cleanupFailure, abortedBy, threshold: pendingReport })");
    expect(benchmark).toContain("resolveTerminalState({ artifactFailed: true, cleanupFailure, abortedBy, threshold: pendingReport })");
    expect(benchmark.indexOf('process.removeListener("SIGINT"')).toBeGreaterThan(benchmark.indexOf("await artifact.finish"));
    expect(benchmark).not.toMatch(/\bsleep\s*\(/);
  });

  it("separates root RSS from strict owned-tree peak and fails uncertain scope", () => {
    const samples = [
      { identity: { pid: 111, startTime: "root" }, rssBytes: { value: 100 } },
      { identity: { pid: 222, startTime: "child" }, rssBytes: { value: 250 } },
    ];
    const valid = summarizeOwnedTreeSamples(samples, { rootIdentityChanged: false, rootIdentityState: null });
    expect(valid).toEqual({ peakBytes: 350, reason: null, uncertainty: null, rssUnavailable: false, processCount: 2 });
    expect(summarizeOwnedTreeSamples(samples, { rootIdentityChanged: true, rootIdentityState: "missing" })).toMatchObject({ peakBytes: null, uncertainty: "root_missing" });
    expect(summarizeOwnedTreeSamples(samples, { rootIdentityChanged: true, rootIdentityState: "changed" })).toMatchObject({ peakBytes: null, uncertainty: "root_changed" });
    expect(summarizeOwnedTreeSamples(samples, { rootIdentityChanged: false, rootIdentityState: "inspection_failed" })).toMatchObject({ peakBytes: null, uncertainty: "root_inspection_failed" });
    expect(summarizeOwnedTreeSamples(samples, { rootIdentityChanged: false, rootIdentityState: null, inspectionErrors: new Map([[222, {}]]) })).toMatchObject({ peakBytes: null, uncertainty: "owned_tree_inspection_failed" });
    expect(summarizeOwnedTreeSamples([{ identity: { pid: 111, startTime: "root" }, rssBytes: { value: null } }], { rootIdentityChanged: false, rootIdentityState: null })).toEqual({ peakBytes: null, reason: "owned_tree_rss_unavailable", uncertainty: null, rssUnavailable: true, processCount: 1 });
    expect(summarizeOwnedTreeSamples([{ identity: { pid: 111, startTime: null }, rssBytes: { value: 100 } }], { rootIdentityChanged: false, rootIdentityState: null })).toMatchObject({ peakBytes: null, reason: "scope_uncertain", uncertainty: "owned_tree_identity_unavailable" });
    expect(mergeOwnedTreeEvidence(valid, undefined)).toMatchObject({ peakBytes: null, reason: "snapshot_unavailable", uncertainty: "owned_tree_snapshot_unavailable" });
    expect(mergeOwnedTreeEvidence(valid, { ...valid, peakBytes: 400 })).toMatchObject({ peakBytes: 400, reason: null, uncertainty: null });
    expect(mergeOwnedTreeEvidence(valid, { ...valid, peakBytes: null, reason: "rss_unavailable", rssUnavailable: true })).toMatchObject({ peakBytes: null, reason: "owned_tree_rss_unavailable", uncertainty: null });
    expect(mergeOwnedTreeEvidence(valid, { ...valid, peakBytes: null, reason: "scope_uncertain", uncertainty: "root_missing" })).toMatchObject({ peakBytes: null, reason: "scope_uncertain", uncertainty: "root_missing" });
  });

  it("distinguishes abnormal root exit from intentional shutdown", () => {
    expect(resolveRootExitBeforeShutdown({ childOutcome: { code: 0, signal: null } })).toBe(true);
    expect(resolveRootExitBeforeShutdown({ childOutcome: { code: 7, signal: null } })).toBe(true);
    expect(resolveRootExitBeforeShutdown({ childOutcome: { code: null, signal: "SIGKILL" } })).toBe(true);
    expect(resolveRootExitBeforeShutdown({ childOutcome: { code: null, signal: null } })).toBe(false);
    expect(resolveRootExitBeforeShutdown({ rootIdentityChanged: true, rootIdentityState: "missing" })).toBe(true);
    expect(resolveRootExitBeforeShutdown({ rootIdentityChanged: true, rootIdentityState: "changed" })).toBe(true);
    expect(resolveRootExitBeforeShutdown({ childOutcome: { code: 0, signal: null }, shutdownRequested: true })).toBe(false);
    expect(resolveRootExitBeforeShutdown()).toBe(false);
    expect(classifyOom({ exitCode: 0, windowsExitCode: 0, ownedRootDied: false, ownedPeakBytes: 1024 }).confirmed).toBe(false);
    expect(resolveTerminalState({ cleanupFailure: "root_exited_before_shutdown" })).toMatchObject({ status: "child_failed", exitCode: 4, reason: "root_exited_before_shutdown" });
    expect(preShutdownFailure({ uncertainty: "root_missing" })).toEqual({ reason: "root_exited_before_shutdown", rootExited: true });
    expect(preShutdownFailure({ uncertainty: "root_changed" })).toEqual({ reason: "root_identity_changed_before_shutdown", rootExited: true });
    expect(preShutdownFailure({ uncertainty: "owned_tree_inspection_failed" })).toEqual({ reason: "pre_shutdown_inspection_failed", rootExited: false });
    expect(preShutdownFailure({ uncertainty: null })).toBeNull();
  });

  it("prioritizes artifact and cleanup failures over abort", () => {
    expect(resolveTerminalState({ abortedBy: "SIGTERM", cleanupFailure: "owned_process_residual" })).toMatchObject({ status: "child_failed", exitCode: 4, reason: "owned_process_residual", abortReason: "aborted_by_SIGTERM" });
    expect(resolveTerminalState({ abortedBy: "SIGTERM" })).toMatchObject({ status: "resource_blocked", exitCode: 3, reason: "aborted_by_SIGTERM" });
    expect(resolveTerminalState({ artifactFailed: true, abortedBy: "SIGINT", cleanupFailure: "local_cleanup_failed" })).toMatchObject({ status: "internal", exitCode: 5, reason: "artifact_finalization_failed" });
  });

  it("keeps an unknown owned RSS peak null instead of fabricating zero", () => {
    expect(benchmark).toContain("let rssPeakBytes = null");
    expect(benchmark).toContain("ownedPeakBytes: ownedTreeEvidence.peakBytes");
    expect(benchmark).toContain('pendingReport.rssPeakReason = rssPeakBytes === null ? "unavailable" : null;');
    const unknown = classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: null });
    expect(unknown.confirmed).toBe(false);
    expect(unknown.reason).toBe("windows_oom_code_peak_unknown");
    expect(unknown.ownedPeakBytes).toBeNull();
    expect(unknown.ownedPeakReason).toBe("unavailable");
    const unknownWithLog = classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: null, log: "FATAL ERROR: JavaScript heap out of memory" });
    expect(unknownWithLog.confirmed).toBe(false);
    expect(unknownWithLog.reason).toBe("windows_oom_code_peak_unknown");
    expect(unknownWithLog.confirmedReasons).toEqual([]);
    expect(unknownWithLog.evidence).toContain("owned_peak_unknown");
    const knownWithoutLog = classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: 1024 });
    expect(knownWithoutLog.confirmed).toBe(false);
    expect(knownWithoutLog.reason).toBe("windows_oom_code_without_corroborating_log");
    const knownWithLog = classifyOom({ windowsExitCode: 0xC0000017, ownedRootDied: true, ownedPeakBytes: 1024, log: "memory allocation failed" });
    expect(knownWithLog.confirmed).toBe(true);
    expect(knownWithLog.reason).toBe("windows_oom_code_with_owned_peak");
  });

  it("does not fabricate cgroup OOM evidence when the counter is unavailable", () => {
    expect(benchmark).toContain("cgroupOomDelta = Number.isSafeInteger(beforeOom) && Number.isSafeInteger(afterOom)");
    expect(benchmark).toContain("? Math.max(0, afterOom - beforeOom) : null");
    expect(benchmark).toContain('reason: cgroupOomDelta === null ? "unavailable" : null');
  });
});
