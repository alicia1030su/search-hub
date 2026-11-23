function inspectionErrorCount(rootState) {
  if (rootState.inspectionErrors instanceof Map) return rootState.inspectionErrors.size;
  return Array.isArray(rootState.inspectionErrors) ? rootState.inspectionErrors.length : 0;
}

function rootUncertainty(rootState) {
  if (!rootState.rootIdentityChanged && !rootState.rootIdentityState) return null;
  const state = rootState.rootIdentityState ?? "changed";
  if (state === "missing") return "root_missing";
  if (state === "changed") return "root_changed";
  return "root_inspection_failed";
}

/**
 * Summarize one strict owned-tree snapshot. Identity/listing/ancestry uncertainty
 * invalidates the scope; RSS uncertainty only invalidates the peak evidence.
 */
export function summarizeOwnedTreeSamples(samples, rootState = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const base = { peakBytes: null, reason: null, uncertainty: null, rssUnavailable: false, processCount: list.length };
  const rootIssue = rootUncertainty(rootState);
  if (rootIssue) return { ...base, reason: "scope_uncertain", uncertainty: rootIssue };
  if (inspectionErrorCount(rootState) > 0) {
    return { ...base, reason: "scope_uncertain", uncertainty: "owned_tree_inspection_failed" };
  }
  if (list.length === 0) return { ...base, reason: "scope_uncertain", uncertainty: "owned_tree_empty" };
  if (Number.isSafeInteger(rootState.rootPid) && rootState.rootPid > 0) {
    const root = list.find((sample) => sample?.identity?.pid === rootState.rootPid);
    if (!root || root.identity.startTime !== rootState.rootStartTime) {
      return { ...base, reason: "scope_uncertain", uncertainty: "owned_tree_root_unverified" };
    }
  }

  let total = 0;
  for (const sample of list) {
    const pid = sample?.identity?.pid;
    const startTime = sample?.identity?.startTime;
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof startTime !== "string" || startTime.length === 0) {
      return { ...base, reason: "scope_uncertain", uncertainty: "owned_tree_identity_unavailable" };
    }
    const value = sample?.rssBytes?.value ?? sample?.rssBytes;
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
      return { ...base, reason: "owned_tree_rss_unavailable", rssUnavailable: true };
    }
    total += value;
  }
  return { ...base, peakBytes: total };
}

/** Both strict snapshots must be valid; otherwise never invent an owned-tree peak. */
export function mergeOwnedTreeEvidence(initial, preShutdown) {
  const snapshots = [initial, preShutdown];
  if (snapshots.some((snapshot) => !snapshot)) {
    return { peakBytes: null, reason: "snapshot_unavailable", uncertainty: "owned_tree_snapshot_unavailable", rssUnavailable: false };
  }
  const uncertainty = snapshots.find((snapshot) => snapshot.uncertainty)?.uncertainty ?? null;
  if (uncertainty) {
    return { peakBytes: null, reason: "scope_uncertain", uncertainty, rssUnavailable: false };
  }
  if (snapshots.some((snapshot) => snapshot?.rssUnavailable || !Number.isSafeInteger(snapshot?.peakBytes))) {
    return { peakBytes: null, reason: "owned_tree_rss_unavailable", uncertainty: null, rssUnavailable: true };
  }
  return {
    peakBytes: Math.max(...snapshots.map((snapshot) => snapshot.peakBytes)),
    reason: null,
    uncertainty: null,
    rssUnavailable: false,
  };
}

/** A close before the shutdown request is never an intentional shutdown. */
export function resolveRootExitBeforeShutdown({ childOutcome = null, rootIdentityChanged = false, rootIdentityState = null, shutdownRequested = false } = {}) {
  if (shutdownRequested) return false;
  const childClosed = Boolean(childOutcome && (childOutcome.code !== null || childOutcome.signal !== null));
  return Boolean(childClosed || rootIdentityChanged || rootIdentityState === "missing" || rootIdentityState === "changed");
}

/** Map pre-shutdown scope uncertainty to explicit cleanup evidence. */
export function preShutdownFailure(evidence) {
  if (evidence?.uncertainty === "root_missing") {
    return { reason: "root_exited_before_shutdown", rootExited: true };
  }
  if (evidence?.uncertainty === "root_changed") {
    return { reason: "root_identity_changed_before_shutdown", rootExited: true };
  }
  if (evidence?.uncertainty) return { reason: "pre_shutdown_inspection_failed", rootExited: false };
  return null;
}
