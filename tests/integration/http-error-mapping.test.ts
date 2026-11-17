/**
 * Malformed requests must be reported as the caller's mistake.
 *
 * Fastify rejects a few request shapes before any handler runs: an empty body
 * with `content-type: application/json`, invalid JSON, an unsupported media
 * type, a body over the limit. Those carry a 4xx `statusCode`.
 *
 * The global error handler used to collapse everything that was not a
 * `SearchHubError`, a `ZodError` or a 429 into `500 internal_error`. That is
 * wrong in two directions: a caller who sent a broken request is told the
 * server broke, and the operator gets an error-level log for traffic that is
 * not an incident. Found while acceptance-testing the v0.1.7-beta.2 Windows
 * package, where `curl -X POST -H 'content-type: application/json'` with no
 * body returned 500.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "search-hub-http-errors-"));
  const ctx = createContext(testConfig(dir));
  const app = await buildApp(ctx);
  await app.ready();
  const harness: Harness = { app, ctx, dir };
  harnesses.push(harness);
  return harness;
}

describe("malformed request mapping", () => {
  it("an empty JSON body is 400 bad_request, not 500", async () => {
    const { app } = await createHarness();
    const response = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("invalid JSON is 400 with a stable code", async () => {
    const { app } = await createHarness();
    const response = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "content-type": "application/json" },
      // A trailing comma is a syntax error in JSON, not a validation failure.
      payload: '{"email":"a@b.c",}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("an unsupported media type is 415, not a server fault", async () => {
    const { app } = await createHarness();
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/provider-health/settings",
      headers: { "content-type": "text/csv" },
      payload: "a,b\n1,2",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("a body over the limit is 413, not 500", async () => {
    const { app } = await createHarness();
    const response = await app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { "content-type": "application/json" },
      // The app sets bodyLimit to 2 MiB.
      payload: JSON.stringify({ email: "a@b.c", password: "x".repeat(3 * 1024 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("a domain error keeps its own status and code", async () => {
    const { app } = await createHarness();
    const response = await app.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
  });
});
