import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SearchHubError } from "@search-hub/shared";
import type { AppContext } from "./context.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerSearchRoutes } from "./routes/search-routes.js";
import { registerWebRoutes } from "./routes/web-routes.js";
import { registerHealthRoutes, registerProviderHealthRoutes } from "./routes/health-routes.js";
import { registerQualityRoutes } from "./routes/quality-routes.js";
import { registerMcpAdminRoutes } from "./routes/mcp-admin-routes.js";
import { registerProviderRoutes } from "./routes/provider-routes.js";
import { registerOnboardingRoutes } from "./routes/onboarding-routes.js";
import { registerModelRoutes } from "./routes/model-routes.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerMcpRoutes } from "./routes/mcp-routes.js";
import { registerOpenApiRoutes } from "./routes/openapi-routes.js";
import { sendError } from "./http.js";
import { isAllowedHost } from "./security/host.js";
import { REPO_ROOT } from "./config.js";
import { MCP_TOOL_COUNT } from "@search-hub/mcp";

/**
 * Protocol constants of the installed MCP SDK, read from its own shipped files.
 *
 * The deep import path is not a public entry point, so a version bump could
 * break an `import`. Reading the dist files keeps the admin page working across
 * SDK releases and degrades to "unknown" instead of crashing.
 */
function resolveSdkProtocolFiles(): string[] {
  try {
    const require = createRequire(import.meta.url);
    // Resolve the server entry, then walk to its own dependency directory: the
    // core package's `./package.json` subpath is not exported, so it cannot be
    // used directly.
    const serverEntry = require.resolve("@modelcontextprotocol/server");
    const serverDir = dirname(serverEntry);
    const coreDir = join(dirname(dirname(serverDir)), "core", "dist");
    return [join(coreDir, "internal.cjs"), ...readDistFiles(coreDir)];
  } catch {
    return [];
  }
}

function readDistFiles(dir: string): string[] {
  try {
    const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".cjs"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function readSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@modelcontextprotocol/server");
    // The package's `exports` map hides `./package.json`, so read it from the
    // resolved location instead of importing it.
    const raw = require("node:fs").readFileSync(join(dirname(entry), "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const MCP_SDK_VERSION = readSdkVersion();
import { pruneStaleUploads, registerBackupUploadParser, uploadOwnerNamespace } from "./services/backup.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // pino's Logger is structurally a FastifyBaseLogger; the cast keeps every
    // route module on the default generic so route registrars stay simple.
    loggerInstance: ctx.logger as unknown as import("fastify").FastifyBaseLogger,
    trustProxy: ctx.config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    max: ctx.config.rateLimitPerMin,
    timeWindow: "1 minute",
    allowList: (request) => request.url === "/api/health",
  });

  // `POST /api/admin/backup/verify` accepts the raw .db body. A stream parser
  // keeps the 64 MB snapshot out of memory and lets the handler enforce its own
  // limit before anything touches the (unpredictable) temp file.
  registerBackupUploadParser(app, ctx);
  await pruneStaleUploads(uploadOwnerNamespace(ctx.config.dataDir)).catch(() => undefined);

  // Host header validation for every route (DNS-rebinding hardening).
  // Health checks are exempt so container healthchecks can use any local address.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/health" || request.url === "/healthz") return;
    if (!isAllowedHost(request.headers.host, ctx.config.allowedHosts)) {
      request.log.warn({ host: request.headers.host }, "rejected request with disallowed Host header");
      await reply.status(403).send({
        error: {
          code: "forbidden",
          message:
            `Host "${request.headers.host ?? ""}" is not allowed. ` +
            "Set SEARCH_HUB_ALLOWED_HOSTS (comma separated) to the hostname clients use.",
        },
      });
    }
  });

  if (ctx.config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: ctx.config.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    });
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "geolocation=(), camera=(), microphone=()");
    reply.header("cross-origin-opener-policy", "same-origin");
    if (ctx.config.nodeEnv === "production") {
      reply.header(
        "content-security-policy",
        [
          "default-src 'self'",
          "img-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self'",
          "connect-src 'self'",
          "font-src 'self' data:",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join("; "),
      );
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof SearchHubError) {
      request.log.warn({ code: error.code, path: request.url }, error.message);
    } else if (typeof status === "number" && status >= 400 && status < 500) {
      // A malformed request is the caller's fault. Logging it at error level
      // turns routine bad traffic into an alarm, and a 500 would tell the caller
      // the server broke.
      request.log.debug({ status, path: request.url }, "rejected malformed request");
    } else if (status !== 429) {
      request.log.error({ err: error, path: request.url }, "unhandled request error");
    }
    sendError(reply, error);
  });

  registerAuthRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerWebRoutes(app, ctx);
  registerHealthRoutes(app, ctx);
  registerProviderHealthRoutes(app, ctx);
  registerQualityRoutes(app, ctx);
  registerMcpAdminRoutes(app, ctx, {
    repoRoot: REPO_ROOT,
    sdkFiles: () => resolveSdkProtocolFiles(),
    sdkVersion: MCP_SDK_VERSION,
    toolCount: () => MCP_TOOL_COUNT,
  });
  registerProviderRoutes(app, ctx);
  registerOnboardingRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerOpenApiRoutes(app, ctx.config.version);

  const staticDir = ctx.config.staticDir;
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
      index: ["index.html"],
      maxAge: ctx.config.nodeEnv === "production" ? "1h" : 0,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/mcp") {
        void reply.status(404).send({
          error: { code: "not_found", message: `No route for ${request.method} ${request.url}` },
        });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        void reply.status(405).send({ error: { code: "method_not_allowed", message: "Method not allowed" } });
        return;
      }
      void reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/mcp") {
        void reply.status(404).send({
          error: { code: "not_found", message: `No route for ${request.method} ${request.url}` },
        });
        return;
      }
      void reply
        .status(503)
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><html lang="zh-CN"><body style="font-family:system-ui;max-width:720px;margin:60px auto;line-height:1.7">
          <h1>Search Hub API 正在运行</h1>
          <p>Web 管理后台尚未构建。开发模式请运行 <code>pnpm dev:web</code>；生产镜像会包含已构建的前端。</p>
          <p>接口文档：<a href="/api/docs">/api/docs</a>，健康检查：<a href="/api/health">/api/health</a></p>
          </body></html>`,
        );
    });
  }

  app.addHook("onClose", async () => {
    ctx.providers.stopFlusher();
    await ctx.providers.flushDirty().catch(() => undefined);
    ctx.search.shutdown();
    ctx.resourceBudget.stop();
    ctx.resourceSlots.dispose();
    ctx.closeDb();
  });

  return app;
}

export function defaultStaticDir(): string {
  return join(process.cwd(), "apps", "web", "dist");
}
