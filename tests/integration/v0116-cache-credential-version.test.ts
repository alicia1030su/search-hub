import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { apiKeys, searchCache } from "../../packages/db/src/schema.js";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  cookie: string;
  csrf: string;
  providerId: string;
  keyId: string;
  stubHits: () => number;
}

const harnesses: Harness[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.app.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function createHarness(): Promise<Harness> {
  let hits = 0;
  const stub = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      web: {
        results: Array.from({ length: 5 }, (_, index) => ({
          title: `Row ${index}`,
          url: `https://example.org/${index}`,
          description: "stub",
        })),
      },
    }));
  });
  servers.push(stub);
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "v0116-cache-credential-"));
  const config: AppConfig = {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "cache.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
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
  const auth = { cookies: { sh_session: cookie }, headers: { "x-csrf-token": csrf } };
  await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...auth,
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] }, cache: { enabled: true, ttlSeconds: 3600 } },
  });
  const provider = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...auth,
    payload: {
      name: "brave-cache",
      type: "brave",
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 5_000,
      maxConcurrency: 2,
      maxRetries: 0,
      rpmLimit: 6000,
      searchConfig: { targetResults: 5, maxPages: 1 },
      config: {},
    },
  });
  const providerId = provider.json().provider.id as string;
  const key = await app.inject({
    method: "POST",
    url: `/api/admin/providers/${providerId}/keys`,
    ...auth,
    payload: { label: "repro", key: "stub-token-value-1234", weight: 100, enabled: true },
  });
  const harness = { app, ctx, dir, cookie, csrf, providerId, keyId: key.json().id as string, stubHits: () => hits };
  harnesses.push(harness);
  return harness;
}

function search(harness: Harness) {
  return harness.app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { query: "same keyed query", mode: "basic", limit: 5, skipCache: false },
  });
}

describe("BUG-0116-04 cache credential identity", () => {
  it("keeps an identical keyed search cacheable after runtime stats flush", async () => {
    const harness = await createHarness();
    const before = harness.ctx.providers.credentialVersion(harness.providerId);
    const first = await search(harness);
    expect(first.json().stats.cached).not.toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    const afterFlush = harness.ctx.providers.credentialVersion(harness.providerId);
    const second = await search(harness);

    expect(afterFlush).toBe(before);
    expect(second.json().stats.cached).toBe(true);
    expect(harness.stubHits()).toBe(1);
  });

  it("invalidates on real key rotation without placing key material in the cache key", async () => {
    const harness = await createHarness();
    const first = await search(harness);
    const before = harness.ctx.providers.credentialVersion(harness.providerId);
    const rotated = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/keys/${harness.keyId}`,
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { key: "rotated-token-value-5678" },
    });
    expect(rotated.statusCode).toBe(200);
    const after = harness.ctx.providers.credentialVersion(harness.providerId);
    const second = await search(harness);

    expect(after).not.toBe(before);
    expect(second.json().stats.cached).not.toBe(true);
    expect(harness.stubHits()).toBe(2);
    const exported = await harness.app.inject({
      method: "GET",
      url: "/api/admin/export",
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
    });
    expect(exported.statusCode).toBe(200);
    for (const canary of ["stub-token-value-1234", "rotated-token-value-5678"]) {
      expect(JSON.stringify(first.json())).not.toContain(canary);
      expect(JSON.stringify(second.json())).not.toContain(canary);
      expect(exported.body).not.toContain(canary);
    }
    for (const row of harness.ctx.db.select().from(searchCache).all()) {
      expect(row.cacheKey).not.toContain("stub-token-value-1234");
      expect(row.cacheKey).not.toContain("rotated-token-value-5678");
    }
  });

  it("keeps identity and cache hit when only the key label changes", async () => {
    const harness = await createHarness();
    await search(harness);
    const before = harness.ctx.providers.credentialVersion(harness.providerId);
    const relabeled = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/keys/${harness.keyId}`,
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { label: "renamed-only" },
    });
    expect(relabeled.statusCode).toBe(200);
    const after = harness.ctx.providers.credentialVersion(harness.providerId);
    const second = await search(harness);

    expect(after).toBe(before);
    expect(second.json().stats.cached).toBe(true);
    expect(harness.stubHits()).toBe(1);
  });

  it("changes identity and bypasses cache when key weight changes", async () => {
    const harness = await createHarness();
    await search(harness);
    const before = harness.ctx.providers.credentialVersion(harness.providerId);
    const reweighted = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/keys/${harness.keyId}`,
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { weight: 250 },
    });
    expect(reweighted.statusCode).toBe(200);
    const after = harness.ctx.providers.credentialVersion(harness.providerId);
    const second = await search(harness);

    expect(after).not.toBe(before);
    expect(second.json().stats.cached).not.toBe(true);
    expect(harness.stubHits()).toBe(2);
  });

  it("changes identity when the same plaintext is re-encrypted with a fresh IV", async () => {
    const harness = await createHarness();
    await search(harness);
    const before = harness.ctx.providers.credentialVersion(harness.providerId);
    const beforeRow = harness.ctx.db.select().from(apiKeys).all().find((row) => row.id === harness.keyId)!;
    const reencrypted = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/keys/${harness.keyId}`,
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
      payload: { key: "stub-token-value-1234" },
    });
    expect(reencrypted.statusCode).toBe(200);
    const afterRow = harness.ctx.db.select().from(apiKeys).all().find((row) => row.id === harness.keyId)!;
    const after = harness.ctx.providers.credentialVersion(harness.providerId);
    const second = await search(harness);

    expect(afterRow.keyIv).not.toBe(beforeRow.keyIv);
    expect(afterRow.keyCiphertext).not.toBe(beforeRow.keyCiphertext);
    expect(after).not.toBe(before);
    expect(second.json().stats.cached).not.toBe(true);
    expect(harness.stubHits()).toBe(2);
  });

  it("changes identity and bypasses cache on disable, re-enable, add, and remove", async () => {
    const harness = await createHarness();
    await search(harness);
    const auth = {
      cookies: { sh_session: harness.cookie },
      headers: { "x-csrf-token": harness.csrf },
    };
    const versions = [harness.ctx.providers.credentialVersion(harness.providerId)];

    const disabled = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/keys/${harness.keyId}`,
      ...auth,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    versions.push(harness.ctx.providers.credentialVersion(harness.providerId));
    expect((await search(harness)).json().stats.cached).not.toBe(true);

    const enabled = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/keys/${harness.keyId}`,
      ...auth,
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    versions.push(harness.ctx.providers.credentialVersion(harness.providerId));
    expect((await search(harness)).json().stats.cached).not.toBe(true);

    const added = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${harness.providerId}/keys`,
      ...auth,
      payload: { label: "second", key: "added-token-value-9012", weight: 100, enabled: true },
    });
    expect(added.statusCode).toBe(200);
    const addedKeyId = added.json().id as string;
    versions.push(harness.ctx.providers.credentialVersion(harness.providerId));
    expect((await search(harness)).json().stats.cached).not.toBe(true);

    const removed = await harness.app.inject({
      method: "DELETE",
      url: `/api/admin/keys/${addedKeyId}`,
      ...auth,
    });
    expect(removed.statusCode).toBe(200);
    versions.push(harness.ctx.providers.credentialVersion(harness.providerId));
    expect((await search(harness)).json().stats.cached).not.toBe(true);

    expect(new Set(versions).size).toBe(versions.length);
    expect(harness.stubHits()).toBe(4);
  });
});
