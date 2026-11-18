import type { FastifyInstance, FastifyRequest } from "fastify";
import { SearchHubError } from "@search-hub/shared";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorLabel, authenticate, type Actor } from "../auth.js";
import { jsonFor, parseInput } from "../http.js";
import {
  QUALITY_LIMITS,
  type DatasetInput,
  type JudgmentInput,
  type QueryInput,
  type RunInput,
} from "../services/quality.js";

/**
 * Search quality evaluation endpoints.
 *
 * Everything here is `admin` scope, and every mutation additionally requires the
 * CSRF header. A `search`-scope token is rejected with 403: the qrels, the
 * queries and the scores are operator data, and they also reveal which vendors
 * an instance has configured.
 */
const categorySchema = z.enum([
  "general",
  "chinese",
  "english",
  "code",
  "academic",
  "news",
  "documentation",
  "factual",
  "multi_hop",
]);

const originSchema = z.enum(["manual", "imported", "synthetic_fixture"]);
const judgmentSourceSchema = z.enum(["human", "machine_generated", "synthetic_fixture"]);

const createDatasetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  origin: originSchema.optional(),
  judgmentsComplete: z.boolean().optional(),
});

const querySchema = z.object({
  query: z.string().trim().min(1).max(500),
  category: categorySchema.optional(),
  language: z.string().trim().min(2).max(16).optional(),
  intent: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
});

const addQueriesSchema = z.object({
  queries: z.array(querySchema).min(1).max(QUALITY_LIMITS.maxQueriesPerDataset),
});

const judgmentSchema = z
  .object({
    queryId: z.string().min(1),
    documentId: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    relevance: z.number().int().min(0).max(3),
    source: judgmentSourceSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((value) => value.documentId !== undefined || value.url !== undefined, {
    message: "Each judgment needs url or documentId",
  });

const addJudgmentsSchema = z.object({
  judgments: z.array(judgmentSchema).min(1).max(2000),
});

const freezeSchema = z.object({ judgmentsComplete: z.boolean().optional() }).default({});

const importSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  judgmentsComplete: z.boolean().optional(),
  queries: z
    .array(
      querySchema.extend({
        judgments: z
          .array(
            z.object({
              url: z.string().min(1),
              relevance: z.number().int().min(0).max(3),
              notes: z.string().max(2000).optional(),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .min(1)
    .max(QUALITY_LIMITS.maxQueriesPerDataset),
});

const fusionSchema = z.object({
  strategy: z.enum(["single", "base", "rrf"]),
  k: z.number().int().min(1).max(1000).optional(),
  providerWeights: z.record(z.string(), z.number().min(0).max(100)).optional(),
  providerId: z.string().min(1).optional(),
});

const runSchema = z.object({
  datasetId: z.string().min(1),
  name: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  mode: z.enum(["offline", "live"]),
  fusion: fusionSchema,
  limit: z.number().int().min(1).max(QUALITY_LIMITS.maxResultsPerQuery).optional(),
  cutoff: z.number().int().min(QUALITY_LIMITS.minCutoff).max(QUALITY_LIMITS.maxCutoff).optional(),
  unjudgedPolicy: z.enum(["exclude", "as_zero"]).optional(),
  queryIds: z.array(z.string().min(1)).max(QUALITY_LIMITS.maxQueriesPerRun).optional(),
  snapshotRunId: z.string().min(1).optional(),
  providerIds: z.array(z.string().min(1)).max(QUALITY_LIMITS.maxProvidersPerRun).optional(),
  requestBudget: z.number().int().min(1).max(QUALITY_LIMITS.maxRequestBudget).optional(),
  confirmPaid: z.boolean().optional(),
  unitCosts: z.record(z.string(), z.number().min(0)).optional(),
});

const sweepSchema = z.object({
  datasetId: z.string().min(1),
  kValues: z.array(z.number().int().min(1).max(1000)).min(1).max(10).optional(),
  metric: z.enum(["precisionAtK", "recallAtK", "mrrAtK", "ndcgAtK"]).optional(),
  developmentShare: z.number().min(0.2).max(0.8).optional(),
});

const pruneSchema = z.object({
  olderThanDays: z.number().int().min(1).max(3650),
  keepLatest: z.number().int().min(0).max(1000).optional(),
});

function adminOf(ctx: AppContext, request: FastifyRequest, mutation = false): Actor {
  return authenticate(
    {
      headers: request.headers as Record<string, string | string[] | undefined>,
      cookies: request.cookies as Record<string, string | undefined>,
      ip: request.ip,
    },
    ctx.authDeps,
    { scope: "admin", mutation },
  );
}

export function registerQualityRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------------------------------------------------------------- datasets

  app.get(
    "/api/admin/quality/datasets",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      return { datasets: ctx.quality.listDatasets() };
    }),
  );

  app.post(
    "/api/admin/quality/datasets",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const input = parseInput(createDatasetSchema, request.body ?? {});
      const dataset = ctx.quality.createDataset(input as DatasetInput, actorLabel(actor));
      return { dataset };
    }),
  );

  app.get(
    "/api/admin/quality/datasets/:id",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const { id } = request.params as { id: string };
      return ctx.quality.getDataset(id);
    }),
  );

  app.post(
    "/api/admin/quality/datasets/:id/queries",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      const input = parseInput(addQueriesSchema, request.body ?? {});
      const result = ctx.quality.addQueries(id, input.queries as QueryInput[], actorLabel(actor));
      return result;
    }),
  );

  app.post(
    "/api/admin/quality/datasets/:id/judgments",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      const input = parseInput(addJudgmentsSchema, request.body ?? {});
      return ctx.quality.upsertJudgments(
        id,
        input.judgments as JudgmentInput[],
        actorLabel(actor),
        actorLabel(actor),
      );
    }),
  );

  app.post(
    "/api/admin/quality/datasets/:id/freeze",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      const input = parseInput(freezeSchema, request.body ?? {});
      return { dataset: ctx.quality.freeze(id, input, actorLabel(actor)) };
    }),
  );

  app.post(
    "/api/admin/quality/datasets/:id/fork",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      return { dataset: ctx.quality.forkDataset(id, actorLabel(actor)) };
    }),
  );

  app.get(
    "/api/admin/quality/datasets/:id/export",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const { id } = request.params as { id: string };
      const detail = ctx.quality.getDataset(id);
      const byQuery = new Map<string, typeof detail.judgments>();
      for (const judgment of detail.judgments) {
        const list = byQuery.get(judgment.queryId) ?? [];
        list.push(judgment);
        byQuery.set(judgment.queryId, list);
      }
      return {
        format: "search-hub.quality.dataset/1",
        name: detail.dataset.name,
        description: detail.dataset.description,
        language: detail.dataset.language,
        origin: detail.dataset.origin,
        version: detail.dataset.version,
        judgmentsComplete: detail.dataset.judgmentsComplete,
        exportedAt: new Date().toISOString(),
        queries: detail.queries.map((query) => ({
          query: query.query,
          category: query.category,
          language: query.language,
          intent: query.intent,
          notes: query.notes,
          judgments: (byQuery.get(query.id) ?? []).map((judgment) => ({
            url: judgment.documentId,
            relevance: judgment.relevance,
            notes: judgment.notes,
          })),
        })),
      };
    }),
  );

  app.post(
    "/api/admin/quality/datasets/import",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const input = parseInput(importSchema, request.body ?? {});
      return ctx.quality.importDataset(
        {
          name: input.name ?? "Imported dataset",
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.language === undefined ? {} : { language: input.language }),
          ...(input.judgmentsComplete === undefined ? {} : { judgmentsComplete: input.judgmentsComplete }),
          queries: input.queries.map((query) => ({
            query: query.query,
            ...(query.category === undefined ? {} : { category: query.category }),
            ...(query.language === undefined ? {} : { language: query.language }),
            ...(query.intent === undefined ? {} : { intent: query.intent }),
            ...(query.notes === undefined ? {} : { notes: query.notes }),
            ...(query.judgments === undefined
              ? {}
              : {
                  judgments: query.judgments.map((judgment) => ({
                    url: judgment.url,
                    relevance: judgment.relevance as 0 | 1 | 2 | 3,
                    ...(judgment.notes === undefined ? {} : { notes: judgment.notes }),
                  })),
                }),
          })),
        },
        actorLabel(actor),
      );
    }),
  );

  // -------------------------------------------------------------------- runs

  app.get(
    "/api/admin/quality/runs",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const query = request.query as { datasetId?: string; limit?: string };
      const limit = query.limit ? Number(query.limit) : 50;
      return {
        runs: ctx.quality.listRuns({
          ...(query.datasetId === undefined ? {} : { datasetId: query.datasetId }),
          limit: Number.isFinite(limit) ? limit : 50,
        }),
      };
    }),
  );

  app.post(
    "/api/admin/quality/runs",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const input = parseInput(runSchema, request.body ?? {});
      const run = ctx.quality.startRun(input as RunInput, actorLabel(actor));
      return { run };
    }),
  );

  app.get(
    "/api/admin/quality/runs/:id",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const { id } = request.params as { id: string };
      return ctx.quality.getRunDetail(id);
    }),
  );

  app.post(
    "/api/admin/quality/runs/:id/cancel",
    jsonFor(app, async (request) => {
      adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      const actor = adminOf(ctx, request, true);
      return ctx.quality.cancelRun(id, actorLabel(actor));
    }),
  );

  app.get(
    "/api/admin/quality/compare",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const query = request.query as { baseline?: string; candidate?: string; metric?: string };
      if (!query.baseline || !query.candidate) {
        throw new SearchHubError("validation_error", "baseline and candidate run ids are required");
      }
      const metric = query.metric ?? "ndcgAtK";
      if (!["precisionAtK", "recallAtK", "mrrAtK", "ndcgAtK"].includes(metric)) {
        throw new SearchHubError("validation_error", "metric must be one of precisionAtK, recallAtK, mrrAtK, ndcgAtK");
      }
      return ctx.quality.compare({
        baselineRunId: query.baseline,
        candidateRunId: query.candidate,
        metric: metric as "precisionAtK" | "recallAtK" | "mrrAtK" | "ndcgAtK",
      });
    }),
  );

  app.post(
    "/api/admin/quality/sweep",
    jsonFor(app, async (request) => {
      adminOf(ctx, request, true);
      const input = parseInput(sweepSchema, request.body ?? {});
      return ctx.quality.sweepRrf(input);
    }),
  );

  app.post(
    "/api/admin/quality/prune",
    jsonFor(app, async (request) => {
      adminOf(ctx, request, true);
      const input = parseInput(pruneSchema, request.body ?? {});
      return ctx.quality.pruneRuns(input);
    }),
  );

  app.post(
    "/api/admin/quality/fixtures",
    jsonFor(app, async (request) => {
      adminOf(ctx, request, true);
      return ctx.quality.ensureFixtures();
    }),
  );
}
