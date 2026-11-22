export const MIB = 1024 * 1024;

export const STAGE_ESTIMATES = Object.freeze({
  typecheck: Object.freeze({ fixedMiB: 256, peakMiB: 1024 }),
  lint: Object.freeze({ fixedMiB: 192, peakMiB: 768 }),
  vitest: Object.freeze({ fixedMiB: 384, peakMiB: 768 }),
  build: Object.freeze({ fixedMiB: 768, peakMiB: 1024 }),
  playwright: Object.freeze({ fixedMiB: 1024, peakMiB: 1536 }),
});

export const DEFAULT_THRESHOLDS = Object.freeze({ normal: 0.70, warn: 0.50, high: 0.25, danger: 0.25, recovery: 0.75 });

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function integerMiB(bytes) {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes / MIB) : null;
}

/** Compute conservative headroom from host and positive cgroup limit. */
export function headroomMiB(snapshot) {
  const physical = integerMiB(snapshot?.host?.physicalBytes?.value);
  const available = integerMiB(snapshot?.host?.availableBytes?.value);
  const cgroupLimit = integerMiB(snapshot?.cgroup?.limitBytes?.value);
  const cgroupCurrent = integerMiB(snapshot?.cgroup?.currentBytes?.value);
  if (physical === null || available === null) return { value: null, source: "host", reason: "host_memory_unavailable" };
  const hostReserve = clamp(physical * 0.10, 512, 2048);
  const hostHeadroom = available - hostReserve;
  const cgroupVersion = snapshot?.cgroup?.version;
  const limitReading = snapshot?.cgroup?.limitBytes;
  if ((cgroupVersion === "v1" || cgroupVersion === "v2") && limitReading?.value === null && limitReading?.reason !== "unlimited") {
    return { value: null, source: "cgroup", reason: "cgroup_limit_unavailable" };
  }
  if (limitReading?.value !== null && limitReading?.value !== undefined && limitReading.value <= 0) {
    return { value: null, source: "cgroup", reason: "cgroup_limit_invalid" };
  }
  const cgroupLimited = limitReading?.value !== null && limitReading?.value !== undefined;
  if (cgroupLimited && (cgroupLimit === null || cgroupCurrent === null)) {
    return { value: null, source: "cgroup", reason: "cgroup_headroom_unavailable" };
  }
  const cgroupReserve = cgroupLimited ? clamp(cgroupLimit * 0.05, 256, 1024) : 0;
  const cgroupHeadroom = cgroupLimited ? cgroupLimit - cgroupCurrent - cgroupReserve : null;
  return {
    value: Math.max(0, Math.floor(Math.min(hostHeadroom, cgroupHeadroom ?? hostHeadroom))),
    source: cgroupLimited ? "host_and_cgroup" : "host",
    reason: null,
    hostReserveMiB: Math.floor(hostReserve),
    cgroupReserveMiB: Math.floor(cgroupReserve),
    hostHeadroomMiB: Math.floor(hostHeadroom),
    cgroupHeadroomMiB: cgroupHeadroom === null ? null : Math.floor(cgroupHeadroom),
  };
}

/**
 * Freeze resource estimates before any stage starts. CPU only caps workers; a
 * positive worker count is never allowed when the memory budget is unsafe.
 *
 * @param {import("./types.mjs").ResourceSnapshot} snapshot
 * @param {{peakMiB?: Partial<Record<keyof typeof STAGE_ESTIMATES, number>>, thresholds?: typeof DEFAULT_THRESHOLDS, now?: Date}} [options]
 */
export function freezeBudget(snapshot, options = {}) {
  const logicalCpus = snapshot?.cpu?.logicalCpus?.value ?? null;
  const headroom = headroomMiB(snapshot);
  const baselineHeadroomMiB = headroom.value ?? 0;
  const hostReserveMiB = headroom.hostReserveMiB ?? 0;
  const cgroupReserveMiB = headroom.cgroupReserveMiB ?? 0;
  const safetyFloorMiB = Math.max(256, hostReserveMiB);
  const cpuCap = Number.isSafeInteger(logicalCpus) && logicalCpus > 0 ? Math.min(logicalCpus, 8) : 0;
  const peaks = { ...Object.fromEntries(Object.entries(STAGE_ESTIMATES).map(([stage, estimate]) => [stage, estimate.peakMiB])), ...options.peakMiB };
  for (const peak of Object.values(peaks)) {
    if (!Number.isFinite(peak) || peak <= 0) throw new TypeError("Stage peak estimates must be positive finite numbers");
  }
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  if (Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 0 || value > 1) || thresholds.normal < thresholds.warn || thresholds.warn < thresholds.high || thresholds.high < thresholds.danger || thresholds.recovery < thresholds.normal) {
    throw new TypeError("Pressure thresholds must be ordered fractions between zero and one");
  }
  const stages = {};
  const blockedStages = [];
  for (const [stage, estimate] of Object.entries(STAGE_ESTIMATES)) {
    const peakMiB = peaks[stage];
    const requiredMiB = estimate.fixedMiB + peakMiB;
    const safe = headroom.value !== null && cpuCap > 0 && baselineHeadroomMiB >= requiredMiB;
    const workers = stage === "vitest" && safe ? clamp(Math.floor((baselineHeadroomMiB - estimate.fixedMiB) / peakMiB), 1, cpuCap) : safe ? 1 : 0;
    stages[stage] = { fixedMiB: estimate.fixedMiB, peakMiB, requiredMiB, workers, safe };
    if (!safe) blockedStages.push(stage);
  }
  return {
    hostReserveMiB,
    cgroupReserveMiB,
    safetyFloorMiB,
    baselineHeadroomMiB,
    vitestWorkers: stages.vitest.workers,
    peakMiB: peaks.vitest,
    estimated: true,
    thresholds,
    frozenAt: (options.now ?? new Date()).toISOString(),
    cpuCap,
    stages,
    safe: blockedStages.length === 0,
    blockedStages,
    reason: headroom.reason ?? (cpuCap === 0 ? "logical_cpus_unavailable" : blockedStages.length > 0 ? "insufficient_safe_budget" : null),
    source: headroom.source,
  };
}
