import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fetchWebpage, type WebpageReadResult } from "@search-hub/core";
import { SearchHubError } from "@search-hub/shared";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { jsonFor, parseInput } from "../http.js";

const webReadSchema = z.object({
  url: z.string().min(1).max(8192).url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  }, "url must be an HTTP(S) URL without credentials"),
  maxContentChars: z.number().int().min(1).max(500_000).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
});

export function registerWebRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/web/read",
    jsonFor(app, async (request, reply) => {
      authenticate(
        {
          headers: request.headers as Record<string, string | string[] | undefined>,
          cookies: request.cookies as Record<string, string | undefined>,
          ip: request.ip,
        },
        ctx.authDeps,
        { scope: "search" },
      );
      const input = parseInput(webReadSchema, request.body);
      let result: WebpageReadResult;
      try {
        result = await fetchWebpage(input.url, {
          fetch: ctx.fetch,
          maxContentChars: input.maxContentChars,
          timeoutMs: input.timeoutMs,
        });
      } catch (error) {
        if (error instanceof SearchHubError && error.status >= 500) {
          const message = error.code === "timeout" ? "Webpage request timed out" : "Webpage request failed";
          throw new SearchHubError(error.code === "timeout" ? "timeout" : "network", message, { status: error.status });
        }
        throw error;
      }
      if (result.readStatus !== "ok") reply.status(422);
      return result;
    }),
  );
}
