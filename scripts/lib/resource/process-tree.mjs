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
 * Tracks only processes whose ancestry is proven to a registered root. Identity
 * is rechecked before every signal; unknown ownership is reported, never killed.
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
    this.records.set(rootPid, { pid: rootPid, ppid: process.ppid, startTime: rootStartTime, owned: true, role: "node", executableName: "node" });
  }

  async sample(telemetry = null) {
    // Root identity is the ownership anchor. Never infer ownership from PID
    // alone: a reused root PID could otherwise adopt an unrelated process tree.
    let root = null;
    try {
      root = await this.io.readProcess(this.rootPid);
    } catch {
      root = null;
    }
    if (!root) {
      this.rootIdentityChanged = true;
      this.rootIdentityState = "missing";
      return [];
    }
    if (root.identity.startTime !== this.rootStartTime) {
      this.rootIdentityChanged = true;
      this.rootIdentityState = "changed";
      return [];
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
      const listedEntry = byPid.get(pid);
      const current = listedEntry ?? await this.io.readProcess(pid);
      if (!current) continue;
      const registered = this.records.get(pid);
      if (registered && registered.startTime !== current.identity.startTime) continue;
      const identity = { ...current.identity, owned: true };
      this.records.set(pid, identity);
      const reported = telemetry?.samples.get(pid);
      const v8 = reported ? {
        heapUsedBytes: { value: reported.heapUsedBytes, source: "node_telemetry", reason: null },
        heapTotalBytes: { value: reported.heapTotalBytes, source: "node_telemetry", reason: null },
        externalBytes: { value: reported.externalBytes, source: "node_telemetry", reason: null },
        arrayBuffersBytes: { value: reported.arrayBuffersBytes, source: "node_telemetry", reason: null },
      } : identity.role === "node"
        ? unavailableV8("telemetry_unavailable", "node_telemetry")
        : { ...NOT_NODE_V8 };
      samples.push({ identity, rssBytes: current.rssBytes, v8, sampledAt });
    }
    return samples;
  }

  /** Return only identity-stable owned processes still eligible for cleanup. */
  async verifiedOwnedProcesses() {
    const samples = await this.sample();
    return samples.filter((sample) => sample.identity.startTime === this.records.get(sample.identity.pid)?.startTime);
  }

  identityCleanupResult(errors = []) {
    if (this.rootIdentityState === "changed") {
      return { ok: false, residuals: [], errors: [...errors, { pid: this.rootPid, stage: "identity", reason: "root_identity_changed" }], rootIdentityChanged: true };
    }
    if (this.rootIdentityState === "missing") {
      return { ok: errors.length === 0, residuals: [], errors, rootIdentityChanged: true, reason: "root_missing" };
    }
    return null;
  }

  /** TERM leaves-to-root, wait up to the grace period, then KILL survivors. */
  async cleanup() {
    const errors = [];
    const initial = await this.verifiedOwnedProcesses();
    const identityResult = this.identityCleanupResult(errors);
    if (identityResult) return identityResult;
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
      const identityResult = this.identityCleanupResult(errors);
      if (identityResult) return identityResult;
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
      if (remaining.length === 0) return this.identityCleanupResult(errors) ?? { ok: errors.length === 0, residuals: [], errors };
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    for (const sample of await this.verifiedOwnedProcesses()) {
      const current = await this.verifiedOwnedProcesses();
      const identityResult = this.identityCleanupResult(errors);
      if (identityResult) return identityResult;
      if (!current.some((entry) => entry.identity.pid === sample.identity.pid)) continue;
      try {
        await this.io.killProcess(sample.identity.pid);
      } catch (error) {
        if (error?.code !== "ESRCH") errors.push({ pid: sample.identity.pid, stage: "kill", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    await delay(100);
    const residuals = (await this.verifiedOwnedProcesses()).map((sample) => sample.identity);
    return this.identityCleanupResult(errors) ?? { ok: residuals.length === 0 && errors.length === 0, residuals, errors };
  }
}

export { adapter, isDescendant, NOT_NODE_V8 };
