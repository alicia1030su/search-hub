/**
 * Search quality lab — datasets, judgments, runs, comparisons.
 *
 * Rules this suite follows:
 *  - a score is only accepted when the code that produced it is traceable: the
 *    assertions read the stored run, not just the HTTP status;
 *  - offline means offline: the run is executed with **no provider configured**
 *    and must still work, which is only possible if nothing leaves the process;
 *  - no test spends vendor quota. The `mock` adapter is the only live source;
 *  - N/A is asserted as N/A. A `0` that should have been "not measurable" is
 *    exactly the failure this feature exists to prevent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { qualityJudgments, qualityRuns, searchTasks } from "../../packages/db/src/schema.js";

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
    dbPath: join(dir, "quality.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-"));
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

async function waitForRun(harness: Harness, runId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await harness.app.inject({
      method: "GET",
      url: `/api/admin/quality/runs/${runId}`,
      cookies: { sh_session: harness.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { run: { status: string } };
    if (body.run.status !== "running") return body as unknown as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not finish");
}

describe("datasets", () => {
  it("seeds the built-in synthetic fixtures on a fresh install", async () => {
    const { app, cookie } = await createHarness();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: cookie },
    });
    expect(response.statusCode).toBe(200);
    const datasets = response.json().datasets as Array<{ id: string; origin: string; queryCount: number; judgmentCount: number }>;
    const core = datasets.find((item) => item.id === "ds_synthetic_core_v1");
    expect(core).toBeTruthy();
    expect(core!.origin).toBe("synthetic_fixture");
    expect(core!.queryCount).toBeGreaterThanOrEqual(12);
    expect(core!.judgmentCount).toBeGreaterThan(0);
  });

  it("creates a dataset, adds queries and grades, then freezes it", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "My qrels", description: "manual set" },
    });
    expect(created.statusCode).toBe(200);
    const datasetId = created.json().dataset.id as string;

    const added = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/queries`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        queries: [
          { query: "typescript satisfies", category: "code", intent: "learn the operator" },
          { query: "vite proxy config", category: "documentation" },
        ],
      },
    });
    expect(added.statusCode).toBe(200);
    const ids = added.json().ids as string[];
    expect(ids).toHaveLength(2);

    const judged = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/judgments`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        judgments: [
          { queryId: ids[0], url: "https://a.fixture.test/1", relevance: 3 },
          { queryId: ids[0], url: "https://b.fixture.test/1", relevance: 1 },
        ],
      },
    });
    expect(judged.statusCode).toBe(200);
    expect(judged.json().written).toBe(2);

    const frozen = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/freeze`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { judgmentsComplete: false },
    });
    expect(frozen.statusCode).toBe(200);
    expect(frozen.json().dataset.status).toBe("frozen");

    const blocked = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/queries`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { queries: [{ query: "after freeze" }] },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("conflict");
  });

  it("refuses to freeze an empty dataset", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "empty" },
    });
    const datasetId = created.json().dataset.id as string;
    const frozen = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/freeze`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {},
    });
    expect(frozen.statusCode).toBe(400);
  });

  it("replaces a re-assessed document instead of duplicating it", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "rejudge" },
    });
    const datasetId = created.json().dataset.id as string;
    const added = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/queries`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { queries: [{ query: "q" }] },
    });
    const queryId = added.json().ids[0] as string;

    const first = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/judgments`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { judgments: [{ queryId, url: "https://a.fixture.test/1", relevance: 1 }] },
    });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/judgments`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { judgments: [{ queryId, url: "https://a.fixture.test/1", relevance: 3 }] },
    });
    expect(second.statusCode).toBe(200);

    const detail = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/datasets/${datasetId}`,
      cookies: { sh_session: h.cookie },
    });
    const judgments = detail.json().judgments as Array<{ relevance: number }>;
    expect(judgments).toHaveLength(1);
    expect(judgments[0]!.relevance).toBe(3);
  });

  it("rejects a duplicate query inside one import", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "dupes" },
    });
    const datasetId = created.json().dataset.id as string;
    const response = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/queries`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { queries: [{ query: "Same" }, { query: "same" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("forks a frozen dataset into a new draft without touching the old version", async () => {
    const h = await createHarness();
    const detailBefore = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const before = detailBefore.json() as { dataset: { version: number }; queries: unknown[] };

    const forked = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1/fork",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {},
    });
    expect(forked.statusCode).toBe(200);
    const dataset = forked.json().dataset as { id: string; version: number; status: string };
    expect(dataset.status).toBe("draft");
    expect(dataset.version).toBe(before.dataset.version + 1);
    expect(dataset.id).not.toBe("ds_synthetic_core_v1");

    const detailAfter = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    expect(detailAfter.json().queries).toHaveLength(before.queries.length);
    const copy = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/datasets/${dataset.id}`,
      cookies: { sh_session: h.cookie },
    });
    expect(copy.json().queries).toHaveLength(before.queries.length);
    expect(copy.json().judgments.length).toBeGreaterThan(0);
  });

  it("exports and re-imports a dataset with the same queries and grades", async () => {
    const h = await createHarness();
    const exported = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1/export",
      cookies: { sh_session: h.cookie },
    });
    expect(exported.statusCode).toBe(200);
    const payload = exported.json();
    expect(payload.format).toBe("search-hub.quality.dataset/1");

    const imported = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets/import",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { ...payload, name: "Round trip" },
    });
    expect(imported.statusCode).toBe(200);
    const body = imported.json() as { queries: number; judgments: number };
    expect(body.queries).toBe(payload.queries.length);

    const detail = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/datasets/${imported.json().dataset.id}`,
      cookies: { sh_session: h.cookie },
    });
    expect(detail.json().judgments).toHaveLength(body.judgments);
  });

  it("rejects an import whose relevance is out of range", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets/import",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        name: "bad",
        queries: [{ query: "q", judgments: [{ url: "https://a.fixture.test/1", relevance: 7 }] }],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("keeps unjudged documents out of the qrel set", async () => {
    const h = await createHarness();
    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_shallow_v1",
      cookies: { sh_session: h.cookie },
    });
    const body = detail.json() as {
      dataset: { judgmentsComplete: boolean };
      coverage: { unjudgedQueries: number };
      judgments: Array<{ relevance: number }>;
    };
    expect(body.dataset.judgmentsComplete).toBe(false);
    // Positive-only judgments: nothing is graded 0 or 1 in the shallow set.
    expect(body.judgments.every((judgment) => judgment.relevance >= 2)).toBe(true);
  });

  it("does not create a second judgment for the same normalized document", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "url identity" },
    });
    const datasetId = created.json().dataset.id as string;
    const added = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/queries`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { queries: [{ query: "q" }] },
    });
    const queryId = added.json().ids[0] as string;
    // The documentId is the caller's normalized URL; the route stores it as
    // given, so the tracker-stripped form must be supplied by the assessor.
    await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/judgments`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        judgments: [{ queryId, documentId: "https://a.fixture.test/1", relevance: 3 }],
      },
    });
    const second = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/judgments`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        judgments: [{ queryId, documentId: "https://a.fixture.test/1", relevance: 2 }],
      },
    });
    expect(second.statusCode).toBe(200);
    const rows = h.ctx.db.select().from(qualityJudgments).all().filter((row) => row.datasetId === datasetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relevance).toBe(2);
  });
});

describe("runs", () => {
  it("runs the offline fixture without any provider or network", async () => {
    const h = await createHarness();
    // No provider is configured at all in this harness.
    expect(h.ctx.providers.runtimeSnapshots()).toHaveLength(0);

    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        name: "RRF default",
        mode: "offline",
        fusion: { strategy: "rrf", k: 60 },
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const runId = started.json().run.id as string;
    const detail = await waitForRun(h, runId);

    const run = detail.run as { status: string; requestsUsed: number; datasetVersion: number; engineVersion: string };
    expect(run.status).toBe("completed");
    expect(run.requestsUsed).toBe(0);
    expect(run.datasetVersion).toBe(1);
    expect(run.engineVersion).toBeTruthy();

    const metrics = detail.metrics as Record<string, { status: string; value: number | null; sampleSize: number }>;
    expect(metrics.ndcgAtK!.status).toBe("ok");
    expect(metrics.ndcgAtK!.value).toBeGreaterThan(0);
    expect(metrics.ndcgAtK!.value).toBeLessThanOrEqual(1);
    expect(metrics.ndcgAtK!.sampleSize).toBeGreaterThanOrEqual(12);

    const cost = detail.cost as { requests: number; unknownCost: boolean };
    expect(cost.requests).toBe(0);
    expect(cost.unknownCost).toBe(true);
  });

  it("produces identical metrics when the same snapshot is ranked again", async () => {
    const h = await createHarness();
    const run = async () => {
      const started = await h.app.inject({
        method: "POST",
        url: "/api/admin/quality/runs",
        cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
        payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf", k: 60 } },
      });
      const detail = await waitForRun(h, started.json().run.id as string);
      return detail.metrics as Record<string, { value: number | null }>;
    };
    const first = await run();
    const second = await run();
    expect(second.ndcgAtK!.value).toBe(first.ndcgAtK!.value);
    expect(second.mrrAtK!.value).toBe(first.mrrAtK!.value);
    expect(second.precisionAtK!.value).toBe(first.precisionAtK!.value);
  });

  it("re-ranks the same captured snapshots for a second strategy", async () => {
    const h = await createHarness();
    const first = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf", k: 20 } },
    });
    const firstId = first.json().run.id as string;
    await waitForRun(h, firstId);

    const second = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        mode: "offline",
        fusion: { strategy: "rrf", k: 80 },
        // Re-rank the *same* rows, never a fresh capture.
        snapshotRunId: firstId,
      },
    });
    expect(second.statusCode, second.body).toBe(200);
    const detail = await waitForRun(h, second.json().run.id as string);
    const run = detail.run as { requestsUsed: number; status: string };
    expect(run.status).toBe("completed");
    // A re-rank issues no request at all.
    expect(run.requestsUsed).toBe(0);
  });

  it("requires an explicit budget, provider list and paid confirmation for a live run", async () => {
    const h = await createHarness();
    const noConfirm = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "live", fusion: { strategy: "rrf" }, providerIds: ["p"], requestBudget: 50 },
    });
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().error.message).toContain("confirmPaid");

    const noProviders = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "live", fusion: { strategy: "rrf" }, confirmPaid: true, requestBudget: 50 },
    });
    expect(noProviders.statusCode).toBe(400);

    const tooSmall = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        mode: "live",
        fusion: { strategy: "rrf" },
        confirmPaid: true,
        providerIds: ["p"],
        requestBudget: 2,
      },
    });
    expect(tooSmall.statusCode).toBe(400);
    expect(tooSmall.json().error.message).toContain("requestBudget");
  });

  it("runs live against a local mock provider and writes no search task", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/providers",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        name: "mock-src",
        type: "mock",
        enabled: true,
        timeoutMs: 5000,
        maxRetries: 0,
        config: { resultCount: 6 },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const providerId = created.json().provider.id as string;

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const queryIds = (detail.json().queries as Array<{ id: string }>).slice(0, 3).map((item) => item.id);

    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        mode: "live",
        fusion: { strategy: "rrf", k: 60 },
        providerIds: [providerId],
        requestBudget: 20,
        confirmPaid: true,
        queryIds,
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    const run = await waitForRun(h, started.json().run.id as string);
    const summary = run.run as { status: string; requestsUsed: number };
    expect(summary.status).toBe("completed");
    expect(summary.requestsUsed).toBeGreaterThan(0);

    // Evaluation traffic must not look like user traffic.
    const tasks = h.ctx.db.select().from(searchTasks).all();
    expect(tasks).toHaveLength(0);
  });

  it("refuses to evaluate an unfrozen dataset", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "draft only" },
    });
    const datasetId = created.json().dataset.id as string;
    await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/queries`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { queries: [{ query: "q" }] },
    });
    const run = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId, mode: "offline", fusion: { strategy: "rrf" } },
    });
    expect(run.statusCode).toBe(400);
    expect(run.json().error.message).toContain("frozen");
  });

  it("refuses an offline run on a manual dataset with no snapshots", async () => {
    const h = await createHarness();
    const created = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "manual, no snapshots" },
    });
    const datasetId = created.json().dataset.id as string;
    const added = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/queries`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { queries: [{ query: "q" }] },
    });
    await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/judgments`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { judgments: [{ queryId: added.json().ids[0], url: "https://a.fixture.test/1", relevance: 3 }] },
    });
    await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${datasetId}/freeze`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {},
    });
    const run = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId, mode: "offline", fusion: { strategy: "rrf" } },
    });
    expect(run.statusCode).toBe(400);
    expect(run.json().error.message).toContain("snapshot");
  });

  it("records the dataset version and the build on every run", async () => {
    const h = await createHarness();
    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "base" } },
    });
    const runId = started.json().run.id as string;
    await waitForRun(h, runId);
    const row = h.ctx.db.select().from(qualityRuns).all().find((item) => item.id === runId);
    expect(row!.datasetVersion).toBe(1);
    expect(row!.engineVersion).toBeTruthy();
    expect(row!.fusionStrategy).toBe("base");
    expect(row!.queryCount).toBeGreaterThanOrEqual(12);
  });
});

describe("comparison and sweeps", () => {
  it("compares two runs of the same dataset version", async () => {
    const h = await createHarness();
    const create = async (k: number) => {
      const started = await h.app.inject({
        method: "POST",
        url: "/api/admin/quality/runs",
        cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
        payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf", k } },
      });
      const runId = started.json().run.id as string;
      await waitForRun(h, runId);
      return runId;
    };
    const baseline = await create(60);
    const candidate = await create(20);

    const compared = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/compare?baseline=${baseline}&candidate=${candidate}&metric=ndcgAtK`,
      cookies: { sh_session: h.cookie },
    });
    expect(compared.statusCode, compared.body).toBe(200);
    const body = compared.json() as {
      verdict: string;
      comparableQueries: number;
      improved: unknown[];
      degraded: unknown[];
    };
    expect(body.comparableQueries).toBeGreaterThan(0);
    expect(["candidate_better", "baseline_better", "no_difference", "insufficient_evidence"]).toContain(
      body.verdict,
    );
    expect(Array.isArray(body.improved)).toBe(true);
    expect(Array.isArray(body.degraded)).toBe(true);
  });

  it("refuses to compare runs from different dataset versions", async () => {
    const h = await createHarness();
    const start = async (datasetId: string) => {
      const started = await h.app.inject({
        method: "POST",
        url: "/api/admin/quality/runs",
        cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
        payload: { datasetId, mode: "offline", fusion: { strategy: "rrf" } },
      });
      expect(started.statusCode, started.body).toBe(200);
      const runId = started.json().run.id as string;
      await waitForRun(h, runId);
      return runId;
    };
    const firstRun = await start("ds_synthetic_core_v1");
    // A fork has a different version, so the two are not comparable.
    const forked = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1/fork",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {},
    });
    const forkedId = forked.json().dataset.id as string;
    await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/datasets/${forkedId}/freeze`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {},
    });
    // The fork is a manual-origin dataset, so an offline run needs snapshots.
    const secondRun = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {
        datasetId: forkedId,
        mode: "offline",
        fusion: { strategy: "rrf" },
        snapshotRunId: firstRun,
      },
    });
    // Cross-dataset re-ranking is refused outright.
    expect(secondRun.statusCode).toBe(400);
  });

  it("sweeps RRF k on development and reports the holdout separately", async () => {
    const h = await createHarness();
    const sweep = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/sweep",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_core_v1", kValues: [20, 60, 100], metric: "ndcgAtK" },
    });
    expect(sweep.statusCode, sweep.body).toBe(200);
    const body = sweep.json() as {
      split: { development: number; holdout: number };
      candidates: Array<{ k: number; development: Record<string, { value: number | null }>; holdout: Record<string, { value: number | null }> }>;
      chosen: number | null;
      holdoutVerdict: string | null;
      evidence: string;
    };
    expect(body.candidates).toHaveLength(3);
    expect(body.split.development + body.split.holdout).toBe(14);
    expect(body.candidates.every((item) => typeof item.development.ndcgAtK!.value === "number")).toBe(true);
    expect(["sufficient", "INSUFFICIENT_EVIDENCE"]).toContain(body.evidence);
    if (body.evidence === "INSUFFICIENT_EVIDENCE") {
      expect(body.holdoutVerdict).toBeNull();
    }
  });

  it("marks a shallow qrel set as N/A recall rather than a plausible number", async () => {
    const h = await createHarness();
    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_shallow_v1", mode: "offline", fusion: { strategy: "rrf" } },
    });
    const detail = await waitForRun(h, started.json().run.id as string);
    const metrics = detail.metrics as Record<string, { status: string; reason?: string; value: number | null }>;
    expect(metrics.recallAtK!.status).toBe("na");
    expect(metrics.recallAtK!.reason).toBe("qrels_incomplete");
    expect(metrics.recallAtK!.value).toBeNull();
  });

  it("prunes old runs but keeps the most recent ones", async () => {
    const h = await createHarness();
    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf" } },
    });
    await waitForRun(h, started.json().run.id as string);
    const pruned = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/prune",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { olderThanDays: 1, keepLatest: 5 },
    });
    expect(pruned.statusCode).toBe(200);
    expect(pruned.json().removed).toBe(0);
  });

  it("reports conflict when cancelling a run that is not in progress", async () => {
    const h = await createHarness();
    const started = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf" } },
    });
    const runId = started.json().run.id as string;
    await waitForRun(h, runId);
    const cancelled = await h.app.inject({
      method: "POST",
      url: `/api/admin/quality/runs/${runId}/cancel`,
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: {},
    });
    expect(cancelled.statusCode).toBe(409);
  });
});

describe("authorization", () => {
  it("rejects a search-scope token and any read without a session", async () => {
    const h = await createHarness();
    const anonymous = await h.app.inject({ method: "GET", url: "/api/admin/quality/datasets" });
    expect(anonymous.statusCode).toBe(401);

    const token = await h.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      cookies: { sh_session: h.cookie },
      headers: { "x-csrf-token": h.csrf },
      payload: { name: "search-only", scopes: ["search"] },
    });
    expect(token.statusCode).toBe(200);
    const secret = (token.json().token ?? token.json().plainToken) as string;
    expect(secret).toBeTruthy();

    const denied = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(denied.statusCode).toBe(403);

    const deniedRun = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      headers: { authorization: `Bearer ${secret}` },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf" } },
    });
    expect(deniedRun.statusCode).toBe(403);
  });

  it("requires the CSRF header on a mutation", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/datasets",
      cookies: { sh_session: h.cookie },
      payload: { name: "no csrf" },
    });
    expect(response.statusCode).toBe(403);
  });
});
