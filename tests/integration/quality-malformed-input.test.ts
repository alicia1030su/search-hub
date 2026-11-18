/**
 * Malformed input on the evaluation endpoints must be a 400, never a 500.
 *
 * These are the shapes a caller actually produces by accident: a page size typed
 * as text, a query list serialised as a string instead of an array. Both used to
 * reach a code path that assumes the well-formed version and throws a TypeError,
 * which the global error handler reports as "internal server error" — telling
 * the operator the server is broken when their request was.
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
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath: join(dir, "quality-malformed.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-malformed-"));
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
  expect(setup.statusCode).toBe(200);
  const cookie = setup.cookies.find((item) => item.name === "sh_session")?.value;
  const csrf = setup.json().csrfToken as string;
  const harness: Harness = { app, ctx, dir, cookie: cookie!, csrf };
  harnesses.push(harness);
  return harness;
}

describe("an unparseable page size", () => {
  it("falls back to the documented page rather than reporting an empty total", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets?limit=abc&offset=xyz",
      cookies: { sh_session: h.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { datasets: unknown[]; total: number; limit: number; offset: number };
    // The seeded fixtures are real rows: a request for page "abc" must not turn
    // them into an empty list, and must not echo a NaN page size back.
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.datasets.length).toBeGreaterThan(0);
    expect(Number.isFinite(body.limit)).toBe(true);
    expect(body.offset).toBe(0);
  });

  it("still caps a page size that is merely too large", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets?limit=9999",
      cookies: { sh_session: h.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    // Capping is a valid answer for a number; only a non-number is defaulted.
    expect((response.json() as { limit: number }).limit).toBe(200);
  });
});

describe("a query list that is not a list", () => {
  it("is a 400, not an internal error", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets/import",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "bad", queries: "not-an-array" },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("rejects a judgment list that is not a list without crashing", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets/import",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "bad", queries: [{ query: "ok", judgments: "nope" }] },
    });
    expect(response.statusCode, response.body).toBe(400);
  });

  it("still accepts a well-formed import", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets/import",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        name: "good",
        queries: [{ query: "typescript satisfies", category: "code", extraCategories: ["english"] }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { queries: number }).queries).toBe(1);
  });
});
