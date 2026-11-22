import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MIB = 1024 * 1024;
const KIB = 1024;

function reading(value, source, reason = null) {
  const normalized = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
  return { value: normalized, source, reason: normalized === null ? reason ?? "measurement_unavailable" : reason };
}

function unavailable(source, reason) {
  return reading(null, source, reason);
}

async function readText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseKiB(text, key) {
  const match = text?.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Number(match[1]) * KIB : null;
}

/** Collect Linux host memory without treating total-free as available. */
export async function collectMemory() {
  const text = await readText("/proc/meminfo");
  if (text === null) {
    return {
      physicalBytes: unavailable("proc_meminfo", "read_failed"),
      availableBytes: unavailable("proc_meminfo", "read_failed"),
      swapTotalBytes: unavailable("proc_meminfo", "read_failed"),
      swapFreeBytes: unavailable("proc_meminfo", "read_failed"),
      pageCacheBytes: unavailable("proc_meminfo", "read_failed"),
    };
  }
  const physicalBytes = parseKiB(text, "MemTotal");
  let availableBytes = parseKiB(text, "MemAvailable");
  let availableSource = "proc_meminfo";
  let availableReason = null;
  if (availableBytes === null) {
    const free = parseKiB(text, "MemFree");
    const buffers = parseKiB(text, "Buffers");
    const cached = parseKiB(text, "Cached");
    const reclaimable = parseKiB(text, "SReclaimable");
    const shmem = parseKiB(text, "Shmem");
    if ([free, buffers, cached, reclaimable, shmem].every((value) => value !== null)) {
      availableBytes = Math.max(0, free + buffers + cached + reclaimable - shmem);
      availableSource = "proc_meminfo_estimate";
      availableReason = "memavailable_missing_estimated_from_components";
    }
  }
  const cached = parseKiB(text, "Cached");
  const reclaimable = parseKiB(text, "SReclaimable");
  const shmem = parseKiB(text, "Shmem");
  return {
    physicalBytes: reading(physicalBytes, "proc_meminfo", physicalBytes === null ? "memtotal_missing" : null),
    availableBytes: reading(availableBytes, availableSource, availableBytes === null ? "available_unavailable" : availableReason),
    swapTotalBytes: reading(parseKiB(text, "SwapTotal"), "proc_meminfo"),
    swapFreeBytes: reading(parseKiB(text, "SwapFree"), "proc_meminfo"),
    pageCacheBytes: reading(
      cached !== null && reclaimable !== null ? Math.max(0, cached + reclaimable - (shmem ?? 0)) : null,
      "proc_meminfo",
      cached === null || reclaimable === null ? "page_cache_components_missing" : null,
    ),
  };
}

function parseCpuLine(text) {
  const line = text?.split("\n").find((entry) => entry.startsWith("cpu "));
  const values = line?.trim().split(/\s+/).slice(1).map(Number) ?? [];
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
  const idle = values[3] + (values[4] ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

/** Take a bounded two-sample Linux CPU utilization measurement. */
export async function collectCpu(delayMs = 100) {
  const firstText = await readText("/proc/stat");
  const first = parseCpuLine(firstText);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
  const second = parseCpuLine(await readText("/proc/stat"));
  if (!first || !second || second.total <= first.total) {
    return { logicalCpus: reading(os.cpus().length, "os_cpus"), utilizationPercent: unavailable("proc_stat", "cpu_sample_unavailable") };
  }
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  return {
    logicalCpus: reading(os.cpus().length, "os_cpus"),
    utilizationPercent: reading(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)), "proc_stat"),
  };
}

function unescapeMount(value) {
  return value.replaceAll("\\040", " ").replaceAll("\\011", "\t").replaceAll("\\134", "\\");
}

export function parseCgroupRoot(mountinfo, version) {
  if (typeof mountinfo !== "string") return null;
  const filesystems = version === "2" ? new Set(["cgroup2"]) : version === "1" ? new Set(["cgroup", "cgroup1"]) : new Set();
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator >= 0 && filesystems.has(fields[separator + 1]) && fields[4]) {
      return unescapeMount(fields[4]);
    }
  }
  return null;
}

async function findCgroupRoot(version) {
  const mountinfo = await readText("/proc/self/mountinfo");
  const mounted = parseCgroupRoot(mountinfo, version);
  if (mounted) return mounted;
  const fallback = version === "2" ? "/sys/fs/cgroup" : "/sys/fs/cgroup/memory";
  try {
    if ((await stat(fallback)).isDirectory()) return fallback;
  } catch {
    return null;
  }
  return null;
}

async function cgroupPath(root, relative) {
  if (relative === "/" || relative === "") return root;
  const target = path.resolve(root, `.${relative}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

async function readInteger(filePath) {
  const text = await readText(filePath);
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseStatNumber(text, key) {
  const match = text?.match(new RegExp(`^${key}\\s+(\\d+)$`, "m"));
  return match ? Number(match[1]) : null;
}

/** Collect cgroup v2, then v1, with explicit unlimited/unavailable readings. */
export async function collectCgroup() {
  const rootV2 = await findCgroupRoot("2");
  const selfV2 = await readText("/proc/self/cgroup");
  const relativeV2 = selfV2?.split("\n").find((line) => line.startsWith("0::"))?.slice(3) ?? null;
  if (rootV2 && relativeV2 !== null) {
    const base = await cgroupPath(rootV2, relativeV2);
    if (base) {
      const maxText = await readText(path.join(base, "memory.max"));
      const limit = maxText?.trim() === "max" ? null : await readInteger(path.join(base, "memory.max"));
      const current = await readInteger(path.join(base, "memory.current"));
      const events = await readText(path.join(base, "memory.events"));
      const memoryStat = await readText(path.join(base, "memory.stat"));
      const limited = limit !== null;
      return {
        version: "v2",
        limitBytes: reading(limit, "cgroup_v2", maxText === null ? "memory_max_missing" : limited ? null : "unlimited"),
        currentBytes: reading(current, "cgroup_v2", current === null ? "memory_current_missing" : null),
        oomKills: reading(parseStatNumber(events, "oom_kill"), "cgroup_v2", events === null ? "memory_events_missing" : null),
        oomEvents: reading(parseStatNumber(events, "oom"), "cgroup_v2", events === null ? "memory_events_missing" : null),
        anonBytes: reading(parseStatNumber(memoryStat, "anon"), "cgroup_v2"),
        fileBytes: reading(parseStatNumber(memoryStat, "file"), "cgroup_v2"),
      };
    }
  }

  const rootV1 = await findCgroupRoot("1");
  const selfV1 = await readText("/proc/self/cgroup");
  const relativeV1 = selfV1?.split("\n").find((line) => line.split(":")[1]?.split(",").includes("memory"))?.split(":").slice(2).join(":") ?? null;
  if (rootV1 && relativeV1 !== null) {
    const base = await cgroupPath(rootV1, relativeV1);
    if (base) {
      const rawLimit = await readInteger(path.join(base, "memory.limit_in_bytes"));
      const limit = rawLimit !== null && rawLimit < 2 ** 60 ? rawLimit : null;
      const current = await readInteger(path.join(base, "memory.usage_in_bytes"));
      const oomControl = await readText(path.join(base, "memory.oom_control"));
      const memoryStat = await readText(path.join(base, "memory.stat"));
      return {
        version: "v1",
        limitBytes: reading(limit, "cgroup_v1", rawLimit === null ? "limit_missing" : limit === null ? "unlimited" : null),
        currentBytes: reading(current, "cgroup_v1", current === null ? "usage_missing" : null),
        oomKills: reading(parseStatNumber(oomControl, "oom_kill"), "cgroup_v1", oomControl === null ? "oom_control_missing" : null),
        anonBytes: reading(parseStatNumber(memoryStat, "rss"), "cgroup_v1"),
        fileBytes: reading(parseStatNumber(memoryStat, "cache"), "cgroup_v1"),
      };
    }
  }
  return {
    version: "none",
    limitBytes: unavailable("cgroup", "cgroup_not_detected"),
    currentBytes: unavailable("cgroup", "cgroup_not_detected"),
    oomKills: unavailable("cgroup", "cgroup_not_detected"),
  };
}

function safeExecutableName(value) {
  const name = path.basename(String(value ?? "unknown")).replace(/[^\w.+-]/g, "_").slice(0, 64);
  return name || "unknown";
}

function roleFor(name) {
  const normalized = name.toLowerCase();
  if (normalized.includes("chrom")) return "chromium";
  if (normalized.includes("node") || normalized.includes("bun")) return "node";
  if (normalized.includes("esbuild")) return "build";
  return "other";
}

async function readLinuxProcess(pid) {
  const status = await readText(`/proc/${pid}/status`);
  const statText = await readText(`/proc/${pid}/stat`);
  if (status === null || statText === null) return null;
  const ppid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
  const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
  const name = status.match(/^Name:\s+(.+)$/m)?.[1] ?? "unknown";
  const closeParen = statText.lastIndexOf(")");
  const fields = closeParen >= 0 ? statText.slice(closeParen + 2).split(" ") : [];
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || !startTime) return null;
  const executableName = safeExecutableName(name);
  return {
    identity: { pid, ppid, startTime, owned: false, role: roleFor(executableName), executableName },
    rssBytes: reading(Number.isFinite(rssKiB) ? rssKiB * KIB : null, "proc_status", Number.isFinite(rssKiB) ? null : "vmrss_missing"),
  };
}

/** List a bounded set of Linux process identities without argv/env. */
export async function listProcesses(limit = 512) {
  let entries = [];
  try {
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number).sort((a, b) => a - b).slice(0, limit);
  const processes = (await Promise.all(pids.map(readLinuxProcess))).filter(Boolean);
  return processes;
}

export async function readProcess(pid) {
  return readLinuxProcess(pid);
}

export async function terminateProcess(pid) {
  process.kill(pid, "SIGTERM");
}

export async function killProcess(pid) {
  process.kill(pid, "SIGKILL");
}

export async function detectContainers() {
  const release = await readText("/proc/sys/kernel/osrelease");
  const procOne = await readText("/proc/1/cgroup");
  let docker = null;
  try {
    await stat("/.dockerenv");
    docker = true;
  } catch {
    docker = /docker|kubepods|containerd/i.test(procOne ?? "") ? true : procOne === null ? null : false;
  }
  return {
    docker: { detected: docker, source: "container_markers", reason: docker === null ? "docker_marker_unavailable" : null },
    wsl: {
      detected: /microsoft/i.test(release ?? "") || Boolean(process.env["WSL_DISTRO_NAME"]) ? true : null,
      source: "kernel_and_environment_markers",
      reason: release === null ? "wsl_marker_unavailable" : null,
    },
  };
}

export { MIB };
