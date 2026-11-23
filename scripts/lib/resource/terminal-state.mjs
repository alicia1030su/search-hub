import { EXIT_CODES } from "./artifacts.mjs";

/** Resolve terminal evidence state without allowing abort to hide cleanup failure. */
export function resolveTerminalState(input = {}) {
  const threshold = input.threshold ?? { status: "success", exitCode: EXIT_CODES.success, reason: null };
  const abortReason = input.abortedBy ? `aborted_by_${input.abortedBy}` : null;
  if (input.artifactFailed) {
    return { status: "internal", exitCode: EXIT_CODES.internal, reason: "artifact_finalization_failed", abortReason };
  }
  if (input.cleanupFailure) {
    return { status: "child_failed", exitCode: EXIT_CODES.childFailed, reason: input.cleanupFailure, abortReason };
  }
  if (abortReason) {
    return { status: "resource_blocked", exitCode: EXIT_CODES.resourceBlocked, reason: abortReason, abortReason };
  }
  return { ...threshold, abortReason };
}
