import { createServer, type Server } from "node:http";
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
let brokenServer: Server;
let brokenPort = 0;

const RUNS = 50;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "faults.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

async function addProvider(input: Record<string, unknown>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: {
      enabled: true,
      timeoutMs: 800,
      maxConcurrency: 8,
      maxRetries: 0,
      resultsPerPage: 5,
      rpmLimit: 10_000,
      ...input,
    },
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
  dir = mkdtempSync(join(tmpdir(), "search-hub-faults-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  csrf = setup.json().csrfToken as string;

  // Allow the loopback test server through the SSRF allowlist.
  const settings = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });
  expect(settings.statusCode).toBe(200);

  brokenServer = createServer((req, res) => {
    // A 200 response with a content-type that promises JSON but is not.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("<html>this is not json</html>");
  });
  await new Promise<void>((resolve) => brokenServer.listen(0, "127.0.0.1", resolve));
  const address = brokenServer.address();
  if (typeof address === "object" && address) brokenPort = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("AC-06 fault isolation matrix", () => {
  const modes = [
    { name: "timeout", failMode: "timeout", acceptable: ["timeout", "circuit_open"] },
    { name: "401", failMode: "auth_invalid", acceptable: ["auth_invalid"] },
    { name: "429", failMode: "rate_limited", acceptable: ["rate_limited", "no_available_key", "queue_timeout"] },
    { name: "5xx", failMode: "server_error", acceptable: ["server_error", "circuit_open"] },
  ];

  for (const mode of modes) {
    it(`keeps >=99% success with a ${mode.name} source (${RUNS} runs)`, async () => {
      const broken = await addProvider({
        name: `fault-${mode.name}`,
        type: "mock",
        config: { resultCount: 3, latencyMs: 10, failMode: mode.failMode },
      });
      const healthy = await addProvider({
        name: `healthy-for-${mode.name}`,
        type: "mock",
        config: { resultCount: 5, latencyMs: 10, namespace: `ok-${mode.name}` },
      });

      const startedAt = Date.now();
      const responses = [];
      for (let offset = 0; offset < RUNS; offset += 10) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(10, RUNS - offset) }, (_, index) =>
            search([broken, healthy], `${mode.name} fault ${offset + index}`),
          ),
        );
        responses.push(...batch);
      }
      const duration = Date.now() - startedAt;

      const ok = responses.filter((response) => response.statusCode === 200 && response.json().results.length > 0);
      const successRate = ok.length / responses.length;
      expect(successRate, "success rate").toBeGreaterThanOrEqual(0.99);

      const observedCodes = new Set<string>();
      for (const response of responses) {
        const body = response.json();
        expect(body.stats.partial).toBe(true);
        expect(body.failedSources).toHaveLength(1);
        expect(body.failedSources[0].id).toBe(broken);
        expect(mode.acceptable).toContain(body.failedSources[0].code);
        observedCodes.add(body.failedSources[0].code);
        expect(body.results.some((item: { sources: Array<{ providerId: string }> }) =>
          item.sources.some((source) => source.providerId === healthy),
        )).toBe(true);
        // A circuit that has already opened reports zero attempts (skipped);
        // otherwise the source gets exactly one attempt (maxRetries=0).
        const stat = body.stats.providers.find((item: { providerId: string }) => item.providerId === broken);
        expect([0, 1]).toContain(stat.attempts);
      }

      // The true failure code must be visible at least once before the breaker
      // trips; after that circuit_open is the correct, explicit signal.
      expect(observedCodes.has(mode.acceptable[0]!)).toBe(true);

      // Timeout budget: 5s per request, plus fusion overhead.
      expect(duration / responses.length).toBeLessThan(6_000);
    });
  }

  it("isolates a malformed JSON response from a real HTTP provider", async () => {
    const broken = await addProvider({
      name: "fault-malformed",
      type: "generic-http",
      baseUrl: `http://127.0.0.1:${brokenPort}`,
      config: {
        method: "GET",
        path: "/search",
        resultsPath: "results",
        mapping: { title: "title", url: "url", snippet: "snippet" },
      },
    });
    const healthy = await addProvider({
      name: "healthy-for-malformed",
      type: "mock",
      config: { resultCount: 4, latencyMs: 8, namespace: "ok-malformed" },
    });

    for (let index = 0; index < 5; index += 1) {
      const response = await search([broken, healthy], `malformed ${index}`);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.failedSources).toHaveLength(1);
      expect(body.failedSources[0].id).toBe(broken);
      expect(body.failedSources[0].code).toBe("bad_request");
    }
  });

  it("returns 503 (not an empty 200) when every source is broken", async () => {
    const broken = await addProvider({
      name: "only-broken",
      type: "mock",
      config: { resultCount: 3, latencyMs: 5, failMode: "server_error" },
    });
    const response = await search([broken], "all sources down");
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("failed");
    expect(response.json().results).toHaveLength(0);
    expect(response.json().failedSources).toEqual([{ id: broken, code: "server_error" }]);
  });
});
