export interface AttestationReference {
  bundle: string;
  signerWorkflow: string;
  sourceSha: string;
  predicateType: string;
}

export interface ReleaseAsset {
  name: string;
  bytes: number;
  sha256: string;
  attestation: AttestationReference;
}

export interface CandidateImageBase {
  ref: string;
  digest: string;
  repository: string;
  reference: string;
  platform: { os: string; architecture: string };
}

export interface CandidateImage extends CandidateImageBase {
  manifestMediaType: string;
  configDigest: string;
  configMediaType: string;
  attestation: AttestationReference;
}

export interface CandidateWorkflowRun {
  workflowPath: string;
  id: number;
  headSha: string;
  event: string;
  headBranch: string | null;
  conclusion: string;
}

export interface CandidateManifest {
  schemaVersion: number;
  version: string;
  sourceSha: string;
  runId: number;
  attempt: number;
  ciRunId: number;
  workflowPath: string;
  event: string;
  packageArtifacts: string[];
  evidenceArtifact: string;
  ciEvidenceArtifact: string;
  attestationPolicy: {
    repository: string;
    signerWorkflow: string;
    sourceSha: string;
    predicateType: string;
    manifestBundlePattern: string;
  };
  requiredWorkflowRuns: CandidateWorkflowRun[];
  resourceEvidence: {
    releaseCommit: string;
    suite: string;
    runtimeArtifact: string;
    sha256: string;
    summarySha256: string;
    sumsSha256: string;
    rawFileCount: number;
  };
  disasterRecovery: {
    artifact: string;
    gate: string;
    gateSha256: string;
    sumsSha256: string;
    requirementCount: number;
    evidenceFileCount: number;
    verdict: string;
  };
  image: CandidateImage;
  sha256sumsSha256: string;
  assets: ReleaseAsset[];
}

export interface NormalizedGhcrInspection {
  Manifest: {
    Digest: string;
    MediaType: string;
    Config: { digest: string; mediaType: string };
  };
  Image: { os: string; architecture: string };
  RawManifest: { sha256: string; bytes: number };
}

export type GhcrInspection = {
  Manifest: {
    Digest: string;
    MediaType?: string;
    Descriptor?: { mediaType?: string };
    Config: { digest: string; mediaType: string };
  };
  Image: { os: string; architecture: string };
  RawManifest?: { sha256: string; bytes: number };
} | {
  manifest: {
    digest: string;
    mediaType?: string;
    descriptor?: { mediaType?: string };
    config: { digest: string; mediaType: string };
  };
  image: { os: string; architecture: string };
};

export declare function expectedReleaseAssets(version: string): string[];
export declare function sha256File(file: string): string;
export declare function parseSha256Sums(text: string): Map<string, string>;
export declare function verifyReleaseAssets(directory: string, options: { version: string; sourceSha: string; manifest: CandidateManifest }): { ok: true; assets: string[]; sha256sumsSha256: string };
export declare function verifyCandidateManifest(manifest: CandidateManifest, options: { version: string; sourceSha: string; runId: number; attempt: number }): { ok: true; image: CandidateImage };
export declare function verifyGhcrImage(image: CandidateImageBase): { ok: true; digest: string; platform: { os: string; architecture: string } };
export declare function normalizeGhcrInspection(formatted: unknown, rawManifestBytes: Buffer, expectedDigest: string): NormalizedGhcrInspection;
export declare function verifyGhcrInspection(inspection: GhcrInspection, expectedDigest: string, image?: CandidateImage | null): { ok: true; digest: string; mediaType: string; configDigest: string; configMediaType: string; platform: { os: string; architecture: string } };
export declare function verifyCandidateAttestationFiles(manifest: CandidateManifest, attestationDirectory: string, manifestDigest?: string | null): { ok: true; count: number };
export declare function combineReleaseEvidence(options: { resourcePath: string; disasterRecoveryDir: string; output: string; repoRoot?: string; commit: string }): unknown;
export declare function verifyCombinedReleaseEvidence(options: { combinedPath: string; disasterRecoveryDir: string; repoRoot?: string; commit: string }): { ok: true; releaseCommit: string; releaseCodeFingerprint: string; requirementCount: number };
export declare function createCandidateManifest(options: {
  directory: string;
  output: string;
  version: string;
  sourceSha: string;
  runId: number;
  attempt: number;
  ciRunId: number;
  image: CandidateImageBase;
  imageInspection: GhcrInspection;
  candidateGate: string;
  repo: string;
  disasterRecoveryDir: string;
}): CandidateManifest;
