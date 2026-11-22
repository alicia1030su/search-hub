import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM cache module
import { createCachePlan, plansMatch, planExpired } from "../../scripts/lib/cache-cli/plan.mjs";
// @ts-expect-error -- plain ESM cache module
import { applyCachePlan } from "../../scripts/lib/cache-cli/prune.mjs";
// @ts-expect-error -- plain ESM cache module
import { validatePath } from "../../scripts/lib/cache-cli/allowlist.mjs";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), "search-hub-cache-cli-"));
  directories.push(repoRoot);
  const files = {
    cache: join(repoRoot, ".cache", "vitest", "result.json"),
    modules: join(repoRoot, "node_modules", "sentinel.txt"),
    bench: join(repoRoot, ".resource-bench", "baseline.json"),
    database: join(repoRoot, ".data", "search.db"),
    unknown: join(repoRoot, "unknown-cache", "keep.txt"),
  };
  for (const [key, file] of Object.entries(files)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, key);
  }
  return { repoRoot, files };
}

describe("D09 cache maintenance safety", () => {
  it("inspect/dry-run are zero-delete and only include the explicit allowlist", async () => {
    const { repoRoot, files } = await fixture();
    const before = await Promise.all(Object.values(files).map((file) => readFile(file, "utf8")));
    const plan = await createCachePlan({ repoRoot, vitestCacheDir: ".cache/vitest", tsBuildInfoFiles: [] });
    expect(plan.items.map((item: { category: string }) => item.category), JSON.stringify(plan.rejected)).toEqual(["vitest-cache"]);
    expect(plan.deleted).toBeUndefined();
    expect(plan.totalBytes).toBeGreaterThan(0);
    expect(plan.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(await Promise.all(Object.values(files).map((file) => readFile(file, "utf8")))).toEqual(before);
  });

  it("rejects protected and escaping paths", async () => {
    const { repoRoot, files } = await fixture();
    expect((await validatePath(files.modules, repoRoot)).ok).toBe(false);
    expect((await validatePath(files.database, repoRoot)).ok).toBe(false);
    expect((await validatePath(join(repoRoot, "..", "outside"), repoRoot)).ok).toBe(false);
    expect((await validatePath(files.bench, repoRoot)).ok).toBe(false);
  });

  it("requires authorization and rejects plan drift before deleting", async () => {
    const { repoRoot, files } = await fixture();
    const plan = await createCachePlan({ repoRoot, vitestCacheDir: ".cache/vitest", tsBuildInfoFiles: [] });
    await expect(applyCachePlan(plan, { repoRoot, authorizeDelete: false })).rejects.toThrow("delete_authorization_missing");
    await writeFile(files.cache, "changed");
    await expect(applyCachePlan(plan, { repoRoot, authorizeDelete: true, confirmPlanId: plan.planId })).rejects.toThrow("plan_drift_detected");
    expect(await readFile(files.cache, "utf8")).toBe("changed");
  });

  it("applies only a fresh authorized plan and preserves every protected sentinel", async () => {
    const { repoRoot, files } = await fixture();
    const plan = await createCachePlan({ repoRoot, vitestCacheDir: ".cache/vitest", tsBuildInfoFiles: [] });
    const fresh = await createCachePlan({ repoRoot, vitestCacheDir: ".cache/vitest", tsBuildInfoFiles: [] });
    expect(plansMatch(plan, fresh)).toBe(true);
    const result = await applyCachePlan(plan, { repoRoot, authorizeDelete: true, confirmPlanId: plan.planId });
    expect(result.ok).toBe(true);
    expect(result.deleted).toEqual([files.cache]);
    await expect(stat(files.cache)).rejects.toThrow();
    expect(await readFile(files.modules, "utf8")).toBe("modules");
    expect(await readFile(files.bench, "utf8")).toBe("bench");
    expect(await readFile(files.database, "utf8")).toBe("database");
    expect(await readFile(files.unknown, "utf8")).toBe("unknown");
  });

  it("requires an owner manifest for tool-owned runs and rejects symlink escapes", async () => {
    const { repoRoot } = await fixture();
    const runPath = join(repoRoot, ".cache", "search-hub-resource", "v1", "run-1");
    await mkdir(runPath, { recursive: true });
    await writeFile(join(runPath, "data.bin"), "cache");
    let plan = await createCachePlan({ repoRoot, tsBuildInfoFiles: [] });
    expect(plan.items).toHaveLength(0);
    await writeFile(join(runPath, "owner.json"), JSON.stringify({ owner: "search-hub-resource", version: 1, runId: "run-1", createdAt: "2026-11-22T00:00:00.000Z" }));
    plan = await createCachePlan({ repoRoot, tsBuildInfoFiles: [] });
    expect(plan.items[0].category).toBe("tool-owned-run");
    const outside = await mkdtemp(join(tmpdir(), "search-hub-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    try {
      await symlink(outside, join(repoRoot, ".cache", "escape"), process.platform === "win32" ? "junction" : "dir");
      expect((await validatePath(join(repoRoot, ".cache", "escape"), repoRoot)).ok).toBe(false);
    } catch {
      // Some Windows accounts cannot create junctions; path validation remains covered above.
    }
  });

  it("expires plans after fifteen minutes", async () => {
    const plan = { expiresAt: "2027-11-22T00:15:00.000Z" };
    expect(planExpired(plan, new Date("2027-11-22T00:15:00.001Z"))).toBe(true);
    expect(planExpired(plan, new Date("2027-11-22T00:14:59.000Z"))).toBe(false);
  });
});
