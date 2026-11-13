import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SearchHubError, setupSchema, loginSchema } from "@search-hub/shared";
import { adminUsers } from "@search-hub/db";
import type { AppContext } from "../context.js";
import { SESSION_COOKIE } from "../auth.js";
import { jsonFor, parseInput, requestMeta, audit } from "../http.js";
import { hashPassword, newId, verifyPassword } from "../security/crypto.js";
import { setupTokenMatches } from "../security/setup-token.js";

/** Process-local login throttle, configurable via settings.security.loginRateLimitPerMin. */
const loginAttempts = new Map<string, number[]>();

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/setup/status",
    jsonFor(app, async () => {
      const admins = ctx.db.select({ count: sql<number>`count(*)` }).from(adminUsers).all()[0];
      const count = Number(admins?.count ?? 0);
      return {
        initialized: count > 0,
        version: ctx.config.version,
        admins: count,
        // Always true while uninitialized: a fresh instance must never be
        // claimable by whoever happens to reach the port first.
        setupTokenRequired: count === 0 && Boolean(ctx.setupToken.value),
      };
    }),
  );

  app.post(
    "/api/setup",
    jsonFor(app, async (request, reply) => {
      const existing = ctx.db.select({ count: sql<number>`count(*)` }).from(adminUsers).all()[0];
      if (Number(existing?.count ?? 0) > 0) {
        throw new SearchHubError("already_initialized", "This instance is already initialized. Sign in instead.");
      }
      const input = parseInput(setupSchema, request.body);

      const expected = ctx.setupToken.value;
      const provided = input.setupToken ?? request.headers["x-setup-token"];
      if (!expected) {
        throw new SearchHubError(
          "forbidden",
          "This instance has no active setup token. Restart it to generate one.",
        );
      }
      if (typeof provided !== "string" || !setupTokenMatches(expected, provided)) {
        throw new SearchHubError("forbidden", "A valid setup token is required to initialize this instance");
      }

      const now = new Date().toISOString();
      const userId = newId("usr");
      const passwordHash = hashPassword(input.password);

      // BEGIN IMMEDIATE serialises this check-and-insert across processes that
      // share the same database file, so two simultaneous setup calls cannot
      // both create an administrator.
      const claim = ctx.sqlite.transaction(() => {
        const row = ctx.sqlite
          .prepare("SELECT COUNT(*) AS count FROM admin_users")
          .get() as { count: number };
        if (Number(row.count) > 0) {
          throw new SearchHubError(
            "already_initialized",
            "This instance is already initialized. Sign in instead.",
          );
        }
        ctx.db
          .insert(adminUsers)
          .values({
            id: userId,
            email: input.email.toLowerCase(),
            name: input.name,
            passwordHash,
            role: "admin",
            createdAt: now,
          })
          .run();
      });
      claim.immediate();

      ctx.settings.markInitialized();
      ctx.refreshSetupToken();
      audit(ctx, `admin:${input.email}`, "setup.initialize", null, { version: ctx.config.version }, requestMeta(request).ip);

      const meta = requestMeta(request);
      const session = ctx.sessions.create(userId, {
        ip: meta.ip,
        userAgent: meta.userAgent,
        ttlHours: ctx.settings.get().security.sessionTtlHours,
      });
      void reply.setCookie(SESSION_COOKIE, session.token, ctx.sessions.cookieOptions());
      return {
        user: { id: userId, email: input.email.toLowerCase(), name: input.name },
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    }),
  );

  app.post(
    "/api/auth/login",
    jsonFor(app, async (request, reply) => {
      const limit = ctx.settings.get().security.loginRateLimitPerMin;
      const now = Date.now();
      const recent = (loginAttempts.get(request.ip) ?? []).filter((timestamp) => timestamp > now - 60_000);
      if (recent.length >= limit) {
        throw new SearchHubError("rate_limited", "Too many login attempts. Try again in a minute.");
      }
      recent.push(now);
      loginAttempts.set(request.ip, recent);
      if (loginAttempts.size > 2000) loginAttempts.clear();

      const input = parseInput(loginSchema, request.body);
      const user = ctx.db
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.email, input.email.toLowerCase()))
        .get();
      const genericFailure = new SearchHubError("unauthorized", "Invalid email or password");
      if (!user) throw genericFailure;
      if (!verifyPassword(input.password, user.passwordHash)) throw genericFailure;

      const meta = requestMeta(request);
      ctx.db
        .update(adminUsers)
        .set({ lastLoginAt: new Date().toISOString() })
        .where(eq(adminUsers.id, user.id))
        .run();
      const session = ctx.sessions.create(user.id, {
        ip: meta.ip,
        userAgent: meta.userAgent,
        ttlHours: ctx.settings.get().security.sessionTtlHours,
      });
      void reply.setCookie(SESSION_COOKIE, session.token, ctx.sessions.cookieOptions());
      audit(ctx, `admin:${user.email}`, "auth.login", null, null, meta.ip);
      return {
        user: { id: user.id, email: user.email, name: user.name },
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      };
    }),
  );

  app.get(
    "/api/auth/session",
    jsonFor(app, async (request) => {
      const token = request.cookies[SESSION_COOKIE];
      if (!token) throw new SearchHubError("unauthorized", "Not signed in");
      const found = ctx.sessions.lookup(token);
      if (!found) throw new SearchHubError("unauthorized", "Session expired");
      return {
        user: found.actor,
        csrfToken: found.session.csrfToken,
        expiresAt: found.session.expiresAt,
        initialized: true,
        version: ctx.config.version,
      };
    }),
  );

  app.post(
    "/api/auth/logout",
    jsonFor(app, async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) ctx.sessions.destroyByToken(token);
      void reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return { ok: true };
    }),
  );

  app.get(
    "/api/health",
    jsonFor(app, async () => {
      const admins = ctx.db.select({ count: sql<number>`count(*)` }).from(adminUsers).all()[0];
      const setupRequired = Number(admins?.count ?? 0) === 0;
      const providers = ctx.providers.providerSummaries();
      const outbound = ctx.describeOutboundPolicy();
      return {
        status: "ok",
        version: ctx.config.version,
        uptimeSeconds: Math.round(process.uptime()),
        setupRequired,
        providers: {
          total: providers.length,
          enabled: providers.filter((provider) => provider.enabled).length,
          healthy: providers.filter((provider) => provider.enabled && provider.healthyKeyCount > 0).length,
          circuitOpen: providers.filter((provider) => provider.circuitOpen).length,
        },
        database: { driver: "sqlite", migrations: ctx.migrated.length },
        encryption: { source: ctx.secrets.source },
        // Anonymous endpoint: only the coarse egress mode. The proxy endpoint,
        // NO_PROXY entries and residual-risk text are reachable by any
        // unauthenticated caller, so they live behind admin auth at
        // /api/admin/outbound; exposing them here would leak internal
        // topology (proxy host:port) to the network.
        outbound: {
          mode: outbound.mode,
          proxyTrust: outbound.proxyTrust,
          proxyTrustDeclared: outbound.proxyTrustDeclared,
        },
      };
    }),
  );
}
