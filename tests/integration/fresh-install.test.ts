import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

/**
 * A brand-new installation must contain **no** search source. The catalog is
 * available, but nothing is installed and nothing is enabled, so the first
 * search cannot silently use a provider the operator never chose.
 *
 * This lives in its own file with its own database because the provider suite
 * creates instances earlier in its run.
 */
let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "fresh.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-fresh-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      email: "admin@example.com",
      password: "A-very-long-password-1",
      name: "Admin",
      setupToken: ctx.setupToken.value!,
    },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("fresh installation", () => {
  it("installs no provider and enables nothing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      providers: unknown[];
      catalog: Array<{ type: string }>;
      manifests: Array<{ providerId: string }>;
    };
    expect(body.providers).toEqual([]);
    // The marketplace is still fully populated.
    expect(body.catalog.length).toBeGreaterThan(0);
    expect(body.manifests.map((item) => item.providerId)).toEqual(
      body.catalog.map((item) => item.type),
    );
  });

  it("refuses to search before anything is installed", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: cookie },
      payload: { query: "hello", mode: "basic", limit: 5 },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("can install and enable a keyless source, then search it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": sessionCsrf() },
      payload: {
        name: "mock-after-install",
        type: "mock",
        enabled: true,
        timeoutMs: 5000,
        maxConcurrency: 2,
        maxRetries: 0,
        rpmLimit: 60,
        config: { resultCount: 2, latencyMs: 5, namespace: "fresh" },
      },
    });
    expect(created.statusCode, created.body).toBe(200);

    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": sessionCsrf() },
      payload: { query: "hello", mode: "basic", limit: 5, skipCache: true },
    });
    expect(search.statusCode, search.body).toBe(200);
    expect((search.json() as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });
});

function sessionCsrf(): string {
  const session = ctx.sessions.lookup(cookie);
  if (!session) throw new Error("no session");
  return session.session.csrfToken;
}
