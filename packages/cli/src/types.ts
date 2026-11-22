import type {
  ProviderInstance,
  ProviderRuntimeSnapshot,
  ProviderTestResult,
  SearchResponse,
} from "@search-hub/shared";

export interface HealthResponse {
  status: string;
  version: string;
  uptimeSeconds: number;
  setupRequired: boolean;
  providers: {
    total: number;
    enabled: number;
    healthy: number;
    circuitOpen: number;
  };
  database?: { driver?: string; migrations?: number };
}

export interface ProviderSummary extends ProviderInstance {
  keyCount: number;
  healthyKeyCount: number;
  availableKeyCount?: number;
  ready: boolean;
  notReadyReason: string | null;
  circuitOpen: boolean;
}

export interface ProvidersResponse {
  providers: ProviderSummary[];
  status: ProviderRuntimeSnapshot[];
  catalog: unknown[];
  adapters: string[];
  manifests: unknown[];
}

export interface SingleProbeResult extends ProviderTestResult {
  billingUnit?: "unknown";
  spent?: boolean;
}

export interface SingleProbeResponse {
  result: SingleProbeResult;
  budget: Record<string, unknown>;
}

export interface BatchPreviewCounts {
  eligible: number;
  noKey: number;
  noEnabledKey: number;
  configError: number;
  disabled: number;
  keylessSkipped: number;
  coolingSkipped: number;
}

export interface BatchPreview {
  kind: "connect" | "search";
  total: number;
  counts: BatchPreviewCounts;
  budget: Record<string, unknown> & { remainingRun: number };
  paidRisk: boolean;
  estimatedPaidProbes: number;
  estimatedAnonymousProbes: number;
}

export interface BatchCounts {
  total: number;
  done: number;
  ok: number;
  failed: number;
  pending: number;
  skipped: number;
  remaining: number;
}

export interface BatchItem {
  providerId: string;
  providerName: string;
  providerType: string | null;
  keyCount: number | null;
  state: "ok" | "failed" | "pending" | "skipped" | "unknown";
  code: string;
  latencyMs: number | null;
  resultCount: number | null;
  requests: number | null;
  billingUnit?: "unknown";
  checkId: string | null;
  reason: string | null;
  checkedAt: string | null;
}

export interface BatchJob {
  jobId: string;
  status: "running" | "completed" | "partial" | "cancelled" | "interrupted";
  kind: "connect" | "search";
  counts: BatchCounts;
  items: BatchItem[];
  budget: Record<string, unknown>;
  includeKeyless: boolean;
  concurrency: number;
  startedAt: string | null;
  finishedAt: string | null;
  nextPollAfterMs: number | null;
}

export interface SearchCommandResponse extends SearchResponse {
  streaming?: false;
}
