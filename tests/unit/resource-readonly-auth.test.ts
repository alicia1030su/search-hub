import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminUsers, createDb, resolveMigrationsDir, runMigrations, sessions, type DbHandle } from "@search-hub/db";
import { authenticateAdminSessionReadOnly, SessionService, TokenService, type AuthDependencies } from "../../apps/api/src/auth.js";
import { loadConfig } from "../../apps/api/src/config.js";
import type { SettingsService } from "../../apps/api/src/services/settings.js";

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-readonly-auth-"));
  dirs.push(dir);
  const handle = createDb({ file: join(dir, "auth.db") });
  handles.push(handle);
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const now = new Date().toISOString();
  handle.db.insert(adminUsers).values({ id: "admin", email: "admin@example.com", name: "Admin", passwordHash: "hash", role: "admin", createdAt: now }).run();
  const config = { ...loadConfig(), dataDir: dir, dbPath: join(dir, "auth.db"), cookieSecure: false };
  const sessionService = new SessionService(handle.db, config, handle.sqlite);
  const tokens = new TokenService(handle.db);
  const deps: AuthDependencies = { db: handle.db, sessions: sessionService, tokens, settings: {} as SettingsService };
  const created = sessionService.create("admin", { ttlHours: 1 });
  return { handle, sessionService, tokens, deps, token: created.token };
}

describe("read-only admin session authentication", () => {
  it("does not touch lastSeenAt for a valid read-only lookup", () => {
    const { handle, sessionService, token } = fixture();
    handle.db.update(sessions).set({ lastSeenAt: "2020-01-01T00:00:00.000Z" }).run();
    expect(sessionService.lookup(token, { readOnly: true })?.actor.email).toBe("admin@example.com");
    expect(handle.db.select().from(sessions).all()[0]?.lastSeenAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("does not delete an expired session for a read-only lookup", () => {
    const { handle, sessionService, token } = fixture();
    handle.db.update(sessions).set({ expiresAt: "2020-01-01T00:00:00.000Z" }).run();
    expect(sessionService.lookup(token, { readOnly: true })).toBeNull();
    expect(handle.db.select().from(sessions).all()).toHaveLength(1);
  });

  it("rejects any Authorization header before TokenService.verify", () => {
    const { deps, tokens, token } = fixture();
    const verify = vi.spyOn(tokens, "verify");
    expect(() => authenticateAdminSessionReadOnly({ headers: { authorization: "Bearer anything" }, cookies: { sh_session: token }, ip: "127.0.0.1" }, deps)).toThrow(/Authorization headers/);
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns 401-style errors for missing or invalid cookies and accepts a valid session", () => {
    const { deps, token } = fixture();
    expect(() => authenticateAdminSessionReadOnly({ headers: {}, cookies: {}, ip: "127.0.0.1" }, deps)).toThrow(/Authentication required/);
    expect(() => authenticateAdminSessionReadOnly({ headers: {}, cookies: { sh_session: "invalid" }, ip: "127.0.0.1" }, deps)).toThrow(/Session expired or invalid/);
    expect(authenticateAdminSessionReadOnly({ headers: {}, cookies: { sh_session: token }, ip: "127.0.0.1" }, deps).type).toBe("admin");
  });
});
