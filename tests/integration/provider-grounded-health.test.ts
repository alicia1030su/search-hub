import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { addKey, allowLocalhost, createProvider } from "../helpers/vendor-stubs.js";

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
  for (const server of servers.splice(0)) server.close();
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "grounded-health.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-grounded-health-"));
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
  return harness;
}

function admin(harness: Harness) {
  return {
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
  };
}

async function startGroundedStub(): Promise<{ baseUrl: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "Grounded answer" }] },
        groundingMetadata: {
          webSearchQueries: ["contract query"],
          groundingChunks: [{ web: { uri: "https://example.com/source", title: "Source" } }],
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, hits: () => hits };
}

async function addGroundedProvider(harness: Harness, baseUrl: string): Promise<string> {
  await allowLocalhost(harness.app, admin(harness));
  const providerId = await createProvider(harness.app, admin(harness), {
    name: "grounded-gemini",
    type: "gemini",
    baseUrl,
    enabled: true,
    timeoutMs: 5_000,
    maxConcurrency: 2,
    maxRetries: 0,
    rpmLimit: 600,
    config: { model: "gemini-test" },
  });
  await addKey(
    harness.app,
    admin(harness),
    providerId,
    "sk-GROUNDED-HEALTH-STUB-0000000000",
  );
  return providerId;
}

async function setPaidProbes(harness: Harness, enabled: boolean): Promise<void> {
  const response = await harness.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...admin(harness),
    payload: {
      health: {
        paidProbesEnabled: enabled,
        maxRequestsPerRun: 5,
        maxRequestsPerDay: 20,
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe("grounded provider health probes", () => {
  it("refuses a grounded connect probe before spending when paid probes are disabled", async () => {
    const harness = await createHarness();
    const stub = await startGroundedStub();
    const providerId = await addGroundedProvider(harness, stub.baseUrl);
    await setPaidProbes(harness, false);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...admin(harness),
      payload: { kind: "connect" },
    });

    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    expect(stub.hits()).toBe(0);
  });

  it("counts grounded citations as successful search-probe results", async () => {
    const harness = await createHarness();
    const stub = await startGroundedStub();
    const providerId = await addGroundedProvider(harness, stub.baseUrl);
    await setPaidProbes(harness, true);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...admin(harness),
      payload: { kind: "search" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(stub.hits()).toBe(1);
    expect(response.json()).toMatchObject({
      ok: true,
      cause: "ok",
      resultCount: 1,
      kind: "search",
    });
  });
});
