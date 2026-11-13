import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function boot(overrides: Partial<AppConfig> = {}): Promise<{
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-sec-"));
  const config: AppConfig = {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "sec.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    ...overrides,
  };
  const ctx = createContext(config);
  const app = await buildApp(ctx);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, ctx, dir };
}

const password = "A-very-long-password-1";

describe("first-run setup hardening", () => {
  it("generates a one-time token and refuses anonymous initialization", async () => {
    const { app, ctx, dir } = await boot();
    const tokenPath = join(dir, "setup-token");
    expect(existsSync(tokenPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    }

    const status = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toMatchObject({ initialized: false, setupTokenRequired: true });

    const denied = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "attacker@example.com", password, name: "Attacker" },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password, name: "Admin", setupToken: ctx.setupToken.value! },
    });
    expect(allowed.statusCode).toBe(200);
    // The generated file is removed once an administrator exists.
    expect(existsSync(tokenPath)).toBe(false);

    const second = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "other@example.com", password, name: "Other", setupToken: ctx.setupToken.value ?? "x" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("rejects two concurrent setup requests instead of creating two admins", async () => {
    const { app, ctx, dir } = await boot();
    const token = ctx.setupToken.value!;
    const payload = { email: "race@example.com", password, name: "Race", setupToken: token };
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/setup", payload }),
      app.inject({ method: "POST", url: "/api/setup", payload }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    // Exactly one administrator row must exist.
    const row = ctx.sqlite.prepare("SELECT COUNT(*) AS count FROM admin_users").get() as { count: number };
    expect(Number(row.count)).toBe(1);
    void dir;
  });

  it("requires the environment token when one is configured", async () => {
    const { app } = await boot({ setupToken: "env-token-value" });
    const denied = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password, name: "Admin" },
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password, name: "Admin", setupToken: "env-token-value" },
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe("Host header and CSRF hardening", () => {
  async function setupAdmin(app: FastifyInstance, ctx: AppContext) {
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password, name: "Admin", setupToken: ctx.setupToken.value! },
    });
    return {
      cookie: setup.cookies.find((item) => item.name === "sh_session")!.value,
      csrf: setup.json().csrfToken as string,
    };
  }

  it("rejects a DNS-rebinding Host header on admin routes", async () => {
    const { app, ctx } = await boot();
    const { cookie } = await setupAdmin(app, ctx);
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      headers: { host: "rebind.example.com" },
      cookies: { sh_session: cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("SEARCH_HUB_ALLOWED_HOSTS");
  });

  it("accepts an allowlisted hostname", async () => {
    const { app, ctx } = await boot({ allowedHosts: ["localhost", "127.0.0.1", "hub.internal"] });
    const { cookie } = await setupAdmin(app, ctx);
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      headers: { host: "hub.internal" },
      cookies: { sh_session: cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it("requires CSRF for cookie-authenticated mutations", async () => {
    const { app, ctx } = await boot();
    const { cookie } = await setupAdmin(app, ctx);
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: cookie },
      payload: { defaults: { limit: 10 } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("CSRF");
  });

  it("ignores X-Forwarded-For unless a trusted proxy is configured", async () => {
    const { app, ctx } = await boot({ trustProxy: false });
    const { cookie, csrf } = await setupAdmin(app, ctx);
    await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf, "x-forwarded-for": "203.0.113.9" },
      payload: { defaults: { limit: 11 } },
    });
    const logs = ctx.db
      .select()
      .from(ctx.db._.fullSchema.auditLogs)
      .all() as Array<{ action: string; ip: string | null }>;
    const settingsAudit = logs.filter((row) => row.action === "settings.update");
    expect(settingsAudit.length).toBeGreaterThan(0);
    expect(settingsAudit.at(-1)!.ip).toBe("127.0.0.1");
  });

  it("honours X-Forwarded-For from an explicitly trusted proxy", async () => {
    const { app, ctx } = await boot({ trustProxy: "127.0.0.1/8,::1/128" });
    const { cookie, csrf } = await setupAdmin(app, ctx);
    await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf, "x-forwarded-for": "203.0.113.9" },
      payload: { defaults: { limit: 12 } },
    });
    const logs = ctx.db
      .select()
      .from(ctx.db._.fullSchema.auditLogs)
      .all() as Array<{ action: string; ip: string | null }>;
    const settingsAudit = logs.filter((row) => row.action === "settings.update");
    expect(settingsAudit.at(-1)!.ip).toBe("203.0.113.9");
  });
});
