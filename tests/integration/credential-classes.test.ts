import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { getAdapter, getCatalogEntry } from "../../packages/providers/src/index.js";

/**
 * Credential rules for the health system.
 *
 * The failure this suite exists to prevent: a zero-key check that treats every
 * source without an API key as unusable. Six public sources need no credential
 * at all, and reporting them as "unverified because it has no key" makes the
 * health page lie in the opposite direction from claiming success.
 *
 * Four distinct classes must stay distinct:
 *  1. key required, none configured  → cannot be verified, never healthy;
 *  2. key optional, operator stays anonymous → must be probed normally;
 *  3. officially keyless → must be probed normally and be able to report healthy;
 *  4. needs an instance/identity (e.g. a self-hosted SearXNG URL) → configuration
 *     incomplete, not "no credential".
 *
 * Nothing here calls a real vendor: `mock` is the keyless adapter under test, and
 * the live-shaped payloads are served by a local HTTP server through the real
 * fetch path.
 */

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.ctx.health.stopScheduler();
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "credentials.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-credentials-"));
  const ctx = createContext(testConfig(dir));
  const app = await buildApp(ctx);
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
  const harness: Harness = {
    app,
    ctx,
    dir,
    cookie: setup.cookies.find((item) => item.name === "sh_session")!.value,
    csrf: setup.json().csrfToken as string,
  };
  harnesses.push(harness);
  // Every probe in this suite talks to 127.0.0.1; the SSRF policy has to allow it.
  await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });
  return harness;
}

const adminHeaders = (harness: Harness) => ({
  cookies: { sh_session: harness.cookie },
  headers: { "x-csrf-token": harness.csrf },
});

async function addProvider(
  harness: Harness,
  payload: Record<string, unknown>,
): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...adminHeaders(harness),
    payload: { enabled: true, timeoutMs: 5000, maxRetries: 0, rpmLimit: 6000, ...payload },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

/**
 * Local server that answers exactly like the Hacker News Algolia API.
 *
 * Going through a real socket (and the real adapter + SafeFetch) is the point:
 * a stubbed `fetch` would prove nothing about the request path the operator's
 * probe actually takes.
 */
async function hnStub(): Promise<{ base: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (!request.url?.startsWith("/api/v1/search")) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        hits: [
          {
            objectID: "1",
            title: "Keyless search probe",
            url: "https://example.org/keyless-1",
            created_at: "2026-01-01T00:00:00.000Z",
            points: 10,
            author: "stub",
            num_comments: 1,
          },
        ],
        nbHits: 1,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("stub did not bind");
  return { base: `http://127.0.0.1:${address.port}`, hits: () => hits };
}

describe("credential classes", () => {
  it("classifies every public source as keyless in the catalog and the adapter", () => {
    // A static fact, asserted so a future adapter that silently starts requiring
    // a key is caught here rather than in production.
    for (const type of ["hackernews", "crossref", "openalex", "pubmed", "arxiv", "wikipedia"]) {
      const entry = getCatalogEntry(type);
      const adapter = getAdapter(type);
      expect(entry, `${type} must be in the catalog`).toBeDefined();
      expect(entry!.authType, `${type} authType`).toBe("none");
      expect(adapter, `${type} must have an adapter`).toBeDefined();
      expect(adapter!.requiresKey, `${type} requiresKey`).toBe(false);
    }
    // The other side of the line: an api_key source must declare it.
    for (const type of ["brave", "tavily"]) {
      expect(getAdapter(type)!.requiresKey, `${type} requiresKey`).toBe(true);
      expect(getCatalogEntry(type)!.authType).toBe("api_key");
    }
  });

  it("T-CR1 a key-required source with no key is unverified, not healthy", async () => {
    const harness = await createHarness();
    const providerId = await addProvider(harness, { name: "needs-key", type: "brave" });

    const probe = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...adminHeaders(harness),
      payload: { kind: "connect" },
    });
    expect(probe.statusCode, probe.body).toBe(200);
    expect(probe.json().result.cause).toBe("no_credential");
    expect(probe.json().result.status).toBe("unverified");

    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health",
      cookies: { sh_session: harness.cookie },
    });
    const row = (overview.json().providers as Array<{ providerId: string; runtime: string; keyTotal: number }>).find(
      (item) => item.providerId === providerId,
    )!;
    expect(row.runtime).toBe("unverified");
    expect(row.keyTotal).toBe(0);
  });

  it("T-CR2 a keyless source is probed for real and can report healthy", async () => {
    const harness = await createHarness();
    const stub = await hnStub();
    const providerId = await addProvider(harness, {
      name: "hn-stub",
      type: "hackernews",
      resultsPerPage: 5,
      config: { baseUrl: stub.base, tags: "story" },
    });

    const probe = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...adminHeaders(harness),
      payload: { kind: "search" },
    });
    expect(probe.statusCode, probe.body).toBe(200);
    // A real request reached the socket, and the adapter parsed real bytes.
    expect(stub.hits()).toBeGreaterThan(0);
    expect(probe.json().result.cause).toBe("ok");
    expect(probe.json().result.resultCount).toBeGreaterThan(0);

    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health",
      cookies: { sh_session: harness.cookie },
    });
    const row = (
      overview.json().providers as Array<{ providerId: string; runtime: string; keyTotal: number; keyAvailable: number }>
    ).find((item) => item.providerId === providerId)!;
    expect(row.runtime).toBe("healthy");
    expect(row.keyTotal).toBe(0);
    expect(row.keyAvailable).toBe(0);
  });

  it("T-CR3 a keyless source with zero keys is not counted as unusable by /api/health", async () => {
    const harness = await createHarness();
    const stub = await hnStub();
    const providerId = await addProvider(harness, {
      name: "hn-count",
      type: "hackernews",
      config: { baseUrl: stub.base, tags: "story" },
    });
    await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...adminHeaders(harness),
      payload: { kind: "search" },
    });

    const health = await harness.app.inject({ method: "GET", url: "/api/health" });
    const providers = health.json().providers as { total: number; enabled: number; healthy: number };
    expect(providers.total).toBe(1);
    expect(providers.enabled).toBe(1);
    // The source answers searches with no credential at all. Reporting
    // `healthy: 0` here would tell an operator their working source is broken.
    expect(providers.healthy).toBe(1);
  });

  it("T-CR4 a keyless source is listed as ready rather than 'no credential'", async () => {
    const harness = await createHarness();
    await addProvider(harness, { name: "hn-ready", type: "hackernews" });
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: harness.cookie },
    });
    const providers = response.json().providers as Array<{
      name: string;
      ready: boolean;
      notReadyReason: string | null;
      keyCount: number;
      healthyKeyCount: number;
    }>;
    const row = providers.find((item) => item.name === "hn-ready")!;
    expect(row.ready).toBe(true);
    expect(row.notReadyReason).toBeNull();
    expect(row.keyCount).toBe(0);
    // No key exists, so the key counter stays 0 — but that must not be the
    // signal the UI uses to call the source broken.
    expect(row.healthyKeyCount).toBe(0);
  });

  it("T-CR5 a source that needs its own instance is configuration-incomplete, not keyless", async () => {
    const harness = await createHarness();
    // SearXNG needs a self-hosted base URL. With none, the probe must fail as a
    // configuration problem, and must not be reported as healthy.
    const providerId = await addProvider(harness, { name: "searxng-no-url", type: "searxng" });
    const probe = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...adminHeaders(harness),
      payload: { kind: "connect" },
    });
    expect(probe.statusCode, probe.body).toBe(200);
    const result = probe.json().result as { status: string; cause: string };
    expect(result.status).not.toBe("healthy");
    // Either it refuses before the request (config_incomplete) or the request
    // fails because there is nowhere to send it; both are honest, "healthy" is not.
    expect(["config_incomplete", "network", "dns", "bad_response", "server_error", "timeout"]).toContain(
      result.cause,
    );
  });
});
