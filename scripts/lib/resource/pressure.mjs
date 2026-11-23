import { headroomMiB } from "./budget.mjs";

/**
 * Classify current pressure using frozen thresholds. Recovery from a degraded
 * level requires two consecutive samples at or above the recovery threshold.
 *
 * @param {ReturnType<import("./budget.mjs").freezeBudget>} budget
 * @param {import("./types.mjs").ResourceSnapshot} snapshot
 * @param {{ownedTreeRssBytes?: number, previousLevel?: string, recoverySamples?: number}} [options]
 */
export function classifyPressure(budget, snapshot, options = {}) {
  const current = headroomMiB(snapshot);
  const sampledAt = new Date().toISOString();
  if (!budget.safe || current.value === null) {
    return { level: "stop", ratio: null, action: "do_not_start_or_stop", source: current.source, reason: current.reason ?? budget.reason ?? "unsafe_budget", sampledAt, recoverySamples: 0 };
  }
  const cgroupLimit = snapshot.cgroup?.limitBytes?.value ?? null;
  const ownedTreeRssBytes = options.ownedTreeRssBytes ?? 0;
  const ratio = budget.baselineHeadroomMiB > 0 ? current.value / budget.baselineHeadroomMiB : 0;
  const cgroupFloor = Math.max(128, budget.cgroupReserveMiB);
  if (current.value < budget.safetyFloorMiB || (cgroupLimit !== null && current.value < cgroupFloor)) {
    return { level: "stop", ratio, action: "do_not_start_or_stop", source: current.source, reason: "safety_floor_reached", sampledAt, recoverySamples: 0 };
  }
  if (ratio < budget.thresholds.danger || (cgroupLimit !== null && ownedTreeRssBytes > cgroupLimit * 0.90)) {
    return { level: "danger", ratio, action: "stop_new_stages_and_cleanup_owned_tree", source: current.source, reason: cgroupLimit !== null && ownedTreeRssBytes > cgroupLimit * 0.90 ? "owned_tree_cgroup_90_percent" : "headroom_below_danger", sampledAt, recoverySamples: 0 };
  }
  if (ratio < budget.thresholds.warn) {
    return { level: "high", ratio, action: "serial_next_stage", source: current.source, reason: null, sampledAt, recoverySamples: 0 };
  }
  if (ratio < budget.thresholds.normal) {
    return { level: "warn", ratio, action: "reduce_next_stage_workers", source: current.source, reason: null, sampledAt, recoverySamples: 0 };
  }
  const degraded = options.previousLevel && options.previousLevel !== "normal";
  if (degraded && ratio < budget.thresholds.recovery) {
    return { level: "warn", ratio, action: "hold_workers_for_hysteresis", source: current.source, reason: "recovery_threshold_not_reached", sampledAt, recoverySamples: 0 };
  }
  const recoverySamples = degraded ? (options.recoverySamples ?? 0) + 1 : 0;
  if (degraded && recoverySamples < 2) {
    return { level: "warn", ratio, action: "hold_workers_for_hysteresis", source: current.source, reason: "recovery_confirmation_pending", sampledAt, recoverySamples };
  }
  return { level: "normal", ratio, action: "keep_frozen_workers", source: current.source, reason: null, sampledAt, recoverySamples: 0 };
}
