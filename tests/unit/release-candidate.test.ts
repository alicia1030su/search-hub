import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM resource module
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";
import {
  createCandidateManifest, combineReleaseEvidence, expectedReleaseAssets, parseSha256Sums,
  verifyCandidateAttestationFiles, verifyCandidateManifest, verifyGhcrImage,
  verifyGhcrInspection, normalizeGhcrInspection, verifyReleaseAssets,
} from "../../packaging/release-evidence.mjs";

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const version = "0.1.15";
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8" }).trim();
const runId = 123456;
const attempt = 1;
const digest = `sha256:${"b".repeat(64)}`;

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function rawInspectionFixture() {
  const mediaType = "application/vnd.oci.image.manifest.v1+json";
  const config = { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${"c".repeat(64)}`, size: 512 };
  const raw = { schemaVersion: 2, mediaType, config, layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: `sha256:${"d".repeat(64)}`, size: 1024 }] };
  const rawBytes = Buffer.from(JSON.stringify(raw));
  const rawDigest = `sha256:${hash(rawBytes)}`;
  const formatted = { name: "ghcr.io/example/search-hub:candidate", manifest: { mediaType, digest: rawDigest, size: rawBytes.length }, image: { os: "linux", architecture: "amd64" } };
  return { formatted, raw, rawBytes, rawDigest, mediaType, config };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "search-hub-candidate-test-"));
  temporary.push(root);
  const directory = join(root, "assets");
  const attestations = join(root, "attestations");
  mkdirSync(directory);
  mkdirSync(attestations);
  const repository = "ghcr.io/example/search-hub";
  const image = { ref: `${repository}:candidate-${sourceSha}-${runId}-${attempt}`, digest, repository, reference: `${repository}@${digest}`, platform: { os: "linux", architecture: "amd64" } };
  const inspection = {
    Manifest: {
      Digest: digest,
      MediaType: "application/vnd.oci.image.manifest.v1+json",
      Config: { digest: `sha256:${"c".repeat(64)}`, mediaType: "application/vnd.oci.image.config.v1+json" },
    },
    Image: image.platform,
  };
  const gate = {
    sha: sourceSha,
    candidateRunId: runId,
    ciRunId: 99,
    runs: ["ci.yml", "cli.yml", "docker.yml", "systemd.yml", "upgrade.yml"].map((workflowPath) => ({
      workflowPath, id: 1, headSha: sourceSha, event: "push", headBranch: "main", conclusion: "success",
    })),
  };
  const drDir = join(root, "disaster-recovery");
  mkdirSync(join(drDir, "reports"), { recursive: true });
  const drReport = JSON.stringify({ result: "PASS", synthetic: true });
  writeFileSync(join(drDir, "reports", "acceptance.json"), drReport);
  const requirementIds = [
    ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
  ];
  const drGate = {
    schemaVersion: 1,
    suite: "search-hub-disaster-recovery-v0.1.15",
    releaseCommit: sourceSha,
    releaseCodeFingerprint: codeFingerprint(resolve(import.meta.dirname, "../.."), sourceSha),
    verdict: "PASS",
    requirements: Object.fromEntries(requirementIds.map((id) => [id, "PASS"])),
    evidence: Object.fromEntries(requirementIds.map((id) => [id, [{ path: "reports/acceptance.json", sha256: hash(drReport) }]])),
  };
  const drGateBytes = JSON.stringify(drGate);
  writeFileSync(join(drDir, "gate.json"), drGateBytes);
  writeFileSync(join(drDir, "SHA256SUMS"), `${hash(drGateBytes)}  gate.json\n${hash(drReport)}  reports/acceptance.json\n`);
  for (const name of expectedReleaseAssets(version)) {
    if (name !== "resource-evidence.json") writeFileSync(join(directory, name), `bytes:${name}`);
  }
  const runtime = {
    schemaVersion: 1,
    suite: "search-hub-resource-v0.1.14",
    releaseCommit: sourceSha,
    releaseCodeFingerprint: codeFingerprint(resolve(import.meta.dirname, "../.."), sourceSha),
    summarySha256: "d".repeat(64),
    sumsSha256: "e".repeat(64),
    rawFileCount: 8,
  };
  const runtimePath = join(root, "resource-evidence-v0115.json");
  writeFileSync(runtimePath, JSON.stringify(runtime));
  combineReleaseEvidence({ resourcePath: runtimePath, disasterRecoveryDir: drDir, output: join(directory, "resource-evidence.json"), commit: sourceSha });
  writeFileSync(join(directory, "SHA256SUMS"), `${expectedReleaseAssets(version).map((name) => `${hash(readFileSync(join(directory, name)))}  ${name}`).sort().join("\n")}\n`);
  const gatePath = join(root, "candidate-gate.json");
  writeFileSync(gatePath, JSON.stringify(gate));
  const imagePath = join(root, "image.json");
  const inspectionPath = join(root, "image-inspection.json");
  writeFileSync(imagePath, JSON.stringify(image));
  writeFileSync(inspectionPath, JSON.stringify(inspection));
  const manifestPath = join(root, "candidate-manifest.json");
  const manifest = createCandidateManifest({
    directory, output: manifestPath, version, sourceSha, runId, attempt, ciRunId: 99,
    image, imageInspection: inspection, candidateGate: gatePath,
    repo: "example/search-hub", disasterRecoveryDir: drDir,
  });
  for (const asset of manifest.assets) writeFileSync(join(attestations, asset.attestation.bundle), "signed bundle\n");
  writeFileSync(join(attestations, `sha256-${hash(readFileSync(manifestPath))}.jsonl`), "signed manifest\n");
  writeFileSync(join(attestations, manifest.image.attestation.bundle), "signed image\n");
  return { root, directory, attestations, manifestPath, manifest, image, inspection };
}

function expected(manifest: ReturnType<typeof createCandidateManifest>) {
  return { version, sourceSha, runId, attempt, manifest };
}

describe("release candidate evidence", () => {
  it("preserves the seven package names and resource evidence plus SHA256SUMS", () => {
    const { directory, manifest, manifestPath, attestations } = fixture();
    expect(expectedReleaseAssets(version)).toHaveLength(8);
    expect(verifyReleaseAssets(directory, expected(manifest))).toMatchObject({ ok: true, assets: expect.arrayContaining(["SHA256SUMS", "shub-v0.1.15-node22.tar.gz"]) });
    expect(verifyCandidateManifest(manifest, { version, sourceSha, runId, attempt })).toMatchObject({ ok: true });
    expect(verifyCandidateAttestationFiles(manifest, attestations, hash(readFileSync(manifestPath)))).toEqual({ ok: true, count: 11 });
  });

  it("requires the manifest attestation bundle to match the exact manifest bytes", () => {
    const { manifest, attestations } = fixture();
    expect(() => verifyCandidateAttestationFiles(manifest, attestations, "0".repeat(64))).toThrow(/manifest_attestation_bundle_missing/);
  });

  it("rejects an attestation reference that does not match the asset digest", () => {
    const { manifest, attestations } = fixture();
    manifest.assets[0]!.attestation.bundle = "sha256-wrong.jsonl";
    expect(() => verifyCandidateAttestationFiles(manifest, attestations)).toThrow(/attestation_reference_mismatch/);
  });

  it("rejects a missing candidate package instead of weakening the asset set", () => {
    const { directory, manifest } = fixture();
    unlinkSync(join(directory, "search-hub-v0.1.15-linux-arm64.tar.gz"));
    expect(() => verifyReleaseAssets(directory, expected(manifest))).toThrow(/release_asset_set_mismatch/);
  });

  it("rejects a candidate built from a different exact SHA", () => {
    const { directory, manifest } = fixture();
    expect(() => verifyReleaseAssets(directory, { ...expected(manifest), sourceSha: "d".repeat(40) })).toThrow(/candidate_source_sha_mismatch/);
    expect(() => verifyCandidateManifest(manifest, { version, sourceSha: "d".repeat(40), runId, attempt })).toThrow(/candidate_source_sha_mismatch/);
  });

  it("keeps the historical cache suite but rejects a legacy combined release envelope", () => {
    const { directory, manifest } = fixture();
    expect(verifyReleaseAssets(directory, expected(manifest))).toMatchObject({ ok: true });
    const file = join(directory, "resource-evidence.json");
    const evidence = JSON.parse(readFileSync(file, "utf8"));
    evidence.suite = "search-hub-resource-v0.1.14";
    writeFileSync(file, JSON.stringify(evidence));
    expect(() => verifyReleaseAssets(directory, expected(manifest))).toThrow(/release_evidence_suite_mismatch/);
    expect(() => verifyCandidateManifest({ ...manifest, ciEvidenceArtifact: "resource-evidence-v0114" }, { version, sourceSha, runId, attempt })).toThrow(/candidate_ci_evidence_artifact_mismatch/);
  });

  it("rejects changed bytes, a changed sums file and duplicate sums entries", () => {
    const { directory, manifest } = fixture();
    writeFileSync(join(directory, "search-hub-v0.1.15-linux-x64.tar.gz"), "tampered");
    expect(() => verifyReleaseAssets(directory, expected(manifest))).toThrow(/asset_sha256_mismatch/);
    writeFileSync(join(directory, "SHA256SUMS"), `${readFileSync(join(directory, "SHA256SUMS"), "utf8")}${"e".repeat(64)}  ../SHA256SUMS\n`);
    expect(() => parseSha256Sums(readFileSync(join(directory, "SHA256SUMS"), "utf8"))).toThrow(/invalid_sha256_line/);
  });

  it("rejects a wrong GHCR digest or non-linux-amd64 platform", () => {
    const { image, inspection, manifest } = fixture();
    expect(() => verifyCandidateManifest({ ...manifest, image: { ...manifest.image, ref: "ghcr.io/example/search-hub:candidate-other" } }, { version, sourceSha, runId, attempt })).toThrow(/candidate_image_ref_binding_mismatch/);
    expect(() => verifyGhcrImage({ ...image, digest: "sha256:abc" })).toThrow(/ghcr_digest_invalid/);
    expect(() => verifyGhcrImage({ ...image, platform: { os: "linux", architecture: "arm64" } })).toThrow(/ghcr_platform_mismatch/);
    expect(() => verifyGhcrInspection({ ...inspection, Manifest: { ...inspection.Manifest, Digest: `sha256:${"f".repeat(64)}` } }, digest)).toThrow(/ghcr_manifest_digest_mismatch/);
    expect(() => verifyGhcrInspection({ ...inspection, Image: { os: "linux", architecture: "arm64" } }, digest)).toThrow(/ghcr_image_platform_mismatch/);
    expect(() => verifyGhcrInspection({ ...inspection, Manifest: { ...inspection.Manifest, MediaType: "application/vnd.oci.image.index.v1+json" } }, digest)).toThrow(/ghcr_media_type_mismatch/);
    expect(() => verifyGhcrInspection({ ...inspection, Manifest: { ...inspection.Manifest, Config: { ...inspection.Manifest.Config, digest: "sha256:abc" } } }, digest)).toThrow(/ghcr_config_digest_invalid/);
    expect(verifyGhcrInspection(inspection, digest)).toMatchObject({ ok: true, digest, configDigest: inspection.Manifest.Config.digest });
    expect(() => verifyGhcrInspection(inspection, digest, { ...manifest.image, configDigest: `sha256:${"d".repeat(64)}` })).toThrow(/candidate_image_config_digest_mismatch/);
    expect(() => verifyGhcrInspection(inspection, digest, { ...manifest.image, manifestMediaType: "application/vnd.oci.image.index.v1+json" })).toThrow(/candidate_image_manifest_media_type_mismatch/);
  });

  it("accepts lowercase Buildx inspect output without weakening validation", () => {
    const { inspection, manifest } = fixture();
    const lowercase = {
      manifest: {
        digest: inspection.Manifest.Digest,
        mediaType: inspection.Manifest.MediaType,
        descriptor: { mediaType: inspection.Manifest.MediaType },
        config: { ...inspection.Manifest.Config },
      },
      image: { ...inspection.Image },
    };
    expect(verifyGhcrInspection(lowercase, digest)).toMatchObject({ ok: true, digest, configDigest: inspection.Manifest.Config.digest });
    expect(verifyGhcrInspection(lowercase, digest, manifest.image)).toMatchObject({ ok: true, platform: { os: "linux", architecture: "amd64" } });
    expect(() => verifyGhcrInspection({ ...lowercase, manifest: { ...lowercase.manifest, digest: `sha256:${"f".repeat(64)}` } }, digest)).toThrow(/ghcr_manifest_digest_mismatch/);
    expect(() => verifyGhcrInspection({ ...lowercase, manifest: { ...lowercase.manifest, mediaType: "application/vnd.oci.image.index.v1+json", descriptor: { mediaType: "application/vnd.oci.image.index.v1+json" } } }, digest)).toThrow(/ghcr_media_type_mismatch/);
    expect(() => verifyGhcrInspection({ ...lowercase, manifest: { ...lowercase.manifest, config: { ...lowercase.manifest.config, digest: "sha256:abc" } } }, digest)).toThrow(/ghcr_config_digest_invalid/);
    expect(() => verifyGhcrInspection({ ...lowercase, manifest: { ...lowercase.manifest, config: { ...lowercase.manifest.config, mediaType: "application/json" } } }, digest)).toThrow(/ghcr_config_media_type_mismatch/);
    expect(() => verifyGhcrInspection({ ...lowercase, image: { os: "linux", architecture: "arm64" } }, digest)).toThrow(/ghcr_image_platform_mismatch/);
  });

  it("normalizes real formatted inspect output with the raw OCI manifest", () => {
    const value = rawInspectionFixture();
    const { manifest } = fixture();
    const normalized = normalizeGhcrInspection(value.formatted, value.rawBytes, value.rawDigest);
    expect(normalized).toEqual({
      Manifest: { Digest: value.rawDigest, MediaType: value.mediaType, Config: value.config },
      Image: { os: "linux", architecture: "amd64" },
      RawManifest: { sha256: value.rawDigest, bytes: value.rawBytes.length },
    });
    expect(verifyGhcrInspection(normalized, value.rawDigest, { ...manifest.image, manifestMediaType: value.mediaType, configDigest: value.config.digest, configMediaType: value.config.mediaType })).toMatchObject({ ok: true, digest: value.rawDigest, configDigest: value.config.digest });
  });

  it("rejects raw manifest hash, mediaType, config and platform mismatches", () => {
    const value = rawInspectionFixture();
    expect(() => normalizeGhcrInspection(value.formatted, Buffer.concat([value.rawBytes, Buffer.from("\n")]), value.rawDigest)).toThrow(/ghcr_raw_manifest_digest_mismatch/);
    expect(() => normalizeGhcrInspection({ ...value.formatted, manifest: { ...value.formatted.manifest, digest: `sha256:${"f".repeat(64)}` } }, value.rawBytes, value.rawDigest)).toThrow(/ghcr_manifest_digest_mismatch/);
    expect(() => normalizeGhcrInspection({ ...value.formatted, image: { os: "linux", architecture: "arm64" } }, value.rawBytes, value.rawDigest)).toThrow(/ghcr_image_platform_mismatch/);

    const wrongMedia = { ...value.raw, mediaType: "application/vnd.docker.distribution.manifest.v2+json" };
    const wrongMediaBytes = Buffer.from(JSON.stringify(wrongMedia));
    const wrongMediaDigest = `sha256:${hash(wrongMediaBytes)}`;
    expect(() => normalizeGhcrInspection({ ...value.formatted, manifest: { ...value.formatted.manifest, digest: wrongMediaDigest } }, wrongMediaBytes, wrongMediaDigest)).toThrow(/ghcr_raw_manifest_media_type_mismatch/);

    for (const [config, error] of [
      [undefined, /ghcr_config_digest_invalid/],
      [{ ...value.config, digest: "sha256:abc" }, /ghcr_config_digest_invalid/],
      [{ ...value.config, mediaType: "application/json" }, /ghcr_config_media_type_mismatch/],
    ] as const) {
      const raw = { ...value.raw, config };
      const bytes = Buffer.from(JSON.stringify(raw));
      const rawDigest = `sha256:${hash(bytes)}`;
      expect(() => normalizeGhcrInspection({ ...value.formatted, manifest: { ...value.formatted.manifest, digest: rawDigest } }, bytes, rawDigest)).toThrow(error);
    }
  });

  it("normalizes inspection through the CLI without trimming raw bytes", () => {
    const value = rawInspectionFixture();
    const root = mkdtempSync(join(tmpdir(), "search-hub-normalize-inspection-"));
    temporary.push(root);
    const formattedPath = join(root, "formatted.json");
    const rawPath = join(root, "manifest.json");
    const outputPath = join(root, "normalized.json");
    writeFileSync(formattedPath, JSON.stringify(value.formatted));
    writeFileSync(rawPath, value.rawBytes);
    execFileSync(process.execPath, [resolve(import.meta.dirname, "../../packaging/release-evidence.mjs"), "normalize-inspection", "--formatted", formattedPath, "--raw", rawPath, "--digest", value.rawDigest, "--output", outputPath], { encoding: "utf8" });
    expect(JSON.parse(readFileSync(outputPath, "utf8")).RawManifest).toEqual({ sha256: value.rawDigest, bytes: value.rawBytes.length });
  });

  it("requires the five successful main-push gates in the candidate manifest", () => {
    const { directory, manifest } = fixture();
    const gate = manifest.requiredWorkflowRuns[0];
    if (!gate) throw new Error("fixture is missing a required workflow gate");
    gate.event = "workflow_dispatch";
    expect(() => verifyReleaseAssets(directory, expected(manifest))).toThrow(/candidate_gate_not_main_push/);
    gate.event = "push";
    gate.conclusion = "failure";
    expect(() => verifyReleaseAssets(directory, expected(manifest))).toThrow(/candidate_gate_not_green/);
    expect(() => verifyCandidateManifest(manifest, { version, sourceSha, runId, attempt })).toThrow(/candidate_gate_not_green/);
  });

  it("rejects duplicate or substituted main-push workflow gates", () => {
    const { manifest } = fixture();
    manifest.requiredWorkflowRuns[1]!.workflowPath = manifest.requiredWorkflowRuns[0]!.workflowPath;
    expect(() => verifyCandidateManifest(manifest, { version, sourceSha, runId, attempt })).toThrow(/candidate_main_gate_set_mismatch/);
  });

  it("keeps the tag promoter build-free and both workflows free of pull_request_target", () => {
    const promoter = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    const candidate = readFileSync(new URL("../../.github/workflows/release-candidate.yml", import.meta.url), "utf8");
    expect(promoter).not.toContain("pull_request_target");
    expect(candidate).not.toContain("pull_request_target");
    expect(promoter).not.toContain("build-package.mjs");
    expect(promoter).not.toContain("build-cli-package.mjs");
    expect(promoter).not.toContain("docker/build-push-action");
    expect(promoter).not.toContain("attest-build-provenance");
    expect(promoter).toContain('tags: ["v0.1.15"]');
    expect(promoter).not.toContain("workflow_dispatch:");
    expect(candidate).toContain("workflow_dispatch:");
    expect(candidate).toContain('test "$SOURCE_SHA" = "$EVENT_SHA"');
    expect(candidate).toContain('test "$REF_TYPE" = "branch"');
    expect(candidate).toContain("--phase candidate");
    expect(candidate).toContain("--max-attempts 210 --poll-seconds 60");
    expect(candidate).not.toMatch(/^\s+push:/m);
    expect(candidate).not.toMatch(/^\s+pull_request:/m);
    expect(candidate.match(/actions\/attest-build-provenance@v3\.0\.0/g)).toHaveLength(2);
    expect(candidate).toContain("candidate-${SOURCE_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}");
    expect(candidate).not.toContain(":rc-${SOURCE_SHA}");
    expect(candidate).toMatch(/--(?:dr-dir|disaster-recovery-dir) final-dr/);
    expect(candidate).toContain("manifestMediaType:m.MediaType??m.mediaType??m.Descriptor?.mediaType??m.descriptor?.mediaType");
    expect(candidate).not.toContain("subjects: ${{ needs.container.outputs.reference }}");
    expect(candidate).toContain("subject-name: ${{ needs.container.outputs.repository }}");
    expect(candidate).toContain("subject-digest: ${{ needs.container.outputs.digest }}");
    expect(candidate).toContain("push-to-registry: true");
    const evidenceCli = readFileSync(new URL("../../packaging/release-evidence.mjs", import.meta.url), "utf8");
    expect(evidenceCli).toContain('arg("dr-dir", arg("disaster-recovery-dir"))');
    expect(evidenceCli).toContain('RESOURCE_RUNTIME_ARTIFACT = "resource-evidence-v0115.json"');
    const attestations = readFileSync(new URL("../../packaging/candidate-attestations.mjs", import.meta.url), "utf8");
    expect(attestations).toContain("oci://${manifest.image.reference}");
    expect(candidate).toContain("name: dr-core-v0.1.15");
    expect(candidate).toContain("name: dr-cli-windows-x64-v0.1.15");
    expect(candidate).toContain("name: dr-cli-linux-${{ matrix.arch }}-v0.1.15");
    expect(candidate).toContain("name: dr-cli-node22-v0.1.15");
    expect(candidate).toContain("search-hub-candidate-release");
    expect(candidate).toContain("name: dr-platform-windows-v0.1.15");
    expect(candidate).toContain("name: dr-platform-linux-${{ matrix.arch }}-v0.1.15");
    expect(candidate).toContain("name: dr-platform-docker-v0.1.15");
    expect(candidate).toContain("name: dr-platform-systemd-v0.1.15");
    expect(candidate).toContain("--dr-dir final-dr");
    expect(candidate).toContain("derive-release-statuses.mjs");
    expect(candidate).toContain("--statuses-file \"$release_report/statuses.json\"");
    expect(candidate).toContain("i.Manifest??i.manifest");
    expect(candidate).toContain("i.Image??i.image");
    expect(candidate.match(/imagetools inspect[^\n]*--raw/g)).toHaveLength(1);
    expect(candidate).toContain("normalize-inspection");
    expect(candidate).toContain("image-manifest.json");
    expect(promoter.match(/imagetools inspect[^\n]*--raw/g)).toHaveLength(3);
    expect(promoter.match(/normalize-inspection/g)).toHaveLength(3);
    expect(candidate).not.toContain("--allow-incomplete");
    expect(candidate).not.toContain("--statuses '{\"A08\":\"PASS\",\"A11\":\"PASS\",\"A12\":\"PASS\",\"R35\":\"PASS\"}'");
  });
});
