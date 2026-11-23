import { setTimeout as delay } from "node:timers/promises";
import * as linux from "./linux.mjs";
import * as windows from "./windows.mjs";

const NOT_NODE_V8 = Object.freeze({
  heapUsedBytes: { value: null, source: "v8", reason: "not_node" },
  heapTotalBytes: { value: null, source: "v8", reason: "not_node" },
  externalBytes: { value: null, source: "v8", reason: "not_node" },
  arrayBuffersBytes: { value: null, source: "v8", reason: "not_node" },
});

function unavailableV8(reason, source = "v8") {
  return {
    heapUsedBytes: { value: null, source, reason },
    heapTotalBytes: { value: null, source, reason },
    externalBytes: { value: null, source, reason },
    arrayBuffersBytes: { value: null, source, reason },
  };
}

function adapter(platform = process.platform) {
  if (platform === "linux") return linux;
  if (platform === "win32") return windows;
  throw new Error(`unsupported_platform:${platform}`);
}

function isDescendant(candidate, rootPid, identities) {
  const seen = new Set();
  let current = candidate;
  while (current && !seen.has(current.pid)) {
    if (current.pid === rootPid) return true;
    seen.add(current.pid);
    current = identities.get(current.ppid);
  }
  return false;
}

/**
 * Tracks only processes whose ancestry was proven to a registered root. Every
 * signal rechecks PID + startTime. If the root exits or its PID is reused,
 * previously registered descendants are still checked by identity, but the root
 * PID itself is never signalled again.
 */
export class OwnedProcessTree {
  constructor(rootPid, rootStartTime, options = {}) {
    this.rootPid = rootPid;
    this.rootStartTime = rootStartTime;
    this.platform = options.platform ?? process.platform;
    this.io = options.io ?? adapter(this.platform);
    this.maxProcesses = options.maxProcesses ?? 512;
    this.termGraceMs = options.termGraceMs ?? 5_000;
    this.consoleCtrlOwned = options.consoleCtrlOwned ?? false;
    this.rootIdentityChanged = false;
    this.rootIdentityState = null;
    this.records = new Map();
    this.inspectionErrors = new Map();
    this.records.set(rootPid, { pid: rootPid, ppid: process.ppid, startTime: rootStartTime, owned: true, role: "node", executableName: "node" });
  }

  sampleEntry(current, telemetry, sampledAt) {
    const identity = { ...current.identity, owned: true };
    this.records.set(identity.pid, identity);
    const reported = telemetry?.samples.get(identity.pid);
    const v8 = reported ? {
      heapUsedBytes: { value: reported.heapUsedBytes, source: "node_telemetry", reason: null },
      heapTotalBytes: { value: reported.heapTotalBytes, source: "node_telemetry", reason: null },
      externalBytes: { value: reported.externalBytes, source: "node_telemetry", reason: null },
      arrayBuffersBytes: { value: reported.arrayBuffersBytes, source: "node_telemetry", reason: null },
    } : identity.role === "node"
      ? unavailableV8("telemetry_unavailable", "node_telemetry")
      : { ...NOT_NODE_V8 };
    return { identity, rssBytes: current.rssBytes, v8, sampledAt };
  }

  noteInspectionError(pid, reason) {
    const registered = this.records.get(pid);
    this.inspectionErrors.set(pid, {
      pid,
      stage: "inspect",
      reason,
      ...(registered ? { identity: { pid, ppid: registered.ppid, startTime: registered.startTime } } : {}),
    });
  }

  async sampleRegisteredDescendants(telemetry = null) {
    const sampledAt = new Date().toISOString();
    const samples = [];
    for (const [pid, registered] of this.records) {
      if (pid === this.rootPid) continue;
      let current = null;
      try {
        current = await this.io.readProcess(pid);
      } catch (error) {
        this.noteInspectionError(pid, `process_read_failed:${error?.code ?? "unknown"}`);
        continue;
      }
      if (!current) {
        // A null detail read is ambiguous on Windows. Only an authoritative
        // process listing that omits the PID proves it has exited.
        let listed = null;
        try { listed = await this.io.listProcesses(Math.max(this.maxProcesses, 2048)); } catch { listed = null; }
        if (listed && !listed.some((entry) => entry.identity.pid === pid)) {
          this.inspectionErrors.delete(pid);
          continue;
        }
        this.noteInspectionError(pid, "process_read_unavailable");
        continue;
      }
      if (current.identity.startTime !== registered.startTime) {
        // PID reuse is safe to ignore: never signal the replacement process.
        this.inspectionErrors.delete(pid);
        continue;
      }
      this.inspectionErrors.delete(pid);
      samples.push(this.sampleEntry(current, telemetry, sampledAt));
    }
    return samples;
  }

  async sample(telemetry = null) {
    let root = null;
    try { root = await this.io.readProcess(this.rootPid); } catch { root = null; }
    if (!root) {
      this.rootIdentityChanged = true;
      this.rootIdentityState = "missing";
      return this.sampleRegisteredDescendants(telemetry);
    }
    if (root.identity.startTime !== this.rootStartTime) {
      this.rootIdentityChanged = true;
      this.rootIdentityState = "changed";
      return this.sampleRegisteredDescendants(telemetry);
    }
    this.rootIdentityChanged = false;
    this.rootIdentityState = null;
    const listed = await this.io.listProcesses(Math.max(this.maxProcesses, 2048));
    const identities = new Map(listed.map((entry) => [entry.identity.pid, entry.identity]));
    identities.set(this.rootPid, root.identity);
    const byPid = new Map(listed.map((entry) => [entry.identity.pid, entry]));
    byPid.set(this.rootPid, root);
    const ownedPids = new Set([this.rootPid]);
    for (const identity of identities.values()) {
      if (isDescendant(identity, this.rootPid, identities)) ownedPids.add(identity.pid);
    }
    const sampledAt = new Date().toISOString();
    const samples = [];
    for (const pid of ownedPids) {
      const current = byPid.get(pid) ?? await this.io.readProcess(pid);
      if (!current) continue;
      const registered = this.records.get(pid);
      if (registered && registered.startTime !== current.identity.startTime) continue;
      samples.push(this.sampleEntry(current, telemetry, sampledAt));
    }
    return samples;
  }

  /** Return only identity-stable owned processes still eligible for cleanup. */
  async verifiedOwnedProcesses() {
    const samples = await this.sample();
    return samples.filter((sample) => sample.identity.startTime === this.records.get(sample.identity.pid)?.startTime);
  }

  finalCleanupResult(errors = [], residuals = []) {
    errors = [...errors, ...this.inspectionErrors.values()];
    if (this.rootIdentityState === "changed") {
      errors = [...errors, { pid: this.rootPid, stage: "identity", reason: "root_identity_changed" }];
    }
    return {
      ok: residuals.length === 0 && errors.length === 0,
      residuals,
      errors,
      rootIdentityChanged: this.rootIdentityChanged,
      ...(this.rootIdentityState ? { reason: this.rootIdentityState === "changed" ? "root_identity_changed" : "root_missing" } : {}),
    };
  }

  /** TERM leaves-to-root, wait up to the grace period, then KILL survivors. */
  async cleanup() {
    const errors = [];
    const initial = await this.verifiedOwnedProcesses();
    if (initial.length === 0) return this.finalCleanupResult(errors);
    const depth = new Map(initial.map((sample) => [sample.identity.pid, 0]));
    for (const sample of initial) {
      let parent = sample.identity.ppid;
      const seen = new Set([sample.identity.pid]);
      let value = 1;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        value += 1;
        parent = this.records.get(parent)?.ppid;
      }
      depth.set(sample.identity.pid, value);
    }
    const ordered = initial.sort((a, b) => (depth.get(b.identity.pid) ?? 0) - (depth.get(a.identity.pid) ?? 0));
    for (const sample of ordered) {
      if (this.platform === "win32" && !this.consoleCtrlOwned) continue;
      const current = await this.verifiedOwnedProcesses();
      if (!current.some((entry) => entry.identity.pid === sample.identity.pid)) continue;
      try {
        await this.io.terminateProcess(sample.identity.pid);
      } catch (error) {
        if (error?.code !== "ESRCH") errors.push({ pid: sample.identity.pid, stage: "term", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const deadline = Date.now() + this.termGraceMs;
    while (Date.now() < deadline) {
      const remaining = await this.verifiedOwnedProcesses();
      if (remaining.length === 0) return this.finalCleanupResult(errors);
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    for (const sample of await this.verifiedOwnedProcesses()) {
      const current = await this.verifiedOwnedProcesses();
      if (!current.some((entry) => entry.identity.pid === sample.identity.pid)) continue;
      try {
        await this.io.killProcess(sample.identity.pid);
      } catch (error) {
        if (error?.code !== "ESRCH") errors.push({ pid: sample.identity.pid, stage: "kill", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    await delay(100);
    const residuals = (await this.verifiedOwnedProcesses()).map((sample) => sample.identity);
    return this.finalCleanupResult(errors, residuals);
  }
}

export { adapter, isDescendant, NOT_NODE_V8 };
