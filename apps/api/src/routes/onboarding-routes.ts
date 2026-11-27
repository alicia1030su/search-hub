import type { FastifyInstance, FastifyRequest } from "fastify";
import { PROVIDER_CATALOG } from "@search-hub/providers";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorLabel, authenticate, requireAdmin, type Actor } from "../auth.js";
import { audit, jsonFor, parseInput } from "../http.js";

const onboardingActionSchema = z.object({}).optional();
const RECOMMENDED_PROVIDER_ORDER = ["hackernews", "crossref", "openalex", "pubmed"] as const;

function actorOf(request: FastifyRequest, ctx: AppContext, mutation = false): Actor {
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

function recommendedProviders() {
  return RECOMMENDED_PROVIDER_ORDER.flatMap((type) => {
    const entry = PROVIDER_CATALOG.find((candidate) => candidate.type === type);
    if (!entry || entry.implementation !== "builtin" || entry.authType !== "none" ||
        entry.verification !== "live_tested" || (entry.capability ?? "raw_search") !== "raw_search") {
      return [];
    }
    return [{
      type: entry.type,
      name: entry.name,
      verification: entry.verification,
      authType: entry.authType,
      capability: entry.capability ?? "raw_search",
      category: entry.category,
      description: entry.description,
    }];
  });
}

function onboardingStatus(ctx: AppContext) {
  const onboarding = ctx.settings.get().onboarding;
  const readyProviderIds = ctx.providers.providerSummaries()
    .filter((provider) => provider.enabled && provider.ready)
    .map((provider) => provider.id);
  const completed = onboarding.completedAt !== null;
  const dismissed = onboarding.dismissedAt !== null;
  return {
    completed,
    dismissed,
    step: completed || dismissed || readyProviderIds.length > 0 ? 3 as const : 2 as const,
    steps: {
      admin: { complete: true },
      provider: { complete: readyProviderIds.length > 0, readyProviderIds },
      search: { complete: completed },
    },
    recommendedProviders: recommendedProviders(),
  };
}

export function registerOnboardingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/admin/onboarding/status",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      return onboardingStatus(ctx);
    }),
  );

  app.post(
    "/api/admin/onboarding/complete",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      parseInput(onboardingActionSchema, request.body ?? {});
      const now = new Date().toISOString();
      ctx.settings.update({
        onboarding: { completedAt: now, dismissedAt: null, lastSeenVersion: ctx.config.version },
      });
      audit(ctx, actorLabel(actor), "onboarding.complete", null, { version: ctx.config.version }, request.ip);
      return onboardingStatus(ctx);
    }),
  );

  app.post(
    "/api/admin/onboarding/dismiss",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      parseInput(onboardingActionSchema, request.body ?? {});
      const now = new Date().toISOString();
      ctx.settings.update({
        onboarding: { dismissedAt: now, lastSeenVersion: ctx.config.version },
      });
      audit(ctx, actorLabel(actor), "onboarding.dismiss", null, { version: ctx.config.version }, request.ip);
      return onboardingStatus(ctx);
    }),
  );
}
