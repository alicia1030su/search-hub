const WINDOWS_OOM_CODES = new Set([0xC0000017, 0xC000009A]);
const V8_MEMORY_LOG = /FATAL ERROR:\s*(?:Reached heap limit|JavaScript heap out of memory|Allocation failed)/i;
const EXPLICIT_MEMORY_LOG = /(?:out of memory|memory allocation failed|heap allocation failed)/i;

/**
 * Classify OOM only from corroborating OS/V8 evidence. Exit 137, SIGKILL, exit
 * 1, assertion failures and timeouts are deliberately insufficient on their own.
 * Windows OOM codes additionally require an explicit memory-allocation log.
 *
 * @param {{exitCode?: number|null, signal?: string|null, log?: string, windowsExitCode?: number|null, ownedRootDied?: boolean, ownedPeakBytes?: number|null}} attempt
 * @param {{cgroupOomDelta?: number|null, injectedEvidence?: {memoryLog?: boolean, v8Fatal?: boolean, signal?: string|null, windowsCode?: number|null, ownedRootDied?: boolean, ownedPeakBytes?: number|null}}} [evidence]
 */
export function classifyOom(attempt, evidence = {}) {
  const log = attempt.log ?? "";
  const signal = attempt.signal ?? evidence.injectedEvidence?.signal ?? null;
  const ownedRootDied = Boolean(attempt.ownedRootDied ?? evidence.injectedEvidence?.ownedRootDied);
  const ownedPeakBytes = attempt.ownedPeakBytes === null
    ? null
    : attempt.ownedPeakBytes ?? evidence.injectedEvidence?.ownedPeakBytes ?? 0;
  const cgroupOomDelta = evidence.cgroupOomDelta === null ? null : evidence.cgroupOomDelta ?? 0;
  const rawWindowsCode = attempt.windowsExitCode ?? evidence.injectedEvidence?.windowsCode ?? attempt.exitCode ?? null;
  const windowsCode = typeof rawWindowsCode === "number" && Number.isInteger(rawWindowsCode) ? rawWindowsCode >>> 0 : null;
  const memoryLog = evidence.injectedEvidence?.memoryLog === true || V8_MEMORY_LOG.test(log) || EXPLICIT_MEMORY_LOG.test(log);
  const v8Fatal = memoryLog && (evidence.injectedEvidence?.v8Fatal ?? V8_MEMORY_LOG.test(log));
  const confirmedReasons = [];
  const clues = [];
  let unconfirmedReason = null;
  if (cgroupOomDelta !== null && cgroupOomDelta > 0 && ownedRootDied) {
    confirmedReasons.push("cgroup_oom_kill_with_owned_root_death");
    clues.push("cgroup_oom_kill", "owned_root_death");
  }
  if (v8Fatal && (signal === "SIGABRT" || (attempt.exitCode ?? 0) !== 0)) {
    confirmedReasons.push("v8_heap_fatal_with_abort_or_nonzero");
    clues.push("memory_log", "v8_fatal");
  }
  if (WINDOWS_OOM_CODES.has(windowsCode) && ownedRootDied) {
    clues.push("windows_oom_code", "owned_root_death");
    if (!memoryLog) {
      unconfirmedReason = "windows_oom_code_without_memory_log";
    } else if (ownedPeakBytes === null) {
      confirmedReasons.push("windows_oom_code_with_peak_unknown");
      clues.push("memory_log", "owned_peak_unknown");
    } else if (ownedPeakBytes > 0) {
      confirmedReasons.push("windows_oom_code_with_owned_peak");
      clues.push("memory_log", "owned_peak_positive");
    }
  }
  return {
    confirmed: confirmedReasons.length > 0,
    reason: confirmedReasons[0] ?? unconfirmedReason ?? (cgroupOomDelta === null ? "cgroup_oom_unknown" : "insufficient_oom_evidence"),
    evidence: clues,
    confirmedReasons,
    cgroupOomDelta,
    ownedRootDied,
    ownedPeakBytes,
    ownedPeakReason: ownedPeakBytes === null ? "unavailable" : null,
    ownedPeakSource: "owned_process_rss",
    memoryLog,
  };
}
