import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

function testConfig(dir: string): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-test-"));
  const ctx = createContext(testConfig(dir));
  const app = await buildApp(ctx);
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! },
  });
  expect(setup.statusCode).toBe(200);
  const cookie = setup.cookies.find((item) => item.name === "sh_session")?.value;
  expect(cookie).toBeTruthy();
  const csrf = setup.json().csrfToken as string;

  const harness: Harness = { app, ctx, dir, cookie: cookie!, csrf };
  harnesses.push(harness);
  return harness;
}

function adminHeaders(harness: Harness) {
  // fastify.inject requires the cookie inside `cookies` (top-level) and other
  // headers in `headers`; mixing them into `headers.cookies` is not parsed.
  return { cookies: { sh_session: harness.cookie }, headers: { "x-csrf-token": harness.csrf } };
}

async function createMockProvider(
  harness: Harness,
  name: string,
  config: Record<string, unknown> = { resultCount: 6, latencyMs: 10, namespace: name },
): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...adminHeaders(harness),
    payload: { name, type: "mock", enabled: true, config },
  });
  expect(response.statusCode).toBe(200);
  return response.json().provider.id as string;
}

describe("first-run setup and authentication", () => {
  it("creates the administrator exactly once", async () => {
    const harness = await createHarness();
    const status = await harness.app.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json().initialized).toBe(true);

    const again = await harness.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "other@example.com", password: "Another-long-password-1", name: "Other" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("already_initialized");
  });

  it("rejects a wrong password and accepts the right one", async () => {
    const harness = await createHarness();
    const wrong = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "wrong-password" },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await harness.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "A-very-long-password-1" },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().csrfToken).toBeTruthy();
  });

  it("refuses admin mutations without the CSRF header", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: harness.cookie },
      payload: { name: "no-csrf", type: "mock" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/CSRF/i);
  });

  it("rejects unauthenticated admin reads", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({ method: "GET", url: "/api/admin/providers" });
    expect(response.statusCode).toBe(401);
  });
});

describe("provider and key management", () => {
  it("refuses provider types that have no adapter", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      ...adminHeaders(harness),
      // `metaso` is still catalog-only (planned); `bocha` gained a real adapter in v0.1.2.
      payload: { name: "metaso", type: "metaso" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("not_implemented");
    expect(response.json().error.message).toMatch(/not implemented/i);
  });

  it("never returns the plaintext key and stores it encrypted", async () => {
    const harness = await createHarness();
    const providerId = await createMockProvider(harness, "masked-provider");
    const secret = "sk-TEST-MASK-FINGERPRINT-9c1f5e2a";

    const created = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...adminHeaders(harness),
      payload: { label: "primary", key: secret, weight: 100, enabled: true },
    });
    expect(created.statusCode).toBe(200);
    expect(JSON.stringify(created.json())).not.toContain(secret);

    const list = await harness.app.inject({
      method: "GET",
      url: `/api/admin/providers/${providerId}/keys`,
      cookies: { sh_session: harness.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(secret);
    expect(list.json()[0].maskedKey).toContain("…");

    const providerList = await harness.app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: harness.cookie },
    });
    expect(JSON.stringify(providerList.json())).not.toContain(secret);

    // The raw SQLite file must not contain the plaintext either.
    const dbBytes = readFileSync(join(harness.dir, "test.db"));
    expect(dbBytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
    expect(dbBytes.includes(Buffer.from(Buffer.from(secret).toString("base64"), "utf8"))).toBe(false);
  });

  it("keeps provider configuration after a process restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-restart-"));
    const ctx1 = createContext(testConfig(dir));
    const app1 = await buildApp(ctx1);
    await app1.ready();
    const setup = await app1.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx1.setupToken.value! },
    });
    const cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
    const csrf = setup.json().csrfToken as string;
    const created = await app1.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        name: "persisted",
        type: "mock",
        enabled: true,
        priority: 7,
        rpmLimit: 3,
        config: { resultCount: 2, latencyMs: 0, namespace: "persisted" },
      },
    });
    const providerId = created.json().provider.id as string;
    await app1.close();

    const ctx2 = createContext(testConfig(dir));
    const app2 = await buildApp(ctx2);
    await app2.ready();
    const login = await app2.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "A-very-long-password-1" },
    });
    expect(login.statusCode).toBe(200);
    const cookie2 = login.cookies.find((item) => item.name === "sh_session")!.value;

    const list = await app2.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie2 },
    });
    const provider = (list.json().providers as Array<Record<string, unknown>>).find(
      (item) => item.id === providerId,
    );
    expect(provider).toBeTruthy();
    expect(provider!.name).toBe("persisted");
    expect(provider!.priority).toBe(7);
    expect(provider!.rpmLimit).toBe(3);
    expect((provider!.config as Record<string, unknown>).namespace).toBe("persisted");

    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("search execution", () => {
  it("fuses two providers, de-duplicates the shared URL and reports timings", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "prov-a", { resultCount: 6, latencyMs: 30, namespace: "a" });
    await createMockProvider(harness, "prov-b", { resultCount: 5, latencyMs: 20, namespace: "b" });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { query: "typescript monorepo", mode: "rrf", limit: 10 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("completed");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.stats.providers).toHaveLength(2);
    expect(body.stats.rawCount).toBeGreaterThan(body.stats.dedupedCount);

    const shared = body.results.find((item: { url: string }) => item.url.includes("/shared/"));
    expect(shared).toBeTruthy();
    expect(shared.sources.length).toBe(2);
    expect(body.stats.timing.totalMs).toBeGreaterThan(0);
  });

  it("isolates a failing provider and keeps the healthy provider's results", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "healthy", { resultCount: 5, latencyMs: 10, namespace: "ok" });
    await createMockProvider(harness, "broken", { resultCount: 5, latencyMs: 5, failMode: "server_error" });

    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { query: "isolation", mode: "rrf", limit: 10 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("partial");
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].providerName).toBe("broken");
    expect(body.errors[0].code).toBe("server_error");
    expect(body.stats.providers.find((item: { providerName: string }) => item.providerName === "broken").ok).toBe(false);
  });

  it("returns an explicit error when no provider matches", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { query: "nothing", mode: "basic" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/No enabled search provider/i);
  });

  it("persists a task retrievable by id", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "task-provider");
    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { query: "task lookup", mode: "rrf", limit: 5 },
    });
    const taskId = search.json().taskId as string;
    const task = await harness.app.inject({
      method: "GET",
      url: `/api/search/tasks/${taskId}`,
      cookies: { sh_session: harness.cookie },
    });
    expect(task.statusCode).toBe(200);
    expect(task.json().status).toBe("completed");
    expect(task.json().response.results.length).toBeGreaterThan(0);
  });

  it("enforces API token scopes", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "scope-provider");
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "read-only", scopes: ["sources:read"], rateLimitPerMin: 60 },
    });
    const token = created.json().token as string;

    const providers = await harness.app.inject({
      method: "GET",
      url: "/api/providers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(providers.statusCode).toBe(200);

    const search = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { query: "scope", mode: "basic" },
    });
    expect(search.statusCode).toBe(403);
    expect(search.json().error.message).toMatch(/scope/i);
  });

  it("rejects a revoked token", async () => {
    const harness = await createHarness();
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...adminHeaders(harness),
      payload: { name: "revoked", scopes: ["sources:read"], rateLimitPerMin: 60 },
    });
    const id = created.json().record.id as string;
    const token = created.json().token as string;
    await harness.app.inject({
      method: "DELETE",
      url: `/api/admin/tokens/${id}`,
      ...adminHeaders(harness),
    });
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/providers",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("admin surface", () => {
  it("returns dashboard aggregates backed by real search events", async () => {
    const harness = await createHarness();
    await createMockProvider(harness, "dash-provider");
    await harness.app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { query: "dashboard", mode: "rrf", limit: 5 },
    });
    const dashboard = await harness.app.inject({
      method: "GET",
      url: "/api/admin/dashboard?range=24h",
      cookies: { sh_session: harness.cookie },
    });
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json();
    expect(body.totals.searches).toBe(1);
    expect(body.providers[0].calls).toBe(1);
    expect(body.timeline.length).toBeGreaterThan(0);
  });

  it("exports configuration without secret material", async () => {
    const harness = await createHarness();
    const providerId = await createMockProvider(harness, "export-provider");
    await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...adminHeaders(harness),
      payload: { label: "k1", key: "sk-EXPORT-FINGERPRINT", weight: 1, enabled: true },
    });
    const exported = await harness.app.inject({
      method: "GET",
      url: "/api/admin/config/export",
      cookies: { sh_session: harness.cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(JSON.stringify(exported.json())).not.toContain("sk-EXPORT-FINGERPRINT");
    expect(exported.json().providers[0].keyLabels).toEqual(["k1"]);
  });

  it("serves a valid OpenAPI document covering the core endpoints", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({ method: "GET", url: "/api/openapi.json" });
    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(spec.openapi).toBe("3.1.0");
    for (const path of ["/api/search", "/api/providers", "/api/admin/providers", "/mcp"]) {
      expect(spec.paths).toHaveProperty(path);
    }
  });

  it("requires a setup token when one is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-token-"));
    const ctx = createContext({ ...testConfig(dir), setupToken: "setup-secret" });
    const app = await buildApp(ctx);
    await app.ready();
    const denied = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "a@example.com", password: "A-very-long-password-1", name: "A" },
    });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        email: "a@example.com",
        password: "A-very-long-password-1",
        name: "A",
        setupToken: "setup-secret",
      },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a malformed settings payload instead of silently ignoring it", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...adminHeaders(harness),
      payload: { defaults: { limit: 5000 } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("persists a non-default setting after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-settings-"));
    const ctx1 = createContext(testConfig(dir));
    const app1 = await buildApp(ctx1);
    await app1.ready();
    const setup = await app1.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx1.setupToken.value! },
    });
    const cookies = { sh_session: setup.cookies.find((item) => item.name === "sh_session")!.value };
    const headers = { "x-csrf-token": setup.json().csrfToken as string };
    const put = await app1.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies,
      headers,
      payload: { instance: { name: "My Hub" }, defaults: { limit: 33 } },
    });
    expect(put.statusCode).toBe(200);
    await app1.close();

    const ctx2 = createContext(testConfig(dir));
    const app2 = await buildApp(ctx2);
    await app2.ready();
    const login = await app2.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@example.com", password: "A-very-long-password-1" },
    });
    const settings = await app2.inject({
      method: "GET",
      url: "/api/admin/settings",
      cookies: { sh_session: login.cookies.find((item) => item.name === "sh_session")!.value },
    });
    expect(settings.json().instance.name).toBe("My Hub");
    expect(settings.json().defaults.limit).toBe(33);
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("database safety", () => {
  it("does not store the admin password in plaintext", async () => {
    const harness = await createHarness();
    const bytes = readFileSync(join(harness.dir, "test.db"));
    expect(bytes.includes(Buffer.from("A-very-long-password-1", "utf8"))).toBe(false);
    writeFileSync(join(harness.dir, "note.txt"), "test artefact");
  });
});
