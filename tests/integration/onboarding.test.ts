import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, runMigrations, settings as settingsTable } from "@search-hub/db";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { DEFAULT_SETTINGS } from "../../apps/api/src/services/settings.js";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
}

const harnesses: Harness[] = [];

function testConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "onboarding.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

function seedLegacySettings(config: AppConfig): void {
  const handle = createDb({ file: config.dbPath });
  try {
    runMigrations(handle.sqlite, config.migrationsDir);
    const legacy = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    delete legacy["onboarding"];
    handle.db.insert(settingsTable).values({
      key: "app",
      valueJson: JSON.stringify(legacy),
      updatedAt: new Date().toISOString(),
    }).run();
  } finally {
    handle.close();
  }
}

async function createHarness(options: { legacySettings?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-onboarding-"));
  const config = testConfig(dir);
  if (options.legacySettings) seedLegacySettings(config);
  const ctx = createContext(config);
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
  const cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  const csrf = setup.json().csrfToken as string;
  const harness = { app, ctx, dir, cookie, csrf };
  harnesses.push(harness);
  return harness;
}

function auth(harness: Harness) {
  return {
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
  };
}

async function addMockProvider(harness: Harness): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...auth(harness),
    payload: {
      name: "onboarding-mock",
      type: "mock",
      enabled: true,
      config: { resultCount: 1, latencyMs: 1, namespace: "onboarding" },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
});

describe("admin onboarding", () => {
  it("starts at the provider step with four keyless live-tested recommendations", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/onboarding/status",
      ...auth(harness),
    });
    expect(response.statusCode, response.body).toBe(200);
    const status = response.json();
    expect(status).toMatchObject({
      completed: false,
      dismissed: false,
      step: 2,
      steps: {
        admin: { complete: true },
        provider: { complete: false, readyProviderIds: [] },
        search: { complete: false },
      },
    });
    expect(status.recommendedProviders.map((provider: { type: string }) => provider.type)).toEqual([
      "hackernews",
      "crossref",
      "openalex",
      "pubmed",
    ]);
    for (const provider of status.recommendedProviders) {
      expect(provider).toMatchObject({ authType: "none", verification: "live_tested", capability: "raw_search" });
    }
  });

  it("marks the provider step complete when an enabled mock is ready without recommending mock", async () => {
    const harness = await createHarness();
    const providerId = await addMockProvider(harness);
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/onboarding/status",
      ...auth(harness),
    });
    expect(response.statusCode, response.body).toBe(200);
    const status = response.json();
    expect(status.step).toBe(3);
    expect(status.steps.provider).toEqual({ complete: true, readyProviderIds: [providerId] });
    expect(status.recommendedProviders.map((provider: { type: string }) => provider.type)).not.toContain("mock");
  });

  it("persists completion and returns a completed status on refresh", async () => {
    const harness = await createHarness();
    const completed = await harness.app.inject({
      method: "POST",
      url: "/api/admin/onboarding/complete",
      ...auth(harness),
      payload: {},
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({ completed: true, dismissed: false, step: 3, steps: { search: { complete: true } } });

    const refreshed = await harness.app.inject({
      method: "GET",
      url: "/api/admin/onboarding/status",
      ...auth(harness),
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json()).toMatchObject({ completed: true, dismissed: false, step: 3, steps: { search: { complete: true } } });
    const settings = await harness.app.inject({ method: "GET", url: "/api/admin/settings", ...auth(harness) });
    expect(settings.json().onboarding.completedAt).toEqual(expect.any(String));
    expect(settings.json().onboarding.dismissedAt).toBeNull();
    expect(settings.json().onboarding.lastSeenVersion).toBe(harness.ctx.config.version);
  });

  it("persists dismissal without marking completion", async () => {
    const harness = await createHarness();
    const dismissed = await harness.app.inject({
      method: "POST",
      url: "/api/admin/onboarding/dismiss",
      ...auth(harness),
      payload: {},
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(dismissed.json()).toMatchObject({ completed: false, dismissed: true, step: 3, steps: { search: { complete: false } } });

    const refreshed = await harness.app.inject({
      method: "GET",
      url: "/api/admin/onboarding/status",
      ...auth(harness),
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json()).toMatchObject({ completed: false, dismissed: true, step: 3 });
    const settings = await harness.app.inject({ method: "GET", url: "/api/admin/settings", ...auth(harness) });
    expect(settings.json().onboarding.completedAt).toBeNull();
    expect(settings.json().onboarding.dismissedAt).toEqual(expect.any(String));
    expect(settings.json().onboarding.lastSeenVersion).toBe(harness.ctx.config.version);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const harness = await createHarness();
    const unauthenticated = await harness.app.inject({
      method: "GET",
      url: "/api/admin/onboarding/status",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const token = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...auth(harness),
      payload: { name: "search-only", scopes: ["search"], rateLimitPerMin: 60 },
    });
    expect(token.statusCode, token.body).toBe(200);
    const forbidden = await harness.app.inject({
      method: "GET",
      url: "/api/admin/onboarding/status",
      headers: { authorization: `Bearer ${token.json().token as string}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("loads legacy settings JSON without onboarding", async () => {
    const harness = await createHarness({ legacySettings: true });
    expect(harness.ctx.settings.get().onboarding).toEqual({
      completedAt: null,
      dismissedAt: null,
      lastSeenVersion: null,
    });
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/onboarding/status",
      ...auth(harness),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ completed: false, dismissed: false, step: 2 });
  });
});
