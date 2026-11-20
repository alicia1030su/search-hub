import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditLogs } from "@search-hub/db";
import {
  SearchHubError,
  batchTestCreateSchema,
  batchTestPreviewQuerySchema,
  healthSettingsPatchSchema,
} from "@search-hub/shared";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorLabel, authenticate, type Actor } from "../auth.js";
import { jsonFor, parseInput } from "../http.js";

/**
 * Provider health endpoints.
 *
 * Authorization split, deliberately:
 * - reading the overview / history: `admin` scope
 * - running a probe: `admin` scope **and** CSRF (it may spend vendor quota)
 *
 * Nothing here is reachable by a `search`-scope token: source health reveals
 * which vendors an operator has configured and whether their keys still work.
 */
const probeSchema = z.object({
  providerId: z.string().min(1).optional(),
  providerIds: z.array(z.string().min(1)).max(200).optional(),
  kind: z.enum(["connect", "search"]).default("connect"),
  keyId: z.string().min(1).optional(),
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

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/admin/health",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      return ctx.health.overview();
    }),
  );

  app.get(
    "/api/admin/health/history",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const query = request.query as { providerId?: string; limit?: string };
      if (!query.providerId) throw new SearchHubError("validation_error", "providerId is required");
      const limit = query.limit ? Number(query.limit) : 100;
      return { checks: ctx.health.history(query.providerId, Number.isFinite(limit) ? limit : 100) };
    }),
  );

  /**
   * Runs one or more probes.
   *
   * `kind: "search"` consults the per-run and per-day budget *before* the first
   * request; when it does not fit, the response reports `skipped` with the reason
   * instead of quietly spending money.
   */
  app.post(
    "/api/admin/health/check",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const input = parseInput(probeSchema, request.body ?? {});

      if (input.providerId && input.providerIds) {
        throw new SearchHubError("validation_error", "Use either providerId or providerIds, not both");
      }

      if (input.providerId) {
        const result = await ctx.health.checkOne(input.providerId, {
          kind: input.kind,
          ...(input.keyId === undefined ? {} : { keyId: input.keyId }),
          trigger: "manual",
        });
        audit(ctx, actor, "health.check", input.providerId, { kind: input.kind, status: result.status }, request.ip);
        return { results: [result], skipped: [], budget: ctx.health.budget() };
      }

      const run = await ctx.health.checkMany(input.providerIds ?? null, { kind: input.kind, trigger: "manual" });
      audit(
        ctx,
        actor,
        "health.check_all",
        null,
        { kind: input.kind, checked: run.results.length, skipped: run.skipped.length },
        request.ip,
      );
      return run;
    }),
  );

  /** Cheap, read-only view used by the integration page header. */
  app.get(
    "/api/admin/health/budget",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      return ctx.health.budget();
    }),
  );
}

function audit(
  ctx: AppContext,
  actor: Actor,
  action: string,
  target: string | null,
  detail: unknown,
  ip: string,
): void {
  try {
    ctx.db
      .insert(auditLogs)
      .values({
        actor: actorLabel(actor),
        action,
        target,
        detailJson: JSON.stringify(detail),
        ip,
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch {
    // Auditing a probe must never fail the probe itself.
  }
}

/**
 * Provider Health Management Centre.
 *
 * `/api/admin/health*` above stays as the compatibility surface; these paths are
 * the ones the management page calls, and they add the pieces the old surface
 * never exposed (per-provider switching, reset, policy round-trip, budget
 * ledger).
 *
 * Every handler requires an `admin` scope; the mutating ones additionally require
 * CSRF. A `search`-scope token must not learn which vendors exist or whether
 * their credentials still work.
 */
const autoProbeSchema = z.object({ enabled: z.boolean() });

const singleProbeSchema = z.object({
  kind: z.enum(["connect", "search"]).default("connect"),
  keyId: z.string().min(1).optional(),
});

export function registerProviderHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/admin/provider-health",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      return ctx.health.overview();
    }),
  );

  app.get(
    "/api/admin/provider-health/settings",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const policy = ctx.settings.get().health;
      return { policy, budget: ctx.health.budget() };
    }),
  );

  app.put(
    "/api/admin/provider-health/settings",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const input = parseInput(healthSettingsPatchSchema, request.body ?? {});
      const updated = ctx.settings.update({ health: input });
      audit(ctx, actor, "provider_health.settings", null, input, request.ip);
      return { policy: updated.health, budget: ctx.health.budget() };
    }),
  );

  app.get(
    "/api/admin/provider-health/history",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const query = request.query as { providerId?: string; limit?: string };
      if (!query.providerId) throw new SearchHubError("validation_error", "providerId is required");
      const limit = query.limit ? Number(query.limit) : 100;
      return { checks: ctx.health.history(query.providerId, Number.isFinite(limit) ? limit : 100) };
    }),
  );

  /**
   * Probes one provider.
   *
   * `kind: "search"` may cost money. The reservation happens inside the service
   * before the request, so an exhausted budget is a 429 with the ledger numbers
   * rather than a billed failure.
   */
  app.post(
    "/api/admin/provider-health/:id/probe",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      const input = parseInput(singleProbeSchema, request.body ?? {});
      const result = await ctx.health.checkOne(id, {
        kind: input.kind,
        ...(input.keyId === undefined ? {} : { keyId: input.keyId }),
        trigger: "manual",
      });
      audit(ctx, actor, "provider_health.probe", id, { kind: input.kind, status: result.status, cause: result.cause }, request.ip);
      return { result, budget: ctx.health.budget() };
    }),
  );

  app.post(
    "/api/admin/provider-health/:id/auto-probe",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      const input = parseInput(autoProbeSchema, request.body ?? {});
      ctx.health.setAutoProbe(id, input.enabled);
      audit(ctx, actor, "provider_health.auto_probe", id, { enabled: input.enabled }, request.ip);
      return { providerId: id, autoProbeEnabled: input.enabled };
    }),
  );

  app.post(
    "/api/admin/provider-health/:id/reset",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { id } = request.params as { id: string };
      const result = ctx.health.resetProvider(id);
      audit(ctx, actor, "provider_health.reset", id, result, request.ip);
      return result;
    }),
  );

  // ---- bulk provider test ----
  //
  // Four endpoints, one job model. Reading a preview or a job is an `admin`
  // read; starting and cancelling spend money and therefore need CSRF, exactly
  // like `/api/admin/health/check`.

  /**
   * What a run over this scope would do, without writing or spending anything.
   *
   * Deliberately a GET: the confirmation dialog may be opened and dismissed any
   * number of times, and opening it must never have a side effect (T08).
   */
  app.get(
    "/api/admin/provider-health/batch-test/preview",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const query = parseInput(batchTestPreviewQuerySchema, request.query ?? {});
      return ctx.batch.preview(query.kind, query.providerIds ?? null, query.includeKeyless);
    }),
  );

  /**
   * Starts a bulk run.
   *
   * The response is the job as it exists *now* (`status: "running"`); the caller
   * polls `GET …/:jobId` on `nextPollAfterMs`. Refusals happen before a row is
   * written, so a rejected request leaves nothing to poll.
   */
  app.post(
    "/api/admin/provider-health/batch-test",
    jsonFor(app, async (request, reply) => {
      const actor = adminOf(ctx, request, true);
      const input = parseInput(batchTestCreateSchema, request.body ?? {});
      const job = await ctx.batch.startBatch({
        kind: input.kind,
        providerIds: input.providerIds ?? null,
        includeKeyless: input.includeKeyless,
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        actor: actorLabel(actor),
      });
      audit(
        ctx,
        actor,
        "provider_health.batch_test",
        job.jobId,
        { kind: job.kind, total: job.counts.total, concurrency: job.concurrency, includeKeyless: job.includeKeyless },
        request.ip,
      );
      // 201: a run resource was created. A client that only accepts 200 can read
      // the same body from `GET …/:jobId`.
      void reply.status(201);
      return {
        jobId: job.jobId,
        status: job.status,
        total: job.counts.total,
        concurrency: job.concurrency,
      };
    }),
  );

  /** Progress, read from the database only: a restart cannot change the answer. */
  app.get(
    "/api/admin/provider-health/batch-test/:jobId",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const actor = adminOf(ctx, request);
      const { jobId } = request.params as { jobId: string };
      return ctx.batch.getJob(jobId, actorLabel(actor));
    }),
  );

  /**
   * Stops a run.
   *
   * Returns `skippedRemaining` so the UI can say how many sources were not
   * probed. Finished items are untouched: a cancel ends the run, it does not
   * erase what the run already learned.
   */
  app.post(
    "/api/admin/provider-health/batch-test/:jobId/cancel",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const { jobId } = request.params as { jobId: string };
      const result = ctx.batch.cancelBatch(jobId, actorLabel(actor));
      audit(ctx, actor, "provider_health.batch_cancel", jobId, result, request.ip);
      return result;
    }),
  );
}
