import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { OwnedProcessTree, adapter } from "../../scripts/lib/resource/process-tree.mjs";
// @ts-expect-error -- plain ESM resource module
import { createArtifactRun } from "../../scripts/lib/resource/artifacts.mjs";
// @ts-expect-error -- plain ESM resource module
import { runChildAttempt } from "../../scripts/lib/resource/child-runner.mjs";
// @ts-expect-error -- plain ESM resource module
import { createTelemetryServer } from "../../scripts/lib/resource/telemetry-server.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "search-hub-resource-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("D02 owned process identity and telemetry", () => {
  it("cleans a real owned child and leaves no residual", async () => {
    const io = adapter(process.platform);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    expect(child.pid).toBeTruthy();
    const root = await io.readProcess(child.pid!);
    expect(root).toBeTruthy();
    const tree = new OwnedProcessTree(child.pid!, root!.identity.startTime, { io, termGraceMs: 1_000 });
    const result = await tree.cleanup();
    expect(result.ok).toBe(true);
    expect(result.residuals).toEqual([]);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });

  it("never signals a PID whose start identity changed", async () => {
    const signals: number[] = [];
    const identity = { pid: 42, ppid: 1, startTime: "new", owned: false, role: "node", executableName: "node" };
    const io = {
      listProcesses: async () => [{ identity, rssBytes: { value: 10, source: "test", reason: null } }],
      readProcess: async () => ({ identity, rssBytes: { value: 10, source: "test", reason: null } }),
      terminateProcess: async (pid: number) => { signals.push(pid); },
      killProcess: async (pid: number) => { signals.push(pid); },
    };
    const tree = new OwnedProcessTree(42, "old", { io });
    expect(await tree.sample()).toEqual([]);
    expect(tree.rootIdentityChanged).toBe(true);
    expect(tree.rootIdentityState).toBe("changed");
    const result = await tree.cleanup();
    expect(signals).toEqual([]);
    expect(result.residuals).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.reason).toBe("root_identity_changed");
  });

  it("skips Windows console TERM without group ownership and KILLs only the verified owned PID", async () => {
    const signals: string[] = [];
    let alive = true;
    const identity = { pid: 43, ppid: 1, startTime: "stable", owned: false, role: "node", executableName: "node" };
    const entry = { identity, rssBytes: { value: 10, source: "test", reason: null } };
    const io = {
      listProcesses: async () => alive ? [entry] : [],
      listProcessesStrict: async () => alive ? [entry] : [],
      readProcess: async () => alive ? entry : null,
      terminateProcess: async () => { signals.push("term"); },
      killProcess: async () => { signals.push("kill"); alive = false; },
    };
    const tree = new OwnedProcessTree(43, "stable", { platform: "win32", io, consoleCtrlOwned: false, termGraceMs: 10 });
    const result = await tree.cleanup();
    expect(signals).toEqual(["kill"]);
    expect(result.ok).toBe(true);
  });

  it("samples Node telemetry over authenticated loopback and rejects a bad token", async () => {
    const telemetry = await createTelemetryServer();
    try {
      const response = await fetch(telemetry.endpoint, { method: "POST", headers: { "content-type": "application/json", "x-resource-token": "wrong" }, body: "{}" });
      expect(response.status).toBe(403);
      const responseOk = await fetch(telemetry.endpoint, { method: "POST", headers: { "content-type": "application/json", "x-resource-token": telemetry.token }, body: JSON.stringify({ pid: process.pid, heapUsedBytes: 1, heapTotalBytes: 2, externalBytes: 3, arrayBuffersBytes: 4 }) });
      expect(responseOk.status).toBe(204);
      expect(telemetry.samples.get(process.pid)?.heapUsedBytes).toBe(1);
    } finally {
      await telemetry.close();
    }
  });

  it("runs a real child with heap sampling, sanitized logs, and finally cleanup", async () => {
    const repoRoot = await temporaryDirectory();
    const run = await createArtifactRun({ command: "test", repoRoot });
    const spawnImpl = (_command: string, _args: string[], options: object) => spawn(process.execPath, ["-e", "console.log('Authorization: Bearer secret'); console.log('token=secret'); setTimeout(() => {}, 400)"], options as Parameters<typeof spawn>[2]);
    const result = await runChildAttempt({ stage: "typecheck", workers: 1, artifactRun: run, cwd: repoRoot, spawnImpl, sampleIntervalMs: 25 });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.cleanup.ok).toBe(true);
    expect(result.heapPeakBytes.value).toBeGreaterThan(0);
    const log = await readFile(join(run.rootPath, result.logPath), "utf8");
    expect(log).not.toContain("secret");
    await run.finish({ exitCode: 0 });
  });
});
