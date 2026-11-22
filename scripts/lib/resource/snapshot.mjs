import os from "node:os";
import * as linux from "./linux.mjs";
import * as windows from "./windows.mjs";
import { NOT_NODE_V8 } from "./process-tree.mjs";

function unavailableV8(reason) {
  return {
    heapUsedBytes: { value: null, source: "v8", reason },
    heapTotalBytes: { value: null, source: "v8", reason },
    externalBytes: { value: null, source: "v8", reason },
    arrayBuffersBytes: { value: null, source: "v8", reason },
  };
}

/**
 * Collect one normalized, read-only snapshot. Process details are opt-in and
 * bounded; no collector returns argv, environment values, or search content.
 *
 * @param {{includeProcesses?: boolean, platform?: NodeJS.Platform, io?: object, now?: Date, cpuDelayMs?: number, processLimit?: number, scanLimit?: number}} [options]
 * @returns {Promise<import("./types.mjs").ResourceSnapshot>}
 */
export async function collectSnapshot(options = {}) {
  const platform = options.platform ?? process.platform;
  const io = options.io ?? (platform === "linux" ? linux : platform === "win32" ? windows : null);
  const now = options.now ?? new Date();
  if (!io) {
    return {
      schemaVersion: 1,
      sampledAt: now.toISOString(),
      platform: { os: platform, arch: process.arch, node: process.version, uptimeSeconds: Math.trunc(os.uptime()) },
      host: {
        physicalBytes: { value: null, source: "unsupported_platform", reason: "unsupported_platform" },
        availableBytes: { value: null, source: "unsupported_platform", reason: "unsupported_platform" },
        swapTotalBytes: { value: null, source: "unsupported_platform", reason: "unsupported_platform" },
        swapFreeBytes: { value: null, source: "unsupported_platform", reason: "unsupported_platform" },
        pageCacheBytes: { value: null, source: "unsupported_platform", reason: "unsupported_platform" },
      },
      cpu: {
        logicalCpus: { value: os.cpus().length, source: "os_cpus", reason: null },
        utilizationPercent: { value: null, source: "unsupported_platform", reason: "unsupported_platform" },
      },
      cgroup: { version: "unknown", limitBytes: { value: null, source: "unsupported_platform", reason: "unsupported_platform" }, currentBytes: { value: null, source: "unsupported_platform", reason: "unsupported_platform" }, oomKills: { value: null, source: "unsupported_platform", reason: "unsupported_platform" } },
      processes: [],
      containers: { docker: { detected: null, source: "unsupported_platform", reason: "unsupported_platform" }, wsl: { detected: null, source: "unsupported_platform", reason: "unsupported_platform" } },
    };
  }
  const [host, cpu, cgroup, containers] = await Promise.all([
    io.collectMemory(),
    io.collectCpu(options.cpuDelayMs ?? 100),
    io.collectCgroup(),
    io.detectContainers(),
  ]);
  // Enumerate processes after the CPU sample so the collector does not inflate
  // its own utilization measurement on busy hosts.
  const listed = options.includeProcesses ? await io.listProcesses(options.scanLimit ?? 4096) : [];
  const sampledAt = new Date().toISOString();
  const processes = [...listed]
    .sort((a, b) => (b.rssBytes?.value ?? -1) - (a.rssBytes?.value ?? -1))
    .slice(0, options.processLimit ?? 512)
    .map((entry) => ({
    identity: { ...entry.identity, owned: false },
    rssBytes: entry.rssBytes,
    v8: entry.identity.role === "node" ? unavailableV8("telemetry_not_requested") : { ...NOT_NODE_V8 },
    sampledAt,
  }));
  return {
    schemaVersion: 1,
    sampledAt,
    platform: { os: platform, arch: process.arch, node: process.version, uptimeSeconds: Math.trunc(os.uptime()) },
    host,
    cpu,
    cgroup,
    processes,
    containers,
  };
}

export function largestProcesses(snapshot, limit = 5) {
  return [...snapshot.processes]
    .filter((entry) => entry.rssBytes.value !== null)
    .sort((a, b) => b.rssBytes.value - a.rssBytes.value)
    .slice(0, limit)
    .map((entry) => ({ pid: entry.identity.pid, role: entry.identity.role, executableName: entry.identity.executableName ?? null, rssBytes: entry.rssBytes.value }));
}
