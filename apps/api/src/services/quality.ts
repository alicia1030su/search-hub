import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { SearchHubError, normalizeUrl, type Logger } from "@search-hub/shared";
import {
  aggregateByCategory,
  aggregateMetric,
  compareRankings,
  coreFixture,
  costSummary,
  evaluateQuery,
  judgmentsForQuery,
  latencyStats,
  rankSnapshot,
  rateMetric,
  resultSetQuality,
  shallowFixture,
  queryMovements,
  splitQueries,
  type AggregateMetric,
  type CategoryBreakdown,
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
import {
  modelFingerprint,
  providerFingerprint,
  qrelsFingerprint,
  type ModelFingerprintRow,
  type ProviderFingerprintRow,
} from "./quality-fingerprint.js";

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

/** Datasets per page, and the ceiling a caller may ask for. */
const DATASET_PAGE_DEFAULT = 50;
const DATASET_PAGE_MAX = 200;
/** Queries or judgments per page in a dataset detail response. */
const DETAIL_PAGE_DEFAULT = 200;
const DETAIL_PAGE_MAX = 500;

/**
 * Secondary category labels stored on a query row.
 *
 * A malformed value must not make a dataset unreadable: the row was written by
 * this service, and if the JSON is broken the primary `category` is still a
 * correct answer. Returning `[]` keeps the query visible as its primary label
 * instead of failing the whole dataset page.
 */
/** True when the database refused the write because the volume is full. */
function isDiskFull(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code.includes("SQLITE_FULL")) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /disk is full|ENOSPC|database or disk/i.test(message);
}

/**
 * A run could not persist a result.
 *
 * 507 is the honest status: the request was valid and the server failed to
 * store its own work, which is a capacity problem rather than a bug in the
 * caller. `details.runId` survives even when the failure update also failed, so
 * an operator can find the run once the disk is writable again.
 */
function persistenceFailure(runId: string, cause: unknown): SearchHubError {
  const full = isDiskFull(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SearchHubError(
    "internal_error",
    full
      ? "The evaluation run could not be stored: the database volume is full. Free space and re-run."
      : `The evaluation run could not be stored: ${message}`,
    { status: full ? 507 : 500, details: { runId, reason: "persistence_failed" } },
  );
}

/** A page size inside the documented window, defaulted rather than rejected. */
function clampPage(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(max, Math.round(value));
}

function parseExtraCategories(raw: string | null | undefined): QueryCategory[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is QueryCategory => typeof item === "string");
  } catch {
    return [];
  }
}

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

/**
 * Validates the label set of one query and returns the secondary labels.
 *
 * A query carries one primary label in `category` and up to two more in
 * `extraCategories`. Three labels is the ceiling because the report compares
 * categories against each other: a query tagged with five overlapping labels
 * would be counted five times in the same comparison and make every group look
 * larger than it is.
 *
 * Repeating a label is rejected rather than de-duplicated: a caller that sent
 * it twice is describing a different query than the one that would be stored,
 * and silently "fixing" it would hide the mistake.
 */
function validateCategories(
  primary: QueryCategory,
  extras: readonly QueryCategory[] | undefined,
  context: Record<string, unknown>,
): QueryCategory[] {
  const secondary = extras ?? [];
  const unique = new Set<QueryCategory>([primary, ...secondary]);
  if (unique.size !== secondary.length + 1) {
    throw new SearchHubError(
      "validation_error",
      `A query's categories must be distinct (primary "${primary}", secondary [${secondary.join(", ")}])`,
      { details: { ...context, primary, extraCategories: secondary } },
    );
  }
  const total = 1 + secondary.length;
  if (total > 3) {
    throw new SearchHubError(
      "validation_error",
      "A query may carry at most three categories (one primary plus two secondary)",
      { details: { ...context, primary, extraCategories: secondary } },
    );
  }
  return [...secondary];
}

function categoriesJson(extras: readonly QueryCategory[]): string {
  return JSON.stringify(extras);
}

/**
 * Labels as the read model exposes them: primary first, then the secondary ones.
 * Always at least one element, so callers never need a "what if it is empty" path.
 */
function categoriesOf(row: { category: string; extraCategories?: string | null }): QueryCategory[] {
  return [row.category as QueryCategory, ...parseExtraCategories(row.extraCategories)] as QueryCategory[];
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
  /**
   * Upper bound on **physical HTTP requests** one provider may issue for a
   * single query: retries × pages × redirects.
   *
   * Attempts alone are not enough. A Brave-shaped adapter targeting 50 rows
   * with `count=20` fetches three pages inside one attempt, and a redirect adds
   * a hop to each. Counting attempts would authorise a third of the traffic the
   * vendor actually sees.
   */
  providerMaxRequests?: (providerId: string, perProviderLimit?: number) => number;
  /**
   * Credential-free description of the providers that exist right now.
   *
   * Used only to fingerprint a run, so it must never include a key: rotating a
   * key is not a configuration change and must not move the digest.
   */
  providerSnapshot?: () => readonly ProviderFingerprintRow[];
  /** Credential-free description of configured models. Empty means none exist. */
  modelSnapshot?: () => readonly ModelFingerprintRow[];
  /**
   * Called when a request is refused because the run's ceiling is reached.
   * The search path uses it to stop the whole run cleanly.
   */
  onBudgetExhausted?: (providerId: string, url: string) => never;
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
  /** Primary category; `general` when omitted, which keeps old clients valid. */
  category?: QueryCategory;
  /**
   * Secondary labels. A query is counted once under each label it carries, so
   * the per-category query counts can exceed the number of queries.
   */
  extraCategories?: QueryCategory[];
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
  /**
   * Rows requested from each provider, which is not the same question as rows
   * shown to the reader: a fusion can only rank what it was given.
   */
  perProviderLimit?: number;
  /** Request timeout for this run only; never written back to a provider. */
  timeoutMs?: number;
  /**
   * Only `bypass` is implemented. Anything else is rejected rather than stored
   * and silently ignored — a run record that claims a policy the engine did not
   * apply is worse than an unsupported option.
   */
  cachePolicy?: "bypass";
  /** Only `1` (serial) is implemented; see above. */
  maxConcurrency?: number;
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
  /** Metric cutoff that produced the stored numbers. */
  cutoff: number;
  queryCount: number;
  requestsUsed: number;
  requestBudget: number;
  codeCommit: string | null;
  engineVersion: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Rows requested from each provider; `null` on runs recorded before v0.1.10. */
  perProviderLimit: number | null;
  /** Request timeout this run used; `null` on runs recorded before v0.1.10. */
  timeoutMs: number | null;
  /** Which providers took part, empty when it was not recorded. */
  providerIds: string[];
  /**
   * Digests that make a score attributable. All `null` on runs recorded before
   * v0.1.10 — they are never back-filled from today's configuration, which
   * would describe a run that never happened.
   */
  providerFingerprint: string | null;
  /** `null` is a fact: no model took part in this run. */
  modelFingerprint: string | null;
  qrelsFingerprint: string | null;
  /** False when the provenance columns were never written (pre-v0.1.10 runs). */
  provenanceComplete: boolean;
  /** Which provenance fields are missing, so the gap is nameable. */
  provenanceMissing: string[];
  /** Why a failed run failed; `null` when it did not fail or the cause is unknown. */
  failureReason: string | null;
  /** True when only part of the requested queries produced a stored row. */
  partial: boolean;
  /** Per-query rows actually written before the run stopped. */
  persistedQueryCount: number;
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
  let providerIds: string[] = [];
  if (row.providerIdsJson) {
    try {
      const parsed = JSON.parse(row.providerIdsJson) as unknown;
      if (Array.isArray(parsed)) providerIds = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      providerIds = [];
    }
  }
  // A model fingerprint of `null` is a fact ("no model took part"), not a gap.
  // The three fields that describe what the run actually searched are the ones
  // whose absence makes it unattributable.
  const missing: string[] = [];
  if (providerIds.length === 0) missing.push("providerIds");
  if (row.providerFingerprint === null) missing.push("providerFingerprint");
  if (row.qrelsFingerprint === null) missing.push("qrelsFingerprint");
  const recordedModelFingerprint = row.modelFingerprint;
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
    cutoff: row.cutoffValue,
    queryCount: row.queryCount,
    requestsUsed: row.requestsUsed,
    requestBudget: row.requestBudget,
    codeCommit: row.codeCommit,
    engineVersion: row.engineVersion,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error,
    perProviderLimit: row.perProviderLimit,
    timeoutMs: row.requestTimeoutMs,
    providerIds,
    providerFingerprint: row.providerFingerprint,
    modelFingerprint: recordedModelFingerprint,
    qrelsFingerprint: row.qrelsFingerprint,
    provenanceComplete: missing.length === 0,
    provenanceMissing: missing,
    failureReason: row.failureReason,
    partial: row.partial,
    persistedQueryCount: row.persistedQueryCount,
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
  /**
   * Per-run progress, so a failure can say how much was actually written.
   *
   * Kept beside the controller map rather than in the database: it exists to
   * describe a run that is still in flight, and a run that finished normally
   * persists the same number.
   */
  private readonly runningRuns = new Map<string, { persisted: number; total: number; controller: AbortController }>();
  private readonly now: () => number;

  constructor(private readonly deps: QualityServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------- datasets

  /**
   * Imports a dataset in one transaction.
   *
   * The route used to create the dataset, add the queries and then add the
   * judgments as three independent calls: a rejected judgment batch left an
   * orphan draft dataset behind. Import is one operation, so it commits or
   * rolls back as one.
   */
  importDataset(
    input: {
      name: string;
      description?: string;
      language?: string;
      judgmentsComplete?: boolean;
      queries: Array<{
        query: string;
        category?: QueryCategory;
        extraCategories?: QueryCategory[];
        language?: string;
        intent?: string;
        notes?: string;
        judgments?: Array<{ url: string; relevance: RelevanceGrade; notes?: string }>;
      }>;
    },
    actor: string,
  ): { dataset: QualityDataset; queries: number; judgments: number } {
    if (input.queries.length > QUALITY_LIMITS.maxQueriesPerDataset) {
      throw new SearchHubError(
        "validation_error",
        `A dataset may hold at most ${QUALITY_LIMITS.maxQueriesPerDataset} queries`,
      );
    }
    const totalJudgments = input.queries.reduce((sum, query) => sum + (query.judgments?.length ?? 0), 0);
    if (totalJudgments > QUALITY_LIMITS.maxJudgmentsPerDataset) {
      throw new SearchHubError(
        "validation_error",
        `This import contains ${totalJudgments} judgments; the limit is ${QUALITY_LIMITS.maxJudgmentsPerDataset}`,
      );
    }
    const seen = new Set<string>();
    const labelSets: QueryCategory[][] = [];
    for (const [index, query] of input.queries.entries()) {
      const key = query.query.trim().toLowerCase();
      if (!key) throw new SearchHubError("validation_error", "A query cannot be empty");
      if (seen.has(key)) {
        throw new SearchHubError("validation_error", `Duplicate query in this import: "${query.query}"`);
      }
      seen.add(key);
      labelSets.push(validateCategories(query.category ?? "general", query.extraCategories, { queries: index }));
      for (const judgment of query.judgments ?? []) {
        if (!normalizeUrl(judgment.url)) {
          throw new SearchHubError(
            "validation_error",
            `"${judgment.url}" is not a usable http(s) document URL`,
          );
        }
      }
    }

    const now = new Date(this.now()).toISOString();
    const id = `qd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    let queryCount = 0;
    let judgmentCount = 0;
    this.deps.db.transaction((tx) => {
      tx.insert(qualityDatasets)
        .values({
          id,
          name: input.name,
          description: input.description ?? "",
          language: input.language ?? "zh",
          version: 1,
          status: "draft",
          origin: "imported",
          judgmentsComplete: input.judgmentsComplete ?? false,
          createdAt: now,
          updatedAt: now,
          frozenAt: null,
        })
        .run();
      for (const [queryIndex, query] of input.queries.entries()) {
        const queryId = `qq_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        queryCount += 1;
        tx.insert(qualityQueries)
          .values({
            id: queryId,
            datasetId: id,
            query: query.query.trim(),
            category: query.category ?? "general",
            extraCategories: categoriesJson(labelSets[queryIndex]!),
            language: query.language ?? input.language ?? "zh",
            intent: query.intent ?? "",
            notes: query.notes ?? "",
            createdAt: now,
          })
          .run();
        for (const judgment of query.judgments ?? []) {
          judgmentCount += 1;
          tx.insert(qualityJudgments)
            .values({
              id: `qj_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
              datasetId: id,
              queryId,
              documentId: normalizeUrl(judgment.url)!,
              relevance: judgment.relevance,
              assessor: actor,
              source: "human",
              notes: judgment.notes ?? "",
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
      }
    });
    this.audit(actor, "quality.dataset.import", id, `${queryCount} queries / ${judgmentCount} judgments`);
    const row = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, id)).get()!;
    return { dataset: toDataset(row), queries: queryCount, judgments: judgmentCount };
  }

  /**
   * One page of datasets, with the total so the caller can tell "there are 12"
   * from "there are 12 000 and you are looking at the first page".
   *
   * The counts are computed for the page only. Aggregating over every dataset
   * would make listing cost grow with history, and the numbers a caller needs
   * to decide whether to page further are the ones on the page.
   */
  listDatasets(options: { limit?: number; offset?: number } = {}): {
    datasets: Array<QualityDataset & { queryCount: number; judgmentCount: number }>;
    total: number;
    hasMore: boolean;
    limit: number;
    offset: number;
  } {
    const limit = Math.min(DATASET_PAGE_MAX, Math.max(1, Math.round(options.limit ?? DATASET_PAGE_DEFAULT)));
    const offset = Math.max(0, Math.round(options.offset ?? 0));
    const totalRow = this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(qualityDatasets)
      .get();
    const total = Number(totalRow?.count ?? 0);
    const rows = this.deps.db
      .select()
      .from(qualityDatasets)
      .orderBy(desc(qualityDatasets.updatedAt), desc(qualityDatasets.id))
      .limit(limit)
      .offset(offset)
      .all();
    if (rows.length === 0) return { datasets: [], total, hasMore: false, limit, offset };
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
    return {
      datasets: rows.map((row) => ({
        ...toDataset(row),
        queryCount: queryCounts.get(row.id) ?? 0,
        judgmentCount: judgmentCounts.get(row.id) ?? 0,
      })),
      total,
      hasMore: offset + rows.length < total,
      limit,
      offset,
    };
  }

  /**
   * One dataset with its queries and judgments, paged.
   *
   * `queries` and `judgments` keep their original names and type so an existing
   * caller still works; what changes is that they hold at most one page. The
   * `*Page` blocks carry the totals, which is the only way a caller can tell a
   * complete response from a truncated one.
   *
   * `coverage` is always computed over the **whole** dataset. Deriving it from
   * the page would make the reported coverage depend on how far the reader
   * scrolled, which is exactly the kind of quietly-wrong number this lab is
   * meant to avoid.
   */
  getDataset(
    id: string,
    options: {
      queriesLimit?: number;
      queriesOffset?: number;
      judgmentsLimit?: number;
      judgmentsOffset?: number;
    } = {},
  ): {
    dataset: QualityDataset;
    queries: QualityQuery[];
    judgments: QualityJudgment[];
    coverage: {
      judgedDocuments: number;
      judgedQueries: number;
      queryCount: number;
      unjudgedQueries: number;
      unjudgedQueryIds: string[];
    };
    queriesPage: { total: number; offset: number; limit: number; hasMore: boolean };
    judgmentsPage: { total: number; offset: number; limit: number; hasMore: boolean };
  } {
    const row = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, id)).get();
    if (!row) throw new SearchHubError("not_found", "Dataset not found");

    const queriesLimit = clampPage(options.queriesLimit, DETAIL_PAGE_DEFAULT, DETAIL_PAGE_MAX);
    const queriesOffset = Math.max(0, Math.round(options.queriesOffset ?? 0));
    const judgmentsLimit = clampPage(options.judgmentsLimit, DETAIL_PAGE_DEFAULT, DETAIL_PAGE_MAX);
    const judgmentsOffset = Math.max(0, Math.round(options.judgmentsOffset ?? 0));

    const queryTotal = Number(
      this.deps.db
        .select({ count: sql<number>`count(*)` })
        .from(qualityQueries)
        .where(eq(qualityQueries.datasetId, id))
        .get()?.count ?? 0,
    );
    const judgmentTotal = Number(
      this.deps.db
        .select({ count: sql<number>`count(*)` })
        .from(qualityJudgments)
        .where(eq(qualityJudgments.datasetId, id))
        .get()?.count ?? 0,
    );

    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, id))
      .orderBy(qualityQueries.id)
      .limit(queriesLimit)
      .offset(queriesOffset)
      .all()
      .map((item) => ({
        id: item.id,
        datasetId: item.datasetId,
        query: item.query,
        category: item.category as QueryCategory,
        categories: categoriesOf(item),
        language: item.language,
        intent: item.intent,
        notes: item.notes,
        createdAt: item.createdAt,
      }));
    const judgments = this.deps.db
      .select()
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, id))
      .orderBy(qualityJudgments.queryId, qualityJudgments.documentId)
      .limit(judgmentsLimit)
      .offset(judgmentsOffset)
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

    // Aggregate over the whole qrel set, in SQL, not over the page.
    const judgedPerQuery = this.deps.db
      .select({ queryId: qualityJudgments.queryId, count: sql<number>`count(*)` })
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, id))
      .groupBy(qualityJudgments.queryId)
      .all();
    const judgedIds = new Set(judgedPerQuery.map((item) => item.queryId));
    const unjudgedIds = this.deps.db
      .select({ id: qualityQueries.id })
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, id))
      .all()
      .map((item) => item.id)
      .filter((queryId) => !judgedIds.has(queryId));

    return {
      dataset: toDataset(row),
      queries,
      judgments,
      coverage: {
        judgedDocuments: judgmentTotal,
        judgedQueries: judgedPerQuery.length,
        queryCount: queryTotal,
        unjudgedQueries: unjudgedIds.length,
        unjudgedQueryIds: unjudgedIds.slice(0, 200),
      },
      queriesPage: {
        total: queryTotal,
        offset: queriesOffset,
        limit: queriesLimit,
        hasMore: queriesOffset + queries.length < queryTotal,
      },
      judgmentsPage: {
        total: judgmentTotal,
        offset: judgmentsOffset,
        limit: judgmentsLimit,
        hasMore: judgmentsOffset + judgments.length < judgmentTotal,
      },
    };
  }

  /**
   * Every query and judgment of one dataset, for export.
   *
   * Export is the one caller that legitimately needs the whole set: a partial
   * export would silently become a smaller dataset when re-imported. The sizes
   * are bounded by the same limits the import enforces, so this cannot be used
   * to read an unbounded table.
   */
  exportDataset(id: string): {
    dataset: QualityDataset;
    queries: Array<QualityQuery & { extraCategories: QueryCategory[] }>;
    judgments: QualityJudgment[];
  } {
    const row = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, id)).get();
    if (!row) throw new SearchHubError("not_found", "Dataset not found");
    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, id))
      .orderBy(qualityQueries.id)
      .all()
      .map((item) => ({
        id: item.id,
        datasetId: item.datasetId,
        query: item.query,
        category: item.category as QueryCategory,
        extraCategories: parseExtraCategories(item.extraCategories),
        language: item.language,
        intent: item.intent,
        notes: item.notes,
        createdAt: item.createdAt,
      }));
    const judgments = this.deps.db
      .select()
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, id))
      .orderBy(qualityJudgments.queryId, qualityJudgments.documentId)
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
    return { dataset: toDataset(row), queries, judgments };
  }

  /**
   * Queries in a dataset that nobody has judged.
   *
   * "unjudged" is not "irrelevant". This endpoint exists so an operator can see
   * *which* queries are still unmeasured and decide whether to label them or to
   * accept a provisional score — a count alone invites reading the gap as zero.
   *
   * `includeDocuments` scans stored run results for documents that were returned
   * but never graded. It reports `no_run_results` rather than an empty list when
   * the query has never been evaluated, so "nothing was found" is not mistaken
   * for "everything was judged".
   */
  listUnjudged(
    datasetId: string,
    options: { limit?: number; offset?: number; includeDocuments?: boolean } = {},
  ): {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    queries: Array<{
      queryId: string;
      query: string;
      categories: QueryCategory[];
      judgmentCount: number;
      documents?: Array<{
        documentId: string;
        url: string;
        bestRank: number;
        providers: string[];
        seenInRuns: number;
      }>;
      reason?: "no_run_results";
    }>;
  } {
    const row = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, datasetId)).get();
    if (!row) throw new SearchHubError("not_found", "Dataset not found");

    const limit = clampPage(options.limit, 50, 200);
    const offset = Math.max(0, Math.round(options.offset ?? 0));

    const judgedCounts = new Map(
      this.deps.db
        .select({ queryId: qualityJudgments.queryId, count: sql<number>`count(*)` })
        .from(qualityJudgments)
        .where(eq(qualityJudgments.datasetId, datasetId))
        .groupBy(qualityJudgments.queryId)
        .all()
        .map((item) => [item.queryId, Number(item.count)]),
    );

    const allQueries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, datasetId))
      .orderBy(qualityQueries.id)
      .all()
      .filter((query) => (judgedCounts.get(query.id) ?? 0) === 0);
    const total = allQueries.length;
    const page = allQueries.slice(offset, offset + limit);

    const gradeById = new Map<string, Set<string>>();
    if (options.includeDocuments === true && page.length > 0) {
      const judged = this.deps.db
        .select({ queryId: qualityJudgments.queryId, documentId: qualityJudgments.documentId })
        .from(qualityJudgments)
        .where(eq(qualityJudgments.datasetId, datasetId))
        .all();
      for (const item of judged) {
        const set = gradeById.get(item.queryId) ?? new Set<string>();
        set.add(item.documentId);
        gradeById.set(item.queryId, set);
      }
    }

    const queries = page.map((query) => {
      const base = {
        queryId: query.id,
        query: query.query,
        categories: categoriesOf(query),
        judgmentCount: judgedCounts.get(query.id) ?? 0,
      };
      if (options.includeDocuments !== true) return base;

      const results = this.deps.db
        .select()
        .from(qualityRunResults)
        .where(eq(qualityRunResults.queryId, query.id))
        .all();
      if (results.length === 0) return { ...base, documents: [], reason: "no_run_results" as const };

      const seen = new Map<string, { url: string; bestRank: number; providers: Set<string>; runs: number }>();
      for (const result of results) {
        let ranked: Array<{ documentId: string; url: string }> = [];
        try {
          ranked = JSON.parse(result.rankedJson) as Array<{ documentId: string; url: string }>;
        } catch {
          continue;
        }
        ranked.forEach((document, index) => {
          if (gradeById.get(query.id)?.has(document.documentId)) return;
          const entry = seen.get(document.documentId) ?? {
            url: document.url,
            bestRank: index + 1,
            providers: new Set<string>(),
            runs: 0,
          };
          entry.bestRank = Math.min(entry.bestRank, index + 1);
          entry.runs += 1;
          seen.set(document.documentId, entry);
        });
        // Providers are not stored per row; the snapshot is the only place that
        // records who returned a document, and it is optional by design.
        const snapshot = this.deps.db
          .select()
          .from(qualitySnapshots)
          .where(eq(qualitySnapshots.queryId, query.id))
          .get();
        if (snapshot) {
          try {
            const providers = JSON.parse(snapshot.snapshotJson) as Array<{
              providerId?: string;
              results?: Array<{ url?: string }>;
            }>;
            for (const provider of providers) {
              for (const providerResult of provider.results ?? []) {
                if (typeof providerResult.url !== "string") continue;
                const id = normalizeUrl(providerResult.url);
                const entry = id === null ? undefined : seen.get(id);
                if (entry && typeof provider.providerId === "string") entry.providers.add(provider.providerId);
              }
            }
          } catch {
            /* a corrupt snapshot only costs the provider attribution */
          }
        }
      }

      const documents = [...seen.entries()]
        .map(([documentId, entry]) => ({
          documentId,
          url: entry.url,
          bestRank: entry.bestRank,
          providers: [...entry.providers].sort(),
          seenInRuns: entry.runs,
        }))
        .sort((left, right) => left.bestRank - right.bestRank || (left.url < right.url ? -1 : 1))
        .slice(0, 50);
      return { ...base, documents };
    });

    return { total, limit, offset, hasMore: offset + page.length < total, queries };
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
    // Validate every label set before writing anything: a rejected query must
    // not leave the earlier ones behind, because the import would then be
    // half-applied and the dataset version would claim a change it never made.
    const labelSets = inputs.map((input, index) =>
      validateCategories(input.category ?? "general", input.extraCategories, { queries: index }),
    );
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
            extraCategories: categoriesJson(labelSets[index]!),
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
        // The document id *is* the normalized URL (see evaluation/types.ts).
        // Storing the caller's raw string would let `?utm_source=` split one
        // page into two documents, and the qrel would silently never match the
        // snapshot — the query would look unjudged instead of mismatched.
        const raw = input.documentId ?? input.url!;
        const documentId = normalizeUrl(raw);
        if (!documentId) {
          throw new SearchHubError(
            "validation_error",
            `"${raw}" is not a usable http(s) document URL`,
          );
        }
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
        // Freezing is the moment a qrel set becomes a fixed question, so the
        // version moves here. A later fork continues from it.
        version: row.version + 1,
        ...(input.judgmentsComplete === undefined ? {} : { judgmentsComplete: input.judgmentsComplete }),
      })
      .where(eq(qualityDatasets.id, datasetId))
      .run();
    this.audit(actor, "quality.dataset.freeze", datasetId, `v${row.version}`);
    return toDataset({
      ...row,
      status: "frozen",
      frozenAt: now,
      updatedAt: now,
      version: row.version + 1,
      judgmentsComplete: input.judgmentsComplete ?? row.judgmentsComplete,
    });
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

  listRuns(options: { datasetId?: string; limit?: number; offset?: number } = {}): {
    runs: RunSummary[];
    total: number;
    hasMore: boolean;
  } {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const offset = Math.max(0, Math.round(options.offset ?? 0));
    const where = options.datasetId ? eq(qualityRuns.datasetId, options.datasetId) : undefined;
    const totalRow = this.deps.db
      .select({ count: sql<number>`count(*)` })
      .from(qualityRuns)
      .where(where)
      .get();
    const total = Number(totalRow?.count ?? 0);
    const rows = this.deps.db
      .select()
      .from(qualityRuns)
      .where(where)
      .orderBy(desc(qualityRuns.startedAt), desc(qualityRuns.id))
      .limit(limit)
      .offset(offset)
      .all();
    return { runs: rows.map(toRunSummary), total, hasMore: offset + rows.length < total };
  }

  getRunDetail(runId: string): {
    run: RunSummary;
    metrics: Record<string, MetricValue>;
    latency: LatencyStats;
    cost: CostSummary;
    quality: Record<string, MetricValue>;
    /** Per-category means; groups overlap when a query carries two labels. */
    byCategory: CategoryBreakdown;
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
        (stored["cost"] as CostSummary | null) ?? {
          // A run that failed before finishing has no cost record. The counts
          // come from the run row; the money is unknown, and remains unknown.
          requests: row.requestsUsed,
          logicalSearches: row.queryCount,
          adapterAttempts: row.requestsUsed,
          httpRequests: row.requestsUsed,
          billableUnits: null,
          cacheHits: row.cacheHits,
          knownCost: null,
          estimatedCost: null,
          unknownCost: true,
        },
      quality: (stored["quality"] as Record<string, MetricValue>) ?? {},
      byCategory: aggregateByCategory(
        results.map((item) => JSON.parse(item.metricsJson) as QueryMetrics),
        queries.map((item) => ({ queryId: item.id, categories: categoriesOf(item) })),
      ),
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

  cancelRun(runId: string, actor?: string): { cancelled: boolean } {
    const row = this.deps.db.select().from(qualityRuns).where(eq(qualityRuns.id, runId)).get();
    if (!row) throw new SearchHubError("not_found", "Run not found");
    // Same rule as a search task: one actor cannot cancel another's work.
    if (actor !== undefined && row.actor !== null && row.actor !== actor) {
      throw new SearchHubError("forbidden", "This run belongs to another actor");
    }
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

    // ---------------------------------------------------- run configuration
    //
    // These are rejected rather than clamped or ignored. A run record that
    // states a policy the engine never applied is worse than a 400: it makes the
    // report describe an experiment nobody ran.
    if (input.cachePolicy !== undefined && input.cachePolicy !== "bypass") {
      throw new SearchHubError(
        "validation_error",
        `cachePolicy "${String(input.cachePolicy)}" is not implemented in this version. ` +
          "Evaluation runs always bypass the response cache; omit the field or send \"bypass\".",
        { details: { unsupportedOption: "cachePolicy", supported: ["bypass"] } },
      );
    }
    if (input.maxConcurrency !== undefined && input.maxConcurrency !== 1) {
      throw new SearchHubError(
        "validation_error",
        `maxConcurrency ${String(input.maxConcurrency)} is not implemented in this version. ` +
          "Queries are evaluated serially; send 1 or omit the field. " +
          "Parallel execution would need a reservation-based budget, which this release does not have.",
        { details: { unsupportedOption: "maxConcurrency", supported: [1] } },
      );
    }
    if (input.perProviderLimit !== undefined) {
      if (
        !Number.isInteger(input.perProviderLimit) ||
        input.perProviderLimit < 1 ||
        input.perProviderLimit > QUALITY_LIMITS.maxResultsPerQuery
      ) {
        throw new SearchHubError(
          "validation_error",
          `perProviderLimit must be an integer between 1 and ${QUALITY_LIMITS.maxResultsPerQuery}`,
        );
      }
    }
    if (input.timeoutMs !== undefined) {
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 60_000) {
        // Deliberately not clamped: a clamped value would be recorded as if the
        // caller had asked for it.
        throw new SearchHubError("validation_error", "timeoutMs must be an integer between 500 and 60000");
      }
    }
    const perProviderLimit = input.perProviderLimit ?? limit;

    if (input.fusion.strategy === "single" && !input.fusion.providerId) {
      throw new SearchHubError("validation_error", "A single-provider baseline needs fusion.providerId");
    }
    if (
      input.mode === "live" &&
      input.fusion.strategy === "single" &&
      input.fusion.providerId &&
      !(input.providerIds ?? []).includes(input.fusion.providerId)
    ) {
      // Otherwise every request is spent and the run fails on the last step
      // because the baseline provider is not in the captured snapshot.
      throw new SearchHubError(
        "validation_error",
        "fusion.providerId must also appear in providerIds for a live run",
      );
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
      // Worst case from the *actual* retry allowance, not a guessed one: the
      // engine issues up to `1 + maxRetries` attempts per provider, and
      // maxRetries may be 5. Assuming 2 would let a run through that can spend
      // three times its budget.
      const perQueryWorstCase = this.requestsPerQuery(providerIds, perProviderLimit);
      const worstCase = selected.length * perQueryWorstCase;
      if (worstCase > budget) {
        throw new SearchHubError(
          "validation_error",
          `This run could issue up to ${worstCase} upstream HTTP requests ` +
            `(${selected.length} queries × ${perQueryWorstCase} per query across ${providerIds.length} provider(s), ` +
            `counting retries, pages and redirects) but requestBudget is ${budget}. ` +
            "Raise the budget or reduce the scope.",
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
      const stored = this.deps.db
        .select({ count: sql<number>`count(*)` })
        .from(qualitySnapshots)
        .where(eq(qualitySnapshots.runId, input.snapshotRunId))
        .get();
      if (Number(stored?.count ?? 0) === 0) {
        // A fixture run never stores snapshots, so "re-rank it" would produce an
        // empty run that still reports `completed`.
        throw new SearchHubError(
          "validation_error",
          "That run has no stored snapshots to re-rank; run a live capture first",
        );
      }
    } else if (datasetRow.origin !== "synthetic_fixture") {
      throw new SearchHubError(
        "validation_error",
        "An offline run needs snapshots. Capture one live run first, then re-rank it with snapshotRunId.",
      );
    }


    // --------------------------------------------------------- provenance
    const judgeRows = this.deps.db
      .select({
        queryId: qualityJudgments.queryId,
        documentId: qualityJudgments.documentId,
        relevance: qualityJudgments.relevance,
      })
      .from(qualityJudgments)
      .where(eq(qualityJudgments.datasetId, input.datasetId))
      .all();
    const qrelsDigest = qrelsFingerprint(judgeRows, datasetRow.judgmentsComplete);
    const usedProviderIds = this.resolveProviderIds(input, datasetRow);
    const providerDigest = this.providerFingerprintFor(usedProviderIds);
    // This version's evaluation path never invokes a model, so the honest value
    // is `null`. It is not "unknown": a run that used a model would report one.
    const modelDigest = modelFingerprint([]);

    const id = `qr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date(this.now()).toISOString();
    try {
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
        cutoffValue: cutoff,
        snapshotRunId: input.snapshotRunId ?? null,
        codeCommit: this.deps.codeCommit ?? null,
        engineVersion: this.deps.engineVersion,
        providerIdsJson: JSON.stringify(usedProviderIds),
        providerFingerprint: providerDigest,
        modelFingerprint: modelDigest,
        qrelsFingerprint: qrelsDigest,
        perProviderLimit,
        requestTimeoutMs: input.timeoutMs ?? null,
        failureReason: null,
        persistedQueryCount: 0,
        partial: false,
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
    } catch (writeError) {
      // The very first write failed: there is no run row to mark, so the honest
      // answer is the storage error itself rather than a 500 that hides it.
      if (isDiskFull(writeError)) throw persistenceFailure(id, writeError);
      throw writeError;
    }

    const controller = new AbortController();
    this.controllers.set(id, controller);
    const persistedQueries = selected.map((row) => ({
      id: row.id,
      query: row.query,
      category: row.category as QueryCategory,
      extraCategories: parseExtraCategories(row.extraCategories),
      language: row.language,
    }));
    this.runningRuns.set(id, { persisted: 0, total: selected.length, controller });
    void this.execute({
      runId: id,
      datasetRow,
      queries: persistedQueries,
      input,
      limit,
      perProviderLimit,
      cutoff,
      controller,
    })
      // The promise must be observed. `execute` already records its own
      // failure, but if that recording throws too (a full disk fails the
      // *failure* write), an unhandled rejection would take the process down
      // and lose every other in-flight run with it.
      .catch((error: unknown) => {
        this.deps.logger.error({ err: error, runId: id }, "quality run crashed outside its failure handler");
      })
      .finally(() => {
        this.controllers.delete(id);
        this.runningRuns.delete(id);
      });

    // Read the row back instead of rebuilding it here: a hand-written copy of
    // the insert payload silently drifts from the table whenever a column is
    // added, and the response would then claim values the database does not
    // hold.
    const stored = this.deps.db.select().from(qualityRuns).where(eq(qualityRuns.id, id)).get();
    if (!stored) throw new SearchHubError("internal_error", "The run row could not be read back after insert");
    return toRunSummary(stored);
  }

  private async execute(args: {
    runId: string;
    datasetRow: typeof qualityDatasets.$inferSelect;
    queries: Array<{
      id: string;
      query: string;
      category: QueryCategory;
      extraCategories: QueryCategory[];
      language: string;
    }>;
    input: RunInput;
    limit: number;
    perProviderLimit: number;
    cutoff: number;
    controller: AbortController;
  }): Promise<void> {
    const { runId, datasetRow, queries, input, limit, perProviderLimit, cutoff } = args;
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
    let adapterAttempts = 0;
    const latencies: number[] = [];
    /** Measured wall time per query, so a row cannot inherit another's. */
    const latencyByQuery = new Map<string, number>();
    const requestsByProvider: Record<string, number> = {};

    try {
      if (input.mode === "live") {
        const providerIds = input.providerIds ?? [];
        const budget = Math.round(input.requestBudget ?? 0);
        for (const query of queries) {
          if (args.controller.signal.aborted) break;
          // Worst case for this query before issuing it.
          const worstCase = this.requestsPerQuery(providerIds, args.perProviderLimit);
          if (requestsUsed + worstCase > budget) {
            this.deps.logger.warn(
              { runId, requestsUsed, budget },
              "quality run stopped at its request budget",
            );
            break;
          }
          const started = this.now();
          // The per-query pre-check above is an early exit; this gate is the
          // real ceiling. It runs before *every* physical request, so a
          // paginated adapter cannot spend the budget of three queries by
          // fetching three pages, and a retry cannot spend it twice.
          let budgetRefused = false;
          const response = await this.deps.search.execute(
            {
              query: query.query,
              limit,
              perProviderLimit,
              mode: "basic",
              providers: providerIds,
              skipCache: true,
              ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            },
            {
              signal: args.controller.signal,
              evaluate: true,
              actor: `quality:${runId}`,
              beforeRequest: (_providerId, _url) => {
                if (requestsUsed >= budget) {
                  budgetRefused = true;
                  // `blocked`, not `quota_exceeded`: this is our own ceiling, not
                  // the vendor's. Reusing the quota code would make the key
                  // scheduler cool the operator's key until UTC midnight for a
                  // decision that had nothing to do with the vendor.
                  throw new SearchHubError(
                    "blocked",
                    `Request budget of ${budget} upstream requests is exhausted; refusing further traffic.`,
                  );
                }
                requestsUsed += 1;
              },
            },
          );
          const latencyMs = Math.max(0, this.now() - started);
          latencies.push(latencyMs);
          // Bound to the query, not to loop order: the old code wrote
          // `latencies[latencies.length - 1]` at persist time, which silently
          // attributed the last measured query's time to whichever row happened
          // to be written.
          latencyByQuery.set(query.id, latencyMs);
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
            // Physical HTTP requests, not adapter attempts: this is what the
            // vendor sees and what the budget above already consumed.
            const physical = stat.httpRequests ?? stat.attempts;
            requestsByProvider[stat.providerId] = (requestsByProvider[stat.providerId] ?? 0) + physical;
            adapterAttempts += stat.attempts;
          }
          if (budgetRefused) {
            this.deps.logger.warn({ runId, budget }, "quality run stopped at its request budget");
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
          // Persist them like a live capture so a fixture run can itself be
          // re-ranked with a different strategy. Without this, `snapshotRunId`
          // pointing at a fixture run would silently produce an empty run.
          this.deps.db
            .insert(qualitySnapshots)
            .values({
              runId,
              queryId: snapshot.queryId,
              snapshotJson: JSON.stringify(snapshot.providers),
              createdAt: new Date(this.now()).toISOString(),
            })
            .onConflictDoNothing()
            .run();
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
          queryOutcome.set(query.id, { partial: false, failed: true });
          this.persistResult(
            runId,
            query.id,
            "failed",
            { documents: [] },
            empty,
            latencyByQuery.get(query.id) ?? null,
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
        // The row status follows the *search* verdict, not the mere presence of
        // a snapshot. A run whose providers all failed still stores an empty
        // snapshot for audit, and recording that as "ok" is how a report ends
        // up claiming 100% success while every request failed.
        const outcome = queryOutcome.get(query.id);
        const status = outcome?.failed ? "failed" : "ok";
        this.persistResult(
          runId,
          query.id,
          status,
          ranked,
          metrics,
          latencyByQuery.get(query.id) ?? null,
          status === "failed" ? "Every selected provider failed for this query" : null,
          snapshot.upstreamRequests,
        );
      }

      const diversity = this.diversitySignals(queries, snapshots, input.fusion, limit, input.providerIds ?? []);
      const quality = {
        resultCount: this.meanValue(documentCounts),
        duplicateRate: this.duplicateRate(queries, snapshots, input.fusion),
        uniqueDomainCount: this.meanValue(diversity.uniqueDomainCount),
        providerCoverage: this.meanValue([diversity.providerCoverage]),
        sourceDiversity: this.meanValue(diversity.sourceDiversity),
        emptyResultRate: rateMetric(documentCounts.map((count) => count === 0)),
        failedQueryRate: rateMetric(
          // A query counts as failed when its search verdict was `failed` —
          // including the case where an empty snapshot exists. Presence of a
          // snapshot is not evidence that the search worked.
          queries.map((query) => queryOutcome.get(query.id)?.failed === true),
        ),
        // System availability, reported separately from relevance: a run where
        // half the queries errored has a quality problem that P@k cannot express.
        succeededQueryRate: rateMetric(queries.map((query) => queryOutcome.get(query.id) ? queryOutcome.get(query.id)!.failed === false && queryOutcome.get(query.id)!.partial === false : snapshots.has(query.id))),
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
        logicalSearches: queries.length,
        adapterAttempts,
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
      const reason =
        error instanceof SearchHubError &&
        (error.details as { reason?: string } | undefined)?.reason === "persistence_failed"
          ? "persistence_failed"
          : args.controller.signal.aborted
            ? "cancelled"
            : "internal_error";
      this.markFailed(runId, reason, message);
      // Rethrown only for a storage failure, so the promise settles with the
      // 507-bearing error and `startRun`'s catch sees it. Every other path has
      // already been recorded and must not surface as a crashed promise.
      if (reason === "persistence_failed") throw error;
    }
  }

  /**
   * Upper bound on physical HTTP requests for one query across all providers.
   *
   * When the estimate is unavailable the fallback is deliberately pessimistic
   * (2 attempts × 4 pages), because an under-estimate is what turns a budget
   * into a suggestion.
   *
   * `perProviderLimit` participates because paging is what turns one adapter
   * attempt into several requests: asking a Brave-shaped source for 50 rows at
   * 20 per page costs three requests, and a budget that ignored the row count
   * would authorise a third of the traffic the vendor sees.
   */
  private requestsPerQuery(providerIds: readonly string[], perProviderLimit?: number): number {
    let total = 0;
    for (const id of providerIds) {
      total += Math.max(1, this.deps.providerMaxRequests?.(id, perProviderLimit) ?? 8);
    }
    return Math.max(1, total);
  }

  /**
   * Which providers a run is attributable to.
   *
   * `live` knows its list up front. An `offline` re-rank is attributable to the
   * providers inside the snapshots it re-ranked; a fixture run to the fixture's
   * own providers. Recorded rather than derived at read time, because the
   * provider set can be edited afterwards and the run must keep describing
   * itself.
   */
  private resolveProviderIds(
    input: RunInput,
    datasetRow: typeof qualityDatasets.$inferSelect,
  ): string[] {
    if (input.mode === "live") {
      return [...new Set(input.providerIds ?? [])].sort();
    }
    if (input.snapshotRunId) {
      const rows = this.deps.db
        .select({ snapshotJson: qualitySnapshots.snapshotJson })
        .from(qualitySnapshots)
        .where(eq(qualitySnapshots.runId, input.snapshotRunId))
        .all();
      const ids = new Set<string>();
      for (const row of rows) {
        try {
          const providers = JSON.parse(row.snapshotJson) as Array<{ providerId?: unknown }>;
          for (const provider of providers) {
            if (typeof provider.providerId === "string") ids.add(provider.providerId);
          }
        } catch {
          /* a corrupt snapshot must not stop the run from being attributable to nothing */
        }
      }
      return [...ids].sort();
    }
    if (datasetRow.origin === "synthetic_fixture") {
      const fixture = datasetRow.id === shallowFixture().dataset.id ? shallowFixture() : coreFixture();
      const ids = new Set<string>();
      for (const snapshot of fixture.snapshots) {
        for (const provider of snapshot.providers) ids.add(provider.providerId);
      }
      return [...ids].sort();
    }
    return [];
  }

  /**
   * Fingerprint of the participating providers, or `null` when the caller
   * cannot describe them.
   *
   * Only the providers that took part are included: adding a source later must
   * not change the fingerprint of a run that never used it, but changing a
   * participating source's weight must.
   */
  private providerFingerprintFor(providerIds: readonly string[]): string | null {
    if (providerIds.length === 0) return null;
    const snapshot = this.deps.providerSnapshot?.() ?? [];
    const wanted = new Set(providerIds);
    const rows = snapshot.filter((row) => wanted.has(row.id));
    // A provider that no longer exists cannot be described, and describing the
    // remaining ones would produce a digest of a different set.
    if (rows.length !== providerIds.length) return null;
    return providerFingerprint(rows);
  }

  /**
   * Structure of the result sets, which says nothing about relevance.
   *
   * Reported separately from P@k / nDCG on purpose: "more sources" and "more
   * domains" are not quality, and a blended score invites exactly that reading.
   */
  private diversitySignals(
    queries: ReadonlyArray<{ id: string }>,
    snapshots: ReadonlyMap<string, QuerySnapshot>,
    fusion: FusionParameters,
    limit: number,
    providersAsked: readonly string[],
  ): { uniqueDomainCount: number[]; providerCoverage: number; sourceDiversity: number[] } {
    const domains: number[] = [];
    const diversity: number[] = [];
    const contributing = new Set<string>();

    for (const query of queries) {
      const snapshot = snapshots.get(query.id);
      if (!snapshot) continue;
      const ranked = rankSnapshot(snapshot, fusion, { limit });
      const rows = ranked.documents.map((document) => ({ url: document.url }));
      let count = 0;
      for (const provider of snapshot.providers) {
        if (provider.results.length > 0) contributing.add(provider.providerId);
        count += provider.results.length;
      }
      const quality = resultSetQuality({
        documentUrls: rows.map((row) => row.url),
        providersAsked: Math.max(providersAsked.length, snapshot.providers.length),
        providersContributing: snapshot.providers.filter((provider) => provider.results.length > 0).length,
      });
      domains.push(quality.uniqueDomainCount);
      diversity.push(quality.sourceDiversity);
    }
    void limit;
    return {
      uniqueDomainCount: domains,
      providerCoverage: contributing.size,
      sourceDiversity: diversity,
    };
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
  ): MetricValue {
    let raw = 0;
    let unique = 0;
    for (const query of queries) {
      const snapshot = snapshots.get(query.id);
      if (!snapshot) continue;
      // De-duplicated *before* the display limit: counting only the first N
      // rows would make "30 raw rows, 10 shown" look like a 66% duplicate rate.
      const ranked = rankSnapshot(snapshot, fusion, { limit: QUALITY_LIMITS.maxResultsPerQuery });
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

  /**
   * Writes one query's result, and turns a write failure into a run failure.
   *
   * A database that cannot accept the row (a full disk, a locked file) is not a
   * problem with this query: the run has already lost the ability to record its
   * own work. It is marked `failed` here, before the exception leaves, because
   * the alternative is a run stuck at `running` forever with no explanation —
   * and an operator would read it as still in progress.
   */
  private persistResult(
    runId: string,
    queryId: string,
    status: string,
    ranked: { documents: Array<{ documentId: string; title: string; url: string }> },
    metrics: QueryMetrics,
    latencyMs: number | null,
    error: string | null,
    upstreamRequests = 0,
  ): void {
    try {
      this.deps.db
        .insert(qualityRunResults)
        .values({
          runId,
          queryId,
          status,
          rankedJson: JSON.stringify(ranked.documents),
          metricsJson: JSON.stringify(metrics),
          latencyMs,
          upstreamRequests,
          errorJson: error ? JSON.stringify({ message: error }) : null,
          createdAt: new Date(this.now()).toISOString(),
        })
        .run();
      const progress = this.runningRuns.get(runId);
      if (progress) progress.persisted += 1;
    } catch (writeError) {
      throw persistenceFailure(runId, writeError);
    }
  }

  /**
   * Records a failed run without letting the recording itself escape.
   *
   * When the same disk fault that broke a result write also breaks this update,
   * there is nothing left to persist: the caller still needs the 507 (or 500)
   * response, and an unhandled rejection here would take the process with it.
   */
  private markFailed(runId: string, reason: string, message: string, persisted?: number): void {
    try {
      this.deps.db
        .update(qualityRuns)
        .set({
          status: "failed",
          failureReason: reason,
          persistedQueryCount: persisted ?? this.runningRuns.get(runId)?.persisted ?? 0,
          partial: true,
          finishedAt: new Date(this.now()).toISOString(),
          errorJson: JSON.stringify({ message }),
        })
        .where(eq(qualityRuns.id, runId))
        .run();
    } catch (writeError) {
      this.deps.logger.error(
        { err: writeError, runId, reason },
        "quality run could not be marked failed; the database is unavailable",
      );
    }
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
      failureReason?: string;
      persistedQueryCount?: number;
      partial?: boolean;
    },
  ): void {
    const progress = this.runningRuns.get(runId);
    const persisted = payload.persistedQueryCount ?? progress?.persisted ?? 0;
    const total = progress?.total ?? 0;
    this.deps.db
      .update(qualityRuns)
      .set({
        status,
        finishedAt: new Date(this.now()).toISOString(),
        requestsUsed: payload.requestsUsed,
        cacheHits: payload.cacheHits,
        persistedQueryCount: persisted,
        partial: payload.partial ?? (status !== "completed" || (total > 0 && persisted < total)),
        failureReason: payload.failureReason ?? null,
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
  }): ComparisonSummary & {
    datasetId: string;
    datasetVersion: number;
    holdoutOnly: boolean;
    /** Per-category means; groups overlap when a query carries several labels. */
    byCategory: CategoryBreakdown;
    /** Document-level rank changes, judged documents only. */
    movements: {
      queries: Array<ReturnType<typeof queryMovements>>;
      hiddenUnjudgedMovements: number;
      categoryGroupsOverlap: boolean;
    };
  } {
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
    if (baseline.cutoffValue !== candidate.cutoffValue) {
      throw new SearchHubError(
        "validation_error",
        `The two runs measured different cutoffs (@${baseline.cutoffValue} vs @${candidate.cutoffValue})`,
      );
    }
    const cutoff = baseline.cutoffValue;

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

    const categoriesById = new Map(
      this.deps.db
        .select()
        .from(qualityQueries)
        .where(eq(qualityQueries.datasetId, baseline.datasetId))
        .all()
        .map((row) => [row.id, categoriesOf(row)]),
    );
    const judgedQueries: JudgedQuery[] = [...baselineRows.keys()].map((queryId) => {
      const grades = gradesByQuery.get(queryId) ?? new Map<string, RelevanceGrade>();
      return {
        queryId,
        query: textById.get(queryId) ?? queryId,
        category: categoryById.get(queryId) ?? "general",
        categories: categoriesById.get(queryId) ?? [categoryById.get(queryId) ?? "general"],
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
          }, { cutoff }),
      }),
      datasetId: baseline.datasetId,
      datasetVersion: baseline.datasetVersion,
      // A stored-run comparison covers exactly the queries both runs measured;
      // there is no hidden holdout. `sweepRrf` is where the split lives.
      holdoutOnly: false,
      byCategory: aggregateByCategory(
        [...baselineRows.values()].map((row) => row.metrics),
        judgedQueries.map((item) => ({
          queryId: item.queryId,
          categories: (item.categories ?? [item.category]) as QueryCategory[],
        })),
        metric,
      ),
      movements: this.buildMovements(baselineRows, candidateRows, gradesByQuery, judgedQueries),
    };
  }

  /**
   * Document-level rank changes for every query both runs measured.
   *
   * Unjudged documents are counted but withheld: "this unjudged result moved up
   * five places" is a fact about the ranking, not about quality, and mixing the
   * two is how a report starts implying that unranked means wrong.
   */
  private buildMovements(
    baselineRows: Map<string, { ranked: Array<{ documentId: string; title: string; url: string }> }>,
    candidateRows: Map<string, { ranked: Array<{ documentId: string; title: string; url: string }> }>,
    gradesByQuery: Map<string, Map<string, RelevanceGrade>>,
    judgedQueries: readonly JudgedQuery[],
  ): {
    queries: Array<ReturnType<typeof queryMovements>>;
    hiddenUnjudgedMovements: number;
    categoryGroupsOverlap: boolean;
  } {
    const categoryById = new Map(judgedQueries.map((item) => [item.queryId, item.category as QueryCategory]));
    const queries: Array<ReturnType<typeof queryMovements>> = [];
    let hidden = 0;
    for (const [queryId, baseline] of baselineRows) {
      const candidate = candidateRows.get(queryId);
      if (!candidate) continue;
      const movements = queryMovements(
        queryId,
        categoryById.get(queryId) ?? "general",
        baseline.ranked,
        candidate.ranked,
        gradesByQuery.get(queryId) ?? new Map<string, RelevanceGrade>(),
      );
      hidden += movements.hiddenUnjudgedMovements;
      queries.push(movements);
    }
    queries.sort((left, right) => (left.queryId < right.queryId ? -1 : left.queryId > right.queryId ? 1 : 0));
    return {
      queries,
      hiddenUnjudgedMovements: hidden,
      categoryGroupsOverlap: judgedQueries.some((item) => item.categories !== undefined && item.categories.length > 1),
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
    /** Re-rank this run's stored snapshots; required for a non-fixture dataset. */
    snapshotRunId?: string;
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
    if (dataset.origin !== "synthetic_fixture" && input.snapshotRunId === undefined) {
      throw new SearchHubError(
        "validation_error",
        "A parameter sweep needs stored snapshots. Run a live capture, then pass its run id as snapshotRunId.",
      );
    }
    const split = splitQueries(queries.map((row) => row.id), input.developmentShare ?? 0.5);
    const metric = input.metric ?? "ndcgAtK";
    const kValues = input.kValues ?? [20, 40, 60, 80, 100];

    const evaluated: Array<{
      k: number;
      development: Record<string, MetricValue>;
      holdout: Record<string, MetricValue>;
    }> = [];

    for (const k of kValues) {
      const development = this.evaluateSubset(input.datasetId, split.development, { strategy: "rrf", k }, input.snapshotRunId);
      const holdout = this.evaluateSubset(input.datasetId, split.holdout, { strategy: "rrf", k }, input.snapshotRunId);
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
    const comparison = compareRankings({
      metric,
      baseline: this.rankSubset(input.datasetId, split.holdout, { strategy: "rrf", k: 60 }, input.snapshotRunId),
      candidate: this.rankSubset(input.datasetId, split.holdout, { strategy: "rrf", k: chosen }, input.snapshotRunId),
      judgments: this.judgedSubset(input.datasetId, split.holdout),
      metricsFor: (ranked, judged) =>
        evaluateQuery(ranked.documents.map((document) => document.documentId), {
          queryId: judged.queryId,
          grades: judged.grades,
          relevantTotal: judged.relevantTotal,
        }),
    });

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

  /**
   * Snapshots for a parameter sweep.
   *
   * A synthetic fixture has them in code; any other dataset needs a completed
   * live capture, which is what `snapshotRunId` points at. Silently falling
   * back to the fixture would sweep parameters against queries that are not in
   * this dataset and report all N/A.
   */
  private snapshotsForSubset(
    datasetId: string,
    queryIds: readonly string[],
    snapshotRunId?: string,
  ): Map<string, QuerySnapshot> {
    const dataset = this.deps.db.select().from(qualityDatasets).where(eq(qualityDatasets.id, datasetId)).get();
    if (!dataset) throw new SearchHubError("not_found", "Dataset not found");
    const allowed = new Set(queryIds);

    if (dataset.origin === "synthetic_fixture" && snapshotRunId === undefined) {
      const fixture = dataset.id === shallowFixture().dataset.id ? shallowFixture() : coreFixture();
      return new Map(
        fixture.snapshots
          .filter((snapshot) => allowed.has(snapshot.queryId))
          .map((snapshot) => [snapshot.queryId, snapshot]),
      );
    }

    const sourceRunId =
      snapshotRunId ??
      this.deps.db
        .select({ id: qualityRuns.id })
        .from(qualityRuns)
        .where(and(eq(qualityRuns.datasetId, datasetId), eq(qualityRuns.status, "completed")))
        .orderBy(desc(qualityRuns.startedAt))
        .get()?.id;
    if (!sourceRunId) return new Map();

    const rows = this.deps.db
      .select()
      .from(qualitySnapshots)
      .where(eq(qualitySnapshots.runId, sourceRunId))
      .all();
    const byQuery = new Map<string, ProviderSnapshot[]>();
    for (const row of rows) {
      if (!allowed.has(row.queryId)) continue;
      byQuery.set(row.queryId, JSON.parse(row.snapshotJson) as ProviderSnapshot[]);
    }
    const queries = this.deps.db
      .select()
      .from(qualityQueries)
      .where(eq(qualityQueries.datasetId, datasetId))
      .all();
    const meta = new Map(queries.map((row) => [row.id, row]));
    return new Map(
      [...byQuery.entries()].map(([queryId, providers]) => {
        const row = meta.get(queryId);
        return [
          queryId,
          {
            queryId,
            query: row?.query ?? queryId,
            category: (row?.category ?? "general") as QueryCategory,
            providers,
            capturedAt: new Date(this.now()).toISOString(),
            upstreamRequests: 0,
            cacheHits: 0,
          } satisfies QuerySnapshot,
        ];
      }),
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

  private rankSubset(datasetId: string, queryIds: readonly string[], fusion: FusionParameters, snapshotRunId?: string) {
    const snapshots = this.snapshotsForSubset(datasetId, queryIds, snapshotRunId);
    return [...snapshots.values()].map((snapshot) => rankSnapshot(snapshot, fusion, { limit: 10 }));
  }

  private evaluateSubset(
    datasetId: string,
    queryIds: readonly string[],
    fusion: FusionParameters,
    snapshotRunId?: string,
  ): Record<string, MetricValue> {
    const snapshots = this.snapshotsForSubset(datasetId, queryIds, snapshotRunId);
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
