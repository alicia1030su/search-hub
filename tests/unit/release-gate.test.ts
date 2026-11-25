import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM packaging module
import { PREFLIGHT_WORKFLOWS, REQUIRED_WORKFLOWS, evaluateRuns, ghApiArgv, githubRepoApiPath, selectLatestRuns, verifyAnnotatedTag, verifyFinalReadme } from "../../packaging/check-release-gates.mjs";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const sha = "a".repeat(40);
const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
const currentTag = `v${version}`;
const screenshotFiles = [
  "docs/screenshots/v0116/dashboard.png",
  "docs/screenshots/v0116/search-lab.png",
  "docs/screenshots/v0116/provider-health.png",
];
const readmeAnchors = [
  "top", "highlights", "screenshots", "quick-start", "interfaces",
  "providers", "docs", "limits", "license",
];

function finalReadme(english: boolean): string {
  const assets = [
    `search-hub-v${version}-windows-x64.zip`,
    `search-hub-v${version}-linux-x64.tar.gz`,
    `search-hub-v${version}-linux-arm64.tar.gz`,
    `shub-v${version}-windows-x64.zip`,
    `shub-v${version}-linux-x64.tar.gz`,
    `shub-v${version}-linux-arm64.tar.gz`,
    `shub-v${version}-node22.tar.gz`,
    "resource-evidence.json",
    "SHA256SUMS",
  ];
  const facts = english
    ? [
        "mcp:use sources:read get_search_sources",
        "Hacker News Crossref OpenAlex PubMed",
        "live_tested documented mock_verified",
        "Windows x64 Linux x64 Linux arm64 Docker Compose",
        "SHA256SUMS resource-evidence.json best-effort",
        "Multi-instance deployment is not implemented Redis PostgreSQL synthetic fixtures SSE",
      ]
    : [
        "mcp:use sources:read get_search_sources",
        "Hacker News Crossref OpenAlex PubMed",
        "live_tested documented mock_verified",
        "Windows x64 Linux x64 Linux arm64 Docker Compose",
        "SHA256SUMS resource-evidence.json best-effort",
        "多实例未实现 Redis PostgreSQL 合成基准 SSE",
      ];
  const lines = [
    "# Search Hub",
    `v${version} Stable`,
    `https://github.com/alicia1030su/search-hub/releases/tag/v${version}`,
    "Node.js >=22.12.0",
    ...assets,
    ...facts,
    ...readmeAnchors.map((anchor) => `<a id="${anchor}"></a>`),
    ...screenshotFiles.map((file, index) => `![screenshot ${index}](${file})`),
  ];
  while (lines.length < 110) lines.push(`Documentation line ${lines.length + 1}.`);
  return `${lines.join("\n")}\n`;
}

function finalReadmeFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "search-hub-final-readme-"));
  temporary.push(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version, engines: { node: ">=22.12.0" } }));
  writeFileSync(join(directory, "README.md"), finalReadme(false));
  writeFileSync(join(directory, "README_EN.md"), finalReadme(true));
  mkdirSync(join(directory, "docs", "screenshots", "v0116"), { recursive: true });
  for (const file of screenshotFiles) writeFileSync(join(directory, file), "png-fixture");
  return directory;
}

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

  it("requires candidate workflow_dispatch evidence only in the six-workflow preflight", () => {
    const mainPush = Object.keys(REQUIRED_WORKFLOWS).map((path) => run(path));
    const candidate = run("release-candidate.yml", { event: "workflow_dispatch", head_branch: "feat/v0116-stable" });
    expect(evaluateRuns([...mainPush, candidate], sha).allGreen).toBe(true);
    expect(evaluateRuns(mainPush, sha).allGreen).toBe(true);
    expect(evaluateRuns(mainPush, sha, { includeCandidate: true }).allGreen).toBe(false);
    expect(evaluateRuns([...mainPush, { ...candidate, event: "push" }], sha, { includeCandidate: true }).allGreen).toBe(false);
    expect(evaluateRuns([...mainPush, { ...candidate, head_sha: "b".repeat(40) }], sha, { includeCandidate: true }).allGreen).toBe(false);
    expect(evaluateRuns([...mainPush, run("other/release-candidate.yml", { event: "workflow_dispatch" })], sha, { includeCandidate: true }).allGreen).toBe(false);
    expect(Object.keys(PREFLIGHT_WORKFLOWS)).toHaveLength(6);
  });

  it("passes GitHub API endpoints to gh as one safely encoded argument", () => {
    const tagPath = githubRepoApiPath("alicia1030su/search-hub", "git", "ref", "tags", currentTag);
    expect(tagPath).toBe(`repos/alicia1030su/search-hub/git/ref/tags/${currentTag}`);
    expect(ghApiArgv(tagPath)).toEqual(["api", tagPath]);
    expect(githubRepoApiPath("owner/repo", "git", "ref", "tags", "release/候选 #1")).toBe("repos/owner/repo/git/ref/tags/release%2F%E5%80%99%E9%80%89%20%231");
    expect(`${githubRepoApiPath("owner/repo", "actions", "runs", "123", "artifacts")}?per_page=100`).toBe("repos/owner/repo/actions/runs/123/artifacts?per_page=100");
    expect(() => ghApiArgv(["repos", "owner/repo"])).toThrow(/github_api_endpoint_invalid/);
    const source = readFileSync(new URL("../../packaging/check-release-gates.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("ghJson([");
  });

  it("verifies single-arch GHCR images through the image config", () => {
    const promoter = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    const candidate = readFileSync(new URL("../../.github/workflows/release-candidate.yml", import.meta.url), "utf8");
    expect(promoter).not.toContain("{{json .Manifest.Platforms}}");
    expect(candidate).toContain("node packaging/release-evidence.mjs image --inspection image-inspection.json");
    expect(promoter).toContain("node packaging/release-evidence.mjs image --inspection stable-normalized.json");
    expect(promoter).toContain("node packaging/release-evidence.mjs image --inspection final-normalized.json");
    expect(promoter.match(/imagetools inspect[^\n]*--raw/g)).toHaveLength(3);
    expect(promoter.match(/normalize-inspection/g)).toHaveLength(3);
  });

  it("promotes the exact manifest and safely dispatches the existing draft", () => {
    const promoter = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(promoter).toContain('docker buildx imagetools create --tag "$ref" --prefer-index=false "${base}@${EXPECTED_DIGEST}"');
    expect(promoter).toContain("workflow_dispatch:");
    expect(promoter).toContain("if: github.event_name == 'push' || github.ref == 'refs/heads/main'");
    expect(promoter).toContain("required: true");
    expect(promoter).not.toContain('default: "v0.1.15"');
    expect(promoter).toContain('test "$TAG" = "v${version}"');
    expect(promoter).toContain("ref: ${{ inputs.tag || github.ref_name }}");
    expect(promoter).toContain("ref: ${{ github.event_name == 'workflow_dispatch' && github.sha || inputs.tag || github.ref_name }}");
    expect(promoter).toContain("TAG: ${{ inputs.tag || github.ref_name }}");
    expect(promoter).toContain('if [[ "$EVENT_NAME" == "push" ]]; then');
    expect(promoter).toContain('args+=(--event-sha "$GITHUB_SHA")');
    expect(promoter).toContain('node packaging/check-release-draft.mjs --repo "$GITHUB_REPOSITORY" --tag "$TAG" --event "$EVENT_NAME"');
    const draftChecker = readFileSync(new URL("../../packaging/check-release-draft.mjs", import.meta.url), "utf8");
    expect(draftChecker).not.toContain("HTTP 404");
    expect(draftChecker).toContain("release_tag_ambiguous");
    expect(draftChecker).toContain("pages.length === 0");
    expect(draftChecker).toContain("Array.isArray(release?.assets)");
    expect(draftChecker).toContain("assets.length !== 0");
    expect(draftChecker).toContain("assets.length !== 9");
    expect(promoter).toMatch(/name: Create or update only an empty draft\n\s+if: github\.event_name == 'push'/);
    const finalize = promoter.slice(promoter.indexOf("  finalize:"));
    const publishIndex = finalize.indexOf('gh release edit "$TAG" --draft=false --latest');
    expect(publishIndex).toBeGreaterThan(-1);
    for (const marker of [
      'gh release download "$TAG" --dir final-download',
      "sha256sum -c SHA256SUMS",
      "packaging/candidate-attestations.mjs verify",
      "git/ref/tags/${TAG}",
      "git/tags/${tag_object}",
      'expected_tag_object=$(git rev-parse "refs/tags/$TAG")',
      'imagetools inspect "$ref" --raw',
      "normalize-inspection",
      "release-evidence.mjs image --inspection final-normalized.json",
    ]) {
      const index = finalize.indexOf(marker);
      expect(index, marker).toBeGreaterThanOrEqual(0);
      expect(index, marker).toBeLessThan(publishIndex);
    }
    expect(finalize).not.toContain("name: Publish the already verified Stable draft");
    expect(finalize.match(/gh release edit /g)).toHaveLength(1);
  });

  it("accepts a final README fixture with three screenshots and valid links", () => {
    expect(verifyFinalReadme(finalReadmeFixture())).toEqual({ ok: true, version });
  });

  it("rejects final README capture placeholders", () => {
    const directory = finalReadmeFixture();
    writeFileSync(join(directory, "README.md"), `${readFileSync(join(directory, "README.md"), "utf8")}\nCAPTURE_REQUIRED\n`);
    expect(() => verifyFinalReadme(directory)).toThrow(/CAPTURE_REQUIRED/);
  });

  it("rejects a final README that links a missing screenshot", () => {
    const directory = finalReadmeFixture();
    rmSync(join(directory, screenshotFiles[1]!));
    expect(() => verifyFinalReadme(directory)).toThrow(/screenshot file is missing/);
  });

  it("runs the final README gate after exact-SHA checkout and before workflow polling", () => {
    const candidate = readFileSync(new URL("../../.github/workflows/release-candidate.yml", import.meta.url), "utf8");
    const checkout = candidate.indexOf("ref: ${{ steps.resolve.outputs.sha }}");
    const readmeGate = candidate.indexOf("node scripts/check-readme-consistency.mjs --mode final");
    const workflowGate = candidate.indexOf("name: Require only the five exact-SHA main-push workflows");
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(readmeGate).toBeGreaterThan(checkout);
    expect(workflowGate).toBeGreaterThan(readmeGate);
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
    git("tag", currentTag);
    expect(() => verifyAnnotatedTag(directory, currentTag, version)).toThrow(/tag_not_annotated/);
  });
});
