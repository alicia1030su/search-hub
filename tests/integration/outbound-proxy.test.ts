import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.unstubAllEnvs();
});

async function boot(env: Record<string, string> = {}): Promise<{
  app: FastifyInstance;
  ctx: AppContext;
}> {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const dir = mkdtempSync(join(tmpdir(), "search-hub-outbound-"));
  const config: AppConfig = {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "outbound.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
  const ctx = createContext(config);
  const app = await buildApp(ctx);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, ctx };
}

const password = "A-very-long-password-1";

async function signIn(app: FastifyInstance, ctx: AppContext) {
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      email: "admin@example.com",
      password,
      name: "Admin",
      setupToken: ctx.setupToken.value!,
    },
  });
  expect(setup.statusCode).toBe(200);
  return {
    cookies: { sh_session: setup.cookies.find((item) => item.name === "sh_session")!.value },
    headers: { "x-csrf-token": setup.json().csrfToken as string },
  };
}

type HealthResponse = { json(): { outbound: Record<string, unknown> } };

function healthOutbound(response: HealthResponse): Record<string, unknown> {
  return response.json().outbound;
}

describe("outbound proxy configuration", () => {
  it("defaults to direct connections and says so on /api/health", async () => {
    const { app } = await boot();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    // /api/health is anonymous: it must report the coarse mode only, never the
    // proxy endpoint or NO_PROXY topology (that lives at /api/admin/outbound).
    expect(health.json().outbound).toEqual({
      mode: "direct",
      proxyTrust: "untrusted",
      proxyTrustDeclared: false,
    });
  });

  it("reads SEARCH_HUB_PROXY and defaults the trust level to untrusted", async () => {
    const { app } = await boot({
      SEARCH_HUB_PROXY: "http://127.0.0.1:3128",
      SEARCH_HUB_NO_PROXY: "internal.test,127.0.0.1",
    });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().outbound).toEqual({
      mode: "proxy",
      proxyTrust: "untrusted",
      proxyTrustDeclared: false,
    });
    // The undeclared-trust state must be stated, but the endpoint itself must
    // not leak internal topology to an unauthenticated caller.
    expect(health.payload).not.toContain("127.0.0.1:3128");
    expect(health.payload).not.toContain("internal.test");
  });

  it("reports trusted-networks when the operator declares it", async () => {
    const { app } = await boot({
      SEARCH_HUB_PROXY: "http://127.0.0.1:3128",
      SEARCH_HUB_PROXY_TRUST: "trusted-networks",
    });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().outbound).toEqual({
      mode: "proxy",
      proxyTrust: "trusted-networks",
      proxyTrustDeclared: true,
    });
  });

  it("accepts the documented trust-level aliases", async () => {
    for (const [input, expected] of [
      ["application-only", "untrusted"],
      ["egress-enforced", "trusted-networks"],
    ] as const) {
      const { app, ctx } = await boot({
        SEARCH_HUB_PROXY: `http://127.0.0.1:3128`,
        SEARCH_HUB_PROXY_TRUST: input,
      });
      expect(ctx.outboundProxy.trust).toBe(expected);
      expect(ctx.outboundProxy.trustDeclared).toBe(true);
      await app.close();
    }
  });

  it("keeps accepting the SEARCH_HUB_OUTBOUND_* aliases", async () => {
    const { app } = await boot({
      SEARCH_HUB_OUTBOUND_PROXY: "http://127.0.0.1:3128",
      SEARCH_HUB_OUTBOUND_NO_PROXY: "a.test",
      SEARCH_HUB_OUTBOUND_PROXY_TRUST: "trusted-networks",
    });
    expect(healthOutbound(await app.inject({ method: "GET", url: "/api/health" }))).toEqual({
      mode: "proxy",
      proxyTrust: "trusted-networks",
      proxyTrustDeclared: true,
    });
  });

  it("fails closed at boot for an unsupported proxy scheme", async () => {
    vi.stubEnv("SEARCH_HUB_PROXY", "socks5://127.0.0.1:1080");
    const dir = mkdtempSync(join(tmpdir(), "search-hub-outbound-bad-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config: AppConfig = {
      ...loadConfig(),
      nodeEnv: "test",
      dataDir: dir,
      dbPath: join(dir, "outbound.db"),
      staticDir: null,
      logLevel: "silent",
    };
    expect(() => createContext(config)).toThrowError(/Unsupported outbound proxy scheme/i);
  });

  it("fails closed at boot for an unknown trust level", async () => {
    vi.stubEnv("SEARCH_HUB_PROXY", "http://127.0.0.1:3128");
    vi.stubEnv("SEARCH_HUB_PROXY_TRUST", "trust-me");
    const dir = mkdtempSync(join(tmpdir(), "search-hub-outbound-bad-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config: AppConfig = {
      ...loadConfig(),
      nodeEnv: "test",
      dataDir: dir,
      dbPath: join(dir, "outbound.db"),
      staticDir: null,
      logLevel: "silent",
    };
    expect(() => createContext(config)).toThrowError(/Invalid outbound proxy trust level/i);
  });

  it("ignores ambient HTTP_PROXY unless explicitly opted in", () => {
    vi.stubEnv("HTTP_PROXY", "http://attacker.test:8080");
    vi.stubEnv("HTTPS_PROXY", "http://attacker.test:8080");
    expect(loadConfig().outboundProxy.proxy).toBeNull();
  });

  it("refuses an inherited HTTP_PROXY that has no declared trust level", () => {
    // Opting in to ambient env vars must not also opt in to trusting whoever
    // set them: an inherited HTTP_PROXY without a trust level would silently
    // reroute every provider request through an undeclared endpoint.
    vi.stubEnv("SEARCH_HUB_PROXY_FROM_ENV", "true");
    vi.stubEnv("HTTP_PROXY", "http://attacker.test:8080");
    expect(() => loadConfig()).toThrowError(/SEARCH_HUB_PROXY_TRUST is not set/i);
  });

  it("accepts an inherited HTTP_PROXY once a trust level is declared", () => {
    vi.stubEnv("SEARCH_HUB_PROXY_FROM_ENV", "true");
    vi.stubEnv("HTTPS_PROXY", "http://corp-proxy.test:8080");
    vi.stubEnv("NO_PROXY", "internal.test");
    vi.stubEnv("SEARCH_HUB_PROXY_TRUST", "untrusted");
    const config = loadConfig().outboundProxy;
    expect(config.proxy).toBe("http://corp-proxy.test:8080");
    expect(config.noProxy).toBe("internal.test");
    expect(config.source).toBe("conventional-env");
  });

  it("exposes the redacted proxy endpoint to admins only", async () => {
    const { app, ctx } = await boot({
      SEARCH_HUB_PROXY: "http://proxyuser:sup3rsecret@127.0.0.1:3128",
      SEARCH_HUB_NO_PROXY: "a.test,b.test",
    });

    const anonymous = await app.inject({ method: "GET", url: "/api/admin/outbound" });
    expect(anonymous.statusCode).toBe(401);

    const admin = await signIn(app, ctx);
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/outbound",
      cookies: admin.cookies,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe("proxy");
    expect(body.proxyHost).toBe("http://127.0.0.1:3128");
    expect(body.proxyHasCredentials).toBe(true);
    expect(body.noProxyEntries).toBe(2);
    expect(body.privateHostAllowlistHonored).toBe(false);
    // The full NO_PROXY list is admin-visible; credentials never are.
    expect(body.noProxy).toEqual(["a.test", "b.test"]);
    expect(response.payload).not.toContain("sup3rsecret");
    expect(response.payload).not.toContain("proxyuser");

    // Health is anonymous: coarse mode/trust only. The proxy endpoint,
    // NO_PROXY entries and residual-risk text are admin-only, so an
    // unauthenticated caller cannot map the internal egress topology.
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().outbound).toEqual({
      mode: "proxy",
      proxyTrust: "untrusted",
      proxyTrustDeclared: false,
    });
    expect(health.payload).not.toContain("3128");
    expect(health.payload).not.toContain("sup3rsecret");
    expect(health.payload).not.toContain("proxyuser");
    expect(health.payload).not.toContain("a.test");
  });
});
