import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { SearchHubError, type Logger } from "@search-hub/shared";
import {
  aggregateMetric,
  compareRankings,
  coreFixture,
  costSummary,
  evaluateQuery,
  judgmentsForQuery,
  latencyStats,
  rankSnapshot,
  rateMetric,
  shallowFixture,
  splitQueries,
  type AggregateMetric,
  type ComparisonSummary,
  type CostSummary,
  type DatasetOrigin,
  type FusionParameters,
  type JudgedQuery,
  type JudgmentSource,
  type LatencyStats,
  type MetricValue,
  type ProviderSnapshot,
  type QualityDataset,
  type QualityJudgment,
  type QualityQuery,
  type QueryCategory,
  type QueryMetrics,
  type QuerySnapshot,
  type RelevanceGrade,
} from "@search-hub/core";
import type { SearchHubDb } from "@search-hub/db";
import {
  qualityDatasets,
  qualityJudgments,
  qualityQueries,
  qualityRunResults,
  qualityRuns,
  qualitySnapshots,
} from "@search-hub/db";
import type { SearchService } from "./search.js";
import type { SettingsService } from "./settings.js";

/** Bounds that keep one import or one run from exhausting the process. */
export const QUALITY_LIMITS = {
  maxQueriesPerDataset: 500,
  maxJudgmentsPerDataset: 20_000,
  maxQueriesPerRun: 200,
  maxProvidersPerRun: 20,
  maxRequestBudget: 2_000,
  maxResultsPerQuery: 50,
  minCutoff: 1,
  maxCutoff: 50,
} as const;

interface DatasetRowLike {
  id: string;
  name: string;
  description: string;
  language: string;
  version: number;
  status: string;
  origin: string;
  judgmentsComplete: boolean;
  createdAt: string;
  updatedAt: string;
  frozenAt: string | null;
}

function toDataset(row: DatasetRowLike): QualityDataset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    language: row.language,
    version: row.version,
    status: row.status as QualityDataset["status"],
    origin: row.origin as DatasetOrigin,
    judgmentsComplete: row.judgmentsComplete,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    frozenAt: row.frozenAt,
  };
}

export interface QualityServiceDeps {
  db: SearchHubDb;
  settings: SettingsService;
  search: SearchService;
  logger: Logger;
  /** Installed version, recorded on every run so a score is attributable. */
  engineVersion: string;
  /** Commit the run was produced from, when the build knows it. */
  codeCommit?: string | null;
  now?: () => number;
}

export interface DatasetInput {
  name: string;
  description?: string;
  language?: string;
  origin?: DatasetOrigin;
  judgmentsComplete?: boolean;
}

export interface QueryInput {
  query: string;
  category?: QueryCategory;
  language?: string;
  intent?: string;
  notes?: string;
}

export interface JudgmentInput {
  queryId: string;
  documentId?: string;
  url?: string;
  relevance: RelevanceGrade;
  source?: JudgmentSource;
  notes?: string;
}

export interface RunInput {
  datasetId: string;
  name?: string;
  notes?: string;
  mode: "offline" | "live";
  fusion: FusionParameters;
  limit?: number;
  cutoff?: number;
  unjudgedPolicy?: "exclude" | "as_zero";
  queryIds?: string[];
  /** Re-rank the snapshots captured by a previous run instead of new ones. */
  snapshotRunId?: string;
  /** Live only: which providers may be called. */
  providerIds?: string[];
  /** Live only: hard ceiling on upstream requests. */
  requestBudget?: number;
  /** Live only: explicit acknowledgement that this spends vendor quota. */
  confirmPaid?: boolean;
  /** Optional per-provider price, used only to report cost; never to decide. */
  unitCosts?: Record<string, number>;
  /** Held-out query ids, excluded from parameter selection. */
  holdoutQueryIds?: string[];
}

export interface RunSummary {
  id: string;
  datasetId: string;
  datasetVersion: number;
  datasetOrigin: DatasetOrigin;
  name: string;
  mode: "offline" | "live";
  fusion: FusionParameters;
  status: string;
  limit: number;
  queryCount: number;
  requestsUsed: number;
  requestBudget: number;
  codeCommit: string | null;
  engineVersion: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

function toRunSummary(row: typeof qualityRuns.$inferSelect): RunSummary {
  let fusion: FusionParameters = { strategy: "rrf" };
  try {
    fusion = JSON.parse(row.fusionJson) as FusionParameters;
  } catch {
    /* a corrupt row must not break the list */
  }
  let error: string | null = null;
  if (row.errorJson) {
    try {
      const parsed = JSON.parse(row.errorJson) as { message?: string };
      error = parsed.message ?? null;
    } catch {
      error = null;
    }
  }
  return {
    id: row.id,
    datasetId: row.datasetId,
    datasetVersion: row.datasetVersion,
    datasetOrigin: row.datasetOrigin as DatasetOrigin,
    name: row.name,
    mode: row.mode as "offline" | "live",
    fusion,
    status: row.status,
    limit: row.limitValue,
    queryCount: row.queryCount,
    requestsUsed: row.requestsUsed,
    requestBudget: row.requestBudget,
    codeCommit: row.codeCommit,
    engineVersion: row.engineVersion,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error,
  };
}

/**
 * Search quality evaluation service.
 *
 * The two modes are separated by what they are allowed to touch:
 *
 *  - `offline` reads stored snapshots (or the built-in fixture) and never opens
 *    a socket. It is what CI and parameter experiments use.
 *  - `live` calls real providers through the same `SearchService` the public
 *    API uses — same key pool, same scheduler, same SSRF guard, same health
 *    gate — with an explicit provider list and a hard request budget. It writes
 *    no `search_tasks` row and bypasses the response cache, so an experiment
 *    can neither be served a stale result nor inflate the user-traffic metrics.
 */
export class QualityService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly deps: QualityServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------- datasets

  listDatasets(): Array<QualityDataset & { queryCount: number; judgmentCount: number }> {
    const rows = this.deps.db.select().from(qualityDatasets).orderBy(desc(qualityDatasets.updatedAt)).all();
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const queries = this.deps.db
      .select({ datasetId: qualityQueries.datasetId, count: sql<number>`count(*)` })
      .from(qualityQueries)
      .where(inArray(qualityQueries.datasetId, ids))
      .groupBy(qualityQueries.datasetId)
      .all();
    const judgments = this.deps.db
      .select({ datasetId: qualityJudgments.datasetId, count: sql<number>`count(*)` })
      .from(qualityJudgments)
      .where(inArray(qualityJudgments.datasetId, ids))
      .groupBy(qualityJudgments.datasetId)
      .all();
    const queryCounts = new Map(queries.map((row) => [row.datasetId, Number(row.count)]));
    const judgmentCounts = new Map(judgments.map((row) => [row.datasetId, Number(row.count)]));
    return rows.map((row) => ({
      ...toDataset(row),
      queryCount: queryCounts.get(row.id) ?? 0,
      judgmentCount: judgmentCounts.get(row.id) ?? 0,
    }));
  }

  getDataset(id: string): {
    dataset: QualityDataset;
    queries: QualityQuery[];
    judgments: QualityJudgment[];
    coverage: { judgedDocuments: number; judgedQueries: number; queryCount: number; unjudgedQueries: number };
  } {
    const row = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, id)).get();
    if (!row) throw new SearchHubError("not_found", "Dataset not found");
    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, id))
      .all()
      .map((item) => ({
        id: item.id,
        datasetId: item.datasetId,
        query: item.query,
        category: item.category as QueryCategory,
        language: item.language,
        intent: item.intent,
        notes: item.notes,
        createdAt: item.createdAt,
      }));
    const judgments = this.deps.db
      .select()
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, id))
      .all()
      .map((item) => ({
        id: item.id,
        datasetId: item.datasetId,
        queryId: item.queryId,
        documentId: item.documentId,
        relevance: item.relevance as RelevanceGrade,
        assessor: item.assessor,
        source: item.source as JudgmentSource,
        notes: item.notes,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));

    const judgedPerQuery = new Map<string, number>();
    for (const judgment of judgments) {
      judgedPerQuery.set(judgment.queryId, (judgedPerQuery.get(judgment.queryId) ?? 0) + 1);
    }
    return {
      dataset: toDataset(row),
      queries,
      judgments,
      coverage: {
        judgedDocuments: judgments.length,
        judgedQueries: judgedPerQuery.size,
        queryCount: queries.length,
        unjudgedQueries: queries.filter((item) => !judgedPerQuery.has(item.id)).length,
      },
    };
  }

  createDataset(input: DatasetInput, actor: string): QualityDataset {
    const now = new Date(this.now()).toISOString();
    const id = `qd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.deps.db
      .insert(qualityDatasets)
      .values({
        id,
        name: input.name,
        description: input.description ?? "",
        language: input.language ?? "zh",
        version: 1,
        status: "draft",
        origin: input.origin ?? "manual",
        judgmentsComplete: input.judgmentsComplete ?? false,
        createdAt: now,
        updatedAt: now,
        frozenAt: null,
      })
      .run();
    this.audit(actor, "quality.dataset.create", id, input.name);
    return toDataset({ ...input, id, version: 1, status: "draft", createdAt: now, updatedAt: now, frozenAt: null, description: input.description ?? "", language: input.language ?? "zh", origin: input.origin ?? "manual", judgmentsComplete: input.judgmentsComplete ?? false });
  }

  assertEditable(datasetId: string): DatasetRowLike {
    const row = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, datasetId)).get();
    if (!row) throw new SearchHubError("not_found", "Dataset not found");
    if (row.status === "frozen") {
      throw new SearchHubError(
        "conflict",
        "This dataset version is frozen. Create a new version to change its queries or judgments.",
      );
    }
    return row;
  }

  addQueries(datasetId: string, inputs: QueryInput[], actor: string): { added: number; ids: string[] } {
    const dataset = this.assertEditable(datasetId);
    const existing = this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, datasetId))
      .get();
    const already = Number(existing?.count ?? 0);
    if (already + inputs.length > QUALITY_LIMITS.maxQueriesPerDataset) {
      throw new SearchHubError(
        "validation_error",
        `A dataset may hold at most ${QUALITY_LIMITS.maxQueriesPerDataset} queries`,
      );
    }
    const now = new Date(this.now()).toISOString();
    const ids: string[] = [];
    const normalized = inputs.map((input) => input.query.trim());
    const duplicates = new Set<string>();
    for (const text of normalized) {
      if (!text) throw new SearchHubError("validation_error", "A query cannot be empty");
      const key = text.toLowerCase();
      if (duplicates.has(key)) {
        throw new SearchHubError("validation_error", `Duplicate query in this import: "${text}"`);
      }
      duplicates.add(key);
    }
    this.deps.db.transaction((tx) => {
      for (const [index, input] of inputs.entries()) {
        const id = `qq_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        ids.push(id);
        tx.insert(qualityQueries)
          .values({
            id,
            datasetId,
            query: normalized[index]!,
            category: input.category ?? "general",
            language: input.language ?? dataset.language,
            intent: input.intent ?? "",
            notes: input.notes ?? "",
            createdAt: now,
          })
          .run();
      }
      tx.update(qualityDatasets)
        .set({ updatedAt: now, version: dataset.version + 1 })
        .where(eq(qualityDatasets.id, datasetId))
        .run();
    });
    this.audit(actor, "quality.dataset.add_queries", datasetId, `${inputs.length} queries`);
    return { added: ids.length, ids };
  }

  upsertJudgments(datasetId: string, inputs: JudgmentInput[], actor: string, assessor: string): { written: number } {
    this.assertEditable(datasetId);
    const queryIds = new Set(
      this.deps.db
        .select({ id: qualityQueries.id })
        .from(qualityQueries)
        .where(eq(qualityQueries.datasetId, datasetId))
        .all()
        .map((row) => row.id),
    );
    for (const input of inputs) {
      if (!queryIds.has(input.queryId)) {
        throw new SearchHubError("validation_error", `Query ${input.queryId} does not belong to this dataset`);
      }
      if (input.relevance < 0 || input.relevance > 3) {
        throw new SearchHubError("validation_error", "Relevance must be 0, 1, 2 or 3");
      }
      if (!input.documentId && !input.url) {
        throw new SearchHubError("validation_error", "Each judgment needs url or documentId");
      }
    }
    const count = this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, datasetId))
      .get();
    if (Number(count?.count ?? 0) + inputs.length > QUALITY_LIMITS.maxJudgmentsPerDataset) {
      throw new SearchHubError(
        "validation_error",
        `A dataset may hold at most ${QUALITY_LIMITS.maxJudgmentsPerDataset} judgments`,
      );
    }

    const now = new Date(this.now()).toISOString();
    let written = 0;
    this.deps.db.transaction((tx) => {
      for (const input of inputs) {
        const documentId = input.documentId ?? input.url!;
        // Same document re-assessed: replace, never duplicate.
        const existing = tx
          .select()
          .from(qualityJudgments)
          .where(and(eq(qualityJudgments.queryId, input.queryId), eq(qualityJudgments.documentId, documentId)))
          .get();
        if (existing) {
          tx.update(qualityJudgments)
            .set({
              relevance: input.relevance,
              source: input.source ?? existing.source,
              notes: input.notes ?? existing.notes,
              assessor,
              updatedAt: now,
            })
            .where(eq(qualityJudgments.id, existing.id))
            .run();
        } else {
          tx.insert(qualityJudgments)
            .values({
              id: `qj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
              datasetId,
              queryId: input.queryId,
              documentId,
              relevance: input.relevance,
              assessor,
              source: input.source ?? "human",
              notes: input.notes ?? "",
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
        written += 1;
      }
    });
    this.audit(actor, "quality.dataset.judge", datasetId, `${written} judgments`);
    return { written };
  }

  freeze(datasetId: string, input: { judgmentsComplete?: boolean }, actor: string): QualityDataset {
    const row = this.assertEditable(datasetId);
    const queryCount = Number(
      this.deps.db
        .select({ count: sql<number>`count(*)` })
        .from(qualityQueries)
        .where(eq(qualityQueries.datasetId, datasetId))
        .get()?.count ?? 0,
    );
    if (queryCount === 0) {
      throw new SearchHubError("validation_error", "A dataset with no queries cannot be frozen");
    }
    const now = new Date(this.now()).toISOString();
    this.deps.db
      .update(qualityDatasets)
      .set({
        status: "frozen",
        frozenAt: now,
        updatedAt: now,
        ...(input.judgmentsComplete === undefined ? {} : { judgmentsComplete: input.judgmentsComplete }),
      })
      .where(eq(qualityDatasets.id, datasetId))
      .run();
    this.audit(actor, "quality.dataset.freeze", datasetId, `v${row.version}`);
    return toDataset({ ...row, status: "frozen", frozenAt: now, updatedAt: now, judgmentsComplete: input.judgmentsComplete ?? row.judgmentsComplete });
  }

  /** Copies a frozen dataset into a new draft version. History stays readable. */
  forkDataset(datasetId: string, actor: string): QualityDataset {
    const source = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, datasetId)).get();
    if (!source) throw new SearchHubError("not_found", "Dataset not found");
    const queries = this.deps.db.select().from(qualityQueries).where(eq(qualityQueries.datasetId, datasetId)).all();
    const judgments = this.deps.db.select().from(qualityJudgments).where(eq(qualityJudgments.datasetId, datasetId)).all();
    const now = new Date(this.now()).toISOString();
    const id = `qd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const queryIdMap = new Map<string, string>();
    this.deps.db.transaction((tx) => {
      tx.insert(qualityDatasets)
        .values({
          id,
          name: `${source.name} (v${source.version + 1})`,
          description: source.description,
          language: source.language,
          version: source.version + 1,
          status: "draft",
          origin: source.origin,
          judgmentsComplete: source.judgmentsComplete,
          createdAt: now,
          updatedAt: now,
          frozenAt: null,
        })
        .run();
      for (const query of queries) {
        const newId = `qq_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        queryIdMap.set(query.id, newId);
        tx.insert(qualityQueries)
          .values({
            id: newId,
            datasetId: id,
            query: query.query,
            category: query.category,
            language: query.language,
            intent: query.intent,
            notes: query.notes,
            createdAt: now,
          })
          .run();
      }
      for (const judgment of judgments) {
        const newQueryId = queryIdMap.get(judgment.queryId);
        if (!newQueryId) continue;
        tx.insert(qualityJudgments)
          .values({
            id: `qj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
            datasetId: id,
            queryId: newQueryId,
            documentId: judgment.documentId,
            relevance: judgment.relevance,
            assessor: judgment.assessor,
            source: judgment.source,
            notes: judgment.notes,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    });
    this.audit(actor, "quality.dataset.fork", id, `from ${datasetId}`);
    return toDataset({ ...source, id, version: source.version + 1, status: "draft", createdAt: now, updatedAt: now, frozenAt: null, name: `${source.name} (v${source.version + 1})` });
  }

  // -------------------------------------------------------------------- runs

  listRuns(options: { datasetId?: string; limit?: number } = {}): RunSummary[] {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const rows = options.datasetId
      ? this.deps.db
          .select()
          .from(qualityRuns)
          .where(eq(qualityRuns.datasetId, options.datasetId))
          .orderBy(desc(qualityRuns.startedAt))
          .limit(limit)
          .all()
      : this.deps.db.select().from(qualityRuns).orderBy(desc(qualityRuns.startedAt)).limit(limit).all();
    return rows.map(toRunSummary);
  }

  getRunDetail(runId: string): {
    run: RunSummary;
    metrics: Record<string, MetricValue>;
    latency: LatencyStats;
    cost: CostSummary;
    quality: Record<string, MetricValue>;
    perQuery: Array<{
      queryId: string;
      query: string;
      status: string;
      ranked: Array<{ documentId: string; title: string; url: string }>;
      metrics: QueryMetrics;
      latencyMs: number | null;
    }>;
  } {
    const row = this.deps.db.select().from(qualityRuns).where(eq(qualityRuns.id, runId)).get();
    if (!row) throw new SearchHubError("not_found", "Run not found");
    const results = this.deps.db
      .select()
      .from(qualityRunResults)
      .where(eq(qualityRunResults.runId, runId))
      .all();
    const queries = this.deps.db.select().from(qualityQueries).where(eq(qualityQueries.datasetId, row.datasetId)).all();
    const queryText = new Map(queries.map((item) => [item.id, item.query]));

    const stored = row.metricsJson ? (JSON.parse(row.metricsJson) as Record<string, unknown>) : {};
    return {
      run: toRunSummary(row),
      metrics: (stored["metrics"] as Record<string, MetricValue>) ?? {},
      latency: (stored["latency"] as LatencyStats) ?? latencyStats([]),
      cost:
        (stored["cost"] as CostSummary) ?? { requests: 0, cacheHits: 0, knownCost: null, estimatedCost: null, unknownCost: true },
      quality: (stored["quality"] as Record<string, MetricValue>) ?? {},
      perQuery: results.map((item) => {
        const metrics = JSON.parse(item.metricsJson) as QueryMetrics;
        const ranked = JSON.parse(item.rankedJson) as Array<{ documentId: string; title: string; url: string }>;
        return {
          queryId: item.queryId,
          query: queryText.get(item.queryId) ?? item.queryId,
          status: item.status,
          ranked,
          metrics,
          latencyMs: item.latencyMs,
        };
      }),
    };
  }

  cancelRun(runId: string): { cancelled: boolean } {
    const row = this.deps.db.select().from(qualityRuns).where(eq(qualityRuns.id, runId)).get();
    if (!row) throw new SearchHubError("not_found", "Run not found");
    const controller = this.controllers.get(runId);
    if (!controller) {
      // Not running here: an offline run is instantaneous and a finished run
      // cannot be cancelled. Say so instead of pretending.
      throw new SearchHubError("conflict", "This run is not in progress");
    }
    controller.abort(new Error("cancelled by user"));
    return { cancelled: true };
  }

  /**
   * Starts a run and returns immediately.
   *
   * Polling `getRunDetail` is the interface. Offline runs finish in
   * milliseconds; live runs write their progress per query, so a cancellation
   * keeps whatever was actually measured instead of losing the whole run.
   */
  startRun(input: RunInput, actor: string): RunSummary {
    const datasetRow = this.deps.db
      .select()
      .from(qualityDatasets)
      .where(eq(qualityDatasets.id, input.datasetId))
      .get();
    if (!datasetRow) throw new SearchHubError("not_found", "Dataset not found");
    if (datasetRow.status !== "frozen") {
      throw new SearchHubError(
        "validation_error",
        "Only a frozen dataset can be evaluated. Freeze it first so the score is attributable to a version.",
      );
    }

    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, input.datasetId))
      .all();
    if (queries.length === 0) throw new SearchHubError("validation_error", "This dataset has no queries");

    const selected = input.queryIds
      ? queries.filter((query) => input.queryIds!.includes(query.id))
      : queries;
    if (selected.length === 0) {
      throw new SearchHubError("validation_error", "No query in this dataset matched queryIds");
    }
    if (selected.length > QUALITY_LIMITS.maxQueriesPerRun) {
      throw new SearchHubError(
        "validation_error",
        `A run may cover at most ${QUALITY_LIMITS.maxQueriesPerRun} queries`,
      );
    }

    const cutoff = Math.min(
      QUALITY_LIMITS.maxCutoff,
      Math.max(QUALITY_LIMITS.minCutoff, Math.round(input.cutoff ?? 10)),
    );
    const limit = Math.min(
      QUALITY_LIMITS.maxResultsPerQuery,
      Math.max(cutoff, Math.round(input.limit ?? Math.max(10, cutoff))),
    );

    if (input.fusion.strategy === "single" && !input.fusion.providerId) {
      throw new SearchHubError("validation_error", "A single-provider baseline needs fusion.providerId");
    }

    if (input.mode === "live") {
      if (input.confirmPaid !== true) {
        throw new SearchHubError(
          "validation_error",
          "Live runs call real providers. Confirm that you accept the API cost (confirmPaid=true).",
        );
      }
      const providerIds = input.providerIds ?? [];
      if (providerIds.length === 0) {
        throw new SearchHubError("validation_error", "A live run needs an explicit providerIds list");
      }
      if (providerIds.length > QUALITY_LIMITS.maxProvidersPerRun) {
        throw new SearchHubError(
          "validation_error",
          `A run may call at most ${QUALITY_LIMITS.maxProvidersPerRun} providers`,
        );
      }
      const budget = Math.round(input.requestBudget ?? 0);
      if (!Number.isFinite(budget) || budget <= 0) {
        throw new SearchHubError("validation_error", "A live run needs a positive requestBudget");
      }
      if (budget > QUALITY_LIMITS.maxRequestBudget) {
        throw new SearchHubError(
          "validation_error",
          `requestBudget may not exceed ${QUALITY_LIMITS.maxRequestBudget}`,
        );
      }
      // Worst case: every query × every provider, plus one retry each. If that
      // does not fit, refuse before spending anything.
      const worstCase = selected.length * providerIds.length * 2;
      if (worstCase > budget) {
        throw new SearchHubError(
          "validation_error",
          `This run could issue up to ${worstCase} upstream requests (${selected.length} queries × ${providerIds.length} providers × 2 attempts) but requestBudget is ${budget}. Raise the budget or reduce the scope.`,
        );
      }
    } else if (input.snapshotRunId) {
      const snapshotRun = this.deps.db
        .select()
        .from(qualityRuns)
        .where(eq(qualityRuns.id, input.snapshotRunId))
        .get();
      if (!snapshotRun) throw new SearchHubError("not_found", "Snapshot run not found");
      if (snapshotRun.datasetId !== input.datasetId) {
        throw new SearchHubError(
          "validation_error",
          "The snapshot run belongs to a different dataset; re-ranking across datasets is not comparable",
        );
      }
    } else if (datasetRow.origin !== "synthetic_fixture") {
      throw new SearchHubError(
        "validation_error",
        "An offline run needs snapshots. Capture one live run first, then re-rank it with snapshotRunId.",
      );
    }

    const id = `qr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date(this.now()).toISOString();
    this.deps.db
      .insert(qualityRuns)
      .values({
        id,
        datasetId: input.datasetId,
        datasetVersion: datasetRow.version,
        datasetOrigin: datasetRow.origin,
        name: input.name ?? "",
        notes: input.notes ?? "",
        mode: input.mode,
        fusionStrategy: input.fusion.strategy,
        fusionJson: JSON.stringify(input.fusion),
        limitValue: limit,
        snapshotRunId: input.snapshotRunId ?? null,
        codeCommit: this.deps.codeCommit ?? null,
        engineVersion: this.deps.engineVersion,
        status: "running",
        requestBudget: input.mode === "live" ? Math.round(input.requestBudget ?? 0) : 0,
        requestsUsed: 0,
        cacheHits: 0,
        queryCount: selected.length,
        errorJson: null,
        metricsJson: null,
        actor,
        startedAt: now,
        finishedAt: null,
        createdAt: now,
      })
      .run();

    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.execute({
      runId: id,
      datasetRow,
      queries: selected.map((row) => ({
        id: row.id,
        query: row.query,
        category: row.category as QueryCategory,
        language: row.language,
      })),
      input,
      limit,
      cutoff,
      controller,
    }).finally(() => this.controllers.delete(id));

    return toRunSummary({
      id,
      datasetId: input.datasetId,
      datasetVersion: datasetRow.version,
      datasetOrigin: datasetRow.origin,
      name: input.name ?? "",
      notes: input.notes ?? "",
      mode: input.mode,
      fusionStrategy: input.fusion.strategy,
      fusionJson: JSON.stringify(input.fusion),
      limitValue: limit,
      snapshotRunId: input.snapshotRunId ?? null,
      codeCommit: this.deps.codeCommit ?? null,
      engineVersion: this.deps.engineVersion,
      status: "running",
      requestBudget: input.mode === "live" ? Math.round(input.requestBudget ?? 0) : 0,
      requestsUsed: 0,
      cacheHits: 0,
      queryCount: selected.length,
      errorJson: null,
      metricsJson: null,
      actor,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
    });
  }

  private async execute(args: {
    runId: string;
    datasetRow: typeof qualityDatasets.$inferSelect;
    queries: Array<{ id: string; query: string; category: QueryCategory; language: string }>;
    input: RunInput;
    limit: number;
    cutoff: number;
    controller: AbortController;
  }): Promise<void> {
    const { runId, datasetRow, queries, input, limit, cutoff } = args;
    const judgmentsComplete = datasetRow.judgmentsComplete;
    const judgmentRows = this.deps.db
      .select()
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, datasetRow.id))
      .all();
    const byQuery = new Map<string, Array<{ documentId: string; relevance: RelevanceGrade }>>();
    for (const row of judgmentRows) {
      const list = byQuery.get(row.queryId) ?? [];
      list.push({ documentId: row.documentId, relevance: row.relevance as RelevanceGrade });
      byQuery.set(row.queryId, list);
    }

    const snapshots = new Map<string, QuerySnapshot>();
    let requestsUsed = 0;
    let cacheHits = 0;
    const queryOutcome = new Map<string, { partial: boolean; failed: boolean }>();
    const latencies: number[] = [];
    const requestsByProvider: Record<string, number> = {};

    try {
      if (input.mode === "live") {
        const providerIds = input.providerIds ?? [];
        const budget = Math.round(input.requestBudget ?? 0);
        for (const query of queries) {
          if (args.controller.signal.aborted) break;
          // Worst case for this query before issuing it.
          const worstCase = providerIds.length * 2;
          if (requestsUsed + worstCase > budget) {
            this.deps.logger.warn(
              { runId, requestsUsed, budget },
              "quality run stopped at its request budget",
            );
            break;
          }
          const started = this.now();
          const response = await this.deps.search.execute(
            {
              query: query.query,
              limit,
              perProviderLimit: limit,
              mode: "basic",
              providers: providerIds,
              skipCache: true,
            },
            { signal: args.controller.signal, evaluate: true, actor: `quality:${runId}` },
          );
          const latencyMs = Math.max(0, this.now() - started);
          latencies.push(latencyMs);
          const statById = new Map(response.stats.providers.map((stat) => [stat.providerId, stat]));
          const providers: ProviderSnapshot[] = (response.debug?.perProviderResults ?? []).map(
            (entry) => {
              const stat = statById.get(entry.providerId);
              return {
                providerId: entry.providerId,
                providerName: entry.providerName,
                providerType: stat?.providerType ?? "unknown",
                results: entry.results.map((result, index) => ({
                  documentId: result.id,
                  title: result.title,
                  url: result.url,
                  snippet: result.snippet,
                  rank: index + 1,
                })),
                // A failed provider must be recorded as failed. Writing `ok`
                // unconditionally would make an outage look like a source that
                // simply returned nothing, and every later re-rank of this
                // snapshot would inherit the lie.
                ok: stat?.ok ?? entry.results.length > 0,
                ...(stat?.errorCode === undefined ? {} : { errorCode: stat.errorCode }),
                ...(stat?.latencyMs === undefined ? {} : { latencyMs: stat.latencyMs }),
              };
            },
          );
          const asked = new Set(providerIds);
          for (const stat of response.stats.providers) {
            asked.delete(stat.providerId);
            requestsByProvider[stat.providerId] = (requestsByProvider[stat.providerId] ?? 0) + stat.attempts;
            requestsUsed += stat.attempts;
          }
          for (const missing of asked) {
            // A provider that never ran still counts as asked, so the baseline
            // comparison knows it produced nothing rather than omitting it.
            requestsByProvider[missing] = requestsByProvider[missing] ?? 0;
          }
          // Per query, not per run: one degraded query must not mark all of them.
          queryOutcome.set(query.id, { partial: response.status === "partial", failed: response.status === "failed" });
          snapshots.set(query.id, {
            queryId: query.id,
            query: query.query,
            category: query.category,
            providers,
            capturedAt: new Date(this.now()).toISOString(),
            upstreamRequests: response.stats.providers.reduce((total, stat) => total + stat.attempts, 0),
            cacheHits: 0,
          });
          this.deps.db
            .insert(qualitySnapshots)
            .values({
              runId,
              queryId: query.id,
              snapshotJson: JSON.stringify(providers),
              createdAt: new Date(this.now()).toISOString(),
            })
            .onConflictDoNothing()
            .run();
        }
      } else if (input.snapshotRunId) {
        const rows = this.deps.db
          .select()
          .from(qualitySnapshots)
          .where(eq(qualitySnapshots.runId, input.snapshotRunId))
          .all();
        const snapshotByQuery = new Map(rows.map((row) => [row.queryId, row.snapshotJson]));
        for (const query of queries) {
          const raw = snapshotByQuery.get(query.id);
          if (!raw) continue;
          snapshots.set(query.id, {
            queryId: query.id,
            query: query.query,
            category: query.category,
            providers: JSON.parse(raw) as ProviderSnapshot[],
            capturedAt: new Date(this.now()).toISOString(),
            upstreamRequests: 0,
            cacheHits: 0,
          });
        }
      } else {
        // Built-in synthetic fixture: the dataset id selects which one.
        const fixture =
          datasetRow.id === shallowFixture().dataset.id ? shallowFixture() : coreFixture();
        for (const snapshot of fixture.snapshots) {
          if (!queries.some((query) => query.id === snapshot.queryId)) continue;
          snapshots.set(snapshot.queryId, snapshot);
        }
      }

      const rankedLists: Array<{ queryId: string; documents: Array<{ documentId: string; title: string; url: string }> }> = [];
      const perQueryMetrics: QueryMetrics[] = [];
      const judgedQueries: JudgedQuery[] = [];
      const documentCounts: number[] = [];
      const allUrls: string[] = [];
      let providersContributing = 0;

      for (const query of queries) {
        const snapshot = snapshots.get(query.id);
        const rows = byQuery.get(query.id) ?? [];
        const judged = judgmentsForQuery(query.id, rows, judgmentsComplete);
        judgedQueries.push({
          queryId: query.id,
          query: query.query,
          category: query.category,
          grades: judged.grades,
          relevantTotal: judged.relevantTotal,
        });

        if (!snapshot) {
          const empty = evaluateQuery([], judged, { cutoff });
          perQueryMetrics.push(empty);
          this.persistResult(
            runId,
            query.id,
            "failed",
            { documents: [] },
            empty,
            null,
            "No snapshot was captured for this query",
          );
          continue;
        }

        const ranked = rankSnapshot(snapshot, input.fusion, { limit });
        const metrics = evaluateQuery(
          ranked.documents.map((document) => document.documentId),
          judged,
          { cutoff, judgmentsComplete, unjudgedPolicy: input.unjudgedPolicy ?? "exclude" },
        );
        rankedLists.push({ queryId: query.id, documents: ranked.documents });
        perQueryMetrics.push(metrics);
        documentCounts.push(ranked.documents.length);
        for (const document of ranked.documents) allUrls.push(document.url);
        providersContributing = Math.max(
          providersContributing,
          new Set(
            snapshot.providers
              .filter((provider) => provider.results.length > 0)
              .map((provider) => provider.providerId),
          ).size,
        );
        this.persistResult(runId, query.id, "ok", ranked, metrics, latencies[latencies.length - 1] ?? null, null);
      }

      const quality = {
        resultCount: this.meanValue(documentCounts),
        duplicateRate: this.duplicateRate(queries, snapshots, input.fusion, limit),
        emptyResultRate: rateMetric(documentCounts.map((count) => count === 0)),
        failedQueryRate: rateMetric(
          // A query counts as failed when no snapshot was captured for it, which
          // is recorded as a zero-length result with a status of "failed".
          queries.map((query) => snapshots.get(query.id) === undefined),
        ),
        partialQueryRate: rateMetric(queries.map((query) => queryOutcome.get(query.id)?.partial === true)),
      };

      const metrics = {
        precisionAtK: aggregateMetric(perQueryMetrics, "precisionAtK"),
        recallAtK: aggregateMetric(perQueryMetrics, "recallAtK"),
        mrrAtK: aggregateMetric(perQueryMetrics, "mrrAtK"),
        ndcgAtK: aggregateMetric(perQueryMetrics, "ndcgAtK"),
      };
      const latency = latencyStats(latencies);
      const cost = costSummary({
        requests: requestsUsed,
        cacheHits,
        requestsByProvider,
        ...(input.unitCosts === undefined ? {} : { unitCosts: input.unitCosts }),
      });

      const cancelled = args.controller.signal.aborted;
      this.finish(runId, cancelled ? "cancelled" : "completed", {
        metrics,
        latency,
        cost,
        quality,
        requestsUsed,
        cacheHits,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ err: error, runId }, "quality run failed");
      this.finish(runId, "failed", { requestsUsed, cacheHits, error: message });
    }
  }

  private meanValue(values: readonly number[]): MetricValue {
    if (values.length === 0) {
      return { value: null, status: "na", reason: "not_applicable", sampleSize: 0, provisionalCount: 0, lowSample: false };
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      value: Number((total / values.length).toFixed(10)),
      status: "ok",
      sampleSize: values.length,
      provisionalCount: 0,
      lowSample: values.length < 8,
    };
  }

  /**
   * Duplicate rate across the raw provider lists, before fusion.
   *
   * That is the number an operator cares about — "how much of what I paid for
   * was the same page twice" — not the post-dedupe count, which is always zero
   * by construction.
   */
  private duplicateRate(
    queries: ReadonlyArray<{ id: string }>,
    snapshots: ReadonlyMap<string, QuerySnapshot>,
    fusion: FusionParameters,
    limit: number,
  ): MetricValue {
    let raw = 0;
    let unique = 0;
    for (const query of queries) {
      const snapshot = snapshots.get(query.id);
      if (!snapshot) continue;
      const ranked = rankSnapshot(snapshot, fusion, { limit });
      const totalRows = snapshot.providers.reduce((sum, provider) => sum + provider.results.length, 0);
      raw += totalRows;
      unique += ranked.documents.length;
    }
    if (raw === 0) {
      return { value: null, status: "na", reason: "no_results", sampleSize: 0, provisionalCount: 0, lowSample: false };
    }
    return {
      value: Number(((raw - unique) / raw).toFixed(10)),
      status: "ok",
      sampleSize: queries.length,
      provisionalCount: 0,
      lowSample: queries.length < 8,
    };
  }

  private persistResult(
    runId: string,
    queryId: string,
    status: string,
    ranked: { documents: Array<{ documentId: string; title: string; url: string }> },
    metrics: QueryMetrics,
    latencyMs: number | null,
    error: string | null,
  ): void {
    this.deps.db
      .insert(qualityRunResults)
      .values({
        runId,
        queryId,
        status,
        rankedJson: JSON.stringify(ranked.documents),
        metricsJson: JSON.stringify(metrics),
        latencyMs,
        upstreamRequests: 0,
        errorJson: error ? JSON.stringify({ message: error }) : null,
        createdAt: new Date(this.now()).toISOString(),
      })
      .run();
  }

  private finish(
    runId: string,
    status: string,
    payload: {
      metrics?: Record<string, MetricValue>;
      latency?: LatencyStats;
      cost?: CostSummary;
      quality?: Record<string, MetricValue>;
      requestsUsed: number;
      cacheHits: number;
      error?: string;
    },
  ): void {
    this.deps.db
      .update(qualityRuns)
      .set({
        status,
        finishedAt: new Date(this.now()).toISOString(),
        requestsUsed: payload.requestsUsed,
        cacheHits: payload.cacheHits,
        metricsJson: JSON.stringify({
          metrics: payload.metrics ?? {},
          latency: payload.latency ?? latencyStats([]),
          cost: payload.cost ?? null,
          quality: payload.quality ?? {},
        }),
        errorJson: payload.error ? JSON.stringify({ message: payload.error }) : null,
      })
      .where(eq(qualityRuns.id, runId))
      .run();
  }

  // ----------------------------------------------------------------- compare

  /**
   * Compares two runs of the same dataset version.
   *
   * Refuses to compare across dataset versions: two different qrel sets are two
   * different questions, and a delta between them means nothing.
   */
  compare(input: {
    baselineRunId: string;
    candidateRunId: string;
    metric?: AggregateMetric;
  }): ComparisonSummary & { datasetId: string; datasetVersion: number; holdoutOnly: boolean } {
    const baseline = this.deps.db.select().from(qualityRuns).where(eq(qualityRuns.id, input.baselineRunId)).get();
    const candidate = this.deps.db.select().from(qualityRuns).where(eq(qualityRuns.id, input.candidateRunId)).get();
    if (!baseline || !candidate) throw new SearchHubError("not_found", "Run not found");
    if (baseline.datasetId !== candidate.datasetId) {
      throw new SearchHubError("validation_error", "The two runs used different datasets");
    }
    if (baseline.datasetVersion !== candidate.datasetVersion) {
      throw new SearchHubError(
        "validation_error",
        `The two runs used different dataset versions (${baseline.datasetVersion} vs ${candidate.datasetVersion})`,
      );
    }
    if (baseline.status !== "completed" || candidate.status !== "completed") {
      throw new SearchHubError("validation_error", "Only completed runs can be compared");
    }

    const metric = input.metric ?? "ndcgAtK";
    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, baseline.datasetId))
      .all();
    const categoryById = new Map(queries.map((row) => [row.id, row.category as QueryCategory]));
    const textById = new Map(queries.map((row) => [row.id, row.query]));

    const load = (runId: string) => {
      const rows = this.deps.db.select().from(qualityRunResults).where(eq(qualityRunResults.runId, runId)).all();
      return new Map(
        rows.map((row) => [
          row.queryId,
          {
            metrics: JSON.parse(row.metricsJson) as QueryMetrics,
            ranked: JSON.parse(row.rankedJson) as Array<{ documentId: string; title: string; url: string }>,
          },
        ]),
      );
    };
    const baselineRows = load(input.baselineRunId);
    const candidateRows = load(input.candidateRunId);

    const judgedRows = this.deps.db
      .select()
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, baseline.datasetId))
      .all();
    const gradesByQuery = new Map<string, Map<string, RelevanceGrade>>();
    for (const row of judgedRows) {
      const map = gradesByQuery.get(row.queryId) ?? new Map<string, RelevanceGrade>();
      map.set(row.documentId, row.relevance as RelevanceGrade);
      gradesByQuery.set(row.queryId, map);
    }
    const complete = this.deps.db
      .select()
      .from(qualityDatasets)
      .where(eq(qualityDatasets.id, baseline.datasetId))
      .get()?.judgmentsComplete ?? false;

    const judgedQueries: JudgedQuery[] = [...baselineRows.keys()].map((queryId) => {
      const grades = gradesByQuery.get(queryId) ?? new Map<string, RelevanceGrade>();
      return {
        queryId,
        query: textById.get(queryId) ?? queryId,
        category: categoryById.get(queryId) ?? "general",
        grades,
        relevantTotal: complete ? [...grades.values()].filter((grade) => grade >= 2).length : null,
      };
    });

    const toRanked = (rows: Map<string, { ranked: Array<{ documentId: string; title: string; url: string }> }>) =>
      [...rows.entries()].map(([queryId, row]) => ({
        queryId,
        documents: row.ranked,
        fusion: { strategy: "rrf" as const },
      }));

    return {
      ...compareRankings({
        metric,
        baseline: toRanked(baselineRows),
        candidate: toRanked(candidateRows),
        judgments: judgedQueries,
        metricsFor: (ranked, judged) =>
          evaluateQuery(ranked.documents.map((document) => document.documentId), {
            queryId: judged.queryId,
            grades: judged.grades,
            relevantTotal: judged.relevantTotal,
          }),
      }),
      datasetId: baseline.datasetId,
      datasetVersion: baseline.datasetVersion,
      holdoutOnly: false,
    };
  }

  /**
   * Offline RRF parameter sweep with a development/holdout split.
   *
   * The split is computed from query ids, the winner is chosen on the
   * development half only, and the reported number for that winner is measured
   * on the holdout half. Choosing on the holdout and reporting on the same
   * queries is how a parameter search produces a meaningless "improvement".
   */
  async sweepRrf(input: {
    datasetId: string;
    kValues?: number[];
    metric?: AggregateMetric;
    developmentShare?: number;
  }): Promise<{
    split: { development: number; holdout: number };
    candidates: Array<{
      k: number;
      development: Record<string, MetricValue>;
      holdout: Record<string, MetricValue>;
    }>;
    chosen: number | null;
    holdoutVerdict: ComparisonSummary["verdict"] | null;
    comparison: ComparisonSummary | null;
    evidence: "sufficient" | "INSUFFICIENT_EVIDENCE";
    reason?: string;
  }> {
    const dataset = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, input.datasetId)).get();
    if (!dataset) throw new SearchHubError("not_found", "Dataset not found");
    if (dataset.status !== "frozen") {
      throw new SearchHubError("validation_error", "Freeze the dataset before running a parameter sweep");
    }
    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, input.datasetId))
      .all();
    const split = splitQueries(queries.map((row) => row.id), input.developmentShare ?? 0.5);
    const metric = input.metric ?? "ndcgAtK";
    const kValues = input.kValues ?? [20, 40, 60, 80, 100];

    const evaluated: Array<{
      k: number;
      development: Record<string, MetricValue>;
      holdout: Record<string, MetricValue>;
    }> = [];

    for (const k of kValues) {
      const development = this.evaluateSubset(input.datasetId, split.development, { strategy: "rrf", k });
      const holdout = this.evaluateSubset(input.datasetId, split.holdout, { strategy: "rrf", k });
      evaluated.push({ k, development, holdout });
    }

    // Choose on development only.
    let chosen: number | null = null;
    let best = -Infinity;
    for (const candidate of evaluated) {
      const value = candidate.development[metric]?.value;
      if (value === undefined || value === null) continue;
      if (value > best) {
        best = value;
        chosen = candidate.k;
      }
    }

    if (chosen === null) {
      return {
        split: { development: split.development.length, holdout: split.holdout.length },
        candidates: evaluated,
        chosen: null,
        holdoutVerdict: null,
        comparison: null,
        evidence: "INSUFFICIENT_EVIDENCE",
        reason: "no candidate produced a measurable development score",
      };
    }

    // Report on holdout, against the shipped default k=60.
    const baseline = this.evaluateSubset(input.datasetId, split.holdout, { strategy: "rrf", k: 60 });
    const candidate = this.evaluateSubset(input.datasetId, split.holdout, { strategy: "rrf", k: chosen });
    const comparison = compareRankings({
      metric,
      baseline: this.rankSubset(input.datasetId, split.holdout, { strategy: "rrf", k: 60 }),
      candidate: this.rankSubset(input.datasetId, split.holdout, { strategy: "rrf", k: chosen }),
      judgments: this.judgedSubset(input.datasetId, split.holdout),
      metricsFor: (ranked, judged) =>
        evaluateQuery(ranked.documents.map((document) => document.documentId), {
          queryId: judged.queryId,
          grades: judged.grades,
          relevantTotal: judged.relevantTotal,
        }),
    });
    void baseline;
    void candidate;

    // An unmeasured comparison has no verdict to report. Saying
    // "insufficient_evidence" in a field named `holdoutVerdict` would read like a
    // result; the evidence flag carries that meaning instead.
    const insufficient = comparison.verdict === "insufficient_evidence";
    return {
      split: { development: split.development.length, holdout: split.holdout.length },
      candidates: evaluated,
      chosen,
      holdoutVerdict: insufficient ? null : comparison.verdict,
      comparison,
      evidence: insufficient ? "INSUFFICIENT_EVIDENCE" : "sufficient",
      ...(comparison.reason === undefined ? {} : { reason: comparison.reason }),
    };
  }

  private snapshotsForSubset(datasetId: string, queryIds: readonly string[]): Map<string, QuerySnapshot> {
    const dataset = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, datasetId)).get();
    if (!dataset) throw new SearchHubError("not_found", "Dataset not found");
    const allowed = new Set(queryIds);
    const fixture = dataset.id === shallowFixture().dataset.id ? shallowFixture() : coreFixture();
    return new Map(
      fixture.snapshots.filter((snapshot) => allowed.has(snapshot.queryId)).map((snapshot) => [snapshot.queryId, snapshot]),
    );
  }

  private judgedSubset(datasetId: string, queryIds: readonly string[]): JudgedQuery[] {
    const dataset = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, datasetId)).get();
    if (!dataset) return [];
    const allowed = new Set(queryIds);
    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, datasetId))
      .all()
      .filter((row) => allowed.has(row.id));
    const judgments = this.deps.db
      .select()
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, datasetId))
      .all()
      .filter((row) => allowed.has(row.queryId));
    const byQuery = new Map<string, Array<{ documentId: string; relevance: RelevanceGrade }>>();
    for (const row of judgments) {
      const list = byQuery.get(row.queryId) ?? [];
      list.push({ documentId: row.documentId, relevance: row.relevance as RelevanceGrade });
      byQuery.set(row.queryId, list);
    }
    return queries.map((row) => {
      const judged = judgmentsForQuery(row.id, byQuery.get(row.id) ?? [], dataset.judgmentsComplete);
      return {
        queryId: row.id,
        query: row.query,
        category: row.category as QueryCategory,
        grades: judged.grades,
        relevantTotal: judged.relevantTotal,
      };
    });
  }

  private rankSubset(datasetId: string, queryIds: readonly string[], fusion: FusionParameters) {
    const snapshots = this.snapshotsForSubset(datasetId, queryIds);
    return [...snapshots.values()].map((snapshot) => rankSnapshot(snapshot, fusion, { limit: 10 }));
  }

  private evaluateSubset(
    datasetId: string,
    queryIds: readonly string[],
    fusion: FusionParameters,
  ): Record<string, MetricValue> {
    const snapshots = this.snapshotsForSubset(datasetId, queryIds);
    const judged = this.judgedSubset(datasetId, queryIds);
    const perQuery: QueryMetrics[] = [];
    for (const entry of judged) {
      const snapshot = snapshots.get(entry.queryId);
      if (!snapshot) continue;
      const ranked = rankSnapshot(snapshot, fusion, { limit: 10 });
      perQuery.push(
        evaluateQuery(
          ranked.documents.map((document) => document.documentId),
          { queryId: entry.queryId, grades: entry.grades, relevantTotal: entry.relevantTotal },
          { cutoff: 10 },
        ),
      );
    }
    return {
      precisionAtK: aggregateMetric(perQuery, "precisionAtK"),
      recallAtK: aggregateMetric(perQuery, "recallAtK"),
      mrrAtK: aggregateMetric(perQuery, "mrrAtK"),
      ndcgAtK: aggregateMetric(perQuery, "ndcgAtK"),
    } satisfies Record<string, MetricValue>;
  }

  // --------------------------------------------------------------- lifecycle

  /** Deletes runs older than the retention window, keeping the latest N. */
  pruneRuns(input: { olderThanDays: number; keepLatest?: number }): { removed: number } {
    const days = Math.max(1, Math.round(input.olderThanDays));
    const cutoff = new Date(this.now() - days * 86_400_000).toISOString();
    const keep = Math.max(0, Math.round(input.keepLatest ?? 20));
    const recent = this.deps.db
      .select({ id: qualityRuns.id })
      .from(qualityRuns)
      .orderBy(desc(qualityRuns.startedAt))
      .limit(keep)
      .all()
      .map((row) => row.id);
    const stale = this.deps.db
      .select({ id: qualityRuns.id })
      .from(qualityRuns)
      .where(lt(qualityRuns.startedAt, cutoff))
      .all()
      .filter((row) => !recent.includes(row.id));
    let removed = 0;
    this.deps.db.transaction((tx) => {
      for (const row of stale) {
        tx.delete(qualityRunResults).where(eq(qualityRunResults.runId, row.id)).run();
        tx.delete(qualitySnapshots).where(eq(qualitySnapshots.runId, row.id)).run();
        tx.delete(qualityRuns).where(eq(qualityRuns.id, row.id)).run();
        removed += 1;
      }
    });
    return { removed };
  }

  /** Seeds the two built-in fixtures if they are not present yet. */
  ensureFixtures(): { created: string[] } {
    const created: string[] = [];
    for (const fixture of [coreFixture(), shallowFixture()]) {
      const existing = this.deps.db
        .select({ id: qualityDatasets.id })
        .from(qualityDatasets)
        .where(eq(qualityDatasets.id, fixture.dataset.id))
        .get();
      if (existing) continue;
      this.deps.db.transaction((tx) => {
        tx.insert(qualityDatasets)
          .values({
            id: fixture.dataset.id,
            name: fixture.dataset.name,
            description: fixture.dataset.description,
            language: fixture.dataset.language,
            version: fixture.dataset.version,
            status: fixture.dataset.status,
            origin: fixture.dataset.origin,
            judgmentsComplete: fixture.dataset.judgmentsComplete,
            createdAt: fixture.dataset.createdAt,
            updatedAt: fixture.dataset.updatedAt,
            frozenAt: fixture.dataset.frozenAt,
          })
          .run();
        for (const query of fixture.queries) {
          tx.insert(qualityQueries)
            .values({
              id: query.id,
              datasetId: fixture.dataset.id,
              query: query.query,
              category: query.category,
              language: query.language,
              intent: query.intent,
              notes: "",
              createdAt: fixture.dataset.createdAt,
            })
            .run();
        }
        for (const judgment of fixture.judgments) {
          tx.insert(qualityJudgments)
            .values({
              id: `qj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
              datasetId: fixture.dataset.id,
              queryId: judgment.queryId,
              documentId: judgment.documentId,
              relevance: judgment.relevance,
              assessor: "fixture",
              source: "synthetic_fixture",
              notes: "",
              createdAt: fixture.dataset.createdAt,
              updatedAt: fixture.dataset.createdAt,
            })
            .run();
        }
      });
      created.push(fixture.dataset.id);
    }
    return { created };
  }

  private audit(actor: string, action: string, target: string, detail: string): void {
    try {
      this.deps.db
        .insert(this.deps.db._.fullSchema.auditLogs)
        .values({
          actor,
          action,
          target,
          detailJson: JSON.stringify({ detail }).slice(0, 2000),
          ip: null,
          createdAt: new Date(this.now()).toISOString(),
        })
        .run();
    } catch (error) {
      this.deps.logger.warn({ err: error }, "failed to write the quality audit entry");
    }
  }
}
