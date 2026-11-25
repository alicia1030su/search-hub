import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "../../apps/api/src/routes/openapi-routes.js";
import { CLI_VERSION } from "../../packages/cli/src/version.js";
import { MCP_VERSION } from "../../packages/mcp/src/version.js";
import { expectedReleaseAssets } from "../../packaging/release-evidence.mjs";
import * as releaseEvidenceModule from "../../packaging/release-evidence.mjs";
// @ts-expect-error -- plain ESM resource module
import { BASELINE_COMMIT, BENCHMARK_COMMIT, EVIDENCE_VERSION } from "../../scripts/lib/resource-evidence.mjs";
// @ts-expect-error -- plain ESM resource module
import { ARTIFACT_VERSION } from "../../scripts/lib/resource/artifacts.mjs";
// @ts-expect-error -- plain ESM release helper
import * as releaseVersionModule from "../../scripts/lib/release-version.mjs";
const {
  candidateEvidenceArtifact,
  disasterRecoverySuite,
  readReleaseVersion,
  releaseEvidenceArtifact,
  resourceRuntimeArtifact,
  versionSlug,
  versionTag,
} = releaseVersionModule;

const {
  CANDIDATE_EVIDENCE_ARTIFACT,
  CI_RELEASE_EVIDENCE_ARTIFACT,
  CURRENT_RELEASE_VERSION,
  RELEASE_EVIDENCE_VERSION,
  RESOURCE_EVIDENCE_VERSION,
  RESOURCE_RUNTIME_ARTIFACT,
} = releaseEvidenceModule as unknown as Record<string, string>;

const root = resolve(import.meta.dirname, "../..");
const read = (relativePath: string): string => readFileSync(resolve(root, relativePath), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string };
const version = pkg.version;
const tag = `v${version}`;
const slug = version.replaceAll(".", "");

describe("v0.1.16 release version single source", () => {
  it("pins the root and every workspace manifest to the target release", () => {
    expect(version).toBe("0.1.16");
    const manifests = [
      "apps/api/package.json",
      "apps/web/package.json",
      "packages/backup/package.json",
      "packages/cli/package.json",
      "packages/core/package.json",
      "packages/db/package.json",
      "packages/mcp/package.json",
      "packages/models/package.json",
      "packages/providers/package.json",
      "packages/shared/package.json",
    ];
    for (const manifest of manifests) {
      expect(JSON.parse(read(manifest)).version, manifest).toBe(version);
    }
    expect(readReleaseVersion(root)).toBe(version);
    expect(versionTag(version)).toBe(tag);
    expect(versionSlug(version)).toBe(slug);
  });

  it("derives CLI, MCP and OpenAPI runtime versions without stale hardcodes", () => {
    expect(CLI_VERSION).toBe(version);
    expect(MCP_VERSION).toBe(version);
    expect(createOpenApiDocument("9.8.7").info.version).toBe("9.8.7");
    expect(read("packages/cli/src/version.ts")).not.toContain('"0.1.15"');
    expect(read("packages/mcp/src/stdio.ts")).not.toContain('version: "0.1.0"');
    expect(read("apps/api/src/routes/openapi-routes.ts")).not.toContain('version: "0.1.');
    expect(read("apps/api/src/app.ts")).toContain("registerOpenApiRoutes(app, ctx.config.version)");

    const cliBundle = read("packaging/bundle-cli.mjs");
    expect(cliBundle).toContain('readFileSync(join(root, "package.json"), "utf8")');
    expect(cliBundle).toContain("define: { __SHUB_VERSION__: JSON.stringify(pkg.version) }");
    expect(cliBundle).toContain("CLI workspace version mismatch");
    const serverBundle = read("scripts/build-server.mjs");
    expect(serverBundle).toContain("define: { __SHUB_VERSION__: JSON.stringify(releasePackage.version) }");
    expect(serverBundle).toContain("MCP workspace version mismatch");
  });

  it("keeps release evidence and current resource artifact names aligned", () => {
    expect(CURRENT_RELEASE_VERSION).toBe(version);
    expect(RELEASE_EVIDENCE_VERSION).toBe(tag);
    expect(RESOURCE_RUNTIME_ARTIFACT).toBe(`resource-evidence-v${slug}.json`);
    expect(CI_RELEASE_EVIDENCE_ARTIFACT).toBe(`release-evidence-${tag}`);
    expect(CANDIDATE_EVIDENCE_ARTIFACT).toBe(`release-candidate-evidence-${tag}`);
    expect(releaseEvidenceArtifact(version)).toBe(CI_RELEASE_EVIDENCE_ARTIFACT);
    expect(candidateEvidenceArtifact(version)).toBe(CANDIDATE_EVIDENCE_ARTIFACT);
    expect(resourceRuntimeArtifact(version)).toBe(RESOURCE_RUNTIME_ARTIFACT);
    expect(disasterRecoverySuite(version)).toBe(`search-hub-disaster-recovery-${tag}`);
    expect(ARTIFACT_VERSION).toBe(tag);
    expect(expectedReleaseAssets(version)).toHaveLength(8);
    expect([...expectedReleaseAssets(version), "SHA256SUMS"]).toHaveLength(9);
  });

  it("preserves explicitly historical resource and upgrade fixtures", () => {
    expect(RESOURCE_EVIDENCE_VERSION).toBe("v0.1.14");
    expect(EVIDENCE_VERSION).toBe("v0.1.14");
    expect(BASELINE_COMMIT).toBe("4d2e25249f90a085b28ea05ee479b393d716c99e");
    expect(BENCHMARK_COMMIT).toBe("e182f60703d179ec4d28f1dbf23ce04c0f2b0a25");
    expect(read(".github/workflows/ci.yml")).toContain("--source-evidence-dir docs/evidence/v0.1.14");
    expect(read(".github/workflows/release-candidate.yml")).toContain("gh release download v0.1.14");
    expect(read(".github/workflows/systemd.yml")).toContain("SEARCH_HUB_VERSION: 0.9.0-ci");
    expect(read(".github/workflows/systemd.yml")).toContain("search-hub-v0.9.9-linux-x64.tar.gz");
    expect(read("packaging/launcher/updater-test.mjs")).toContain('makeInstallRoot("0.1.0")');
  });

  it("triggers Docker for every main push without a path filter", () => {
    const docker = read(".github/workflows/docker.yml");
    const pushBlock = docker.slice(docker.indexOf("  push:"), docker.indexOf("  pull_request:"));
    expect(pushBlock).toContain("branches: [main, master]");
    expect(pushBlock).not.toMatch(/^\s+paths:/m);
    expect(docker).toContain("docs/evidence-only");
  });

  it("builds current upgrade packages dynamically and includes both real Stable sources", () => {
    const upgrade = read(".github/workflows/upgrade.yml");
    expect(upgrade).toContain("os: [windows-latest, ubuntu-latest]");
    expect(upgrade).toContain('VERSION=$(node -p "require(\'./package.json\').version")');
    expect(upgrade).toContain("SEARCH_HUB_VERSION: ${{ env.VERSION }}");
    expect(upgrade).not.toContain("SEARCH_HUB_VERSION: 0.1.14-ci");
    expect(upgrade).toContain("node packaging/upgrade-matrix.mjs --from v0.1.14 --to \"$TARGET\" --port 8933");
    expect(upgrade).toContain("node packaging/upgrade-matrix.mjs --from v0.1.15 --to \"$TARGET\" --port 8934");
    const matrix = JSON.parse(read("tests/disaster-recovery/requirement-matrix.json")) as {
      suite: string;
      requirements: Record<string, { command: string }>;
    };
    expect(matrix.suite).toBe(disasterRecoverySuite(version));
    expect(matrix.requirements.R31?.command).toContain("--from v0.1.14");
    expect(matrix.requirements.R31?.command).toContain("--from v0.1.15");
    expect(upgrade).toContain("Update fault injection");
    expect(upgrade).toContain("Supply-chain audit (published release)");
  });

  it("parameterizes current workflow artifacts while retaining the immutable tag trigger", () => {
    const ci = read(".github/workflows/ci.yml");
    const candidate = read(".github/workflows/release-candidate.yml");
    const promoter = read(".github/workflows/release.yml");
    expect(ci).toContain("name: release-evidence-${{ env.VERSION }}");
    expect(ci).toContain("resource-evidence-v$VERSION_SLUG.json");
    expect(candidate).toContain("name: candidate-gate-v${{ steps.resolve.outputs.version }}");
    expect(candidate).toContain("name: dr-core-v${{ needs.gate.outputs.version }}");
    expect(candidate).toContain("name: candidate-image-v${{ needs.gate.outputs.version }}");
    expect(candidate).toContain("name: release-candidate-evidence-v${{ needs.gate.outputs.version }}");
    expect(candidate).toContain("resource-evidence-v${{ needs.gate.outputs.versionSlug }}.json");
    expect(candidate).not.toContain('test "$version" = "0.1.15"');
    const candidateGateJob = candidate.slice(candidate.indexOf("  gate:"), candidate.indexOf("  core-acceptance:"));
    expect(candidateGateJob).not.toContain("needs.gate.outputs");
    expect(promoter).toContain(`tags: ["${tag}"]`);
    expect(promoter).toContain('test "$TAG" = "v${version}"');
    expect(promoter).toContain("name: release-gate-v${{ steps.version.outputs.version }}");
    const promoterGateJob = promoter.slice(promoter.indexOf("  gate:"), promoter.indexOf("  candidate:"));
    expect(promoterGateJob).not.toContain("needs.gate.outputs");
    expect(promoter).toContain("name: release-final-v${{ needs.gate.outputs.versionSlug }}");
    expect(promoter).toContain('"${base}:${{ needs.gate.outputs.version }}" "${base}:v${{ needs.gate.outputs.version }}" "${base}:latest"');
    for (const workflow of [ci, candidate, promoter]) {
      expect(workflow).not.toContain("v0.1.15");
      expect(workflow).not.toContain("v0115");
    }
  });

  it("keeps exact-SHA latest-run selection fail-closed", () => {
    const gate = read("packaging/check-release-gates.mjs");
    expect(gate).toContain("workflowRun.head_sha !== sha");
    expect(gate).toContain("workflowRun.event === \"push\" && workflowRun.head_branch === \"main\"");
    expect(gate).toContain("`${workflowRun.created_at ?? \"\"}:${workflowRun.id ?? 0}`");
    expect(gate).toContain("if (evaluation.failed.length > 0)");
    expect(gate).toContain("latest workflow terminal failure:");
    expect(gate).toContain('if (workflowRun.status !== "completed") pending.push');
    expect(gate).toContain('else if (workflowRun.conclusion !== "success") failed.push');
  });
});
