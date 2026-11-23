import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM packaging module
import { REQUIRED_WORKFLOWS, evaluateRuns, selectLatestRuns, verifyAnnotatedTag } from "../../packaging/check-release-gates.mjs";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const sha = "a".repeat(40);

function run(path: string, overrides: Record<string, unknown> = {}) {
  return {
    id: Math.floor(Math.random() * 1_000_000), head_sha: sha, event: "push", head_branch: "main",
    path: path.startsWith(".github/workflows/") ? path : `.github/workflows/${path}`,
    status: "completed", conclusion: "success", created_at: "2026-11-23T00:00:00Z",
    html_url: `https://example.test/${path}`, run_attempt: 1, ...overrides,
  };
}

describe("release gate", () => {
  it("selects only exact-SHA main-push runs for the five required workflow paths", () => {
    const runs = Object.keys(REQUIRED_WORKFLOWS).map((path) => run(path));
    runs.push(run("ci.yml", { event: "pull_request" }), run("docker.yml", { head_branch: "feature" }), run("cli.yml", { head_sha: "b".repeat(40) }), run("other.yml"), run("other/ci.yml"));
    const selected = selectLatestRuns(runs, sha);
    expect([...selected.keys()].sort()).toEqual(Object.keys(REQUIRED_WORKFLOWS).sort());
    expect(evaluateRuns(runs, sha).allGreen).toBe(true);
    expect(selectLatestRuns([run("other/ci.yml")], sha).size).toBe(0);
  });

  it("uses the latest terminal run and ignores an older success", () => {
    const runs = [
      run("ci.yml", { id: 1, created_at: "2026-11-23T00:00:00Z", conclusion: "success" }),
      run("ci.yml", { id: 2, created_at: "2026-11-23T01:00:00Z", conclusion: "failure" }),
      ...Object.keys(REQUIRED_WORKFLOWS).filter((path) => path !== "ci.yml").map((path) => run(path)),
    ];
    const result = evaluateRuns(runs, sha);
    expect(result.allGreen).toBe(false);
    expect(result.failed).toEqual([expect.objectContaining({ workflowPath: "ci.yml", run: expect.objectContaining({ id: 2 }) })]);
  });

  it("waits for a newer in-progress run instead of accepting an older success", () => {
    const runs = [
      run("ci.yml", { id: 1, created_at: "2026-11-23T00:00:00Z", conclusion: "success" }),
      run("ci.yml", { id: 2, created_at: "2026-11-23T01:00:00Z", status: "in_progress", conclusion: null }),
      ...Object.keys(REQUIRED_WORKFLOWS).filter((path) => path !== "ci.yml").map((path) => run(path)),
    ];
    const result = evaluateRuns(runs, sha);
    expect(result.allGreen).toBe(false);
    expect(result.pending).toEqual([expect.objectContaining({ workflowPath: "ci.yml", run: expect.objectContaining({ id: 2 }) })]);
  });

  it("verifies single-arch GHCR images through the image config", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).not.toContain("{{json .Manifest.Platforms}}");
    expect(workflow).toContain("--format '{{json .Image}}'");
    expect(workflow).toContain('.os == "linux" and .architecture == "amd64"');
  });

  it("requires an annotated tag on main with a matching stable version", () => {
    const directory = mkdtempSync(join(tmpdir(), "search-hub-tag-test-"));
    temporary.push(directory);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.1.14" }));
    git("add", "package.json");
    git("commit", "-qm", "fixture");
    git("branch", "-M", "main");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("tag", "-a", "v0.1.14", "-m", "fixture");
    expect(verifyAnnotatedTag(directory, "v0.1.14", "0.1.14").commit).toBe(git("rev-parse", "HEAD"));
    expect(() => verifyAnnotatedTag(directory, "v0.1.14", "0.1.13")).toThrow(/tag_version_mismatch/);
    git("tag", "v0.1.15");
    expect(() => verifyAnnotatedTag(directory, "v0.1.15", "0.1.15")).toThrow(/tag_not_annotated/);
  });
});
