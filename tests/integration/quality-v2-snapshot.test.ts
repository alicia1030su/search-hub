import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger, SearchResponse } from "@search-hub/shared";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { QualityService } from "../../apps/api/src/services/quality.js";
import type { SearchService } from "../../apps/api/src/services/search.js";
import { qualitySnapshots, qualityRuns } from "../../packages/db/src/schema.js";
import { deserializeSnapshot } from "../../packages/core/src/evaluation/snapshot.js";

const contexts: AppContext[] = [];

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    ctx.closeDb();
    rmSync(ctx.config.dataDir, { recursive: true, force: true });
  }
});

const logger = {
  debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined,
  child: () => logger,
} as unknown as Logger;

function harness(): { ctx: AppContext; service: QualityService; requests: unknown[] } {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-v2-"));
  const config: AppConfig = {
    ...loadConfig(), nodeEnv: "test", dataDir: dir, dbPath: join(dir, "quality.db"),
    staticDir: null, cookieSecure: false, setupToken: null, logLevel: "silent", corsOrigins: [], rateLimitPerMin: 100_000,
  };
  const ctx = createContext(config);
  contexts.push(ctx);
  const requests: unknown[] = [];
  const search = {
    execute: async (request: unknown, options: { beforeRequest?: () => void }) => {
      requests.push(request);
      options.beforeRequest?.();
      return {
        taskId: "task", query: "test", mode: "basic", status: "completed",
        results: [{ id: "https://a.test/1", title: "A", url: "https://a.test/1", snippet: "evidence", provider: "alpha", providerName: "Alpha", rank: 1, score: 1 }],
        stats: {
          rawCount: 1, dedupedCount: 1, fusedCount: 1,
          providers: [{ providerId: "alpha", providerName: "Alpha", providerType: "fixture", ok: true, attempts: 1, httpRequests: 2, latencyMs: 3, resultCount: 1 }],
          timing: { totalMs: 3, fanoutMs: 1, fusionMs: 1 }, rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false,
        },
        errors: [], failedSources: [],
        debug: {
          perProviderResults: [{ providerId: "alpha", providerName: "Alpha", results: [{ id: "https://a.test/1", title: "A", url: "https://a.test/1", snippet: "evidence" }] }],
          providerQueries: [{ providerId: "alpha", query: "test" }],
        },
        deepBudget: { providerQueryCalls: 1, httpRequests: 2, modelCalls: 0, budgetExhausted: false },
      } as unknown as SearchResponse;
    },
  } as unknown as SearchService;
  const service = new QualityService({
    db: ctx.db, settings: ctx.settings, search, logger, engineVersion: "0.1.18", codeCommit: "test",
    providerMaxRequests: () => 1,
    providerSnapshot: () => [{ id: "alpha", type: "fixture", baseUrl: null, weight: 1, timeoutMs: 1000, maxConcurrency: 1, resultsPerPage: 10, rpmLimit: null, maxRetries: 0, searchConfig: {} }],
    modelSnapshot: () => [{ id: "chat1", kind: "chat", providerType: "fixture", baseUrl: "https://model.test", modelId: "frozen-chat" }],
  });
  return { ctx, service, requests };
}

async function waitFor(ctx: AppContext, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = ctx.db.select().from(qualityRuns).all().find((item) => item.id === runId);
    if (row && row.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("run did not finish");
}

describe("quality v2 snapshot production capture", () => {
  it("writes a complete envelope, replays with provenance and compares with B8 evidence", async () => {
    const { ctx, service, requests } = harness();
    const imported = service.importDataset({
      name: "real-shaped", judgmentsComplete: true,
      queries: [{ query: "test", category: "code", language: "zh", judgments: [{ url: "https://a.test/1", relevance: 3 }] }],
    }, "admin");
    service.freeze(imported.dataset.id, {}, "admin");
    const live = service.startRun({
      datasetId: imported.dataset.id, mode: "live", fusion: { strategy: "rrf", k: 60 },
      providerIds: ["alpha"], requestBudget: 10, confirmPaid: true, cachePolicy: "bypass", maxConcurrency: 1,
    }, "admin");
    await waitFor(ctx, live.id);

    const stored = ctx.db.select().from(qualitySnapshots).all()[0]!;
    const envelope = deserializeSnapshot(stored.snapshotJson);
    expect(stored.snapshotJson).toContain('"schemaVersion":2');
    expect(envelope.queryId).toMatch(/^qq_/);
    expect(envelope).toMatchObject({ language: "zh", upstreamRequests: 2, cacheHits: 0 });
    expect(envelope.providerFingerprints.alpha).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.modelArtifacts).toEqual({});
    expect(envelope.deepRounds[0]).toMatchObject({ providerQueryCalls: 1, httpRequests: 2, modelCalls: 0, budgetExhausted: false });
    expect(requests).toHaveLength(1);

    const replay = service.startRun({
      datasetId: imported.dataset.id, mode: "offline", fusion: { strategy: "rrf", k: 60 }, snapshotRunId: live.id,
    }, "admin");
    await waitFor(ctx, replay.id);
    const detail = service.getRunDetail(replay.id);
    expect(detail.perQuery[0]!.snapshotProvenance).toMatchObject({ sourceRunId: live.id, snapshotHash: expect.any(String) });

    const comparison = service.compare({ baselineRunId: live.id, candidateRunId: replay.id, metric: "ndcgAtK" });
    expect(comparison.attrition).toBe(0);
    expect(comparison.pairedN).toBe(1);
    expect(comparison.bootstrap.observed.pairedN).toBe(1);
    expect(comparison.bootstrap.releaseScore.pairedN).toBe(1);
    expect(comparison.bootstrap.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(comparison.strategyComparison).toHaveLength(1);

    // Legacy arrays remain readable and keep the original capture timestamp.
    ctx.db.update(qualitySnapshots).set({ snapshotJson: JSON.stringify(envelope.providers) }).run();
    const legacyReplay = service.startRun({
      datasetId: imported.dataset.id, mode: "offline", fusion: { strategy: "rrf", k: 60 }, snapshotRunId: live.id,
    }, "admin");
    await waitFor(ctx, legacyReplay.id);
    expect(service.getRunDetail(legacyReplay.id).perQuery[0]!.snapshotProvenance).toMatchObject({ sourceRunId: live.id, sourceCapturedAt: null });
  });
});
