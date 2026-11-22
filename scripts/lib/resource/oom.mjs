const WINDOWS_OOM_CODES = new Set([0xC0000017, 0xC000009A]);

/**
 * Classify OOM only from corroborating OS/V8 evidence. Exit 137, SIGKILL, exit
 * 1, assertion failures and timeouts are deliberately insufficient on their own.
 *
 * @param {{exitCode?: number|null, signal?: string|null, log?: string, windowsExitCode?: number|null, ownedRootDied?: boolean, ownedPeakBytes?: number}} attempt
 * @param {{cgroupOomDelta?: number|null, injectedEvidence?: {v8Fatal?: boolean, signal?: string|null, windowsCode?: number|null, ownedRootDied?: boolean, ownedPeakBytes?: number}}} [evidence]
 */
export function classifyOom(attempt, evidence = {}) {
  const log = attempt.log ?? "";
  const signal = attempt.signal ?? evidence.injectedEvidence?.signal ?? null;
  const ownedRootDied = Boolean(attempt.ownedRootDied ?? evidence.injectedEvidence?.ownedRootDied);
  const ownedPeakBytes = attempt.ownedPeakBytes ?? evidence.injectedEvidence?.ownedPeakBytes ?? 0;
  const cgroupOomDelta = evidence.cgroupOomDelta === null ? null : evidence.cgroupOomDelta ?? 0;
  const rawWindowsCode = attempt.windowsExitCode ?? evidence.injectedEvidence?.windowsCode ?? attempt.exitCode ?? null;
  const windowsCode = typeof rawWindowsCode === "number" && Number.isInteger(rawWindowsCode) ? rawWindowsCode >>> 0 : null;
  const v8Fatal = evidence.injectedEvidence?.v8Fatal ?? /FATAL ERROR:\s*(?:Reached heap limit|JavaScript heap out of memory|Allocation failed)/i.test(log);
  const reasons = [];
  if (cgroupOomDelta !== null && cgroupOomDelta > 0 && ownedRootDied) reasons.push("cgroup_oom_kill_with_owned_root_death");
  if (v8Fatal && (signal === "SIGABRT" || (attempt.exitCode ?? 0) !== 0)) reasons.push("v8_heap_fatal_with_abort_or_nonzero");
  if (WINDOWS_OOM_CODES.has(windowsCode) && ownedRootDied && ownedPeakBytes > 0) reasons.push("windows_oom_code_with_owned_peak");
  return {
    confirmed: reasons.length > 0,
    reason: reasons[0] ?? (cgroupOomDelta === null ? "cgroup_oom_unknown" : "insufficient_oom_evidence"),
    evidence: reasons,
    cgroupOomDelta,
    ownedRootDied,
    ownedPeakBytes,
  };
}
