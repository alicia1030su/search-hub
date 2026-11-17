import type { FastifyInstance, FastifyRequest } from "fastify";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import {
  SearchHubError,
  settingsUpdateSchema,
  tokenCreateSchema,
} from "@search-hub/shared";
import { auditLogs, modelConfigs, providerInstances, searchGroups } from "@search-hub/db";
import type { AppContext } from "../context.js";
import { actorLabel, authenticate, requireAdmin, type Actor } from "../auth.js";
import { audit, jsonFor, parseInput, sendError } from "../http.js";
import { dashboardStats, parseRange, recentEvents } from "../services/stats.js";
import { applyLegacyPlan, planLegacyMigration } from "../services/legacy-migration.js";
import {
  createDatabaseSnapshot,
  disposeSnapshot,
  disposeSnapshotSync,
  inspectDatabaseFile,
  pruneStaleSnapshots,
  snapshotDirectory,
  snapshotFileName,
  snapshotReadStream,
  type UploadedSnapshot,
} from "../services/backup.js";
import { newId } from "../security/crypto.js";
import { validateAllSkills } from "../services/skills.js";
import { existsSync as fileExists, readFileSync as readFile } from "node:fs";
import { REPO_ROOT } from "../config.js";

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

const SKILL_DEFINITIONS = [
  {
    name: "search-web",
    description: "Run a single web search through Search Hub and return cited results.",
  },
  {
    name: "deep-research",
    description: "Run a multi-query deep research pass and synthesize cited findings.",
  },
  {
    name: "research-with-citations",
    description: "Retrieve and format a citation-ready evidence list with source attribution.",
  },
];

const MCP_TOOLS = [
  { name: "search_web", title: "Web search", description: "Multi-provider web search with fused results" },
  { name: "search_multi", title: "Multi-query search", description: "Run several queries and merge results" },
  { name: "search_deep", title: "Deep search", description: "Rewrite, retrieve and summarize with citations" },
  { name: "search_news", title: "News search", description: "Freshness-restricted search (last day)" },
  { name: "search_with_sources", title: "Search with sources", description: "Results plus per-provider diagnostics" },
  { name: "search_and_rerank", title: "Search and rerank", description: "Fuse then rerank with a rerank model" },
  { name: "search_and_summarize", title: "Search and summarize", description: "Cited summary over fused results" },
  { name: "get_search_sources", title: "List sources", description: "List configured providers and health" },
  { name: "get_search_status", title: "Service status", description: "Provider, key and breaker status" },
];

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/admin/dashboard",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      const query = request.query as { range?: string; from?: string; to?: string };
      return dashboardStats(ctx.db, ctx.providers, parseRange(query));
    }),
  );

  app.get(
    "/api/admin/settings",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      return ctx.settings.get();
    }),
  );

  // ---- cache management -------------------------------------------------
  /**
   * Cache usage, hit rate and capacity.
   *
   * Every number comes from the database: `entries`/`bytes` are a live
   * aggregate over `search_cache`, and the hit/miss counters are the hourly
   * buckets the search path writes. When a window has no lookups the rate is
   * `null` and the UI says "no data yet" — a fabricated 0% would be worse than
   * admitting there is nothing to measure.
   */
  app.get(
    "/api/admin/cache",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      const settings = ctx.settings.get();
      return ctx.cache.stats({
        enabled: settings.cache.enabled,
        ttlSeconds: settings.cache.ttlSeconds,
      });
    }),
  );

  app.post(
    "/api/admin/cache/sweep",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const removed = ctx.cache.sweepExpired();
      audit(ctx, actorLabel(actor), "cache.sweep", null, { removed }, request.ip);
      return { removed };
    }),
  );

  app.post(
    "/api/admin/cache/clear",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      // Destructive and irreversible: require an explicit acknowledgement in the
      // body, so a stray retry or a mis-wired client cannot wipe the cache.
      const body = (request.body ?? {}) as { confirm?: unknown };
      if (body.confirm !== true) {
        throw new SearchHubError(
          "validation_error",
          "Clearing the cache requires {\"confirm\": true}. This cannot be undone.",
        );
      }
      const removed = ctx.cache.clear();
      audit(ctx, actorLabel(actor), "cache.clear", null, { removed }, request.ip);
      ctx.logger.warn({ actor: actorLabel(actor), removed }, "cache cleared by an administrator");
      return { removed };
    }),
  );

  /**
   * Outbound egress policy for operators: direct vs proxy, the redacted proxy
   * endpoint, NO_PROXY entry count and the trust level. Read-only on purpose —
   * the proxy is deployment configuration (SEARCH_HUB_PROXY / _NO_PROXY /
   * _PROXY_TRUST), never a runtime setting, so it cannot be changed here.
   */
  app.get(
    "/api/admin/outbound",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      return ctx.describeOutboundPolicy();
    }),
  );

  app.put(
    "/api/admin/settings",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const input = parseInput(settingsUpdateSchema, request.body);
      const updated = ctx.settings.update(input);
      audit(ctx, actorLabel(actor), "settings.update", null, Object.keys(input), request.ip);
      return updated;
    }),
  );

  app.get(
    "/api/admin/tokens",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      return ctx.tokens.list();
    }),
  );

  app.post(
    "/api/admin/tokens",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const input = parseInput(tokenCreateSchema, request.body);
      const created = ctx.tokens.create({
        name: input.name,
        scopes: input.scopes,
        rateLimitPerMin: input.rateLimitPerMin,
        expiresAt: input.expiresAt ?? null,
      });
      audit(
        ctx,
        actorLabel(actor),
        "token.create",
        created.id,
        { name: input.name, scopes: input.scopes },
        request.ip,
      );
      return {
        token: created.token,
        record: ctx.tokens.list().find((item) => item.id === created.id),
        warning: "Copy this token now. It will not be shown again.",
      };
    }),
  );

  app.delete(
    "/api/admin/tokens/:id",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const { id } = request.params as { id: string };
      if (!ctx.tokens.revoke(id)) throw new SearchHubError("not_found", "Token not found");
      audit(ctx, actorLabel(actor), "token.revoke", id, null, request.ip);
      return { ok: true };
    }),
  );

  app.get(
    "/api/admin/logs",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      const query = request.query as { limit?: string; offset?: string; providerId?: string };
      const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
      const offset = Math.max(0, Number(query.offset ?? 0));
      return {
        events: recentEvents(ctx.db, {
          limit,
          offset,
          ...(query.providerId ? { providerId: query.providerId } : {}),
        }),
      };
    }),
  );

  app.get(
    "/api/admin/audit",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      const limit = Math.min(500, Math.max(1, Number((request.query as { limit?: string }).limit ?? 100)));
      return {
        logs: ctx.db
          .select()
          .from(auditLogs)
          .orderBy(desc(auditLogs.id))
          .limit(limit)
          .all()
          .map((row) => ({
            id: row.id,
            actor: row.actor,
            action: row.action,
            target: row.target,
            detail: row.detailJson,
            ip: row.ip,
            createdAt: row.createdAt,
          })),
      };
    }),
  );

  /**
   * Skills listing, validated against the Agent Skills specification.
   *
   * Validation is not a separate button: a skill that does not meet the spec must
   * show up as invalid here, otherwise the UI would present a broken skill as
   * installable.
   */
  app.get(
    "/api/admin/skills",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      const root = join(REPO_ROOT, "packages", "skills");
      const skills = validateAllSkills(root);
      return {
        skills: skills.map((item) => ({
          ...item,
          // Legacy fields kept for the integrations page: a client that only
          // wants to show name/description should not have to read the
          // validation report.
          description: item.metadata.description ?? "",
          content: readSkillContent(item.directory),
          installPath: `packages/skills/${item.directory}/SKILL.md`,
          builtin: true,
        })),
        summary: {
          total: skills.length,
          valid: skills.filter((item) => item.valid).length,
          invalid: skills.filter((item) => !item.valid).length,
        },
      };
    }),
  );

  const exportHandler = async (request: FastifyRequest) => {
    requireAdmin(actorOf(request, ctx));
    return exportConfig(ctx);
  };
  app.get("/api/admin/export", jsonFor(app, exportHandler));
  app.get("/api/admin/config/export", jsonFor(app, exportHandler));

  const importHandler = async (request: FastifyRequest) => {
    const actor = requireAdmin(actorOf(request, ctx, true));
    const body = request.body as { config?: unknown } | undefined;
    if (!body?.config || typeof body.config !== "object") {
      throw new SearchHubError("validation_error", "A config object is required in the request body");
    }
    const result = importConfig(ctx, body.config as Record<string, unknown>);
    audit(ctx, actorLabel(actor), "config.import", null, result, request.ip);
    return result;
  };
  app.post("/api/admin/import", jsonFor(app, importHandler));
  app.post("/api/admin/config/import", jsonFor(app, importHandler));

  /**
   * Legacy Search Hub migration.
   *
   * `POST /api/admin/migration/legacy` accepts the provider list exported by an
   * older deployment. It NEVER reads or stores credentials: the response lists
   * which providers need a key, and the operator re-enters keys in the UI.
   * Dry-run is the default; apply requires an explicit confirmation string and
   * refuses to overwrite existing provider names.
   */
  app.post(
    "/api/admin/migration/legacy",
    jsonFor(app, async (request) => {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const body = (request.body ?? {}) as {
        mode?: string;
        payload?: unknown;
        confirm?: string;
        baseUrl?: string;
      };
      const mode = body.mode === "apply" ? "apply" : "dry_run";
      const existing = ctx.providers.listRows().map((row) => row.name);
      const plan = planLegacyMigration(body.payload, existing, mode);

      if (mode === "dry_run") {
        audit(ctx, actorLabel(actor), "migration.legacy.preview", null, {
          total: plan.total,
          importable: plan.importable,
        }, request.ip);
        return plan;
      }

      const result = applyLegacyPlan(
        plan,
        body.confirm ?? "",
        {
          createProvider: ({ body: providerBody }) => {
            const now = new Date().toISOString();
            ctx.db
              .insert(providerInstances)
              .values({
                id: newId("prv"),
                name: String(providerBody["name"]),
                type: String(providerBody["type"]),
                enabled: Boolean(providerBody["enabled"] ?? true),
                baseUrl: (providerBody["baseUrl"] as string | null | undefined) ?? null,
                timeoutMs: Number(providerBody["timeoutMs"] ?? 12_000),
                maxConcurrency: Number(providerBody["maxConcurrency"] ?? 4),
                priority: Number(providerBody["priority"] ?? 100),
                weight: Number(providerBody["weight"] ?? 100),
                maxRetries: Number(providerBody["maxRetries"] ?? 1),
                language: (providerBody["language"] as string | null | undefined) ?? null,
                freshness: (providerBody["freshness"] as string | null | undefined) ?? null,
                resultsPerPage: Number(providerBody["resultsPerPage"] ?? 10),
                rpmLimit: Number(providerBody["rpmLimit"] ?? 60),
                dailyQuota: providerBody["dailyQuota"] == null ? null : Number(providerBody["dailyQuota"]),
                keyStrategy: String(providerBody["keyStrategy"] ?? "round_robin"),
                cooldownMs: Number(providerBody["cooldownMs"] ?? 30_000),
                breakerThreshold: Number(providerBody["breakerThreshold"] ?? 5),
                breakerCooldownMs: Number(providerBody["breakerCooldownMs"] ?? 60_000),
                configJson: JSON.stringify(providerBody["config"] ?? {}),
                createdAt: now,
                updatedAt: now,
              })
              .run();
          },
        },
        body.baseUrl,
      );
      ctx.providers.reload();
      audit(ctx, actorLabel(actor), "migration.legacy.apply", null, result, request.ip);
      return { ...plan, applied: result };
    }),
  );

  /**
   * Forces a WAL checkpoint.
   *
   * Only useful for an *offline* copy of `search-hub.db` on a stopped service.
   * A running service must use `GET /api/admin/backup`, which takes a real
   * snapshot: a checkpoint followed by a file read still races writers.
   */
  app.post(
    "/api/admin/maintenance/checkpoint",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx, true));
      const result = ctx.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      return { ok: true, checkpoint: result };
    }),
  );

  /**
   * Downloads a consistent SQLite snapshot.
   *
   * The snapshot is produced by `createDatabaseSnapshot`: SQLite Online Backup
   * API (or `VACUUM INTO`), normalised to a single file, verified with
   * `PRAGMA integrity_check`, and only then published under its final name.
   * Streaming means a multi-hundred-MB database never sits in memory, and the
   * temp file is deleted once the response is finished (or aborted).
   *
   * The response intentionally does NOT include master.key: restoring the
   * database without that key leaves stored provider credentials unreadable,
   * which is the safe failure mode.
   */
  app.get("/api/admin/backup", async (request, reply) => {
    let snapshotPath: string | null = null;
    try {
      requireAdmin(actorOf(request, ctx));
      // Sweep leftovers from crashed downloads before creating a new snapshot.
      void pruneStaleSnapshots(ctx).catch(() => undefined);
      const name = snapshotFileName();
      const snapshot = await createDatabaseSnapshot(ctx, join(snapshotDirectory(ctx), name));
      snapshotPath = snapshot.path;

      reply
        .header("content-disposition", `attachment; filename="${name}"`)
        .header("cache-control", "no-store")
        .header("content-length", String(snapshot.bytes))
        .header("x-search-hub-schema-version", snapshot.schemaVersion ?? "none")
        .header("x-search-hub-user-version", String(snapshot.userVersion))
        .header("x-search-hub-snapshot-method", snapshot.method)
        .header("x-search-hub-integrity", snapshot.integrity)
        .type("application/vnd.sqlite3");

      const stream = snapshotReadStream(snapshot.path);
      // `finish` = bytes flushed to the client; `close` also covers aborts.
      reply.raw.once("finish", () => {
        stream.destroy();
        disposeSnapshotSync(snapshot.path);
      });
      reply.raw.once("close", () => {
        stream.destroy();
        disposeSnapshotSync(snapshot.path);
      });
      stream.once("error", (error) => {
        request.log.warn({ err: error }, "snapshot stream failed");
        disposeSnapshotSync(snapshot.path);
      });
      // Must be returned: in an async handler, a bare `reply.send()` is
      // overwritten by the implicit `undefined` return value.
      return reply.send(stream);
    } catch (error) {
      if (snapshotPath) await disposeSnapshot(snapshotPath);
      sendError(reply, error);
    }
  });

  /**
   * Verifies an uploaded `.db` snapshot without restoring it.
   *
   * Accepts the raw file body (`application/octet-stream`,
   * `application/vnd.sqlite3` or `application/x-sqlite3`) with a hard 64 MB
   * cap. The file is written to an unpredictable temp path, integrity-checked
   * with a read-only connection, compared against the migrations this build
   * ships, and deleted immediately afterwards.
   *
   * A snapshot that contains migrations unknown to this build was created by
   * a newer release: `ok:false, compatible:false` with an explicit reason, not
   * a bare `ok`.
   */
  app.post("/api/admin/backup/verify", async (request, reply) => {
    let upload: UploadedSnapshot | null = null;
    try {
      const actor = requireAdmin(actorOf(request, ctx, true));
      const body = request.body as UploadedSnapshot | null;
      if (!body || typeof body.filePath !== "string" || typeof body.dispose !== "function") {
        throw new SearchHubError(
          "validation_error",
          "Send the .db file as the raw request body with content-type: application/octet-stream",
        );
      }
      upload = body;
      const report = await inspectDatabaseFile(upload.filePath, {
        migrationsDir: ctx.config.migrationsDir,
        appVersion: ctx.config.version,
        bytes: upload.bytes,
      });
      audit(
        ctx,
        actorLabel(actor),
        "backup.verify",
        null,
        {
          ok: report.ok,
          compatible: report.compatible,
          schemaVersion: report.schemaVersion,
          bytes: report.bytes,
        },
        request.ip,
      );
      request.log.info(
        { ok: report.ok, compatible: report.compatible, schemaVersion: report.schemaVersion },
        "backup snapshot verified",
      );
      reply.header("x-search-hub-integrity", report.integrity === "ok" ? "ok" : "failed");
      return report;
    } catch (error) {
      sendError(reply, error);
    } finally {
      if (upload) await upload.dispose().catch(() => undefined);
    }
  });

  app.get(
    "/api/mcp/info",
    jsonFor(app, async (request) => {
      requireAdmin(actorOf(request, ctx));
      const origin = ctx.settings.publicBaseUrl() ?? `${request.protocol}://${request.headers.host}`;
      return {
        endpoint: `${origin.replace(/\/+$/, "")}/mcp`,
        transports: ["streamable-http", "stdio"],
        protocolVersion: "2026-07-28",
        tools: MCP_TOOLS,
      };
    }),
  );
}

interface ExportShape {
  version: string;
  exportedAt: string;
  providers: Array<Record<string, unknown> & { keyLabels: string[] }>;
  models: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Exports configuration without any secret material (no key, no password). */
function exportConfig(ctx: AppContext): ExportShape {
  const providers = ctx.providers.listRows().map((row) => ({
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    timeoutMs: row.timeoutMs,
    maxConcurrency: row.maxConcurrency,
    priority: row.priority,
    weight: row.weight,
    maxRetries: row.maxRetries,
    language: row.language,
    freshness: row.freshness,
    resultsPerPage: row.resultsPerPage,
    rpmLimit: row.rpmLimit,
    dailyQuota: row.dailyQuota,
    keyStrategy: row.keyStrategy,
    cooldownMs: row.cooldownMs,
    breakerThreshold: row.breakerThreshold,
    breakerCooldownMs: row.breakerCooldownMs,
    config: parseJson<Record<string, unknown>>(row.configJson, {}),
    keyLabels: ctx.providers.listKeys(row.id).map((key) => key.label),
  }));

  const models = ctx.db
    .select()
    .from(modelConfigs)
    .all()
    .map((row) => ({
      kind: row.kind,
      name: row.name,
      providerType: row.providerType,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      dimensions: row.dimensions,
      batchSize: row.batchSize,
      timeoutMs: row.timeoutMs,
      maxConcurrency: row.maxConcurrency,
      params: parseJson<Record<string, unknown>>(row.paramsJson, {}),
      enabled: row.enabled,
      isDefault: row.isDefault,
      hasKey: Boolean(row.apiKeyCiphertext),
    }));

  const groups = ctx.db
    .select()
    .from(searchGroups)
    .all()
    .map((row) => ({
      name: row.name,
      description: row.description,
      providerIds: parseJson<string[]>(row.providerIdsJson, []),
    }));

  return {
    version: ctx.config.version,
    exportedAt: new Date().toISOString(),
    providers,
    models,
    groups,
    settings: ctx.settings.get() as unknown as Record<string, unknown>,
  };
}

function importConfig(
  ctx: AppContext,
  config: Record<string, unknown>,
): { providers: number; models: number; groups: number; skipped: string[] } {
  const skipped: string[] = [];
  let providersCreated = 0;
  let modelsCreated = 0;
  let groupsCreated = 0;
  const now = new Date().toISOString();

  if (Array.isArray(config["providers"])) {
    for (const raw of config["providers"] as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const name = String(row["name"] ?? "").trim();
      const type = String(row["type"] ?? "").trim();
      if (!name || !type) continue;
      const catalog = ctx.providers.catalogFor(type);
      if (!catalog || catalog.implementation === "planned" || catalog.implementation === "unavailable") {
        skipped.push(`provider "${name}": type "${type}" is not implemented`);
        continue;
      }
      if (ctx.providers.listRows().some((item) => item.name === name)) {
        skipped.push(`provider "${name}": name already exists`);
        continue;
      }
      const id = newId("prv");
      ctx.db
        .insert(providerInstances)
        .values({
          id,
          name,
          type,
          enabled: Boolean(row["enabled"] ?? true),
          baseUrl: typeof row["baseUrl"] === "string" ? row["baseUrl"] : null,
          timeoutMs: Number(row["timeoutMs"] ?? 12000),
          maxConcurrency: Number(row["maxConcurrency"] ?? 4),
          priority: Number(row["priority"] ?? 100),
          weight: Number(row["weight"] ?? 100),
          maxRetries: Number(row["maxRetries"] ?? 1),
          language: typeof row["language"] === "string" ? row["language"] : null,
          freshness: typeof row["freshness"] === "string" ? row["freshness"] : null,
          resultsPerPage: Number(row["resultsPerPage"] ?? 10),
          rpmLimit: Number(row["rpmLimit"] ?? 60),
          dailyQuota: row["dailyQuota"] == null ? null : Number(row["dailyQuota"]),
          keyStrategy: String(row["keyStrategy"] ?? "round_robin"),
          cooldownMs: Number(row["cooldownMs"] ?? 30000),
          breakerThreshold: Number(row["breakerThreshold"] ?? 5),
          breakerCooldownMs: Number(row["breakerCooldownMs"] ?? 60000),
          configJson: JSON.stringify(row["config"] ?? {}),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      providersCreated += 1;
      const labels = row["keyLabels"];
      if (Array.isArray(labels) && labels.length > 0) {
        skipped.push(
          `provider "${name}": ${labels.length} key(s) were not imported — re-enter API keys manually`,
        );
      }
    }
  }

  if (Array.isArray(config["models"])) {
    for (const raw of config["models"] as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const kind = String(row["kind"] ?? "");
      const name = String(row["name"] ?? "").trim();
      if (!kind || !name) continue;
      if (!["chat", "embedding", "rerank"].includes(kind)) {
        skipped.push(`model "${name}": unknown kind "${kind}"`);
        continue;
      }
      if (ctx.models.list(kind as "chat" | "embedding" | "rerank").some((item) => item.name === name)) {
        skipped.push(`model "${name}": name already exists`);
        continue;
      }
      const id = newId("mdl");
      ctx.db
        .insert(modelConfigs)
        .values({
          id,
          kind,
          name,
          providerType: String(row["providerType"] ?? "openai-compatible"),
          baseUrl: String(row["baseUrl"] ?? ""),
          modelId: String(row["modelId"] ?? ""),
          dimensions: row["dimensions"] == null ? null : Number(row["dimensions"]),
          batchSize: Number(row["batchSize"] ?? 32),
          timeoutMs: Number(row["timeoutMs"] ?? 30000),
          maxConcurrency: Number(row["maxConcurrency"] ?? 4),
          paramsJson: JSON.stringify(row["params"] ?? {}),
          enabled: Boolean(row["enabled"] ?? true),
          isDefault: Boolean(row["isDefault"] ?? false),
          createdAt: now,
          updatedAt: now,
        })
        .run();
      modelsCreated += 1;
      if (row["hasKey"]) skipped.push(`model "${name}": API key must be re-entered manually`);
    }
  }

  if (Array.isArray(config["groups"])) {
    for (const raw of config["groups"] as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const name = String(row["name"] ?? "").trim();
      if (!name) continue;
      if (ctx.db.select().from(searchGroups).where(eq(searchGroups.name, name)).get()) {
        skipped.push(`group "${name}": name already exists`);
        continue;
      }
      ctx.db
        .insert(searchGroups)
        .values({
          id: newId("grp"),
          name,
          description: typeof row["description"] === "string" ? row["description"] : null,
          providerIdsJson: JSON.stringify(
            Array.isArray(row["providerIds"]) ? (row["providerIds"] as string[]) : [],
          ),
          createdAt: now,
        })
        .run();
      groupsCreated += 1;
    }
  }

  ctx.providers.reload();
  return { providers: providersCreated, models: modelsCreated, groups: groupsCreated, skipped };
}

export { MCP_TOOLS, SKILL_DEFINITIONS };

/** SKILL.md contents, or null when the skill is missing the file. */
function readSkillContent(directory: string): string | null {
  const path = join(REPO_ROOT, "packages", "skills", directory, "SKILL.md");
  if (!fileExists(path)) return null;
  try {
    return readFile(path, "utf8");
  } catch {
    return null;
  }
}
