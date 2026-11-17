import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditLogs } from "@search-hub/db";
import { SearchHubError, healthSettingsPatchSchema } from "@search-hub/shared";
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
}
