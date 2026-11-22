import { eq, sql } from "drizzle-orm";
import { SearchHubError } from "@search-hub/shared";
import type { SearchHubDb } from "@search-hub/db";
import { accessTokens, adminUsers, sessions } from "@search-hub/db";
import type { AppConfig } from "./config.js";
import type { SettingsService } from "./services/settings.js";
import { newSessionToken, randomToken, sha256Hex } from "./security/crypto.js";

export const SESSION_COOKIE = "sh_session";

export interface AdminActor {
  type: "admin";
  id: string;
  name: string;
  email: string;
}

export interface TokenActor {
  type: "token";
  id: string;
  name: string;
  scopes: string[];
}

export type Actor = AdminActor | TokenActor;

export interface SessionInfo {
  id: string;
  userId: string;
  csrfToken: string;
  expiresAt: string;
}

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string | undefined>;
  ip: string;
}

function headerValue(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export class SessionService {
  constructor(
    private readonly db: SearchHubDb,
    private readonly config: AppConfig,
  ) {}

  create(
    userId: string,
    meta: { ip?: string; userAgent?: string; ttlHours: number },
  ): { token: string; csrfToken: string; expiresAt: string } {
    const { token, hash } = newSessionToken();
    const csrfToken = randomToken("csrf_", 24).token;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + meta.ttlHours * 3_600_000).toISOString();
    this.db
      .insert(sessions)
      .values({
        id: `sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
        userId,
        tokenHash: hash,
        csrfToken,
        createdAt: now.toISOString(),
        expiresAt,
        lastSeenAt: now.toISOString(),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .run();
    return { token, csrfToken, expiresAt };
  }

  lookup(token: string, options: { readOnly?: boolean } = {}): { session: SessionInfo; actor: AdminActor } | null {
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256Hex(token)))
      .get();
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      if (!options.readOnly) this.db.delete(sessions).where(eq(sessions.id, row.id)).run();
      return null;
    }
    const user = this.db.select().from(adminUsers).where(eq(adminUsers.id, row.userId)).get();
    if (!user) return null;

    // Throttle lastSeenAt writes to at most once per minute.
    const lastSeen = row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0;
    if (!options.readOnly && Date.now() - lastSeen > 60_000) {
      this.db
        .update(sessions)
        .set({ lastSeenAt: new Date().toISOString() })
        .where(eq(sessions.id, row.id))
        .run();
    }

    return {
      session: {
        id: row.id,
        userId: row.userId,
        csrfToken: row.csrfToken,
        expiresAt: row.expiresAt,
      },
      actor: { type: "admin", id: user.id, name: user.name, email: user.email },
    };
  }

  destroyByToken(token: string): void {
    this.db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token))).run();
  }

  destroyAllForUser(userId: string): void {
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }

  cleanupExpired(): number {
    const result = this.db.run(
      sql`DELETE FROM sessions WHERE expires_at <= ${new Date().toISOString()}`,
    );
    return Number(result.changes ?? 0);
  }

  cookieOptions(): {
    httpOnly: true;
    sameSite: "lax";
    secure: boolean;
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.cookieSecure,
      path: "/",
      maxAge: 7 * 24 * 3600,
    };
  }
}

export class TokenService {
  private readonly rateWindows = new Map<string, number[]>();

  constructor(private readonly db: SearchHubDb) {}

  create(input: {
    name: string;
    scopes: string[];
    rateLimitPerMin: number;
    expiresAt?: string | null;
  }): { token: string; id: string; prefix: string } {
    const generated = randomToken("sh_", 32);
    const id = `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const now = new Date().toISOString();
    this.db
      .insert(accessTokens)
      .values({
        id,
        name: input.name,
        prefix: generated.token.slice(0, 11),
        tokenHash: generated.hash,
        scopesJson: JSON.stringify(input.scopes),
        rateLimitPerMin: input.rateLimitPerMin,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
      })
      .run();
    return { token: generated.token, id, prefix: generated.token.slice(0, 11) };
  }

  verify(rawToken: string): TokenActor | null {
    const row = this.db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.tokenHash, sha256Hex(rawToken)))
      .get();
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;

    const now = Date.now();
    const window = (this.rateWindows.get(row.id) ?? []).filter((timestamp) => timestamp > now - 60_000);
    if (window.length >= row.rateLimitPerMin) {
      throw new SearchHubError("rate_limited", "This access token exceeded its per-minute rate limit", {
        status: 429,
      });
    }
    window.push(now);
    this.rateWindows.set(row.id, window);

    // Update lastUsedAt at most once per minute.
    if (!row.lastUsedAt || now - new Date(row.lastUsedAt).getTime() > 60_000) {
      this.db
        .update(accessTokens)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(accessTokens.id, row.id))
        .run();
    }

    return {
      type: "token",
      id: row.id,
      name: row.name,
      scopes: safeParseArray(row.scopesJson),
    };
  }

  list(): Array<{
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    rateLimitPerMin: number;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }> {
    return this.db
      .select()
      .from(accessTokens)
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: safeParseArray(row.scopesJson),
        rateLimitPerMin: row.rateLimitPerMin,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        lastUsedAt: row.lastUsedAt,
        createdAt: row.createdAt,
      }));
  }

  revoke(id: string): boolean {
    const row = this.db.select().from(accessTokens).where(eq(accessTokens.id, id)).get();
    if (!row) return false;
    this.db
      .update(accessTokens)
      .set({ revokedAt: row.revokedAt ?? new Date().toISOString() })
      .where(eq(accessTokens.id, id))
      .run();
    return true;
  }

  hasScope(actor: TokenActor, scope: string): boolean {
    return actor.scopes.includes("*") || actor.scopes.includes(scope);
  }
}

function safeParseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export interface AuthDependencies {
  db: SearchHubDb;
  sessions: SessionService;
  tokens: TokenService;
  settings: SettingsService;
}

/**
 * Authenticates a request as either an admin session or an API token.
 * Session-authenticated mutations additionally require the CSRF header.
 */
export function authenticate(
  request: RequestLike,
  deps: AuthDependencies,
  options: { scope?: string; requireToken?: boolean; mutation?: boolean } = {},
): Actor {
  const authHeader = headerValue(request, "authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const raw = authHeader.slice(7).trim();
    const actor = deps.tokens.verify(raw);
    if (!actor) throw new SearchHubError("unauthorized", "Invalid or revoked access token");
    if (options.scope && !deps.tokens.hasScope(actor, options.scope)) {
      throw new SearchHubError("forbidden", `Token is missing the "${options.scope}" scope`);
    }
    return actor;
  }

  if (options.requireToken) {
    throw new SearchHubError("unauthorized", "This endpoint requires a Bearer access token");
  }

  const cookieToken = request.cookies[SESSION_COOKIE];
  if (!cookieToken) {
    throw new SearchHubError("unauthorized", "Authentication required");
  }
  const found = deps.sessions.lookup(cookieToken);
  if (!found) throw new SearchHubError("unauthorized", "Session expired or invalid");

  if (options.mutation) {
    const csrf = headerValue(request, "x-csrf-token");
    if (!csrf || csrf !== found.session.csrfToken) {
      throw new SearchHubError("forbidden", "Missing or invalid CSRF token");
    }
  }
  return found.actor;
}

/** Admin-session-only authentication for read-only endpoints; never verifies Bearer tokens. */
export function authenticateAdminSessionReadOnly(request: RequestLike, deps: AuthDependencies): AdminActor {
  if (headerValue(request, "authorization") !== undefined) {
    throw new SearchHubError("forbidden", "Authorization headers are not accepted for this endpoint");
  }
  const cookieToken = request.cookies[SESSION_COOKIE];
  if (!cookieToken) throw new SearchHubError("unauthorized", "Authentication required");
  const found = deps.sessions.lookup(cookieToken, { readOnly: true });
  if (!found) throw new SearchHubError("unauthorized", "Session expired or invalid");
  return found.actor;
}

export function requireAdmin(actor: Actor): AdminActor {
  if (actor.type !== "admin") {
    throw new SearchHubError("forbidden", "Administrator session required");
  }
  return actor;
}

export function actorLabel(actor: Actor): string {
  return actor.type === "admin" ? `admin:${actor.email}` : `token:${actor.name}`;
}

export function sessionFromRequest(request: RequestLike, deps: AuthDependencies): {
  actor: AdminActor;
  csrfToken: string;
  expiresAt: string;
} | null {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const found = deps.sessions.lookup(token);
  if (!found) return null;
  return { actor: found.actor, csrfToken: found.session.csrfToken, expiresAt: found.session.expiresAt };
}

export function cleanupSessions(db: SearchHubDb): void {
  db.run(sql`DELETE FROM sessions WHERE expires_at <= ${new Date().toISOString()}`);
}
