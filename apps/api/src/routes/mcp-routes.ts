import type { FastifyInstance } from "fastify";
import { createMcpHttpHandler } from "@search-hub/mcp";
import { SearchHubError } from "@search-hub/shared";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { jsonFor, sendError } from "../http.js";
import { isAllowedHost, isAllowedOrigin } from "../security/host.js";

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const handler = createMcpHttpHandler({
    search: {
      execute: (request, options) => ctx.search.execute(request, options),
    },
    providers: {
      list: async () =>
        ctx.providers.providerSummaries().map((provider) => ({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          enabled: provider.enabled,
        })),
      status: async () => ctx.providers.runtimeSnapshots(),
    },
    // Read-only projection: the MCP tool must not be able to spend quota, so it
    // gets a getter that only reads the last recorded probes.
    health: async () => {
      const overview = ctx.health.overview();
      return {
        generatedAt: overview.generatedAt,
        totals: overview.totals,
        budget: {
          maxPerRun: overview.budget.maxPerRun,
          maxPerDay: overview.budget.maxPerDay,
          usedToday: overview.budget.usedToday,
          paidProbesEnabled: overview.budget.paidProbesEnabled,
        },
        providers: overview.providers.map((provider) => ({
          providerId: provider.providerId,
          providerName: provider.providerName,
          providerType: provider.providerType,
          enabled: provider.enabled,
          status: provider.status,
          healthScore: provider.healthScore,
          lastCheckedAt: provider.lastCheckedAt,
          lastSuccessAt: provider.lastSuccessAt,
          lastErrorCode: provider.lastErrorCode,
          consecutiveFailures: provider.consecutiveFailures,
          successRate: provider.successRate,
          p50LatencyMs: provider.p50LatencyMs,
          p95LatencyMs: provider.p95LatencyMs,
          keyAvailable: provider.keyAvailable,
          keyTotal: provider.keyTotal,
        })),
      };
    },
    version: ctx.config.version,
  });

  /**
   * Host/Origin validation happens before authentication on purpose: a
   * DNS-rebinding attempt must not even be able to tell whether a token is
   * valid. `publicBaseUrl` is only used for documentation, not for validation,
   * because the instance may legitimately be reached by several names.
   */
  /**
   * Health projection for the stdio MCP bridge.
   *
   * `/api/admin/health` requires the `admin` scope, which a search token must
   * never have. This endpoint exposes the same derived data (status, latency,
   * error code, key counts) minus everything sensitive — no base URLs, no key
   * material, no history — so the stdio server can answer `get_provider_health`
   * without an admin credential.
   */
  app.get("/api/mcp/health", jsonFor(app, async (request) => {
    const actor = authenticate(
      {
        headers: request.headers as Record<string, string | string[] | undefined>,
        cookies: request.cookies as Record<string, string | undefined>,
        ip: request.ip,
      },
      ctx.authDeps,
      { scope: "mcp:use", requireToken: true },
    );
    void actor;
    const overview = ctx.health.overview();
    return {
      generatedAt: overview.generatedAt,
      totals: overview.totals,
      budget: {
        maxPerRun: overview.budget.maxPerRun,
        maxPerDay: overview.budget.maxPerDay,
        usedToday: overview.budget.usedToday,
        paidProbesEnabled: overview.budget.paidProbesEnabled,
      },
      providers: overview.providers.map((provider) => ({
        providerId: provider.providerId,
        providerName: provider.providerName,
        providerType: provider.providerType,
        enabled: provider.enabled,
        status: provider.status,
        healthScore: provider.healthScore,
        lastCheckedAt: provider.lastCheckedAt,
        lastSuccessAt: provider.lastSuccessAt,
        lastErrorCode: provider.lastErrorCode,
        consecutiveFailures: provider.consecutiveFailures,
        successRate: provider.successRate,
        p50LatencyMs: provider.p50LatencyMs,
        p95LatencyMs: provider.p95LatencyMs,
        keyAvailable: provider.keyAvailable,
        keyTotal: provider.keyTotal,
      })),
    };
  }));

  app.all("/mcp", async (request, reply) => {
    try {
      const hostHeader = request.headers.host;
      if (!isAllowedHost(hostHeader, ctx.config.allowedHosts)) {
        throw new SearchHubError(
          "forbidden",
          `Host "${hostHeader ?? ""}" is not allowed. Add it to SEARCH_HUB_ALLOWED_HOSTS if this is intentional.`,
        );
      }

      const requestOrigin = `${request.protocol}://${request.headers.host}`;
      const originHeader = request.headers.origin;
      if (!isAllowedOrigin(originHeader, requestOrigin, ctx.config.corsOrigins)) {
        throw new SearchHubError("forbidden", "Origin is not allowed for this MCP endpoint");
      }

      const actor = authenticate(
        {
          headers: request.headers as Record<string, string | string[] | undefined>,
          cookies: request.cookies as Record<string, string | undefined>,
          ip: request.ip,
        },
        ctx.authDeps,
        { scope: "mcp:use", requireToken: true },
      );

      const host = request.headers.host ?? `127.0.0.1:${ctx.config.port}`;
      const url = new URL(`${request.protocol}://${host}${request.url}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(", "));
      }

      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const body = hasBody ? JSON.stringify(request.body ?? {}) : undefined;
      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });

      const response = await handler.fetch(webRequest, {
        authInfo: {
          clientId: actor.id,
          scopes: actor.type === "token" ? actor.scopes : [],
          token: (request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""),
        },
      });

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "content-length") return;
        reply.header(key, value);
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      reply.send(buffer);
    } catch (error) {
      sendError(reply, error);
    }
  });
}
