import { stat } from "node:fs/promises";
import os from "node:os";

const MIB = 1024 * 1024;

function reading(value, source, reason = null) {
  const normalized = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
  return { value: normalized, source, reason: normalized === null ? reason ?? "measurement_unavailable" : reason };
}

function unavailable(source, reason) {
  return reading(null, source, reason);
}

function safeInteger(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "bigint") return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return null;
}

function fileTime(value) {
  const low = BigInt(value?.dwLowDateTime ?? 0);
  const high = BigInt(value?.dwHighDateTime ?? 0);
  return (high << 32n) | low;
}

function decodeUtf16(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let end = 0;
  while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
  return buffer.subarray(0, end).toString("utf16le");
}

async function loadKoffi() {
  try {
    return await import("koffi");
  } catch (error) {
    throw new Error(`koffi_load_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let apiPromise = null;

function api() {
  apiPromise ??= buildApi();
  return apiPromise;
}

async function buildApi() {
  const koffi = await loadKoffi();
  const MEMORYSTATUSEX = koffi.struct("SearchHubMemoryStatusEx", {
    dwLength: "uint32_t",
    dwMemoryLoad: "uint32_t",
    ullTotalPhys: "uint64_t",
    ullAvailPhys: "uint64_t",
    ullTotalPageFile: "uint64_t",
    ullAvailPageFile: "uint64_t",
    ullTotalVirtual: "uint64_t",
    ullAvailVirtual: "uint64_t",
    ullAvailExtendedVirtual: "uint64_t",
  });
  const FILETIME = koffi.struct("SearchHubFileTime", { dwLowDateTime: "uint32_t", dwHighDateTime: "uint32_t" });
  const PROCESS_MEMORY_COUNTERS_EX = koffi.struct("SearchHubProcessMemoryCountersEx", {
    cb: "uint32_t",
    PageFaultCount: "uint32_t",
    PeakWorkingSetSize: "uint64_t",
    WorkingSetSize: "uint64_t",
    QuotaPeakPagedPoolUsage: "uint64_t",
    QuotaPagedPoolUsage: "uint64_t",
    QuotaPeakNonPagedPoolUsage: "uint64_t",
    QuotaNonPagedPoolUsage: "uint64_t",
    PagefileUsage: "uint64_t",
    PeakPagefileUsage: "uint64_t",
    PrivateUsage: "uint64_t",
  });
  const PROCESSENTRY32W = koffi.struct("SearchHubProcessEntry32W", {
    dwSize: "uint32_t",
    cntUsage: "uint32_t",
    th32ProcessID: "uint32_t",
    th32DefaultHeapID: "uintptr_t",
    th32ModuleID: "uint32_t",
    cntThreads: "uint32_t",
    th32ParentProcessID: "uint32_t",
    pcPriClassBase: "int32_t",
    dwFlags: "uint32_t",
    szExeFile: "uint16_t[260]",
  });
  const kernel32 = koffi.load("kernel32.dll");
  const psapi = koffi.load("psapi.dll");
  return {
    koffi,
    MEMORYSTATUSEX,
    FILETIME,
    PROCESS_MEMORY_COUNTERS_EX,
    PROCESSENTRY32W,
    globalMemoryStatusEx: kernel32.func("bool __stdcall GlobalMemoryStatusEx(SearchHubMemoryStatusEx *status)"),
    getSystemTimes: kernel32.func("bool __stdcall GetSystemTimes(SearchHubFileTime *idle, SearchHubFileTime *kernel, SearchHubFileTime *user)"),
    createToolhelp32Snapshot: kernel32.func("void* __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t processId)"),
    process32FirstW: kernel32.func("bool __stdcall Process32FirstW(void* snapshot, SearchHubProcessEntry32W *entry)"),
    process32NextW: kernel32.func("bool __stdcall Process32NextW(void* snapshot, SearchHubProcessEntry32W *entry)"),
    getLastError: kernel32.func("uint32_t __stdcall GetLastError()"),
    closeHandle: kernel32.func("bool __stdcall CloseHandle(void *handle)"),
    openProcess: kernel32.func("void* __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
    getProcessMemoryInfo: psapi.func("bool __stdcall GetProcessMemoryInfo(void *process, SearchHubProcessMemoryCountersEx *counters, uint32_t size)"),
    getProcessTimes: kernel32.func("bool __stdcall GetProcessTimes(void *process, SearchHubFileTime *creation, SearchHubFileTime *exit, SearchHubFileTime *kernel, SearchHubFileTime *user)"),
    getExitCodeProcess: kernel32.func("bool __stdcall GetExitCodeProcess(void *process, uint32_t *exitCode)"),
    terminateProcess: kernel32.func("bool __stdcall TerminateProcess(void *process, uint32_t exitCode)"),
    generateConsoleCtrlEvent: kernel32.func("bool __stdcall GenerateConsoleCtrlEvent(uint32_t event, uint32_t group)"),
  };
}

/** Collect physical/available/commit/pagefile memory through Win32. */
export async function collectMemory() {
  try {
    const win = await api();
    const status = { dwLength: win.koffi.sizeof(win.MEMORYSTATUSEX), dwMemoryLoad: 0 };
    const pointer = win.koffi.alloc(win.MEMORYSTATUSEX, 1);
    try {
      win.koffi.encode(pointer, win.MEMORYSTATUSEX, status);
      if (!win.globalMemoryStatusEx(pointer)) throw new Error("GlobalMemoryStatusEx_failed");
      const value = win.koffi.decode(pointer, win.MEMORYSTATUSEX);
      return {
        physicalBytes: reading(safeInteger(value.ullTotalPhys), "win32_global_memory_status_ex"),
        availableBytes: reading(safeInteger(value.ullAvailPhys), "win32_global_memory_status_ex"),
        swapTotalBytes: reading(safeInteger(value.ullTotalPageFile), "win32_pagefile_commit"),
        swapFreeBytes: reading(safeInteger(value.ullAvailPageFile), "win32_pagefile_commit"),
        pageCacheBytes: unavailable("win32", "page_cache_not_reliably_attributable"),
      };
    } finally {
      win.koffi.free(pointer);
    }
  } catch (error) {
    const reason = error instanceof Error && error.message.startsWith("koffi_load_failed") ? "koffi_load_failed" : "win32_memory_query_failed";
    return {
      physicalBytes: unavailable("win32", reason),
      availableBytes: unavailable("win32", reason),
      swapTotalBytes: unavailable("win32", reason),
      swapFreeBytes: unavailable("win32", reason),
      pageCacheBytes: unavailable("win32", reason),
    };
  }
}

/** Take a bounded two-sample GetSystemTimes CPU measurement. */
export async function collectCpu(delayMs = 100) {
  try {
    const win = await api();
    const sample = () => {
      const idlePtr = win.koffi.alloc(win.FILETIME, 1);
      const kernelPtr = win.koffi.alloc(win.FILETIME, 1);
      const userPtr = win.koffi.alloc(win.FILETIME, 1);
      try {
        if (!win.getSystemTimes(idlePtr, kernelPtr, userPtr)) throw new Error("GetSystemTimes_failed");
        const idle = win.koffi.decode(idlePtr, win.FILETIME);
        const kernel = win.koffi.decode(kernelPtr, win.FILETIME);
        const user = win.koffi.decode(userPtr, win.FILETIME);
        return { idle: fileTime(idle), total: fileTime(kernel) + fileTime(user) };
      } finally {
        win.koffi.free(idlePtr);
        win.koffi.free(kernelPtr);
        win.koffi.free(userPtr);
      }
    };
    const first = sample();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
    const second = sample();
    const totalDelta = second.total - first.total;
    const rawBusyDelta = totalDelta - (second.idle - first.idle);
    const busyDelta = rawBusyDelta > 0n ? rawBusyDelta : 0n;
    return {
      logicalCpus: reading(os.cpus().length, "os_cpus"),
      utilizationPercent: reading(totalDelta > 0n ? Number(busyDelta * 100n / totalDelta) : null, "win32_get_system_times", totalDelta > 0n ? null : "cpu_sample_unavailable"),
    };
  } catch {
    return { logicalCpus: reading(os.cpus().length, "os_cpus"), utilizationPercent: unavailable("win32_get_system_times", "cpu_query_failed") };
  }
}

export async function collectCgroup() {
  return {
    version: "none",
    limitBytes: unavailable("win32", "cgroup_not_applicable"),
    currentBytes: unavailable("win32", "cgroup_not_applicable"),
    oomKills: unavailable("win32", "cgroup_not_applicable"),
  };
}

function safeName(buffer) {
  const name = decodeUtf16(buffer).replace(/[^\w.+-]/g, "_").slice(0, 64);
  return name || "unknown";
}

function roleFor(name) {
  const normalized = name.toLowerCase();
  if (normalized.includes("chrom")) return "chromium";
  if (normalized.includes("node") || normalized.includes("bun")) return "node";
  if (normalized.includes("esbuild")) return "build";
  return "other";
}

/** Enumerate Win32 process identities, parents and working sets. */
export async function listProcesses(limit = 512) {
  try {
    const win = await api();
    const snapshot = win.createToolhelp32Snapshot(0x2, 0);
    if (!snapshot || snapshot === -1 || snapshot === -1n) return [];
    const pointer = win.koffi.alloc(win.PROCESSENTRY32W, 1);
    const processes = [];
    try {
      const entry = { dwSize: win.koffi.sizeof(win.PROCESSENTRY32W) };
      win.koffi.encode(pointer, win.PROCESSENTRY32W, entry);
      let ok = win.process32FirstW(snapshot, pointer);
      while (ok && processes.length < limit) {
        const value = win.koffi.decode(pointer, win.PROCESSENTRY32W);
        const pid = Number(value.th32ProcessID);
        const executableName = safeName(value.szExeFile);
        const details = await readWindowsProcess(pid, win);
        if (details) {
          processes.push({
            identity: { pid, ppid: Number(value.th32ParentProcessID), startTime: details.startTime, owned: false, role: roleFor(executableName), executableName },
            rssBytes: details.rssBytes,
          });
        }
        ok = processes.length < limit && win.process32NextW(snapshot, pointer);
      }
      return processes;
    } finally {
      win.koffi.free(pointer);
      win.closeHandle(snapshot);
    }
  } catch {
    return [];
  }
}

/** Complete Toolhelp identity enumeration; global enumeration errors propagate. */
export async function enumerateToolhelpEntries(win) {
  const snapshot = win.createToolhelp32Snapshot(0x2, 0);
  if (!snapshot || snapshot === -1 || snapshot === -1n) throw new Error("toolhelp_snapshot_failed");
  const pointer = win.koffi.alloc(win.PROCESSENTRY32W, 1);
  const entries = [];
  try {
    win.koffi.encode(pointer, win.PROCESSENTRY32W, { dwSize: win.koffi.sizeof(win.PROCESSENTRY32W) });
    let ok = win.process32FirstW(snapshot, pointer);
    if (!ok) throw new Error(`toolhelp_enumeration_failed:${win.getLastError()}`);
    while (ok) {
      const value = win.koffi.decode(pointer, win.PROCESSENTRY32W);
      entries.push({ pid: Number(value.th32ProcessID), ppid: Number(value.th32ParentProcessID), executableName: safeName(value.szExeFile) });
      ok = win.process32NextW(snapshot, pointer);
      if (!ok) {
        const code = win.getLastError();
        if (code !== 18) throw new Error(`toolhelp_enumeration_failed:${code}`);
      }
    }
    return entries;
  } finally {
    win.koffi.free(pointer);
    win.closeHandle(snapshot);
  }
}

/** Complete PID enumeration for exit proof; global enumeration errors propagate. */
export async function listProcessPidsStrict(suppliedApi = null) {
  const win = suppliedApi ?? await api();
  return (await enumerateToolhelpEntries(win)).map((entry) => entry.pid);
}

/** Complete detailed listing; per-PID detail failures retain PID and parent. */
export async function listProcessesStrict(suppliedApi = null) {
  const win = suppliedApi ?? await api();
  return Promise.all((await enumerateToolhelpEntries(win)).map(async (entry) => {
    const details = await readWindowsProcess(entry.pid, win);
    return {
      identity: {
        pid: entry.pid,
        ppid: entry.ppid,
        startTime: details?.startTime ?? null,
        owned: false,
        role: roleFor(entry.executableName),
        executableName: entry.executableName,
        ...(details ? {} : { detailUnavailable: true }),
      },
      rssBytes: details?.rssBytes ?? reading(null, "win32_process_memory_counters", "process_details_unavailable"),
    };
  }));
}

async function readWindowsProcess(pid, suppliedApi = null) {
  try {
    const win = suppliedApi ?? await api();
    const handle = win.openProcess(0x1000, false, pid);
    if (!handle) return null;
    try {
      const exitCodePtr = win.koffi.alloc("uint32_t", 1);
      try {
        if (!win.getExitCodeProcess(handle, exitCodePtr) || win.koffi.decode(exitCodePtr, "uint32_t") !== 259) return null;
      } finally {
        win.koffi.free(exitCodePtr);
      }
      const creationPtr = win.koffi.alloc(win.FILETIME, 1);
      const exitPtr = win.koffi.alloc(win.FILETIME, 1);
      const kernelPtr = win.koffi.alloc(win.FILETIME, 1);
      const userPtr = win.koffi.alloc(win.FILETIME, 1);
      const countersPtr = win.koffi.alloc(win.PROCESS_MEMORY_COUNTERS_EX, 1);
      try {
        if (!win.getProcessTimes(handle, creationPtr, exitPtr, kernelPtr, userPtr)) return null;
        const creation = win.koffi.decode(creationPtr, win.FILETIME);
        const counters = { cb: win.koffi.sizeof(win.PROCESS_MEMORY_COUNTERS_EX) };
        win.koffi.encode(countersPtr, win.PROCESS_MEMORY_COUNTERS_EX, counters);
        if (!win.getProcessMemoryInfo(handle, countersPtr, counters.cb)) return null;
        const value = win.koffi.decode(countersPtr, win.PROCESS_MEMORY_COUNTERS_EX);
        return {
          startTime: fileTime(creation).toString(),
          rssBytes: reading(safeInteger(value.WorkingSetSize), "win32_process_memory_counters"),
        };
      } finally {
        win.koffi.free(creationPtr);
        win.koffi.free(exitPtr);
        win.koffi.free(kernelPtr);
        win.koffi.free(userPtr);
        win.koffi.free(countersPtr);
      }
    } finally {
      win.closeHandle(handle);
    }
  } catch {
    return null;
  }
}

async function findToolhelpIdentity(pid, suppliedApi = null) {
  const win = suppliedApi ?? await api();
  const snapshot = win.createToolhelp32Snapshot(0x2, 0);
  if (!snapshot || snapshot === -1 || snapshot === -1n) return null;
  const pointer = win.koffi.alloc(win.PROCESSENTRY32W, 1);
  try {
    win.koffi.encode(pointer, win.PROCESSENTRY32W, { dwSize: win.koffi.sizeof(win.PROCESSENTRY32W) });
    let ok = win.process32FirstW(snapshot, pointer);
    while (ok) {
      const value = win.koffi.decode(pointer, win.PROCESSENTRY32W);
      if (Number(value.th32ProcessID) === pid) {
        const executableName = safeName(value.szExeFile);
        return { ppid: Number(value.th32ParentProcessID), executableName, role: roleFor(executableName) };
      }
      ok = win.process32NextW(snapshot, pointer);
    }
    return null;
  } finally {
    win.koffi.free(pointer);
    win.closeHandle(snapshot);
  }
}

export async function readProcess(pid) {
  const [details, identity] = await Promise.all([readWindowsProcess(pid), findToolhelpIdentity(pid)]);
  if (!details || !identity) return null;
  return { identity: { pid, ppid: identity.ppid, startTime: details.startTime, owned: false, role: identity.role, executableName: identity.executableName }, rssBytes: details.rssBytes };
}

export async function terminateProcess(pid) {
  const win = await api();
  // Children are spawned as their own process group. Never send group 0: that
  // could signal the parent/user console. Failure falls through to KILL after
  // the owned-tree grace period.
  return Boolean(win.generateConsoleCtrlEvent(1, pid));
}

export async function killProcess(pid) {
  const win = await api();
  const handle = win.openProcess(0x1, false, pid);
  if (!handle) return false;
  try {
    return Boolean(win.terminateProcess(handle, 1));
  } finally {
    win.closeHandle(handle);
  }
}

export async function detectContainers() {
  let docker = null;
  let dockerReason = null;
  try {
    await stat("//./pipe/docker_engine");
    docker = true;
  } catch (error) {
    docker = error?.code === "ENOENT" || error?.code === "ENOTDIR" ? false : null;
    dockerReason = docker === null ? "docker_pipe_query_failed" : null;
  }
  return {
    docker: { detected: docker, source: "win32_named_pipe", reason: dockerReason },
    wsl: { detected: process.env["WSL_DISTRO_NAME"] ? true : null, source: "environment_marker", reason: process.env["WSL_DISTRO_NAME"] ? null : "wsl_marker_unavailable" },
  };
}

export { MIB };
