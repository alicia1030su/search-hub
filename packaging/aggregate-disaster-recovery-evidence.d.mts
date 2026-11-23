export interface DisasterRecoveryGate {
  schemaVersion: number;
  suite: string;
  releaseCommit: string;
  releaseCodeFingerprint: string;
  source: { commit: string; dirty: boolean };
  verdict: "PASS" | "FAIL" | "BLOCKED";
  acceptanceComplete: boolean;
  requirements: Record<string, "PASS" | "FAIL" | "BLOCKED" | "NOT TESTED" | "NOT IMPLEMENTED">;
  evidence: Record<string, Array<{ path: string; sha256: string; status: string }>>;
  reports: Array<{ path: string; sha256: string; kind: string }>;
}

export declare function aggregateDisasterRecoveryEvidence(options: {
  repoRoot?: string;
  commit: string;
  evidenceDir: string;
}): { gate: DisasterRecoveryGate; gatePath: string; sumsPath: string; reportCount: number };
