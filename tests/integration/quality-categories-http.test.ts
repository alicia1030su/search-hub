/**
 * Multi-label categories, over HTTP.
 *
 * A query may carry a primary label and up to two secondary ones, and a report
 * counts it once under *each* label. That is only meaningful if it survives the
 * whole path — storage, the read model, and the per-category aggregation on a
 * finished run — so these assertions go through the real routes and the real
 * SQLite file rather than calling the grouping helper directly.
 *
 * The rejection cases are here for the same reason: "duplicate label" and "too
 * many labels" must be a 400 that names the offending query, not a 500 that
 * hides which row was wrong.
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
    dbPath: join(dir, "quality-categories-http.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-categories-http-"));
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

async function createDataset(harness: Harness, name: string): Promise<string> {
  const created = await harness.app.inject({
    method: "POST",
    url: "/api/admin/quality/datasets",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { name },
  });
  expect(created.statusCode, created.body).toBe(200);
  return created.json().dataset.id as string;
}

async function addQueries(
  harness: Harness,
  datasetId: string,
  queries: unknown[],
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: "POST",
    url: `/api/admin/quality/datasets/${datasetId}/queries`,
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { queries },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function freeze(harness: Harness, datasetId: string): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: `/api/admin/quality/datasets/${datasetId}/freeze`,
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { judgmentsComplete: false },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function addMockProvider(harness: Harness): Promise<string> {
  const created = await harness.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: {
      name: "mock-category-src",
      type: "mock",
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0,
      config: { resultCount: 6 },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  return created.json().provider.id as string;
}

async function waitForRun(harness: Harness, runId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await harness.app.inject({
      method: "GET",
      url: `/api/admin/quality/runs/${runId}`,
      cookies: { sh_session: harness.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { run: { status: string } };
    if (body.run.status !== "running") return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not finish");
}

describe("a query that carries two labels", () => {
  it("is counted once under each label in a finished run's byCategory", async () => {
    const h = await createHarness();
    const datasetId = await createDataset(h, "Multi-label HTTP");

    const added = await addQueries(h, datasetId, [
      { query: "typescript satisfies operator narrowing", category: "code", extraCategories: ["english"] },
    ]);
    expect(added.statusCode, JSON.stringify(added.body)).toBe(200);

    // The read model must expose both labels, primary first. A run report that
    // only knew the primary label would silently drop the second group.
    const detail = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/datasets/${datasetId}`,
      cookies: { sh_session: h.cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const queries = (detail.json() as { queries: Array<{ id: string; category: string; categories: string[] }> })
      .queries;
    expect(queries).toHaveLength(1);
    expect(queries[0]!.category).toBe("code");
    expect(queries[0]!.categories).toEqual(["code", "english"]);
    const queryId = queries[0]!.id;

    await freeze(h, datasetId);
    const providerId = await addMockProvider(h);

    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        datasetId,
        mode: "live",
        fusion: { strategy: "rrf", k: 60 },
        providerIds: [providerId],
        requestBudget: 20,
        confirmPaid: true,
        queryIds: [queryId],
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const run = await waitForRun(h, started.json().run.id as string);
    expect((run.run as { status: string }).status).toBe("completed");

    const byCategory = run.byCategory as {
      groups: Array<{ category: string; queryCount: number; comparable: number }>;
      overlappingGroups: boolean;
      primaryOnly: boolean;
    };
    const code = byCategory.groups.find((group) => group.category === "code");
    const english = byCategory.groups.find((group) => group.category === "english");
    // Appears in both groups, exactly once in each.
    expect(code, JSON.stringify(byCategory)).toBeTruthy();
    expect(english, JSON.stringify(byCategory)).toBeTruthy();
    expect(code!.queryCount).toBe(1);
    expect(english!.queryCount).toBe(1);
    // And the report says the totals overlap, so nobody adds the columns up and
    // calls the sum a query count.
    expect(byCategory.overlappingGroups).toBe(true);
    expect(byCategory.primaryOnly).toBe(false);
    const summed = byCategory.groups.reduce((total, group) => total + group.queryCount, 0);
    expect(summed).toBeGreaterThan(1);
  });
});

describe("rejecting a label set the engine cannot honour", () => {
  it("refuses a secondary label that repeats the primary one", async () => {
    const h = await createHarness();
    const datasetId = await createDataset(h, "Duplicate label");

    const response = await addQueries(h, datasetId, [
      { query: "duplicate label query", category: "code", extraCategories: ["code"] },
    ]);
    expect(response.statusCode, JSON.stringify(response.body)).toBe(400);
    const error = response.body.error as { code: string; details: { queries?: number } };
    expect(error.code).toBe("validation_error");
    // The caller must learn *which* query was wrong: an import with 200 rows is
    // unfixable from a message that does not name the row.
    expect(error.details.queries).toBe(0);

    // Nothing was written: a rejected row must not leave a half-applied dataset.
    const detail = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/datasets/${datasetId}`,
      cookies: { sh_session: h.cookie },
    });
    expect((detail.json() as { queries: unknown[] }).queries).toHaveLength(0);
  });

  it("refuses four labels with a 400 rather than a 500", async () => {
    const h = await createHarness();
    const datasetId = await createDataset(h, "Too many labels");

    const response = await addQueries(h, datasetId, [
      {
        query: "four label query",
        category: "code",
        extraCategories: ["english", "chinese", "news"],
      },
    ]);
    // The schema bounds `extraCategories` at two, so this is rejected before the
    // service's own guard runs. What matters is that it is a 4xx: a client error
    // must never look like a server fault.
    expect(response.statusCode, JSON.stringify(response.body)).toBe(400);
    expect((response.body.error as { code: string }).code).toBe("validation_error");
  });
});
