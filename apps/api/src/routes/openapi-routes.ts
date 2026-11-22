import type { FastifyInstance } from "fastify";

/**
 * Hand-maintained OpenAPI 3.1 document for the endpoints that actually exist.
 * A test asserts that every documented path is registered on the app.
 */
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Search Hub API",
    version: "0.1.13",
    description:
      "Self-hosted multi-provider search infrastructure. Search endpoints accept either an admin session cookie + CSRF header or a Bearer access token.",
    license: { name: "MIT" },
  },
  servers: [{ url: "/", description: "Current instance" }],
  tags: [
    { name: "search", description: "Search execution and task inspection" },
    { name: "sources", description: "Provider catalog and health" },
    { name: "admin", description: "Administration (session + CSRF)" },
    { name: "system", description: "Health and setup" },
  ],
  paths: {
    "/api/health": {
      get: {
        tags: ["system"],
        summary: "Health check",
        responses: { "200": { description: "Instance status" } },
      },
    },
    "/api/setup/status": {
      get: {
        tags: ["system"],
        summary: "First-run status",
        responses: { "200": { description: "Whether an administrator exists" } },
      },
    },
    "/api/setup": {
      post: {
        tags: ["system"],
        summary: "Create the first administrator",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SetupRequest" } } } },
        responses: { "200": { description: "Session created" }, "409": { description: "Already initialized" } },
      },
    },
    "/api/auth/login": {
      post: {
        tags: ["system"],
        summary: "Sign in",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } } },
        responses: { "200": { description: "Session created" }, "401": { description: "Invalid credentials" } },
      },
    },
    "/api/auth/session": {
      get: { tags: ["system"], summary: "Current session", responses: { "200": { description: "Session" }, "401": { description: "Not signed in" } } },
    },
    "/api/auth/logout": {
      post: { tags: ["system"], summary: "Sign out", responses: { "200": { description: "Signed out" } } },
    },
    "/api/search": {
      // skipCache:true bypasses the optional response cache.
      post: {
        tags: ["search"],
        summary: "Run a search",
        description:
          "Fans out to the selected providers, isolates failures, normalizes and de-duplicates results, then fuses with RRF. Optional rerank / embedding / summary stages run only when configured.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SearchRequest" } } } },
        responses: {
          "200": { description: "Search response", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } } },
          "400": { description: "Validation error" },
          "401": { description: "Missing or invalid credentials" },
        },
      },
    },
    "/api/search/deep": {
      post: {
        tags: ["search"],
        summary: "Deep search (rewrite + multi-query + summary)",
        responses: { "200": { description: "Search response" } },
      },
    },
    "/api/search/tasks/{id}": {
      get: {
        tags: ["search"],
        summary: "Fetch a stored search task",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Task" }, "404": { description: "Not found" } },
      },
    },
    "/api/search/tasks/{id}/cancel": {
      post: {
        tags: ["search"],
        summary: "Cancel an in-flight search",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Cancellation acknowledged" } },
      },
    },
    "/api/providers": {
      get: {
        tags: ["sources"],
        summary: "List providers, catalog and runtime health",
        responses: { "200": { description: "Provider list (no secrets)" } },
      },
    },
    "/api/admin/dashboard": {
      get: {
        tags: ["admin"],
        summary: "Dashboard aggregates",
        parameters: [{ name: "range", in: "query", schema: { type: "string", enum: ["1h", "24h", "7d", "30d"] } }],
        responses: { "200": { description: "Dashboard statistics" } },
      },
    },
    "/api/admin/providers": {
      get: { tags: ["admin"], summary: "List providers", responses: { "200": { description: "Providers" } } },
      post: {
        tags: ["admin"],
        summary: "Create a provider instance",
        responses: { "200": { description: "Created" }, "409": { description: "Name conflict" } },
      },
    },
    "/api/admin/providers/{id}": {
      patch: { tags: ["admin"], summary: "Update a provider instance", responses: { "200": { description: "Updated" } } },
      delete: { tags: ["admin"], summary: "Delete a provider instance", responses: { "200": { description: "Deleted" } } },
    },
    "/api/admin/providers/{id}/test": {
      post: { tags: ["admin"], summary: "Live-test a provider", responses: { "200": { description: "Test result" } } },
    },
    "/api/admin/provider-health/{id}/probe": {
      post: { tags: ["admin"], summary: "Probe one provider through HealthService", responses: { "200": { description: "Probe result and budget" }, "403": { description: "Admin scope required" }, "409": { description: "Probe already running" }, "429": { description: "Local probe budget exhausted" } } },
    },
    "/api/admin/provider-health/batch-test/preview": {
      get: { tags: ["admin"], summary: "Read-only bulk provider test preview", responses: { "200": { description: "Eligibility counts, budget and paid risk" } } },
    },
    "/api/admin/provider-health/batch-test": {
      post: { tags: ["admin"], summary: "Create a bulk provider test job", responses: { "201": { description: "Job created" }, "403": { description: "Admin scope required" }, "409": { description: "Run refused by policy or budget" } } },
    },
    "/api/admin/provider-health/batch-test/{jobId}": {
      get: { tags: ["admin"], summary: "Read bulk provider test progress", responses: { "200": { description: "Durable job snapshot" } } },
    },
    "/api/admin/provider-health/batch-test/{jobId}/cancel": {
      post: { tags: ["admin"], summary: "Cancel a bulk provider test job", responses: { "200": { description: "Cancellation result" } } },
    },
    "/api/admin/providers/{id}/keys": {
      get: { tags: ["admin"], summary: "List masked keys", responses: { "200": { description: "Keys" } } },
      post: { tags: ["admin"], summary: "Add an API key (encrypted at rest)", responses: { "200": { description: "Key summary" } } },
    },
    "/api/admin/keys/{keyId}": {
      patch: { tags: ["admin"], summary: "Update or rotate a key", responses: { "200": { description: "Updated" } } },
      delete: { tags: ["admin"], summary: "Delete a key", responses: { "200": { description: "Deleted" } } },
    },
    "/api/admin/models": {
      get: { tags: ["admin"], summary: "List model configurations", responses: { "200": { description: "Models" } } },
      post: { tags: ["admin"], summary: "Add a model configuration", responses: { "200": { description: "Created" } } },
    },
    "/api/admin/models/{id}/test": {
      post: { tags: ["admin"], summary: "Live-test a model", responses: { "200": { description: "Test result" } } },
    },
    "/api/admin/settings": {
      get: { tags: ["admin"], summary: "Read settings", responses: { "200": { description: "Settings" } } },
      put: { tags: ["admin"], summary: "Update settings", responses: { "200": { description: "Updated settings" } } },
    },
    "/api/admin/outbound": {
      get: {
        tags: ["admin"],
        summary: "Outbound egress policy",
        description:
          "Read-only view of the deployment's outbound proxy: direct vs proxy, the redacted proxy endpoint, " +
          "NO_PROXY entry count and the proxy trust level. Configure it with SEARCH_HUB_PROXY / " +
          "SEARCH_HUB_NO_PROXY / SEARCH_HUB_PROXY_TRUST environment variables; it is intentionally " +
          "not mutable through the API.",
        responses: { "200": { description: "Outbound policy description (credential free)" } },
      },
    },
    "/api/admin/tokens": {
      get: { tags: ["admin"], summary: "List access tokens", responses: { "200": { description: "Tokens (hashed at rest)" } } },
      post: { tags: ["admin"], summary: "Create an access token (returned once)", responses: { "200": { description: "Token" } } },
    },
    "/api/admin/tokens/{id}": {
      delete: { tags: ["admin"], summary: "Revoke an access token", responses: { "200": { description: "Revoked" } } },
    },
    "/api/admin/migration/legacy": {
      post: {
        tags: ["admin"],
        summary: "Plan or apply a legacy Search Hub provider migration",
        description:
          "mode=dry_run (default) returns a plan; mode=apply requires confirm=\"IMPORT LEGACY PROVIDERS\". Credentials in the payload are ignored and never stored.",
        responses: {
          "200": { description: "Plan (dry run) or plan plus applied result" },
          "400": { description: "Missing confirmation or malformed payload" },
        },
      },
    },
    "/api/admin/backup": {
      get: {
        tags: ["admin"],
        summary: "Download a consistent SQLite snapshot",
        description:
          "Uses the SQLite Online Backup API (falling back to VACUUM INTO) so the copy is transaction-consistent while searches keep writing. " +
          "The file is normalised to journal_mode=delete, checked with PRAGMA integrity_check, and only then published, so a failed backup never returns a partial file. " +
          "Never includes master.key. The response carries x-search-hub-schema-version; the temp snapshot is deleted after the download.",
        responses: {
          "200": {
            description: "SQLite database file",
            headers: {
              "x-search-hub-schema-version": { description: "Newest applied migration", schema: { type: "string" } },
              "x-search-hub-user-version": { description: "PRAGMA user_version of the snapshot", schema: { type: "integer" } },
              "x-search-hub-integrity": { description: "Always `ok` for a returned file", schema: { type: "string" } },
            },
          },
          "500": { description: "Snapshot could not be created or failed integrity_check" },
        },
      },
    },
    "/api/admin/backup/verify": {
      post: {
        tags: ["admin"],
        summary: "Verify an uploaded .db snapshot without restoring it",
        description:
          "Send the file as the raw request body (content-type: application/octet-stream, 64 MB cap). " +
          "Returns integrity, schema version, applied migrations, tables and row counts. " +
          "A snapshot containing migrations this build does not ship is reported as ok:false, compatible:false (created by a newer version).",
        requestBody: {
          required: true,
          content: {
            "application/octet-stream": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: {
          "200": { description: "Verification report" },
          "400": { description: "Empty or unreadable body" },
          "413": { description: "Upload exceeds the size limit" },
        },
      },
    },
    "/api/admin/maintenance/checkpoint": {
      post: { tags: ["admin"], summary: "Force a WAL checkpoint", responses: { "200": { description: "Checkpoint result" } } },
    },
    "/api/openapi.json": {
      get: { tags: ["system"], summary: "This document", responses: { "200": { description: "OpenAPI JSON" } } },
    },
    "/mcp": {
      post: {
        tags: ["search"],
        summary: "MCP Streamable HTTP endpoint",
        description: "Requires a Bearer token with the mcp:use scope. Implements MCP 2026-07-28.",
        responses: { "200": { description: "MCP JSON-RPC response" }, "401": { description: "Missing token" } },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "sh_session" },
    },
    schemas: {
      SetupRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 12 },
          name: { type: "string" },
          setupToken: { type: "string" },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: { email: { type: "string", format: "email" }, password: { type: "string" } },
      },
      SearchRequest: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", maxLength: 2000 },
          providers: { type: "array", items: { type: "string" } },
          group: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          perProviderLimit: { type: "integer", minimum: 1, maximum: 50 },
          language: { type: "string" },
          freshness: { type: "string", enum: ["day", "week", "month", "year", "all"] },
          mode: {
            type: "string",
            enum: ["basic", "rrf", "rerank", "embedding", "embedding_rerank", "rerank_summary", "deep", "web", "grounded", "research"],
            default: "basic",
          },
          rerank: { type: "boolean" },
          summarize: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
          rerankModelId: { type: "string" },
          embeddingModelId: { type: "string" },
          chatModelId: { type: "string" },
        },
      },
      SearchResult: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
          source: { type: "string" },
          provider: { type: "string" },
          providerType: { type: "string" },
          providerName: { type: "string" },
          publishedAt: { type: "string" },
          retrievedAt: { type: "string" },
          score: { type: "number" },
          fusionScore: { type: "number" },
          rerankScore: { type: "number" },
          language: { type: "string" },
          sources: { type: "array", items: { type: "object" } },
        },
      },
      SearchResponse: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          query: { type: "string" },
          mode: { type: "string" },
          status: { type: "string", enum: ["completed", "partial", "failed"] },
          results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
          stats: { type: "object" },
          errors: { type: "array", items: { type: "object" } },
          failedSources: { type: "array", items: { type: "object" } },
          summary: { type: "object" },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: {},
            },
          },
        },
      },
    },
  },
} as const;

export function registerOpenApiRoutes(app: FastifyInstance): void {
  app.get("/api/openapi.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=60");
    return openApiDocument;
  });

  app.get("/api/docs", async (_request, reply) => {
    const rows = Object.entries(openApiDocument.paths)
      .flatMap(([path, methods]) =>
        Object.entries(methods as Record<string, { summary?: string; tags?: readonly string[] }>).map(
          ([method, operation]) => ({
            method: method.toUpperCase(),
            path,
            summary: operation.summary ?? "",
            tag: operation.tags?.[0] ?? "",
          }),
        ),
      )
      .map(
        (row) =>
          `<tr><td><code>${row.method}</code></td><td><code>${row.path}</code></td><td>${row.summary}</td><td>${row.tag}</td></tr>`,
      )
      .join("");

    reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Search Hub API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#111}
h1{font-size:24px}code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e4e4e7}
th{background:#fafafa;font-weight:600}a{color:#2563eb}
</style></head><body>
<h1>Search Hub API</h1>
<p>OpenAPI 3.1 文档：<a href="/api/openapi.json">/api/openapi.json</a>。管理接口需要管理员会话与 <code>x-csrf-token</code>；搜索接口可使用 <code>Authorization: Bearer sh_...</code>。</p>
<table><thead><tr><th>方法</th><th>路径</th><th>说明</th><th>分组</th></tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
  });
}
