import type { FastifyInstance } from "fastify";
import { createMcpHttpHandler } from "@search-hub/mcp";
import { SearchHubError } from "@search-hub/shared";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { sendError } from "../http.js";

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

  app.all("/mcp", async (request, reply) => {
    try {
      const actor = authenticate(
        {
          headers: request.headers as Record<string, string | string[] | undefined>,
          cookies: request.cookies as Record<string, string | undefined>,
          ip: request.ip,
        },
        ctx.authDeps,
        { scope: "mcp:use", requireToken: true },
      );

      // DNS-rebinding / CSRF hardening for browser-originated requests.
      const origin = request.headers.origin;
      if (typeof origin === "string" && origin) {
        const allowed = new Set<string>([`${request.protocol}://${request.headers.host}`]);
        for (const entry of ctx.config.corsOrigins) allowed.add(new URL(entry).origin);
        if (!allowed.has(origin)) {
          throw new SearchHubError("forbidden", "Origin is not allowed for this MCP endpoint");
        }
      }

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
