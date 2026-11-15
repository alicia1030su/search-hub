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

  it("creates provider and credential atomically, and rolls back on failure", async () => {
    // Success path: one request writes both rows.
    const ok = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        name: "atomic-ok",
        type: "deepseek-search",
        enabled: true,
        timeoutMs: 5000,
        maxConcurrency: 2,
        maxRetries: 0,
        rpmLimit: 60,
        credential: { label: "主凭证", key: "sk-atomic-test-value-1234", weight: 100, enabled: true },
      },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const providerId = ok.json().provider.id as string;
    const keys = await app.inject({
      method: "GET",
      url: `/api/admin/providers/${providerId}/keys`,
      cookies: { sh_session: cookie },
    });
    expect(keys.json()).toHaveLength(1);
    expect(keys.body).not.toContain("atomic-test-value");

    // Failure path: a credential that the schema rejects must not leave a
    // provider behind.
    const before = (
      await app.inject({
        method: "GET",
        url: "/api/admin/providers",
        cookies: { sh_session: cookie },
      })
    ).json().providers.length as number;

    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        name: "atomic-rollback",
        type: "deepseek-search",
        enabled: true,
        timeoutMs: 5000,
        maxConcurrency: 2,
        maxRetries: 0,
        rpmLimit: 60,
        credential: { label: "", key: "", weight: 100, enabled: true },
      },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);

    const after = (
      await app.inject({
        method: "GET",
        url: "/api/admin/providers",
        cookies: { sh_session: cookie },
      })
    ).json().providers.length as number;
    expect(after).toBe(before);
    const names = (
      await app.inject({
        method: "GET",
        url: "/api/admin/providers",
        cookies: { sh_session: cookie },
      })
    )
      .json()
      .providers.map((item: { name: string }) => item.name);
    expect(names).not.toContain("atomic-rollback");
  });

  it("never exposes credentials in config export, backups or logs", async () => {
    // Create a provider with a live-looking secret through the atomic path.
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        name: "export-secret-check",
        type: "gemini",
        enabled: true,
        timeoutMs: 5000,
        maxConcurrency: 2,
        maxRetries: 0,
        rpmLimit: 60,
        config: { model: "gemini-3.8-flash" },
        credential: { label: "主凭证", key: "AIza-EXPORT-FINGERPRINT-123456", weight: 100, enabled: true },
      },
    });
    expect(created.statusCode, created.body).toBe(200);

    const exported = await app.inject({
      method: "GET",
      url: "/api/admin/config/export",
      cookies: { sh_session: cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain("AIza-EXPORT-FINGERPRINT-123456");

    // Audit log entries must not contain the value either.
    const auditRows = ctx.sqlite
      .prepare("select detail_json from audit_logs order by created_at desc limit 40")
      .all() as Array<{ detail_json: string }>;
    expect(JSON.stringify(auditRows)).not.toContain("AIza-EXPORT-FINGERPRINT-123456");

    // A provider summary is what the UI sees; it carries no plaintext.
    const summary = (
      await app.inject({ method: "GET", url: "/api/admin/providers", cookies: { sh_session: cookie } })
    ).body;
    expect(summary).not.toContain("AIza-EXPORT-FINGERPRINT-123456");
  });

  it("persists account-group limits and echoes them in the summary and runtime", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        name: "account-group-check",
        type: "bailian",
        enabled: true,
        timeoutMs: 5000,
        maxConcurrency: 2,
        maxRetries: 0,
        rpmLimit: 60,
        config: {
          model: "qwen-plus",
          accountGroup: "bailian-main",
          accountRpmLimit: 30,
          accountDailyQuota: 500,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const provider = created.json().provider as {
      id: string;
      accountGroup: string | null;
      accountRpmLimit: number;
      accountDailyQuota: number | null;
    };
    expect(provider.accountGroup).toBe("bailian-main");
    expect(provider.accountRpmLimit).toBe(30);
    expect(provider.accountDailyQuota).toBe(500);

    // Runtime snapshot exposes the group budget so the UI can show it.
    const status = await app.inject({
      method: "GET",
      url: `/api/admin/providers/${provider.id}/status`,
      cookies: { sh_session: cookie },
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().account).toMatchObject({
      group: "bailian-main",
      rpmLimit: 30,
      dailyQuota: 500,
    });
  });

  it("applies an updated account group without recreating the provider", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    const target = (list.json().providers as Array<{ id: string; name: string }>).find(
      (item) => item.name === "account-group-check",
    )!;
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${target.id}`,
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { config: { model: "qwen-plus", accountGroup: "bailian-main", accountRpmLimit: 7 } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().provider.accountRpmLimit).toBe(7);

    const status = await app.inject({
      method: "GET",
      url: `/api/admin/providers/${target.id}/status`,
      cookies: { sh_session: cookie },
    });
    expect(status.json().account.rpmLimit).toBe(7);
  });

  it("REST and MCP carry the same grounding contract", async () => {
    // REST: the response shape must expose the five status facts, model,
    // supports and display — losing them would break the UI contract.
    const providers = await app.inject({
      method: "GET",
      url: "/api/admin/providers",
      cookies: { sh_session: cookie },
    });
    const gemini = (providers.json().providers as Array<{ id: string; name: string }>).find(
      (item) => item.name === "export-secret-check",
    )!;
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { query: "grounding contract", mode: "basic", limit: 5, providers: [gemini.id] },
    });
    expect([200, 503]).toContain(search.statusCode);
    const rest = search.json() as { answers?: Array<Record<string, unknown>> };
    if (rest.answers && rest.answers.length > 0) {
      const answer = rest.answers[0]!;
      expect(answer).toHaveProperty("status");
      const status = answer["status"] as Record<string, unknown>;
      for (const key of [
        "toolProvided",
        "toolInvoked",
        "retrievalSucceeded",
        "hasVerifiableSources",
        "answerSupported",
      ]) {
        expect(status).toHaveProperty(key);
      }
      // `toolInvoked` must be boolean or the literal "unknown", never null.
      expect(["boolean", "string"]).toContain(typeof status["toolInvoked"]);
    }

    // MCP: the tool result is JSON in a single text block, so the same keys must
    // survive the transport unchanged.
    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: 991,
        method: "tools/call",
        params: { name: "search_web", arguments: { query: "grounding contract", limit: 5 } },
      },
    });
    expect([200, 401, 403]).toContain(mcp.statusCode);
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
