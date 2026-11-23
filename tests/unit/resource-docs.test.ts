import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const agents = readFileSync(resolve(root, "AGENTS.md"), "utf8");
const resourceDocs = readFileSync(resolve(root, "docs/resource-management.md"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("D10 resource-management documentation contracts", () => {
  it("requires a current host-memory check before expensive or parallel work", () => {
    expect(agents).toMatch(/before (?:running )?(?:large[- ]scale|expensive|full)|大规模测试/i);
    expect(agents).toMatch(/available (?:physical )?memory|可用物理内存/);
    expect(agents).toMatch(/build|构建/);
    expect(agents).toMatch(/parallel (?:sub[- ]?)?agents?|并行子 Agent/);
    expect(agents).toMatch(/adjust|调整/);
    expect(agents).toMatch(/concurrency|并发/);
  });

  it("forbids lowering quality, blaming a product leak without evidence, and unsafe cleanup", () => {
    expect(agents).toMatch(/skip.*test|跳过测试/);
    expect(agents).toMatch(/lower.*standard|降低标准/);
    expect(agents).toMatch(/single OOM|单次 OOM/);
    expect(agents).toMatch(/product.*leak|产品.*泄漏/);
    expect(agents).toMatch(/without evidence|无证据/);
    expect(agents).toMatch(/user cache|用户缓存/);
    expect(agents).toMatch(/workspace|工作区/);
    expect(agents).toMatch(/git clean -fdx/);
  });

  it("requires same-SHA resource evidence for every formal release", () => {
    expect(agents).toMatch(/every formal release|每次正式版本发布/);
    expect(agents).toMatch(/resource (?:record|evidence)|资源记录/);
    expect(agents).toMatch(/same SHA|同 SHA/);
  });

  it.each([
    ["resource:doctor", "resource-doctor.mjs"],
    ["verify:smart", "verify-smart.mjs"],
    ["test:lowmem", "test-lowmem.mjs"],
    ["cache:inspect", "cache-maintenance.mjs inspect"],
    ["cache:prune", "cache-maintenance.mjs prune"],
  ])("defines the %s command and documents it", (name, implementation) => {
    expect(pkg.scripts[name]).toContain(implementation);
    expect(resourceDocs).toContain(`pnpm ${name}`);
  });

  it("documents low-memory/CI boundaries and RSS terminology", () => {
    expect(resourceDocs).toContain("typecheck → lint → Vitest → build → Playwright");
    expect(resourceDocs).toContain("--maxWorkers=1");
    expect(resourceDocs).toContain("--no-file-parallelism");
    expect(resourceDocs).toContain("不替代 CI");
    expect(resourceDocs).toContain("max-old-space-size");
    expect(resourceDocs).toContain("不等于 RSS");
    expect(resourceDocs).toContain("null + {source,reason}");
  });

  it("documents safe cache deletion, OOM evidence, and worker policy", () => {
    expect(resourceDocs).toContain("--dry-run");
    expect(resourceDocs).toContain("--authorize-delete");
    expect(resourceDocs).toContain("--confirm planId");
    expect(resourceDocs).toContain("零删除");
    expect(resourceDocs).toContain(".resource-bench/");
    expect(resourceDocs).toContain("owned");
    expect(resourceDocs).toContain("无法归属");
    expect(resourceDocs).toContain("estimated:true");
    expect(resourceDocs).toContain("nearest-rank");
  });
});
