export declare function verifyDisasterRecoveryEvidence(options: {
  repoRoot?: string;
  commit: string;
  evidenceDir?: string;
  requireAllPass?: boolean;
}): {
  ok: true;
  releaseCommit: string;
  releaseCodeFingerprint: string;
  verdict: "PASS" | "FAIL" | "BLOCKED";
  requirementCount: number;
  evidenceFileCount: number;
  gateSha256: string;
  sumsSha256: string;
};
