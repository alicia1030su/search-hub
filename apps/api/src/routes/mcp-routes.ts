import type { FastifyInstance } from "fastify";
import { createMcpHttpHandler } from "@search-hub/mcp";
import { SearchHubError } from "@search-hub/shared";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { sendError } from "../http.js";
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
    version: ctx.config.version,
  });

  /**
   * Host/Origin validation happens before authentication on purpose: a
   * DNS-rebinding attempt must not even be able to tell whether a token is
   * valid. `publicBaseUrl` is only used for documentation, not for validation,
   * because the instance may legitimately be reached by several names.
   */
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
      if (
        !isAllowedOrigin(
          typeof originHeader === "string" ? originHeader : null,
          requestOrigin,
          ctx.config.corsOrigins,
          ctx.config.allowedHosts,
        )
      ) {
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
