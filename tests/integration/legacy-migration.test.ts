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

const legacySecret = "sk-LEGACY-SHOULD-NEVER-BE-STORED-9876";

const legacyPayload = {
  providers: [
    { name: "brave-main", type: "brave", enabled: true },
    {
      name: "search-gateway",
      type: "search-gateway",
      baseUrl: "https://gateway.example.com/api",
      // A real legacy export may contain keys; the importer must ignore them.
      apiKey: legacySecret,
      key: legacySecret,
    },
    {
      name: "custom-news",
      type: "unknown-vendor",
      url: "https://news.example.com",
      mapping: { title: "headline", url: "link", snippet: "summary" },
    },
    { name: "no-endpoint-unknown", type: "something-else" },
  ],
};

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "legacy.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-legacy-"));
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
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function migrate(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/admin/migration/legacy",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: body,
  });
}

describe("legacy Search Hub migration", () => {
  it("plans without writing anything and never echoes credentials", async () => {
    const response = await migrate({ payload: legacyPayload });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(legacySecret);
    const plan = response.json();
    expect(plan.mode).toBe("dry_run");
    expect(plan.total).toBe(4);
    expect(plan.importable).toBe(3);
    expect(plan.skipped).toBe(1);
    expect(plan.items.map((item: { name: string }) => item.name)).toContain("brave-main");
    expect(plan.keysRequired).toContain("search-gateway");

    const before = ctx.db._.fullSchema.providerInstances
      ? (ctx.sqlite.prepare("SELECT COUNT(*) AS count FROM provider_instances").get() as { count: number })
      : { count: 0 };
    expect(Number(before.count)).toBe(0);
  });

  it("refuses to apply without an explicit confirmation", async () => {
    const response = await migrate({ mode: "apply", payload: legacyPayload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("IMPORT LEGACY PROVIDERS");
  });

  it("creates importable providers and stores no keys", async () => {
    const response = await migrate({
      mode: "apply",
      payload: legacyPayload,
      confirm: "IMPORT LEGACY PROVIDERS",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.applied.created).toHaveLength(3);
    expect(body.keysRequired).toContain("search-gateway");

    const providers = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    const list = providers.json().providers as Array<{ name: string; type: string; baseUrl: string | null }>;
    const names = list.map((item) => item.name);
    expect(names).toContain("brave-main");
    expect(names).toContain("search-gateway");
    expect(names).toContain("custom-news");
    expect(names).not.toContain("no-endpoint-unknown");

    // The secret appears in no response and no database column.
    expect(providers.body).not.toContain(legacySecret);
    const keys = ctx.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get() as { count: number };
    expect(Number(keys.count)).toBe(0);
    const raw = ctx.sqlite
      .prepare("SELECT name || ':' || COALESCE(base_url,'') || ':' || config_json AS blob FROM provider_instances")
      .all() as Array<{ blob: string }>;
    expect(raw.map((row) => row.blob).join("|")).not.toContain(legacySecret);
  });

  it("does not overwrite an existing provider on a second run", async () => {
    const response = await migrate({
      mode: "apply",
      payload: legacyPayload,
      confirm: "IMPORT LEGACY PROVIDERS",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.applied.created).toHaveLength(0);
    expect(body.applied.skipped.length).toBeGreaterThan(0);
    // Existing names are skipped, not renamed or overwritten.
    const names = body.items.map((item: { name: string }) => item.name);
    expect(names).toContain("brave-main");
    expect(body.items.every((item: { decision: string }) => item.decision === "skipped")).toBe(true);
  });
});
