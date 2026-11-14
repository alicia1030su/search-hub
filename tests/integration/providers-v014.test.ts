import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

/**
 * The v0.1.4 acceptance target: a provider in the catalog must be creatable
 * through the API, accept a credential afterwards, and stay usable after a
 * save → test → failure sequence. This exercises the real routes, not the
 * adapter in isolation.
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
    dbPath: join(dataDir, "v014.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-v014-"));
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
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const NATIVE_TYPES = ["tencent-yuanbao", "doubao", "deepseek-search", "qianfan-search", "anysearch"];

describe("v0.1.4 provider catalog is actually creatable", () => {
  it("every native v0.1.4 type is listed as implemented and not planned", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      adapters: string[];
      catalog: Array<{ type: string; implementation: string; verification: string; fields?: unknown[] }>;
    };
    for (const type of NATIVE_TYPES) {
      const entry = body.catalog.find((item) => item.type === type);
      expect(entry, `missing catalog entry ${type}`).toBeDefined();
      expect(entry!.implementation).toBe("builtin");
      expect(body.adapters).toContain(type);
    }
  });

  it("creates one instance per native type through the real API", async () => {
    for (const type of NATIVE_TYPES) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/providers",
        cookies: { sh_session: cookie },
        headers: { "x-csrf-token": csrf },
        payload: {
          name: `accept-${type}`,
          type,
          enabled: true,
          timeoutMs: 5000,
          maxConcurrency: 2,
          maxRetries: 0,
          resultsPerPage: 10,
          rpmLimit: 60,
          config: type === "qianfan-search" ? { edition: "pro" } : {},
        },
      });
      expect(response.statusCode, `${type}: ${response.body}`).toBe(200);
      expect(response.json().provider.type).toBe(type);
    }
  });

  it("accepts a credential after creation and keeps it masked", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    const providers = list.json().providers as Array<{ id: string; name: string }>;
    const target = providers.find((item) => item.name === "accept-deepseek-search")!;

    const keyResponse = await app.inject({
      method: "POST",
      url: `/api/admin/providers/${target.id}/keys`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { label: "test", key: "sk-VERY-SECRET-TEST-VALUE-1234", weight: 100, enabled: true },
    });
    expect(keyResponse.statusCode).toBe(200);
    const key = keyResponse.json();
    expect(key.maskedKey).toContain("…");
    expect(JSON.stringify(key)).not.toContain("VERY-SECRET-TEST-VALUE");

    const keys = await app.inject({
      method: "GET",
      url: `/api/admin/providers/${target.id}/keys`,
      cookies: { sh_session: cookie },
    });
    expect(keys.statusCode).toBe(200);
    expect(keys.body).not.toContain("VERY-SECRET-TEST-VALUE");
  });

  it("stores a Tencent pair as one credential and rejects a single half", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    const target = (list.json().providers as Array<{ id: string; name: string }>).find(
      (item) => item.name === "accept-tencent-yuanbao",
    )!;

    const pair = await app.inject({
      method: "POST",
      url: `/api/admin/providers/${target.id}/keys`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        label: "pair",
        key: JSON.stringify({ secretId: "AKIDtest", secretKey: "secretValue123" }),
        weight: 100,
        enabled: true,
      },
    });
    expect(pair.statusCode).toBe(200);
    // One key row, not two: rotation must stay atomic.
    const keys = await app.inject({
      method: "GET",
      url: `/api/admin/providers/${target.id}/keys`,
      cookies: { sh_session: cookie },
    });
    expect(keys.json()).toHaveLength(1);
    expect(keys.body).not.toContain("secretValue123");
  });

  it("a failed test does not store the credential plaintext in the response", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    const target = (list.json().providers as Array<{ id: string; name: string }>).find(
      (item) => item.name === "accept-doubao",
    )!;
    await app.inject({
      method: "POST",
      url: `/api/admin/providers/${target.id}/keys`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { label: "bad", key: "tvly-plaintext-should-not-leak-1234", weight: 100, enabled: true },
    });

    const test = await app.inject({
      method: "POST",
      url: `/api/admin/providers/${target.id}/test`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {},
    });
    // The call goes to the real vendor and fails (no such key); what matters is
    // that the failure message never contains the credential.
    expect(test.statusCode).toBe(200);
    expect(test.body).not.toContain("plaintext-should-not-leak");
  });

  it("an unverified catalog entry cannot be created", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { name: "metaso-probe", type: "metaso", enabled: true },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
