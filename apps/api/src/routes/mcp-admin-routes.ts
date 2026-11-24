import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SearchHubError } from "@search-hub/shared";
import { auditLogs } from "@search-hub/db";
import type { AppContext } from "../context.js";
import { authenticate, type Actor } from "../auth.js";
import { jsonFor } from "../http.js";
import { McpStatusService } from "../services/mcp-status.js";
import { resolveUpdaterInvocation, UpdateService } from "../services/updater.js";
import { REPO_ROOT } from "../config.js";
import { validateSkillDir } from "../services/skills.js";
import { writeZip } from "../services/zip.js";

/**
 * MCP status, Skills management and application updates.
 *
 * Authorization: everything here requires the `admin` scope. A `search`-scope
 * token must not be able to read the protocol version, enumerate installed
 * skills (which reveals internal tooling) or trigger a download.
 *
 * Mutation endpoints additionally require CSRF: staging a package is not
 * something a cross-site request may trigger.
 */
function adminOf(ctx: AppContext, request: FastifyRequest, mutation = false): Actor {
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

const SKILLS_ROOT = join(process.cwd(), "packages", "skills");
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function registerMcpAdminRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  options: { repoRoot: string; sdkFiles: () => string[]; sdkVersion: string; toolCount: () => number },
): void {
  const status = new McpStatusService({
    sdkFiles: options.sdkFiles,
    sdkVersion: options.sdkVersion,
    serverVersion: ctx.config.version,
    toolCount: options.toolCount,
    repoRoot: options.repoRoot,
  });

  const updater = new UpdateService({
    currentVersion: ctx.config.version,
    // Inside a container the image is immutable; the only correct answer is
    // "pull a new tag", so the updater reports that instead of swapping files
    // in a layer that would be discarded.
    deployment: () => (existsSync("/.dockerenv") ? "docker" : "standalone"),
    stagingDir: join(ctx.config.dataDir, "updates"),
  });

  app.get(
    "/api/admin/mcp",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      return status.status();
    }),
  );

  app.post(
    "/api/admin/mcp/update-check",
    jsonFor(app, async (request) => {
      adminOf(ctx, request, true);
      const force = (request.body as { force?: boolean } | undefined)?.force === true;
      return status.checkUpdates({ force });
    }),
  );

  app.get(
    "/api/admin/skills/:name",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      const { name } = request.params as { name: string };
      const dir = safeSkillDir(name);
      const validation = validateSkillDir(dir);
      const content = existsSync(join(dir, "SKILL.md")) ? readFileSync(join(dir, "SKILL.md"), "utf8") : null;
      return { ...validation, content };
    }),
  );

  /**
   * Packs one skill as a ZIP.
   *
   * The name is pattern-checked before any path is built, so `../config` cannot
   * resolve outside `packages/skills`. An invalid skill is refused rather than
   * exported: shipping a package that fails the specification would hand the
   * user a broken install.
   */
  app.get("/api/admin/skills/:name/export", async (request, reply) => {
    adminOf(ctx, request);
    const { name } = request.params as { name: string };
    const dir = safeSkillDir(name);
    if (!existsSync(dir)) throw new SearchHubError("not_found", `Skill ${name} not found`);
    const validation = validateSkillDir(dir);
    if (!validation.valid) {
      throw new SearchHubError(
        "validation_error",
        `Skill ${name} does not satisfy the Agent Skills specification: ${validation.issues
          .filter((issue) => issue.level === "error")
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }

    const tmp = join(ctx.config.dataDir, `skill-${name}-${Date.now()}.zip`);
    writeZip(dir, tmp);
    const size = statSync(tmp).size;
    reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${name}.zip"`)
      .header("content-length", String(size))
      .header("cache-control", "no-store");
    return reply.send(createReadStream(tmp));
  });

  /**
   * Application update surface.
   *
   * Split by risk:
   * - `check` is read-only (GitHub's API, cached)
   * - `stage` downloads and verifies a package but installs nothing
   * - installing is deliberately absent: swapping files under a running process
   *   is the launcher's job, and doing it from inside the server is exactly the
   *   "overwrite the running EXE" mistake that must not happen.
   */
  app.get(
    "/api/admin/update",
    jsonFor(app, async (request) => {
      adminOf(ctx, request);
      return { ...(await updater.check()), pending: updater.pending() };
    }),
  );

  app.post(
    "/api/admin/update/check",
    jsonFor(app, async (request) => {
      adminOf(ctx, request, true);
      return { ...(await updater.check({ force: true })), pending: updater.pending() };
    }),
  );

  app.post(
    "/api/admin/update/stage",
    jsonFor(app, async (request) => {
      const actor = adminOf(ctx, request, true);
      const staged = await updater.stage();
      writeAudit(ctx, actor, "update.stage", staged.assetName, { version: staged.version }, request.ip);
      return staged;
    }),
  );

  /**
   * What the operator should do next.
   *
   * The server cannot replace its own files, so it returns the exact command the
   * launcher-side updater needs. Nothing here executes anything: the CLI is
   * invoked by a human (or by the launcher), which keeps "the API can never
   * overwrite a running executable" true by construction.
   */
  app.post(
    "/api/admin/update/apply-plan",
    jsonFor(app, async (request) => {
      adminOf(ctx, request, true);
      const pending = updater.pending();
      if (!pending) {
        throw new SearchHubError(
          "not_found",
          "No staged update. Call POST /api/admin/update/stage first.",
        );
      }
      const deployment = existsSync("/.dockerenv") ? "docker" : "standalone";
      if (deployment === "docker") {
        return {
          deployment,
          executable: false,
          reason: "Docker deployments update by pulling a new image tag; the container never replaces itself.",
          steps: [
            "docker pull ghcr.io/alicia1030su/search-hub:<new-tag>",
            "docker compose up -d",
            "docker inspect --format='{{.State.Health.Status}}' <container>",
          ],
          rollback: [
            "Set the previous image tag in compose.yaml, then docker compose up -d",
            "The database lives in the named volume; a downgrade of the image does NOT rewind migrations.",
          ],
        };
      }
      const invocation = resolveUpdaterInvocation(REPO_ROOT);
      const argv = [
        invocation.nodeExecutable,
        invocation.updaterScript,
        "--package",
        pending.path,
        "--version",
        pending.version,
        "--sha256",
        pending.expectedSha256 ?? "",
        "--size",
        String(pending.bytes),
        "--root",
        invocation.installRoot,
        "--data",
        ctx.config.dataDir,
        "--db-path",
        ctx.config.dbPath,
      ];
      return {
        deployment,
        executable: true,
        argv,
        command: argv.map((part) => quoteCommandArg(part, process.platform)).join(" "),
        notes: [
          "The updater stops the service, snapshots the entire dataDir, installs the staged program and health-checks the new version.",
          "If the health check fails it restores the previous program and rolls the whole dataDir back to its pre-update state; the failed version is retained for diagnosis.",
          "Exit 3 means rolled back and healthy; exit 4 means manual attention is required.",
        ],
      };
    }),
  );
}

function quoteCommandArg(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeSkillDir(name: string): string {
  if (!SKILL_NAME.test(name)) {
    throw new SearchHubError("validation_error", "Invalid skill name");
  }
  const dir = join(SKILLS_ROOT, name);
  // Belt and braces: even with a valid name, refuse anything outside the root.
  if (!dir.startsWith(SKILLS_ROOT)) {
    throw new SearchHubError("validation_error", "Invalid skill name");
  }
  return dir;
}

function writeAudit(
  ctx: AppContext,
  actor: Actor,
  action: string,
  target: string | null,
  detail: unknown,
  ip: string,
): void {
  try {
    ctx.db
      .insert(auditLogs)
      .values({
        actor: `${actor.type}:${actor.name}`,
        action,
        target,
        detailJson: JSON.stringify(detail),
        ip,
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch {
    // Auditing a failed update attempt must not mask the update result.
  }
}
