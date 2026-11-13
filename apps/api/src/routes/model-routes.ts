import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { SearchHubError, modelCreateSchema, modelUpdateSchema } from "@search-hub/shared";
import { modelConfigs } from "@search-hub/db";
import { validateGenericConfig } from "@search-hub/providers";
import type { AppContext } from "../context.js";
import { actorLabel, authenticate, requireAdmin, type Actor } from "../auth.js";
import { audit, jsonFor, parseInput } from "../http.js";
import { newId } from "../security/crypto.js";
import { assertModelBaseUrlAllowed } from "../services/models.js";

function actorOf(request: FastifyRequest, ctx: AppContext, mutation = false): Actor {
  return authenticate(
    {
      headers: request.headers as Record<string, string | string[] | undefined>,
      cookies: request.cookies as Record<string, string | undefined>,
      ip: request.ip,
    },
    ctx.authDeps,
    { scope: "search", mutation },
  );
}

function serialize(ctx: AppContext, row: typeof modelConfigs.$inferSelect) {
  const model = ctx.models.get(row.id);
  return {
    ...model,
    hasKey: Boolean(row.apiKeyCiphertext),
    apiKeyHint: row.apiKeyHint,
  };
}

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/admin/models", jsonFor(app, async (request) => {
    requireAdmin(actorOf(request, ctx));
    return ctx.db
      .select()
      .from(modelConfigs)
      .all()
      .map((row) => serialize(ctx, row));
  }));

  app.post(
    "/api/admin/models",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const input = parseInput(modelCreateSchema, request.body);
      // Reject a base URL that can never be used before storing it.
      assertModelBaseUrlAllowed(input.baseUrl, ctx.settings.ssrfPolicy());
      if (input.kind === "embedding" && input.dimensions === null) {
        // Dimension is required for embeddings so incompatible vectors are never stored.
        throw new SearchHubError("validation_error", "Embedding models require an explicit vector dimension");
      }
      const now = new Date().toISOString();
      const id = newId("mdl");
      const box = input.apiKey ? ctx.secrets.encrypt(input.apiKey) : null;

      ctx.db.transaction((tx) => {
        if (input.isDefault) {
          tx.update(modelConfigs).set({ isDefault: false }).where(eq(modelConfigs.kind, input.kind)).run();
        }
        tx.insert(modelConfigs)
          .values({
            id,
            kind: input.kind,
            name: input.name,
            providerType: input.providerType,
            baseUrl: input.baseUrl,
            apiKeyCiphertext: box?.ciphertext ?? null,
            apiKeyIv: box?.iv ?? null,
            apiKeyTag: box?.tag ?? null,
            apiKeyHint: input.apiKey ? ctx.secrets.hint(input.apiKey) : null,
            modelId: input.modelId,
            dimensions: input.dimensions ?? null,
            batchSize: input.batchSize,
            timeoutMs: input.timeoutMs,
            maxConcurrency: input.maxConcurrency,
            paramsJson: JSON.stringify(input.params ?? {}),
            enabled: input.enabled,
            isDefault: input.isDefault,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      });

      audit(ctx, actorLabel(actor), "model.create", id, { kind: input.kind, name: input.name }, request.ip);
      const row = ctx.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get()!;
      return serialize(ctx, row);
    }),
  );

  app.patch(
    "/api/admin/models/:id",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      const row = ctx.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get();
      if (!row) throw new SearchHubError("not_found", "Model not found");
      const input = parseInput(modelUpdateSchema, request.body);
      if (input.baseUrl !== undefined) {
        assertModelBaseUrlAllowed(input.baseUrl, ctx.settings.ssrfPolicy());
      }

      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (input.name !== undefined) patch["name"] = input.name;
      if (input.providerType !== undefined) patch["providerType"] = input.providerType;
      if (input.baseUrl !== undefined) patch["baseUrl"] = input.baseUrl;
      if (input.modelId !== undefined) patch["modelId"] = input.modelId;
      if (input.dimensions !== undefined) patch["dimensions"] = input.dimensions;
      if (input.batchSize !== undefined) patch["batchSize"] = input.batchSize;
      if (input.timeoutMs !== undefined) patch["timeoutMs"] = input.timeoutMs;
      if (input.maxConcurrency !== undefined) patch["maxConcurrency"] = input.maxConcurrency;
      if (input.enabled !== undefined) patch["enabled"] = input.enabled;
      if (input.params !== undefined) patch["paramsJson"] = JSON.stringify(input.params);
      if (input.apiKey) {
        const box = ctx.secrets.encrypt(input.apiKey);
        patch["apiKeyCiphertext"] = box.ciphertext;
        patch["apiKeyIv"] = box.iv;
        patch["apiKeyTag"] = box.tag;
        patch["apiKeyHint"] = ctx.secrets.hint(input.apiKey);
      }

      ctx.db.transaction((tx) => {
        if (input.isDefault === true) {
          tx.update(modelConfigs)
            .set({ isDefault: false })
            .where(eq(modelConfigs.kind, row.kind))
            .run();
          patch["isDefault"] = true;
        } else if (input.isDefault === false) {
          patch["isDefault"] = false;
        }
        tx.update(modelConfigs).set(patch).where(eq(modelConfigs.id, id)).run();
      });

      audit(ctx, actorLabel(actor), "model.update", id, Object.keys(patch), request.ip);
      const updated = ctx.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get()!;
      return serialize(ctx, updated);
    }),
  );

  app.delete(
    "/api/admin/models/:id",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      const row = ctx.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get();
      if (!row) throw new SearchHubError("not_found", "Model not found");
      ctx.db.delete(modelConfigs).where(eq(modelConfigs.id, id)).run();
      audit(ctx, actorLabel(actor), "model.delete", id, { name: row.name }, request.ip);
      return { ok: true };
    }),
  );

  app.post(
    "/api/admin/models/:id/test",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      const result = await ctx.models.test(id, ctx.fetch);
      audit(ctx, actorLabel(actor), "model.test", id, { ok: result.ok }, request.ip);
      return result;
    }),
  );

  app.post(
    "/api/admin/providers/validate-generic",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx, true));
      const body = (request.body ?? {}) as { config?: unknown };
      const errors = validateGenericConfig(body.config);
      return { valid: errors.length === 0, errors };
    }),
  );
}
