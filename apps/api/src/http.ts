import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, type ZodType } from "zod";
import { SearchHubError } from "@search-hub/shared";
import type { AppContext } from "./context.js";

export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof SearchHubError) {
    void reply.status(error.status).send(error.toJSON());
    return;
  }
  if (error instanceof ZodError) {
    void reply.status(400).send({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 429) {
    void reply.status(429).send({
      error: { code: "rate_limited", message: "Too many requests. Slow down and retry later." },
    });
    return;
  }
  void reply.status(500).send({
    error: { code: "internal_error", message: "Internal server error" },
  });
}

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new SearchHubError("validation_error", "Request validation failed", {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function requestMeta(request: FastifyRequest): { ip: string; userAgent: string } {
  return {
    ip: request.ip,
    userAgent: request.headers["user-agent"] ?? "",
  };
}

export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

export function audit(
  ctx: AppContext,
  actor: string,
  action: string,
  target: string | null,
  detail: unknown,
  ip: string,
): void {
  try {
    ctx.db
      .insert(ctx.db._.fullSchema.auditLogs)
      .values({
        actor,
        action,
        target,
        detailJson: detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
        ip,
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch (error) {
    ctx.logger.warn({ err: error }, "failed to write audit log");
  }
}

export function attachAbortOnDisconnect(request: FastifyRequest, controller: AbortController): void {
  const closeHandler = () => {
    if (!request.raw.readableEnded) controller.abort(new Error("client disconnected"));
  };
  request.raw.once("close", closeHandler);
}

export function jsonFor(
  app: FastifyInstance,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const result = await handler(request, reply);
      if (!reply.sent) void reply.send(result);
    } catch (error) {
      request.log.debug({ err: error }, "request failed");
      sendError(reply, error);
    }
  };
}
