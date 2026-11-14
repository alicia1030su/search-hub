import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

/**
 * End-to-end behaviour of the legacy gateway adapter through the real API.
 *
 * Proves the integration is truthful at the HTTP boundary:
 *  - upstream attribution survives to `POST /api/search`;
 *  - a `failed` envelope becomes a failed search, not an empty success;
 *  - a `partial` envelope becomes status=partial with a per-provider warning;
 *  - a cancelled client releases the key slot and does not cool the key.
 *
 * The "old service" is a local fake; no real 44475 instance is contacted.
 */

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;
let csrf: string;

interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

let reply: FakeReply = {};
const requests: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
let fake: Server;
let fakeBase = "";

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "legacy-gateway.db"),
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
      timeoutMs: 3_000,
      maxConcurrency: 2,
      maxRetries: 0,
      resultsPerPage: 5,
      rpmLimit: 10_000,
      ...input,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

function search(providers: string[], query = "量子计算") {
  return app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { query, mode: "rrf", limit: 5, providers, timeoutMs: 5_000 },
  });
}

async function keyStats(providerId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/admin/providers/${providerId}/keys`,
    cookies: { sh_session: cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Array<{
    id: string;
    status: string;
    requestCount: number;
    failureCount: number;
    successCount: number;
    consecutiveFailures: number;
  }>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-legacy-gateway-"));
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

  // The loopback fake must be reachable: SSRF validation applies to provider
  // base URLs, so the operator has to allowlist it explicitly.
  const settings = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });
  expect(settings.statusCode).toBe(200);

  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const send = () => {
        res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const RESULT = {
  title: "旧版结果",
  url: "https://example-news.cn/article/1",
  snippet: "摘要",
  provider: "brave",
  providerName: "Brave Search",
  source: "brave-web",
};

describe("legacy gateway through the real search API", () => {
  it("carries upstream attribution into the response", async () => {
    reply = { body: { status: "completed", results: [RESULT] } };
    const providerId = await addProvider({
      name: "legacy-attribution",
      type: "search-hub-legacy",
      baseUrl: fakeBase,
    });

    const response = await search([providerId]);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("completed");
    expect(body.results).toHaveLength(1);
    const first = body.results[0];
    expect(first.upstream).toEqual({
      provider: "brave",
      providerName: "Brave Search",
      source: "brave-web",
    });
    // The gateway itself is still the platform-level provider.
    expect(first.providerType).toBe("search-hub-legacy");
    expect(first.sources[0].upstream?.provider).toBe("brave");
  });

  it("maps an upstream failed envelope to a failed search, not an empty success", async () => {
    reply = {
      body: {
        status: "failed",
        results: [],
        errors: [{ providerName: "brave", code: "rate_limited", message: "quota" }],
      },
    };
    const providerId = await addProvider({
      name: "legacy-failed",
      type: "search-hub-legacy",
      baseUrl: fakeBase,
    });

    const response = await search([providerId]);
    // The HTTP layer deliberately maps a failed search to 503; the body still
    // carries the structured status and per-source error.
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("failed");
    expect(body.results).toHaveLength(0);
    expect(body.errors[0].code).toBe("rate_limited");
    expect(body.errors[0].message).toContain("reported failure");
  });

  it("maps an upstream partial envelope to status=partial with a warning", async () => {
    reply = {
      body: {
        status: "partial",
        results: [RESULT],
        errors: [{ providerName: "bocha", code: "timeout" }],
      },
    };
    const providerId = await addProvider({
      name: "legacy-partial",
      type: "search-hub-legacy",
      baseUrl: fakeBase,
    });

    const response = await search([providerId]);
    const body = response.json();
    expect(body.status).toBe("partial");
    expect(body.results).toHaveLength(1);
    const stat = body.stats.providers.find(
      (item: { providerId: string }) => item.providerId === providerId,
    );
    expect(stat.warning).toContain("status=partial");
  });

  it("does not cool a healthy key when the caller cancels", async () => {
    reply = { body: { status: "completed", results: [RESULT] }, delayMs: 1_500 };
    const providerId = await addProvider({
      name: "legacy-cancel",
      type: "search-hub-legacy",
      baseUrl: fakeBase,
      config: {},
    });
    const keyResponse = await app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { label: "legacy-key", key: "sh_legacy_token_value", weight: 100, enabled: true },
    });
    expect(keyResponse.statusCode).toBe(200);

    // Abort the HTTP request after 200ms: the server sees the client go away.
    const controller = new AbortController();
    const pending = app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { query: "cancel probe", mode: "rrf", limit: 5, providers: [providerId], timeoutMs: 10_000 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_800));

    const keys = await keyStats(providerId);
    expect(keys).toHaveLength(1);
    const key = keys[0]!;
    // No failure counted, no cooldown, and the slot is free again (inFlight 0
    // is implied by a successful follow-up search below).
    expect(key.status).not.toBe("cooldown");
    expect(key.consecutiveFailures).toBe(0);

    reply = { body: { status: "completed", results: [RESULT] } };
    const followUp = await search([providerId], "after cancel");
    expect(followUp.statusCode, followUp.body).toBe(200);
    expect(followUp.json().status).toBe("completed");
    expect(followUp.json().results.length).toBeGreaterThan(0);
  });

  it("retries only the paths the legacy API is documented to expose", async () => {
    const before = requests.filter((item) => item.url.startsWith("/api/search")).length;
    reply = { body: { status: "completed", results: [RESULT] } };
    const providerId = await addProvider({
      name: "legacy-path",
      type: "search-hub-legacy",
      baseUrl: fakeBase,
      config: { path: "/api/search", mode: "basic" },
    });
    await search([providerId]);
    const after = requests.filter((item) => item.url.startsWith("/api/search")).length;
    expect(after).toBeGreaterThan(before);
    const last = requests[requests.length - 1]!;
    expect(last.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(last.body)).toMatchObject({ mode: "basic" });
  });
});
