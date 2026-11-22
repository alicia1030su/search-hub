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

  it("writes residual evidence when an owned process cannot be removed", async () => {
    const repoRoot = await temporaryDirectory();
    const run = await createArtifactRun({ command: "test", repoRoot });
    const identity = { pid: 77, ppid: 1, startTime: "stable", owned: false, role: "node", executableName: "node" };
    const entry = { identity, rssBytes: { value: 1, source: "test", reason: null } };
    const io = {
      listProcesses: async () => [entry],
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
