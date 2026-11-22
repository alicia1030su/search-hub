import { lstat, readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { createCachePlan, planExpired, plansMatch } from "./plan.mjs";
import { hasReparsePoint, isProtected, validatePath } from "./allowlist.mjs";

async function removeEmptyDirectories(root, repoRoot) {
  if (!(await validatePath(root, repoRoot)).ok || await hasReparsePoint(root)) return;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const info = await lstat(child);
    if (info.isDirectory() && !info.isSymbolicLink() && !isProtected(child, repoRoot) && !(await hasReparsePoint(child)) && (await validatePath(child, repoRoot)).ok) await removeEmptyDirectories(child, repoRoot);
  }
  try {
    await rmdir(root);
  } catch {
    // Non-empty roots and their parents are always preserved.
  }
}

/** Delete only files from an authorized, freshly matched plan. */
export async function applyCachePlan(plan, options = {}) {
  const now = options.now ?? new Date();
  if (options.confirmPlanId !== plan.planId || options.authorizeDelete !== true) throw new Error("delete_authorization_missing");
  if (planExpired(plan, now)) throw new Error("plan_expired");
  const fresh = await createCachePlan({ ...options, ...plan.configuration, repoRoot: plan.repoRoot, now });
  if (!plansMatch(plan, fresh)) throw new Error("plan_drift_detected");
  const deleted = [];
  const errors = [];
  for (const item of [...plan.items].sort((a, b) => b.fileEntries.length - a.fileEntries.length)) {
    const valid = await validatePath(item.path, plan.repoRoot);
    if (!valid.ok || isProtected(item.path, plan.repoRoot)) {
      errors.push({ path: item.path, reason: valid.reason ?? "protected_path" });
      continue;
    }
    for (const file of item.fileEntries) {
      try {
        const fileValid = await validatePath(file.path, plan.repoRoot);
        if (!fileValid.ok || isProtected(file.path, plan.repoRoot)) throw new Error(fileValid.reason ?? "protected_path");
        const info = await lstat(file.path);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || Math.trunc(info.mtimeMs) !== file.mtimeMs) throw new Error("file_drift_detected");
        await rm(file.path, { force: false });
        deleted.push(file.path);
      } catch (error) {
        errors.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  for (const item of plan.items) {
    if (item.type === "directory") await removeEmptyDirectories(item.path, plan.repoRoot);
  }
  return { ok: errors.length === 0, planId: plan.planId, deleted, errors };
}

/** Read and minimally validate a persisted plan without trusting its paths. */
export async function readCachePlan(planPath) {
  const value = JSON.parse(await readFile(planPath, "utf8"));
  if (value.version !== 1 || typeof value.planId !== "string" || !Array.isArray(value.items) || typeof value.repoRoot !== "string") throw new Error("invalid_plan");
  return value;
}
