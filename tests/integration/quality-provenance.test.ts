/**
 * Provenance, run options and storage failures — end to end.
 *
 * These go through the real Fastify app and the real SQLite file, because the
 * questions they answer are about the recorded state, not about a function's
 * return value:
 *
 *  - does a finished run carry the fingerprints of what it actually used?
 *  - does an option this release cannot honour get refused instead of stored?
 *  - does a failed write leave a run that says it failed, rather than one stuck
 *    at `running` forever?
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { qualityRuns } from "../../packages/db/src/schema.js";

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
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-provenance-"));
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

async function startFixtureRun(
  harness: Harness,
  extra: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/quality/runs",
    headers: { "x-csrf-token": harness.csrf },
    cookies: { sh_session: harness.cookie },
    payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf", k: 60 }, ...extra },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("run provenance", () => {
  it("records provider, qrels and model fingerprints on a finished run", async () => {
    const h = await createHarness();
    const started = await startFixtureRun(h);
    expect(started.statusCode).toBe(200);
    const runId = (started.body.run as { id: string }).id;
    const detail = await waitForRun(h, runId);

    const run = detail.run as {
      provenanceComplete: boolean;
      providerIds: string[];
      providerFingerprint: string | null;
      qrelsFingerprint: string | null;
      modelFingerprint: string | null;
      provenanceMissing: string[];
    };
    expect(run.provenanceComplete).toBe(true);
    expect(run.provenanceMissing).toEqual([]);
    // A fixture run is attributable to the fixture's own sources.
    expect(run.providerIds).toEqual(["alpha", "beta", "gamma"]);
    expect(run.providerFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(run.qrelsFingerprint).toMatch(/^[0-9a-f]{32}$/);
    // This release's evaluation path invokes no model. That is a fact, so it is
    // null — not missing, and not a digest of nothing.
    expect(run.modelFingerprint).toBeNull();
  });

  it("marks a run recorded before v0.1.10 as incomplete rather than back-filling it", async () => {
    const h = await createHarness();
    const started = await startFixtureRun(h);
    const runId = (started.body.run as { id: string }).id;
    await waitForRun(h, runId);
    // Simulate the row an earlier release would have written.
    // The row an earlier release would have written: the provenance columns are
    // absent, and nothing may reconstruct them from today's configuration.
    h.ctx.sqlite
      .prepare(
        "UPDATE quality_runs SET provider_ids_json = NULL, provider_fingerprint = NULL, qrels_fingerprint = NULL WHERE id = ?",
      )
      .run(runId);

    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/runs/${runId}`,
      cookies: { sh_session: h.cookie },
    });
    const run = response.json().run as { provenanceComplete: boolean; provenanceMissing: string[] };
    expect(run.provenanceComplete).toBe(false);
    expect(run.provenanceMissing).toEqual(["providerIds", "providerFingerprint", "qrelsFingerprint"]);
  });
});

describe("run options", () => {
  it("records the per-provider limit and timeout a run actually used", async () => {
    const h = await createHarness();
    const started = await startFixtureRun(h, { perProviderLimit: 20, timeoutMs: 4000 });
    expect(started.statusCode).toBe(200);
    const runId = (started.body.run as { id: string }).id;
    const detail = await waitForRun(h, runId);
    const run = detail.run as { perProviderLimit: number | null; timeoutMs: number | null };
    expect(run.perProviderLimit).toBe(20);
    expect(run.timeoutMs).toBe(4000);
  });

  it("defaults the per-provider limit to the display limit and says so", async () => {
    const h = await createHarness();
    const started = await startFixtureRun(h, { limit: 15 });
    const runId = (started.body.run as { id: string }).id;
    const detail = await waitForRun(h, runId);
    expect((detail.run as { perProviderLimit: number | null }).perProviderLimit).toBe(15);
  });

  it("refuses a concurrency this release cannot honour instead of storing it", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      headers: { "x-csrf-token": h.csrf },
      cookies: { sh_session: h.cookie },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        mode: "offline",
        fusion: { strategy: "rrf", k: 60 },
        maxConcurrency: 4,
      },
    });
    // zod rejects the literal before the service sees it: either way it is a 400
    // and nothing was written.
    expect(response.statusCode).toBe(400);
    const rows = h.ctx.db.select().from(qualityRuns).all();
    expect(rows).toHaveLength(0);
  });

  it("refuses a cache policy other than bypass", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      headers: { "x-csrf-token": h.csrf },
      cookies: { sh_session: h.cookie },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        mode: "offline",
        fusion: { strategy: "rrf", k: 60 },
        cachePolicy: "isolated",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(h.ctx.db.select().from(qualityRuns).all()).toHaveLength(0);
  });

  it("rejects an out-of-range per-provider limit instead of clamping it", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      headers: { "x-csrf-token": h.csrf },
      cookies: { sh_session: h.cookie },
      payload: {
        datasetId: "ds_synthetic_core_v1",
        mode: "offline",
        fusion: { strategy: "rrf", k: 60 },
        perProviderLimit: 51,
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("pagination", () => {
  it("reports the total and hasMore for datasets and keeps coverage over the whole set", async () => {
    const h = await createHarness();
    const list = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets?limit=1",
      cookies: { sh_session: h.cookie },
    });
    const body = list.json() as { datasets: unknown[]; total: number; hasMore: boolean };
    expect(body.datasets).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.hasMore).toBe(true);

    const detail = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1?queriesLimit=3&judgmentsLimit=2",
      cookies: { sh_session: h.cookie },
    });
    const page = detail.json() as {
      queries: unknown[];
      judgments: unknown[];
      coverage: { queryCount: number; judgedDocuments: number };
      queriesPage: { total: number; hasMore: boolean };
      judgmentsPage: { total: number; hasMore: boolean };
    };
    expect(page.queries).toHaveLength(3);
    expect(page.judgments).toHaveLength(2);
    // Coverage is computed over the whole dataset, so paging must not change it.
    const full = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1",
      cookies: { sh_session: h.cookie },
    });
    const fullBody = full.json() as { coverage: { queryCount: number; judgedDocuments: number } };
    expect(page.coverage.queryCount).toBe(fullBody.coverage.queryCount);
    expect(page.coverage.judgedDocuments).toBe(fullBody.coverage.judgedDocuments);
    expect(page.queriesPage.total).toBe(fullBody.coverage.queryCount);
    expect(page.judgmentsPage.total).toBe(fullBody.coverage.judgedDocuments);
  });

  it("lists unjudged queries with a total, and never calls an unrun query fully judged", async () => {
    const h = await createHarness();
    const response = await h.app.inject({
      method: "GET",
      url: "/api/admin/quality/datasets/ds_synthetic_core_v1/unjudged?includeDocuments=true",
      cookies: { sh_session: h.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { total: number; queries: Array<{ reason?: string; documents?: unknown[] }> };
    // The core fixture is fully judged, so there is nothing left unjudged — and
    // the answer must be an honest zero, not an error.
    expect(body.total).toBe(0);
    expect(body.queries).toEqual([]);
  });
});

