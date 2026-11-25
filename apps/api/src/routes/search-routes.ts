import type { FastifyInstance, FastifyRequest } from "fastify";
import { SearchHubError, searchRequestSchema } from "@search-hub/shared";
import type { AppContext } from "../context.js";
import { authenticate, actorLabel } from "../auth.js";
import { audit, jsonFor, parseInput } from "../http.js";

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const execute = async (request: FastifyRequest, body: unknown) => {
    const actor = authenticate(
      {
        headers: request.headers as Record<string, string | string[] | undefined>,
        cookies: request.cookies as Record<string, string | undefined>,
        ip: request.ip,
      },
      ctx.authDeps,
      { scope: "search" },
    );
    const input = parseInput(searchRequestSchema, body);
    const controller = new AbortController();
    request.raw.once("close", () => {
      if (!request.raw.readableEnded) controller.abort(new Error("client disconnected"));
    });
    return ctx.search.execute(input, { actor: actorLabel(actor), signal: controller.signal });
  };

  app.post(
    "/api/search",
    jsonFor(app, async (request, reply) => {
      const response = await execute(request, request.body);
      if (response.status === "failed") reply.status(503);
      return response;
    }),
  );
  app.post(
    "/api/search/deep",
    jsonFor(app, async (request, reply) => {
      const response = await execute(request, { ...(request.body as Record<string, unknown>), mode: "deep" });
      if (response.status === "failed") reply.status(503);
      return response;
    }),
  );

  app.get(
    "/api/search/tasks/:id",
    jsonFor(app, async (request) => {
      const actor = authenticate(
        {
          headers: request.headers as Record<string, string | string[] | undefined>,
          cookies: request.cookies as Record<string, string | undefined>,
          ip: request.ip,
        },
        ctx.authDeps,
        { scope: "search" },
      );
      const { id } = request.params as { id: string };
      const task = ctx.search.getTask(id);
      if (!task) throw new SearchHubError("not_found", `Search task ${id} not found`);
      // Task contents are per-caller data: a token must not read another
      // caller's query or results just because it guessed the id.
      const owner = actorLabel(actor);
      if (task.actor === null ? actor.type !== "admin" : task.actor !== owner) {
        throw new SearchHubError("not_found", `Search task ${id} not found`);
      }
      const { actor: _owner, ...visible } = task;
      return visible;
    }),
  );

  app.post(
    "/api/search/tasks/:id/cancel",
    jsonFor(app, async (request) => {
      const actor = authenticate(
        {
          headers: request.headers as Record<string, string | string[] | undefined>,
          cookies: request.cookies as Record<string, string | undefined>,
          ip: request.ip,
        },
        ctx.authDeps,
        { scope: "search", mutation: true },
      );
      const { id } = request.params as { id: string };
      const task = ctx.search.getTask(id);
      const privileged = actor.type === "admin";
      const cancelled = ctx.search.cancel(id, actorLabel(actor), { allowUnowned: privileged });
      if (cancelled && privileged && task?.actor === null) {
        audit(
          ctx,
          actorLabel(actor),
          "search.task.cancel.unowned",
          id,
          { taskId: id, privileged: true, unowned: true },
          request.ip,
        );
      }
      return { ok: cancelled, taskId: id };
    }),
  );
}
