import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module; contracts are declared in JSDoc
import { collectSnapshot, largestProcesses } from "../../scripts/lib/resource/snapshot.mjs";
// @ts-expect-error -- plain ESM resource module
import { collectMemory as collectWindowsMemory, collectCpu as collectWindowsCpu } from "../../scripts/lib/resource/windows.mjs";
// @ts-expect-error -- plain ESM resource module
import { freezeBudget, headroomMiB } from "../../scripts/lib/resource/budget.mjs";
// @ts-expect-error -- plain ESM resource module
import { classifyPressure } from "../../scripts/lib/resource/pressure.mjs";
// @ts-expect-error -- plain ESM resource module
import { classifyOom } from "../../scripts/lib/resource/oom.mjs";
// @ts-expect-error -- plain ESM resource module
import { sanitizeLog } from "../../scripts/lib/resource/report.mjs";
// @ts-expect-error -- plain ESM resource module
import { compareLowmem, normalizeList } from "../../scripts/lib/resource/lowmem.mjs";

const MIB = 1024 * 1024;
const reading = (value: number | null, source = "test", reason: string | null = null) => ({ value, source, reason });

function snapshot(availableGiB: number, options: { physicalGiB?: number; cgroupLimitGiB?: number; cgroupCurrentGiB?: number; cpus?: number } = {}) {
  return {
    schemaVersion: 1,
    sampledAt: "2026-11-22T00:00:00.000Z",
    platform: { os: "test", arch: "x64", node: "v22", uptimeSeconds: 1 },
    host: {
      physicalBytes: reading((options.physicalGiB ?? 32) * 1024 * MIB),
      availableBytes: reading(availableGiB * 1024 * MIB),
      swapTotalBytes: reading(8 * 1024 * MIB),
      swapFreeBytes: reading(7 * 1024 * MIB),
      pageCacheBytes: reading(2 * 1024 * MIB),
    },
    cpu: { logicalCpus: reading(options.cpus ?? 16), utilizationPercent: reading(20) },
    cgroup: {
      version: options.cgroupLimitGiB === undefined ? "none" : "v2",
      limitBytes: reading(options.cgroupLimitGiB === undefined ? null : options.cgroupLimitGiB * 1024 * MIB, "test", options.cgroupLimitGiB === undefined ? "unlimited" : null),
      currentBytes: reading((options.cgroupCurrentGiB ?? 0) * 1024 * MIB),
      oomKills: reading(0),
    },
    processes: [],
    containers: { docker: { detected: false, source: "test", reason: null }, wsl: { detected: null, source: "test", reason: "unavailable" } },
  };
}

describe("D01 resource snapshots", () => {
  it("normalizes opt-in processes and never serializes argv/env", async () => {
    const io = {
      collectMemory: async () => snapshot(20).host,
      collectCpu: async () => snapshot(20).cpu,
      collectCgroup: async () => snapshot(20).cgroup,
      detectContainers: async () => snapshot(20).containers,
      listProcesses: async () => [
        { identity: { pid: 10, ppid: 1, startTime: "a", owned: false, role: "node", executableName: "node.exe" }, rssBytes: reading(1000) },
        { identity: { pid: 11, ppid: 10, startTime: "b", owned: false, role: "chromium", executableName: "chrome.exe" }, rssBytes: reading(2000) },
      ],
    };
    const value = await collectSnapshot({ includeProcesses: true, platform: "win32", io, now: new Date("2026-11-22T00:00:00.000Z"), cpuDelayMs: 0 });
    expect(value.processes).toHaveLength(2);
    expect(value.processes.find((entry: { identity: { pid: number } }) => entry.identity.pid === 10)?.v8.heapUsedBytes.reason).toBe("telemetry_not_requested");
    expect(value.processes.find((entry: { identity: { pid: number } }) => entry.identity.pid === 11)?.v8.heapUsedBytes).toEqual(reading(null, "v8", "not_node"));
    expect(largestProcesses(value)[0]?.pid).toBe(11);
    const json = JSON.stringify(value);
    expect(json).not.toContain("argv");
    expect(json).not.toContain("process.env");
  });

  it("uses real Win32 values on Windows and explicit reasons for unknowns", async () => {
    type Reading = { value: number | null; source: string; reason: string | null };
    const host = (await collectWindowsMemory()) as { physicalBytes: Reading; availableBytes: Reading } & Record<string, Reading>;
    if (process.platform === "win32") {
      expect(host.physicalBytes.value).toBeGreaterThan(0);
      expect(host.availableBytes.value).toBeGreaterThan(0);
      expect(host.availableBytes.source).toContain("win32");
    }
    for (const item of Object.values(host)) {
      if (item.value === null) expect(item.reason).toBeTruthy();
    }
    const cpu = await collectWindowsCpu(20);
    expect(cpu.utilizationPercent.value).toBeGreaterThanOrEqual(0);
    expect(cpu.utilizationPercent.value).toBeLessThanOrEqual(100);
  });
});

describe("D01/D07 budget and pressure", () => {
  it("uses the conservative host/cgroup minimum and CPU only as a cap", () => {
    const value = snapshot(20, { cgroupLimitGiB: 6, cgroupCurrentGiB: 2, cpus: 2 });
    expect(headroomMiB(value).value).toBeLessThan(4 * 1024);
    const budget = freezeBudget(value, { now: new Date("2026-11-22T00:00:00.000Z") });
    expect(budget.cpuCap).toBe(2);
    expect(budget.vitestWorkers).toBeLessThanOrEqual(2);
    expect(budget.estimated).toBe(true);
  });

  it("blocks instead of starting one worker when the safe budget is insufficient", () => {
    const budget = freezeBudget(snapshot(1));
    expect(budget.safe).toBe(false);
    expect(budget.vitestWorkers).toBe(0);
    expect(budget.blockedStages).toContain("playwright");
    expect(classifyPressure(budget, snapshot(1)).level).toBe("stop");
  });

  it("classifies all five levels and applies two-sample recovery hysteresis", () => {
    const budget = freezeBudget(snapshot(24));
    expect(classifyPressure(budget, snapshot(24)).level).toBe("normal");
    expect(classifyPressure(budget, snapshot(24 * 0.60)).level).toBe("warn");
    expect(classifyPressure(budget, snapshot(24 * 0.40)).level).toBe("high");
    expect(classifyPressure(budget, snapshot(24 * 0.20)).level).toBe("danger");
    const first = classifyPressure(budget, snapshot(24 * 0.80), { previousLevel: "warn", recoverySamples: 0 });
    expect(first.level).toBe("warn");
    expect(first.recoverySamples).toBe(1);
    expect(classifyPressure(budget, snapshot(24 * 0.80), { previousLevel: first.level, recoverySamples: first.recoverySamples }).level).toBe("normal");
  });
});

describe("D04 low-memory complete-suite comparison", () => {
  it("compares file and fullName unions and rejects skip/todo/scope differences", () => {
    const listed = normalizeList([{ file: "C:/repo/a.test.ts", name: "suite > one" }, { file: "C:/repo/a.test.ts", name: "suite > two" }]);
    const passed = { testResults: [{ name: "C:/repo/a.test.ts", assertionResults: [{ fullName: "suite > two", status: "passed" }, { fullName: "suite > one", status: "passed" }] }] };
    expect(compareLowmem(listed, passed, { runExitCode: 0 }).passed).toBe(true);
    expect(compareLowmem(listed, { testResults: [{ name: "C:/repo/a.test.ts", assertionResults: [{ fullName: "suite > one", status: "passed" }] }] }, { runExitCode: 0 }).missing).toHaveLength(1);
    const skipped = { testResults: [{ name: "C:/repo/a.test.ts", assertionResults: [{ fullName: "suite > one", status: "skipped" }, { fullName: "suite > two", status: "todo" }] }] };
    expect(compareLowmem(listed, skipped, { runExitCode: 0 }).passed).toBe(false);
    expect(compareLowmem([], { testResults: [] }, { runExitCode: 0 }).passed).toBe(false);
  });
});

describe("D08 OOM evidence and redaction", () => {
  it("does not infer OOM from exit 137, SIGKILL, exit 1, or timeout alone", () => {
    for (const attempt of [{ exitCode: 137 }, { exitCode: 1 }, { exitCode: null, signal: "SIGKILL" }, { exitCode: 124 }]) {
      expect(classifyOom(attempt).confirmed).toBe(false);
    }
  });

  it("requires corroboration and accepts explicit V8/Windows/cgroup evidence", () => {
    expect(classifyOom({ exitCode: 137, ownedRootDied: true }, { cgroupOomDelta: 1 }).confirmed).toBe(true);
    expect(classifyOom({ exitCode: 134, signal: "SIGABRT", log: "FATAL ERROR: Reached heap limit" }).confirmed).toBe(true);
    expect(classifyOom({ exitCode: 5, ownedRootDied: true, ownedPeakBytes: 100 }, { injectedEvidence: { windowsCode: 0xC0000017 } }).confirmed).toBe(true);
    expect(classifyOom({ exitCode: 5, ownedRootDied: false }, { cgroupOomDelta: 1 }).confirmed).toBe(false);
  });

  it("redacts credentials without changing failure facts", () => {
    const text = sanitizeLog("Authorization: Bearer secret\nCookie: session=secret\napi_key=secret\nexit=137\n");
    expect(text).not.toContain("secret");
    expect(text).toContain("exit=137");
  });
});
