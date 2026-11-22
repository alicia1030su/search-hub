/**
 * Shared contracts for v0.1.14 resource tooling.
 *
 * Unknown measurements are always `null` with a non-empty `source` and `reason`.
 * Byte values are integer bytes, elapsed values are integer milliseconds, and
 * timestamps are ISO 8601 UTC strings. Never put credentials, cookies, search
 * text, argv, environment variables, SQL, or provider configuration in records.
 */

/** @typedef {"running" | "success" | "usage" | "resource_blocked" | "child_failed" | "internal"} RunStatus */

/**
 * @typedef {Object} ResourceReading
 * @property {number|null} value Integer measurement, or null when unavailable.
 * @property {string} source Stable collector identifier, for example `proc_meminfo`.
 * @property {string|null} reason Machine-readable reason; required when value is null.
 */

/**
 * @typedef {Object} HostMemory
 * @property {ResourceReading} physicalBytes Total physical RAM.
 * @property {ResourceReading} availableBytes Memory available for new work, excluding swap.
 * @property {ResourceReading} swapTotalBytes Total swap, reported independently.
 * @property {ResourceReading} swapFreeBytes Free swap, reported independently.
 * @property {ResourceReading} pageCacheBytes Reclaimable OS page cache, when attributable.
 */

/**
 * @typedef {Object} Cgroup
 * @property {"v1" | "v2" | "none" | "unknown"} version Detected cgroup generation.
 * @property {ResourceReading} limitBytes Positive limit, or null with `unlimited` reason.
 * @property {ResourceReading} currentBytes Current cgroup memory usage.
 * @property {ResourceReading} oomKills Monotonic OOM kill counter.
 * @property {ResourceReading} [oomEvents] v2 memory.events oom counter, when available.
 * @property {ResourceReading} [anonBytes] Anonymous memory, when available.
 * @property {ResourceReading} [fileBytes] File-backed memory, when available.
 */

/**
 * @typedef {Object} ProcessIdentity
 * @property {number} pid Process ID.
 * @property {number} ppid Parent process ID.
 * @property {string} startTime Platform-specific identity token, not a wall-clock timestamp.
 * @property {boolean} owned Whether ancestry proves this run owns the process.
 * @property {string|null} role Coarse role such as `node`, `chromium`, or `unknown`.
 * @property {string} [executableName] Sanitized executable basename; never argv or a full command line.
 */

/**
 * @typedef {Object} ProcessSample
 * @property {ProcessIdentity} identity PID reuse-safe process identity.
 * @property {ResourceReading} rssBytes OS resident set size.
 * @property {V8Sample} v8 Node heap telemetry; readings are null with `not_node` for non-Node processes.
 * @property {string} sampledAt ISO 8601 UTC timestamp.
 */

/**
 * @typedef {Object} V8Sample
 * @property {ResourceReading} heapUsedBytes V8 used heap.
 * @property {ResourceReading} heapTotalBytes V8 allocated heap.
 * @property {ResourceReading} externalBytes V8 external memory.
 * @property {ResourceReading} arrayBuffersBytes V8 ArrayBuffer memory.
 */

/**
 * @typedef {Object} ContainerState
 * @property {boolean|null} detected Whether Docker/WSL was detected; null when unavailable.
 * @property {string} source Stable read-only detector identifier.
 * @property {string|null} reason Required when detected is null.
 */

/**
 * @typedef {Object} CpuSample
 * @property {ResourceReading} logicalCpus Logical CPU count, used only as a concurrency cap.
 * @property {ResourceReading} utilizationPercent Bounded two-sample utilization percentage.
 */

/**
 * @typedef {Object} ResourceSnapshot
 * @property {number} schemaVersion Contract version, currently 1.
 * @property {string} sampledAt ISO 8601 UTC timestamp.
 * @property {{os: string, arch: string, node: string, uptimeSeconds: number}} platform Platform facts.
 * @property {HostMemory} host Host physical/available/swap/page-cache readings.
 * @property {CpuSample} cpu CPU count and utilization.
 * @property {Cgroup} cgroup Linux cgroup readings; Windows uses `none` with a reason.
 * @property {ProcessSample[]} processes Bounded process samples; empty unless requested.
 * @property {{docker: ContainerState, wsl: ContainerState}} containers Container/VM markers, never configuration.
 */

/**
 * @typedef {Object} CleanupResult
 * @property {boolean} ok Whether no owned residuals or cleanup errors remain.
 * @property {ProcessIdentity[]} residuals Identity-stable processes still present.
 * @property {Array<{pid: number, stage: string, reason: string}>} errors Non-sensitive cleanup errors.
 */

/**
 * @typedef {Object} OomEvidence
 * @property {boolean} confirmed Whether corroborating OOM evidence exists.
 * @property {string} reason Stable classification reason.
 * @property {string[]} evidence Corroborating evidence identifiers, without log contents.
 * @property {number} cgroupOomDelta Observed cgroup OOM counter increment.
 * @property {boolean} ownedRootDied Whether the owned root died during the attempt.
 * @property {number} ownedPeakBytes Peak owned-tree RSS in integer bytes.
 */

/**
 * @typedef {Object} StageAttempt
 * @property {string} stage Verification stage.
 * @property {number} attempt One-based attempt number.
 * @property {number} workers Worker count used by this attempt.
 * @property {number} exitCode Real child/tool exit code.
 * @property {string|null} signal Terminating signal, when known.
 * @property {number} durationMs Integer attempt duration.
 * @property {ResourceReading} rssPeakBytes Peak owned-tree RSS.
 * @property {ResourceReading} heapPeakBytes Peak Node heapUsed.
 * @property {CleanupResult} cleanup Finally cleanup result.
 * @property {OomEvidence} oom OOM classification.
 * @property {boolean} resourceAborted Whether resource pressure aborted the attempt.
 * @property {string} logPath Run-relative sanitized log path.
 */

/**
 * @typedef {Object} BudgetStage
 * @property {number} fixedMiB Fixed stage reserve.
 * @property {number} peakMiB Estimated stage/worker peak.
 * @property {number} requiredMiB fixedMiB + peakMiB.
 * @property {number} workers Safe worker count, or zero when blocked.
 * @property {boolean} safe Whether the frozen baseline can start this stage.
 */

/**
 * @typedef {Object} Budget
 * @property {number} hostReserveMiB Frozen host reserve in MiB.
 * @property {number} cgroupReserveMiB Frozen cgroup reserve in MiB.
 * @property {number} safetyFloorMiB Minimum safe headroom in MiB.
 * @property {number} baselineHeadroomMiB Conservative initial headroom in MiB.
 * @property {number} vitestWorkers Frozen Vitest worker count.
 * @property {number} peakMiB Conservative per-worker peak estimate in MiB.
 * @property {boolean} estimated Whether the peak estimate still awaits real D05 measurements.
 * @property {{normal: number, warn: number, high: number, danger: number, recovery: number}} thresholds Frozen pressure thresholds.
 * @property {string} frozenAt ISO 8601 UTC timestamp.
 * @property {number} cpuCap CPU concurrency cap, never a memory substitute.
 * @property {Record<"typecheck" | "lint" | "vitest" | "build" | "playwright", BudgetStage>} stages Per-stage frozen budgets.
 * @property {boolean} safe Whether every required stage has a safe budget.
 * @property {Array<"typecheck" | "lint" | "vitest" | "build" | "playwright">} blockedStages Stages that must not start.
 * @property {string|null} reason Stable unsafe-budget reason.
 * @property {string} source Headroom collector identifier.
 */

/**
 * @typedef {Object} Pressure
 * @property {"normal" | "warn" | "high" | "danger" | "stop"} level Pressure classification.
 * @property {number|null} ratio Current headroom divided by baseline headroom.
 * @property {string} action Bounded scheduling action; never a system mutation.
 * @property {string} source Collector that supplied the headroom reading.
 * @property {string|null} reason Required when ratio or a critical reading is unavailable.
 * @property {string} sampledAt ISO 8601 UTC timestamp.
 */

/**
 * @typedef {Object} StageResult
 * @property {"typecheck" | "lint" | "vitest" | "build" | "playwright"} stage Fixed verification stage.
 * @property {string} source Stable producer identifier for stage measurements.
 * @property {"passed" | "failed" | "blocked" | "aborted" | "passed_after_oom_retry" | "failed_after_oom_retry"} status Honest terminal stage status.
 * @property {number} exitCode Process exit code, or the documented tool exit code.
 * @property {number} attempts Number of real attempts; OOM retry is at most one.
 * @property {number|null} workers Worker count, or null when not applicable.
 * @property {ResourceReading} rssPeakBytes Peak owned-tree RSS.
 * @property {ResourceReading} heapPeakBytes Peak Node heap usage.
 * @property {number|null} durationMs Integer elapsed milliseconds.
 * @property {string|null} reason Machine-readable block/failure reason.
 * @property {string} startedAt ISO 8601 UTC timestamp.
 * @property {string|null} finishedAt ISO 8601 UTC timestamp, or null while running.
 * @property {StageAttempt[]} attemptDetails Every real attempt, including a failed first OOM attempt.
 * @property {CleanupResult} cleanup Final owned-tree cleanup result.
 * @property {Pressure} [pressure] Pre-stage pressure classification.
 */

/**
 * @typedef {Object} Artifact
 * @property {number} schemaVersion Artifact schema version, currently 1.
 * @property {string} runId Unique run identifier.
 * @property {string} command Logical command name without user arguments.
 * @property {string} rootPath Evidence root for this run.
 * @property {string} summaryPath Path to summary.json.
 * @property {string[]} logPaths Paths to sanitized stage logs.
 * @property {string} createdAt ISO 8601 UTC timestamp.
 * @property {RunStatus} status Run status.
 * @property {number|null} exitCode Final process exit code, or null while running.
 */

export {};
