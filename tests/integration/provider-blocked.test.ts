import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

/**
 * End-to-end guard for the SSRF error contract.
 *
 * A destination the SSRF policy rejects must surface as `blocked` in
 * `failedSources[]`. It used to come out as `auth_invalid`, because
 * `SearchHubError("blocked")` carries HTTP status 403 and `callJson` classified
 * by status — which would make an operator (and the key scheduler) believe the
 * credential was bad, while the real cause was a refused destination.
 */

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;
let csrf: string;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "blocked.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

async function addProvider(payload: Record<string, unknown>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { enabled: true, timeoutMs: 800, maxRetries: 0, resultsPerPage: 5, ...payload },
  });
  expect(response.statusCode).toBe(200);
  return response.json().provider.id as string;
}

async function search(providers: string[], query: string) {
  return app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { query, mode: "rrf", limit: 10, providers, timeoutMs: 5_000 },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-blocked-"));
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
  csrf = setup.json().csrfToken as string;
  // No private-host allowlist is configured: every loopback target must be refused.
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("blocked destinations over /api/search", () => {
  it("reports failedSources code blocked for a private (non-allowlisted) target", async () => {
    const blocked = await addProvider({
      name: "blocked-loopback",
      type: "generic-http",
      baseUrl: "http://127.0.0.1:9",
      config: { method: "GET", path: "/search", query: { q: "{{query}}" }, resultsPath: "results" },
    });
    const response = await search([blocked], "blocked target");
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("failed");
    expect(body.results).toHaveLength(0);
    expect(body.failedSources).toEqual([{ id: blocked, code: "blocked" }]);
    expect(body.errors[0].code).toBe("blocked");
    expect(body.errors[0].message).toMatch(/private or reserved address|allowlist/i);
  });

  it("reports blocked for the cloud metadata address even when it is allowlisted", async () => {
    const allow = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { security: { privateHostAllowlist: ["169.254.169.254"] } },
    });
    expect(allow.statusCode).toBe(200);

    const metadata = await addProvider({
      name: "blocked-metadata",
      type: "generic-http",
      baseUrl: "http://169.254.169.254",
      config: { method: "GET", path: "/latest/meta-data", resultsPath: "results" },
    });
    const response = await search([metadata], "metadata target");
    const body = response.json();
    expect(response.statusCode).toBe(503);
    expect(body.failedSources).toEqual([{ id: metadata, code: "blocked" }]);
    expect(body.errors[0].message).toMatch(/metadata/i);
  });

  it("keeps a healthy provider's results while the blocked one is reported", async () => {
    const healthy = await addProvider({
      name: "healthy-alongside-blocked",
      type: "mock",
      config: { resultCount: 3, latencyMs: 5, namespace: "healthy" },
    });
    const blocked = await addProvider({
      name: "blocked-alongside-healthy",
      type: "generic-http",
      baseUrl: "http://10.0.0.1",
      config: { method: "GET", path: "/search", query: { q: "{{query}}" }, resultsPath: "results" },
    });
    const response = await search([healthy, blocked], "mixed");
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("partial");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.failedSources).toEqual([{ id: blocked, code: "blocked" }]);
  });
});
