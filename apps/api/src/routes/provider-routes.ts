import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import {
  SearchHubError,
  groupCreateSchema,
  keyCreateSchema,
  keyUpdateSchema,
  providerCreateSchema,
  providerUpdateSchema,
} from "@search-hub/shared";
import { apiKeys, providerInstances, searchGroups, withTransaction } from "@search-hub/db";
import type { AppContext } from "../context.js";
import { actorLabel, authenticate, requireAdmin, type Actor } from "../auth.js";
import { audit, jsonFor, parseInput } from "../http.js";
import { newId } from "../security/crypto.js";
import { getAdapter, PROVIDER_CATALOG } from "@search-hub/providers";

function actorOf(
  request: FastifyRequest,
  ctx: AppContext,
  mutation = false,
  scope: "search" | "sources:read" | "admin" = "admin",
): Actor {
  return authenticate(
    {
      headers: request.headers as Record<string, string | string[] | undefined>,
      cookies: request.cookies as Record<string, string | undefined>,
      ip: request.ip,
    },
    ctx.authDeps,
    { scope, mutation },
  );
}

export function registerProviderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const listProviders = async () => ({
    providers: ctx.providers.providerSummaries(),
    status: ctx.providers.runtimeSnapshots(),
    catalog: PROVIDER_CATALOG,
    adapters: PROVIDER_CATALOG.filter((entry) => getAdapter(entry.type)).map((entry) => entry.type),
  });

  app.get("/api/providers", jsonFor(app, async (request) => {
    const actor = actorOf(request, ctx, false, "sources:read");
    void actor;
    return listProviders();
  }));

  app.get("/api/admin/providers", jsonFor(app, async (request) => {
    requireAdmin(actorOf(request, ctx, false, "admin"));
    return listProviders();
  }));

  app.post(
    "/api/admin/providers",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const input = parseInput(providerCreateSchema, request.body);
      ctx.providers.assertImplemented(input.type);

      const existing = ctx.db
        .select({ id: providerInstances.id })
        .from(providerInstances)
        .where(eq(providerInstances.name, input.name))
        .get();
      if (existing) throw new SearchHubError("conflict", `A provider named "${input.name}" already exists`);

      const now = new Date().toISOString();
      const id = newId("prv");
      const keyId = input.credential ? newId("key") : null;

      // Provider + first credential are one unit. If the credential cannot be
      // encrypted or written, the provider insert is rolled back too; otherwise
      // the UI would show a saved provider that can never authenticate.
      withTransaction(ctx.sqlite, () => {
        ctx.db
          .insert(providerInstances)
          .values({
            id,
            name: input.name,
            type: input.type,
            enabled: input.enabled,
            baseUrl: input.baseUrl ?? null,
            timeoutMs: input.timeoutMs,
            maxConcurrency: input.maxConcurrency,
            priority: input.priority,
            weight: input.weight,
            maxRetries: input.maxRetries,
            language: input.language ?? null,
            freshness: input.freshness ?? null,
            resultsPerPage: input.resultsPerPage,
            rpmLimit: input.rpmLimit,
            dailyQuota: input.dailyQuota ?? null,
            keyStrategy: input.keyStrategy,
            cooldownMs: input.cooldownMs,
            breakerThreshold: input.breakerThreshold,
            breakerCooldownMs: input.breakerCooldownMs,
            configJson: JSON.stringify(input.config ?? {}),
            createdAt: now,
            updatedAt: now,
          })
          .run();

        if (input.credential && keyId) {
          const box = ctx.secrets.encrypt(input.credential.key);
          ctx.db
            .insert(apiKeys)
            .values({
              id: keyId,
              providerId: id,
              label: input.credential.label,
              keyCiphertext: box.ciphertext,
              keyIv: box.iv,
              keyTag: box.tag,
              keyVersion: box.version,
              keyHint: ctx.secrets.hint(input.credential.key),
              weight: input.credential.weight,
              enabled: input.credential.enabled,
              status: "unknown",
              createdAt: now,
              updatedAt: now,
            })
            .run();
        }
      });

      // Reload only after the transaction committed, so the cache never exposes
      // a provider whose credential failed to persist.
      ctx.providers.reload();
      audit(
        ctx,
        actorLabel(actor),
        "provider.create",
        id,
        { name: input.name, type: input.type, withCredential: Boolean(input.credential) },
        request.ip,
      );
      return { provider: ctx.providers.providerSummaries().find((item) => item.id === id) };
    }),
  );

  app.patch(
    "/api/admin/providers/:id",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      const row = ctx.providers.getRow(id);
      if (!row) throw new SearchHubError("not_found", "Provider not found");
      const input = parseInput(providerUpdateSchema, request.body);
      if (input.type && input.type !== row.type) {
        ctx.providers.assertImplemented(input.type);
      }

      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const columns: Array<[keyof typeof input, string]> = [
        ["name", "name"],
        ["type", "type"],
        ["enabled", "enabled"],
        ["baseUrl", "baseUrl"],
        ["timeoutMs", "timeoutMs"],
        ["maxConcurrency", "maxConcurrency"],
        ["priority", "priority"],
        ["weight", "weight"],
        ["maxRetries", "maxRetries"],
        ["language", "language"],
        ["freshness", "freshness"],
        ["resultsPerPage", "resultsPerPage"],
        ["rpmLimit", "rpmLimit"],
        ["dailyQuota", "dailyQuota"],
        ["keyStrategy", "keyStrategy"],
        ["cooldownMs", "cooldownMs"],
        ["breakerThreshold", "breakerThreshold"],
        ["breakerCooldownMs", "breakerCooldownMs"],
      ];
      for (const [key, column] of columns) {
        const value = input[key];
        if (value !== undefined) patch[column] = value;
      }
      if (input.config !== undefined) patch["configJson"] = JSON.stringify(input.config);

      ctx.db.update(providerInstances).set(patch).where(eq(providerInstances.id, id)).run();
      ctx.providers.reload();
      audit(ctx, actorLabel(actor), "provider.update", id, Object.keys(patch), request.ip);
      return { provider: ctx.providers.providerSummaries().find((item) => item.id === id) };
    }),
  );

  app.delete(
    "/api/admin/providers/:id",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      const row = ctx.providers.getRow(id);
      if (!row) throw new SearchHubError("not_found", "Provider not found");
      ctx.providers.deleteRow(id);
      audit(ctx, actorLabel(actor), "provider.delete", id, { name: row.name }, request.ip);
      return { ok: true };
    }),
  );

  app.post(
    "/api/admin/providers/:id/test",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { keyId?: string };
      return testProvider(ctx, id, body.keyId);
    }),
  );

  app.get("/api/admin/providers/:id/status", jsonFor(app, async (request) => {
    requireAdmin(actorOf(request, ctx));
    const { id } = request.params as { id: string };
    const snapshot = ctx.providers.runtimeSnapshots().find((item) => item.providerId === id);
    if (!snapshot) throw new SearchHubError("not_found", "Provider not found");
    return snapshot;
  }));

  // ---- keys ----
  app.get("/api/admin/providers/:id/keys", jsonFor(app, async (request) => {
    requireAdmin(actorOf(request, ctx));
    const { id } = request.params as { id: string };
    return ctx.providers.listKeys(id);
  }));

  app.post(
    "/api/admin/providers/:id/keys",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      if (!ctx.providers.getRow(id)) throw new SearchHubError("not_found", "Provider not found");
      const input = parseInput(keyCreateSchema, request.body);
      const now = new Date().toISOString();
      const keyId = newId("key");
      const box = ctx.secrets.encrypt(input.key);
      ctx.db
        .insert(apiKeys)
        .values({
          id: keyId,
          providerId: id,
          label: input.label,
          keyCiphertext: box.ciphertext,
          keyIv: box.iv,
          keyTag: box.tag,
          keyVersion: box.version,
          keyHint: ctx.secrets.hint(input.key),
          weight: input.weight,
          enabled: input.enabled,
          status: "unknown",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      ctx.providers.reload();
      audit(ctx, actorLabel(actor), "key.create", keyId, { providerId: id, label: input.label }, request.ip);
      return ctx.providers.listKeys(id).find((key) => key.id === keyId);
    }),
  );

  app.patch(
    "/api/admin/keys/:keyId",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { keyId } = request.params as { keyId: string };
      const found = ctx.providers.findKeyById(keyId);
      if (!found) throw new SearchHubError("not_found", "API key not found");
      const input = parseInput(keyUpdateSchema, request.body);
      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (input.label !== undefined) patch["label"] = input.label;
      if (input.weight !== undefined) patch["weight"] = input.weight;
      if (input.enabled !== undefined) patch["enabled"] = input.enabled;
      if (input.key !== undefined) {
        const box = ctx.secrets.encrypt(input.key);
        patch["keyCiphertext"] = box.ciphertext;
        patch["keyIv"] = box.iv;
        patch["keyTag"] = box.tag;
        patch["keyVersion"] = box.version;
        patch["keyHint"] = ctx.secrets.hint(input.key);
        patch["status"] = "unknown";
        patch["consecutiveFailures"] = 0;
        patch["cooldownUntil"] = null;
      }
      ctx.db.update(apiKeys).set(patch).where(eq(apiKeys.id, keyId)).run();
      ctx.providers.reload();
      if (input.enabled !== undefined) {
        ctx.providers.setKeyEnabled(found.providerId, keyId, input.enabled);
      }
      audit(ctx, actorLabel(actor), "key.update", keyId, Object.keys(patch), request.ip);
      return ctx.providers.listKeys(found.providerId).find((key) => key.id === keyId);
    }),
  );

  app.delete(
    "/api/admin/keys/:keyId",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { keyId } = request.params as { keyId: string };
      const found = ctx.providers.findKeyById(keyId);
      if (!found) throw new SearchHubError("not_found", "API key not found");
      ctx.db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
      ctx.providers.reload();
      audit(ctx, actorLabel(actor), "key.delete", keyId, { providerId: found.providerId }, request.ip);
      return { ok: true };
    }),
  );

  app.post(
    "/api/admin/keys/:keyId/test",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { keyId } = request.params as { keyId: string };
      const found = ctx.providers.findKeyById(keyId);
      if (!found) throw new SearchHubError("not_found", "API key not found");
      const result = await testProvider(ctx, found.providerId, keyId);
      if (result.ok) {
        ctx.providers.markKeyHealthy(found.providerId, keyId);
        ctx.db
          .update(apiKeys)
          .set({ status: "healthy", consecutiveFailures: 0, cooldownUntil: null, lastErrorCode: null, lastErrorMessage: null })
          .where(eq(apiKeys.id, keyId))
          .run();
      } else {
        ctx.db
          .update(apiKeys)
          .set({
            status: "invalid",
            lastErrorCode: "auth_invalid",
            lastErrorMessage: result.message.slice(0, 500),
            lastFailureAt: new Date().toISOString(),
          })
          .where(eq(apiKeys.id, keyId))
          .run();
        ctx.providers.reload();
      }
      audit(ctx, actorLabel(actor), "key.test", keyId, { ok: result.ok }, request.ip);
      return result;
    }),
  );

  // ---- groups ----
  app.get("/api/admin/groups", jsonFor(app, async (request) => {
    requireAdmin(actorOf(request, ctx));
    return ctx.db
      .select()
      .from(searchGroups)
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        providerIds: safeArray(row.providerIdsJson),
        createdAt: row.createdAt,
      }));
  }));

  app.post(
    "/api/admin/groups",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const input = parseInput(groupCreateSchema, request.body);
      const existing = ctx.db
        .select({ id: searchGroups.id })
        .from(searchGroups)
        .where(eq(searchGroups.name, input.name))
        .get();
      if (existing) throw new SearchHubError("conflict", "A group with this name already exists");
      const id = newId("grp");
      ctx.db
        .insert(searchGroups)
        .values({
          id,
          name: input.name,
          description: input.description ?? null,
          providerIdsJson: JSON.stringify(input.providerIds),
          createdAt: new Date().toISOString(),
        })
        .run();
      audit(ctx, actorLabel(actor), "group.create", id, { name: input.name }, request.ip);
      return { id, name: input.name, description: input.description ?? null, providerIds: input.providerIds };
    }),
  );

  app.patch(
    "/api/admin/groups/:id",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      const input = parseInput(groupCreateSchema.partial(), request.body);
      const row = ctx.db.select().from(searchGroups).where(eq(searchGroups.id, id)).get();
      if (!row) throw new SearchHubError("not_found", "Group not found");
      ctx.db
        .update(searchGroups)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description ?? null }),
          ...(input.providerIds === undefined ? {} : { providerIdsJson: JSON.stringify(input.providerIds) }),
        })
        .where(eq(searchGroups.id, id))
        .run();
      audit(ctx, actorLabel(actor), "group.update", id, { fields: Object.keys(input) }, request.ip);
      return { ok: true };
    }),
  );

  app.delete(
    "/api/admin/groups/:id",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      ctx.db.delete(searchGroups).where(eq(searchGroups.id, id)).run();
      audit(ctx, actorLabel(actor), "group.delete", id, null, request.ip);
      return { ok: true };
    }),
  );
}

async function testProvider(
  ctx: AppContext,
  providerId: string,
  keyId?: string,
): Promise<{ ok: boolean; latencyMs: number; resultCount?: number; message: string; sample?: Array<{ title: string; url: string }> }> {
  const row = ctx.providers.getRow(providerId);
  if (!row) throw new SearchHubError("not_found", "Provider not found");
  const adapter = getAdapter(row.type);
  if (!adapter) throw new SearchHubError("unsupported", `Provider type "${row.type}" is not implemented`);

  let apiKey: string | undefined;
  if (keyId) {
    const found = ctx.providers.findKeyById(keyId);
    if (!found || found.providerId !== providerId) {
      throw new SearchHubError("not_found", "API key does not belong to this provider");
    }
    apiKey = ctx.providers.resolveKey(keyId);
    if (!apiKey) {
      return { ok: false, latencyMs: 0, message: "API key could not be decrypted (master key changed?)" };
    }
  } else {
    const keys = ctx.providers.listKeys(providerId).filter((key) => key.enabled);
    if (keys.length > 0) {
      apiKey = ctx.providers.resolveKey(keys[0]!.id);
    }
  }
  if (adapter.requiresKey && !apiKey) {
    return { ok: false, latencyMs: 0, message: "No API key available for this provider" };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.min(row.timeoutMs, 20_000));
  try {
    const result = await adapter.search(
      { query: providerTestQuery(row.type), limit: 3, signal: controller.signal },
      {
        fetch: ctx.fetch,
        ...(apiKey === undefined ? {} : { apiKey }),
        config: {
          id: row.id,
          name: row.name,
          type: row.type,
          baseUrl: row.baseUrl,
          timeoutMs: row.timeoutMs,
          maxResults: row.resultsPerPage,
          language: row.language,
          freshness: row.freshness as never,
          model: null,
          maxRetries: row.maxRetries,
          breakerThreshold: row.breakerThreshold,
          breakerCooldownMs: row.breakerCooldownMs,
          config: safeObject(row.configJson),
        },
        signal: controller.signal,
        logger: ctx.appLogger,
      },
    );
    const latencyMs = Date.now() - started;
    const count = result.results.length;
    return {
      ok: count > 0,
      latencyMs,
      resultCount: count,
      message:
        count > 0
          ? `Provider responded with ${count} result(s) in ${latencyMs}ms`
          : "Provider responded but returned no results. Check the query or provider configuration.",
      sample: result.results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function providerTestQuery(type: string): string {
  if (type === "searxng") return "searxng";
  return "search engine";
}

function safeArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function safeObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
