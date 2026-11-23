import { createHash } from "node:crypto";
import path from "node:path";
import { collectCacheCandidates, discoverTsBuildInfo } from "./allowlist.mjs";

export const PLAN_VERSION = 1;
export const PLAN_TTL_MS = 15 * 60 * 1000;

function canonicalPlanId(plan) {
  const canonical = {
    version: PLAN_VERSION,
    repoRoot: plan.repoRoot,
    items: plan.items.map((item) => ({ path: item.path, size: item.size, mtimeMs: item.mtimeMs, owner: item.owner, reason: item.reason })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Create a read-only maintenance plan; this function never deletes. */
export async function createCachePlan(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const tsBuildInfoFiles = options.tsBuildInfoFiles ?? await discoverTsBuildInfo(repoRoot);
  const candidates = await collectCacheCandidates({ ...options, repoRoot, tsBuildInfoFiles });
  const now = options.now ?? new Date();
  const plan = {
    version: PLAN_VERSION,
    repoRoot,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    configuration: {
      vitestCacheDir: options.vitestCacheDir ?? null,
      esbuildCacheDir: options.esbuildCacheDir ?? null,
      tsBuildInfoFiles,
    },
    items: candidates.items,
    rejected: candidates.rejected,
    totalBytes: candidates.items.reduce((sum, item) => sum + item.size, 0),
  };
  plan.planId = canonicalPlanId(plan);
  return plan;
}

export function planExpired(plan, now = new Date()) {
  return !Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now.getTime();
}

/** Compare all deletion-relevant fields, including file counts and exact paths. */
export function plansMatch(first, second) {
  if (first.version !== second.version || first.repoRoot !== second.repoRoot || first.planId !== second.planId) return false;
  const normalize = (plan) => plan.items.map((item) => ({
    path: item.path,
    size: item.size,
    mtimeMs: item.mtimeMs,
    owner: item.owner,
    reason: item.reason,
    category: item.category,
    type: item.type,
    files: item.files,
    fileEntries: [...item.fileEntries].sort((a, b) => a.path.localeCompare(b.path)),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify(normalize(first)) === JSON.stringify(normalize(second));
}
