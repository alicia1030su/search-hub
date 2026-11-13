import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;
let csrf: string;
let providerId: string;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "load.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-load-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin" },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  csrf = setup.json().csrfToken as string;

  const provider = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: {
      name: "load-mock",
      type: "mock",
      enabled: true,
      maxConcurrency: 2,
      rpmLimit: 10_000,
      config: { resultCount: 3, latencyMs: 8, namespace: "load" },
    },
  });
  providerId = provider.json().provider.id as string;

  // Two keys with a per-key concurrency of 2: 4 slots in total.
  for (const label of ["k1", "k2"]) {
    const created = await app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { label, key: `sk-LOAD-${label}-FINGERPRINT`, weight: 100, enabled: true },
    });
    expect(created.statusCode).toBe(200);
  }
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("100 concurrent searches", () => {
  it("completes every request without breaking key limits or leaking secrets", async () => {
    const requests = Array.from({ length: 100 }, (_, index) =>
      app.inject({
        method: "POST",
        url: "/api/search",
        cookies: { sh_session: cookie },
        headers: { "x-csrf-token": csrf },
        payload: { query: `concurrent query ${index % 7}`, mode: "rrf", limit: 5 },
      }),
    );

    const responses = await Promise.all(requests);
    const failures = responses.filter((response) => response.statusCode !== 200);
    expect(failures.map((response) => response.statusCode)).toEqual([]);

    for (const response of responses) {
      const body = response.json();
      expect(body.results.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain("sk-LOAD-");
    }

    // Live counters must never have exceeded the per-key limit. The scheduler
    // snapshot is taken after the burst; inFlight should be back to zero.
    const keys = ctx.providers.listKeys(providerId);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.inFlight === 0)).toBe(true);
    const totalRequests = keys.reduce((sum, key) => sum + key.requestCount, 0);
    expect(totalRequests).toBeGreaterThanOrEqual(100);

    // The budget is 4 concurrent slots × 2 keys, so 100 requests must not have
    // been serialised into 100 × 8ms.
    const duration = responses.reduce((max, response) => {
      const body = response.json();
      return Math.max(max, body.stats?.timing?.totalMs ?? 0);
    }, 0);
    expect(duration).toBeLessThan(8 * 100);
  });

  it("keeps provider stats consistent with the number of searches", async () => {
    const dashboard = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard?range=24h",
      cookies: { sh_session: cookie },
    });
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json();
    expect(body.totals.searches).toBeGreaterThanOrEqual(100);
    expect(body.providers[0].calls).toBeGreaterThanOrEqual(100);
    expect(body.currentConcurrency).toBe(0);
  });
});
