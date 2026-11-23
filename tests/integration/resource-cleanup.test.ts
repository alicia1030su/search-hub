import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { createArtifactRun } from "../../scripts/lib/resource/artifacts.mjs";
// @ts-expect-error -- plain ESM resource module
import { runChildAttempt } from "../../scripts/lib/resource/child-runner.mjs";
// @ts-expect-error -- plain ESM packaging module
import { runOwnedProcess } from "../../packaging/process-runner.mjs";
// @ts-expect-error -- plain ESM resource module
import { OwnedProcessTree } from "../../scripts/lib/resource/process-tree.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "search-hub-cleanup-"));
  directories.push(directory);
  return directory;
}

describe("D06 finally cleanup", () => {
  it("cleans an owned child after a nonzero exit and persists its real log", async () => {
    const repoRoot = await temporaryDirectory();
    const run = await createArtifactRun({ command: "test", repoRoot });
    const { spawn } = await import("node:child_process");
    const spawnImpl = (_command: string, _args: string[], options: object) => spawn(process.execPath, ["-e", "console.error('real failure'); process.exit(7)"], options as Parameters<typeof spawn>[2]);
    const result = await runChildAttempt({ stage: "lint", workers: 1, artifactRun: run, cwd: repoRoot, spawnImpl, sampleIntervalMs: 20 });
    expect(result.exitCode).toBe(7);
    expect(result.cleanup.ok).toBe(true);
    expect(result.cleanup.residuals).toEqual([]);
    expect(await readFile(join(run.rootPath, result.logPath), "utf8")).toContain("real failure");
  });

  it("packaging runner returns the child exit code with no residual", async () => {
    const result = await runOwnedProcess(process.execPath, ["-e", "process.exit(9)"], { stdio: "ignore", termGraceMs: 1_000 });
    expect(result.exitCode).toBe(9);
    expect(result.cleanup.ok, JSON.stringify(result.cleanup)).toBe(true);
    expect(result.cleanup.residuals).toEqual([]);
  });

  it("reports and cleans an identity-stable descendant after the owned root exits", async () => {
    const descendant = { pid: 222, ppid: 111, startTime: "descendant-stable", owned: false, role: "node", executableName: "node" };
    const entry = { identity: descendant, rssBytes: { value: 1, source: "test", reason: null } };
    const signalled: number[] = [];
    const io = {
      listProcesses: async () => [],
      listProcessPidsStrict: async () => [],
      readProcess: async (pid: number) => pid === 222 ? entry : null,
      terminateProcess: async (pid: number) => { signalled.push(pid); },
      killProcess: async (pid: number) => { signalled.push(pid); },
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    tree.records.set(222, { ...descendant, owned: true });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.residuals).toEqual([expect.objectContaining({ pid: 222, ppid: 111, startTime: "descendant-stable" })]);
    expect(signalled).toContain(222);
    expect(signalled).not.toContain(111);
  });

  it("fails cleanup when a registered descendant cannot be inspected", async () => {
    const descendant = { pid: 222, ppid: 111, startTime: "descendant-stable", owned: false, role: "node", executableName: "node" };
    const signalled: number[] = [];
    const io = {
      listProcesses: async () => [],
      listProcessPidsStrict: async () => [],
      readProcess: async (pid: number) => {
        if (pid === 222) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return null;
      },
      terminateProcess: async (pid: number) => { signalled.push(pid); },
      killProcess: async (pid: number) => { signalled.push(pid); },
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    tree.records.set(222, { ...descendant, owned: true });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.errors).toContainEqual(expect.objectContaining({
      pid: 222,
      stage: "inspect",
      reason: "process_read_failed:EACCES",
      identity: expect.objectContaining({ pid: 222, ppid: 111, startTime: "descendant-stable" }),
    }));
    expect(signalled).toEqual([]);
  });

  it("does not treat an ambiguous null descendant read as proof of exit", async () => {
    const descendant = { pid: 222, ppid: 111, startTime: "descendant-stable", owned: false, role: "node", executableName: "node" };
    const io = {
      listProcesses: async () => { throw new Error("listing unavailable"); },
      listProcessPidsStrict: async () => { throw new Error("strict listing unavailable"); },
      readProcess: async () => null,
      terminateProcess: async () => {},
      killProcess: async () => {},
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    tree.records.set(222, { ...descendant, owned: true });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.errors).toContainEqual(expect.objectContaining({ pid: 222, stage: "inspect", reason: "process_listing_failed:strict listing unavailable" }));
  });

  it("fails when a descendant PID exists but its details remain unreadable", async () => {
    const descendant = { pid: 222, ppid: 111, startTime: "descendant-stable", owned: false, role: "node", executableName: "node" };
    const signalled: number[] = [];
    const io = {
      listProcesses: async () => [],
      listProcessPidsStrict: async () => [222],
      readProcess: async () => null,
      terminateProcess: async (pid: number) => { signalled.push(pid); },
      killProcess: async (pid: number) => { signalled.push(pid); },
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    tree.records.set(222, { ...descendant, owned: true });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.errors).toContainEqual(expect.objectContaining({ pid: 222, stage: "inspect", reason: "process_read_unavailable" }));
    expect(signalled).toEqual([]);
  });

  it("clears an inspection error only after an authoritative listing proves exit", async () => {
    const descendant = { pid: 222, ppid: 111, startTime: "descendant-stable", owned: false, role: "node", executableName: "node" };
    let reads = 0;
    const io = {
      listProcesses: async () => [],
      listProcessPidsStrict: async () => [],
      readProcess: async (pid: number) => {
        if (pid === 222 && reads++ === 0) throw Object.assign(new Error("transient"), { code: "EIO" });
        return null;
      },
      terminateProcess: async () => {},
      killProcess: async () => {},
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    tree.records.set(222, { ...descendant, owned: true });
    await tree.sample();
    await tree.sample();
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(true);
    expect(cleanup.errors).toEqual([]);
  });

  it("fails without signalling when the root identity cannot be inspected", async () => {
    const root = { pid: 111, ppid: 1, startTime: "root-stable", owned: false, role: "node", executableName: "node" };
    const entry = { identity: root, rssBytes: { value: 1, source: "test", reason: null } };
    const signalled: number[] = [];
    const io = {
      listProcesses: async () => [entry],
      listProcessPidsStrict: async () => [entry.identity.pid],
      readProcess: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
      terminateProcess: async (pid: number) => { signalled.push(pid); },
      killProcess: async (pid: number) => { signalled.push(pid); },
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.reason).toBe("root_inspection_failed");
    expect(cleanup.errors).toContainEqual(expect.objectContaining({ pid: 111, stage: "inspect", reason: "process_read_failed:EACCES" }));
    expect(signalled).toEqual([]);
  });

  it("does not call an ambiguous null root read missing when listing fails", async () => {
    const io = {
      listProcesses: async () => { throw new Error("listing unavailable"); },
      listProcessPidsStrict: async () => { throw new Error("strict listing unavailable"); },
      readProcess: async () => null,
      terminateProcess: async () => {},
      killProcess: async () => {},
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.reason).toBe("root_inspection_failed");
    expect(cleanup.errors).toContainEqual(expect.objectContaining({ pid: 111, reason: "process_listing_failed:strict listing unavailable" }));
  });

  it("accepts root exit only when an authoritative listing omits the root", async () => {
    const io = {
      listProcesses: async () => [],
      listProcessPidsStrict: async () => [],
      readProcess: async () => { throw Object.assign(new Error("already exited"), { code: "ESRCH" }); },
      terminateProcess: async () => {},
      killProcess: async () => {},
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(true);
    expect(cleanup.reason).toBe("root_missing");
    expect(cleanup.errors).toEqual([]);
  });

  it("clears a stale descendant inspection error after a successful normal sample", async () => {
    const root = { pid: 111, ppid: 1, startTime: "root-stable", owned: false, role: "node", executableName: "node" };
    const descendant = { pid: 222, ppid: 111, startTime: "descendant-stable", owned: false, role: "node", executableName: "node" };
    const entries = [root, descendant].map((identity) => ({ identity, rssBytes: { value: 1, source: "test", reason: null } }));
    const io = {
      listProcesses: async () => entries,
      listProcessPidsStrict: async () => [111, 222],
      readProcess: async (pid: number) => entries.find((entry) => entry.identity.pid === pid) ?? null,
      terminateProcess: async () => {},
      killProcess: async () => {},
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    tree.records.set(222, { ...descendant, owned: true });
    tree.noteInspectionError(222, "process_read_failed:EIO");
    await tree.sample();
    expect(tree.inspectionErrors.has(222)).toBe(false);
  });

  it("never signals a descendant whose PID was reused", async () => {
    const descendant = { pid: 222, ppid: 111, startTime: "descendant-reused", owned: false, role: "node", executableName: "node" };
    const entry = { identity: descendant, rssBytes: { value: 1, source: "test", reason: null } };
    const signalled: number[] = [];
    const io = {
      listProcesses: async () => [],
      listProcessPidsStrict: async () => [],
      readProcess: async (pid: number) => pid === 222 ? entry : null,
      terminateProcess: async (pid: number) => { signalled.push(pid); },
      killProcess: async (pid: number) => { signalled.push(pid); },
    };
    const tree = new OwnedProcessTree(111, "root-stable", { io, termGraceMs: 1 });
    tree.records.set(222, { ...descendant, startTime: "descendant-old", owned: true });
    const cleanup = await tree.cleanup();
    expect(cleanup.residuals).toEqual([]);
    expect(signalled).toEqual([]);
  });

  it("fails on a reused root identity without signalling the reused root", async () => {
    const reusedRoot = { pid: 111, ppid: 1, startTime: "root-reused", owned: false, role: "node", executableName: "node" };
    const entry = { identity: reusedRoot, rssBytes: { value: 1, source: "test", reason: null } };
    const signalled: number[] = [];
    const io = {
      listProcesses: async () => [],
      listProcessPidsStrict: async () => [],
      readProcess: async () => entry,
      terminateProcess: async (pid: number) => { signalled.push(pid); },
      killProcess: async (pid: number) => { signalled.push(pid); },
    };
    const tree = new OwnedProcessTree(111, "root-original", { io, termGraceMs: 1 });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.errors).toContainEqual(expect.objectContaining({ pid: 111, reason: "root_identity_changed" }));
    expect(signalled).toEqual([]);
  });

  it("writes residual evidence when an owned process cannot be removed", async () => {
    const repoRoot = await temporaryDirectory();
    const run = await createArtifactRun({ command: "test", repoRoot });
    const identity = { pid: 77, ppid: 1, startTime: "stable", owned: false, role: "node", executableName: "node" };
    const entry = { identity, rssBytes: { value: 1, source: "test", reason: null } };
    const io = {
      listProcesses: async () => [entry],
      listProcessPidsStrict: async () => [entry.identity.pid],
      readProcess: async () => entry,
      terminateProcess: async () => {},
      killProcess: async () => {},
    };
    const tree = new OwnedProcessTree(77, "stable", { io, termGraceMs: 20 });
    const cleanup = await tree.cleanup();
    expect(cleanup.ok).toBe(false);
    expect(cleanup.residuals).toHaveLength(1);
    await run.writeJson("residual-processes.json", cleanup.residuals);
    expect(JSON.parse(await readFile(join(run.rootPath, "residual-processes.json"), "utf8"))).toHaveLength(1);
  });
});
