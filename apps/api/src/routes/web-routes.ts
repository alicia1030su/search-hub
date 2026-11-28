import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WebpageReadResult } from "@search-hub/core";
import { SearchHubError } from "@search-hub/shared";
import type { AppContext } from "../context.js";
import { authenticate } from "../auth.js";
import { jsonFor, parseInput } from "../http.js";
import { readWebpageWithBudget } from "../services/web-read-budget.js";

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
      const controller = new AbortController();
      const onDisconnect = () => {
        if (!reply.raw.writableEnded) controller.abort(new Error("client disconnected"));
      };
      request.raw.once("aborted", onDisconnect);
      reply.raw.once("close", onDisconnect);
      let result: WebpageReadResult;
      try {
        result = await readWebpageWithBudget(input.url, {
          fetch: ctx.fetch,
          resourceSlots: ctx.resourceSlots,
          signal: controller.signal,
          maxContentChars: input.maxContentChars,
          timeoutMs: input.timeoutMs,
        });
      } catch (error) {
        if (error instanceof SearchHubError && error.status >= 500) {
          const message = error.code === "timeout" ? "Webpage request timed out" : "Webpage request failed";
          throw new SearchHubError(error.code === "timeout" ? "timeout" : "network", message, { status: error.status });
        }
        throw error;
      } finally {
        request.raw.removeListener("aborted", onDisconnect);
        reply.raw.removeListener("close", onDisconnect);
      }
      if (result.readStatus !== "ok") reply.status(422);
      return result;
    }),
  );
}
