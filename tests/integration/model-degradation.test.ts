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
let modelServer: Server;
let modelPort = 0;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "models.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

let providerCounter = 0;
async function addProvider(): Promise<string> {
  providerCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: {
      name: `degrade-source-${providerCounter}`,
      type: "mock",
      enabled: true,
      maxConcurrency: 4,
      rpmLimit: 1000,
      config: { resultCount: 6, latencyMs: 5, namespace: "degrade" },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().provider.id;
}

async function addModel(kind: "chat" | "embedding" | "rerank", providerType: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/models",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: {
      kind,
      name: `${kind}-failing`,
      providerType,
      baseUrl: `http://127.0.0.1:${modelPort}`,
      modelId: `${kind}-test`,
      ...(kind === "embedding" ? { dimensions: 8 } : {}),
      batchSize: 8,
      timeoutMs: 2_000,
      maxConcurrency: 2,
      enabled: true,
      isDefault: true,
      params: {},
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().model?.id ?? response.json().id;
}

async function search(payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { query: "degradation", mode: "basic", limit: 5, ...payload },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-degrade-"));
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

  await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });

  // Every model endpoint returns 500 so the optional stages must fail open.
  modelServer = createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "model backend unavailable" } }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (typeof address === "object" && address) modelPort = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("AC-16 optional model degradation", () => {
  it("returns base results and marks degraded when rerank fails", async () => {
    const providerId = await addProvider();
    await addModel("rerank", "cohere");
    const response = await search({ providers: [providerId], mode: "rerank", rerank: true });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.stats.rerankApplied).toBe(false);
    expect(body.stats.degraded).toBe(true);
    expect(body.errors.some((item: { providerId: string }) => item.providerId === "rerank-model")).toBe(true);
  });

  it("returns base results and marks degraded when embedding fails", async () => {
    const providerId = await addProvider();
    await addModel("embedding", "openai-compatible");
    const response = await search({ providers: [providerId], mode: "embedding", embedding: true });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.stats.embeddingApplied).toBe(false);
    expect(body.stats.degraded).toBe(true);
  });

  it("returns base results and marks degraded when the summary model fails", async () => {
    const providerId = await addProvider();
    await addModel("chat", "openai-compatible");
    const response = await search({ providers: [providerId], mode: "rrf", summarize: true });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.stats.summaryApplied).toBe(false);
    expect(body.stats.degraded).toBe(true);
    expect(body.summary).toBeUndefined();
    expect(body.errors.some((item: { providerId: string }) => item.providerId === "summary-model")).toBe(true);
  });

  it("still serves plain search when no model is configured at all", async () => {
    const providerId = await addProvider();
    const response = await search({ providers: [providerId], mode: "basic" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.stats.degraded).toBeUndefined();
    expect(body.summary).toBeUndefined();
  });
});
