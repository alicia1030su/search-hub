/**
 * Rank movements in a comparison report.
 *
 * "nDCG fell by 0.03" is not actionable. These assertions pin the part that is:
 * a document that exists on one side only is `entered` / `exited`, and its
 * `deltaPositions` is `null` — not `0` (which reads as "did not move") and not a
 * sentinel like `Infinity` that would poison an average.
 *
 * The two runs use different fusions over the *same* captured snapshots, so the
 * only difference between the rankings is the ranking function. A single-source
 * baseline is used on purpose: it makes documents that only the other sources
 * returned genuinely absent from the baseline list, which is how `entered`
 * arises without inventing a difference.
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
    dbPath: join(dir, "quality-movements.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-movements-"));
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

async function startFixtureRun(harness: Harness, fusion: Record<string, unknown>): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/quality/runs",
    cookies: { sh_session: harness.cookie },
    headers: { "x-csrf-token": harness.csrf },
    payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().run.id as string;
}

async function waitForRun(harness: Harness, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await harness.app.inject({
      method: "GET",
      url: `/api/admin/quality/runs/${runId}`,
      cookies: { sh_session: harness.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    if ((response.json() as { run: { status: string } }).run.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("run did not finish");
}

interface MovementRow {
  documentId: string;
  url: string;
  relevance: number | null;
  baselineRank: number | null;
  candidateRank: number | null;
  deltaPositions: number | null;
  movement: "up" | "down" | "entered" | "exited" | "same";
}

interface CompareBody {
  movements: {
    queries: Array<{
      queryId: string;
      category: string;
      rows: MovementRow[];
      changedCount: number;
      hiddenUnjudgedMovements: number;
      truncatedCount: number;
    }>;
    hiddenUnjudgedMovements: number;
    categoryGroupsOverlap: boolean;
  };
  byCategory: { groups: Array<{ category: string; queryCount: number }>; overlappingGroups: boolean };
  verdict: string;
}

describe("movements between two fusions over the same snapshots", () => {
  it("reports documents that exist on one side only with a null delta, never zero", async () => {
    const h = await createHarness();
    // Baseline: one source's own order. Candidate: the fused order. The
    // baseline therefore *cannot* contain documents only the other sources
    // returned, which is exactly the `entered` case.
    const baselineId = await startFixtureRun(h, { strategy: "single", providerId: "alpha" });
    const candidateId = await startFixtureRun(h, { strategy: "rrf", k: 60 });
    await waitForRun(h, baselineId);
    await waitForRun(h, candidateId);

    const response = await h.app.inject({
      method: "GET",
      url: `/api/admin/quality/compare?baseline=${baselineId}&candidate=${candidateId}`,
      cookies: { sh_session: h.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as CompareBody;

    expect(body.movements.queries.length).toBeGreaterThan(0);

    const rows = body.movements.queries.flatMap((query) => query.rows);
    expect(rows.length).toBeGreaterThan(0);

    const oneSided = rows.filter((row) => row.movement === "entered" || row.movement === "exited");
    // The single-source baseline drops other sources' documents, so there must
    // be at least one one-sided row; a report with none of them would mean the
    // movement code silently treated "absent" as "unmoved".
    expect(oneSided.length, JSON.stringify(body.movements.queries[0])).toBeGreaterThan(0);
    for (const row of oneSided) {
      expect(row.deltaPositions, `${row.documentId} (${row.movement})`).toBeNull();
      if (row.movement === "entered") {
        expect(row.baselineRank).toBeNull();
        expect(row.candidateRank).not.toBeNull();
      } else {
        expect(row.baselineRank).not.toBeNull();
        expect(row.candidateRank).toBeNull();
      }
    }

    // Two-sided rows keep a signed delta: positive is an improvement.
    for (const row of rows.filter((item) => item.movement === "up")) {
      expect(row.deltaPositions).not.toBeNull();
      expect(row.deltaPositions!).toBeGreaterThan(0);
    }
    for (const row of rows.filter((item) => item.movement === "down")) {
      expect(row.deltaPositions).not.toBeNull();
      expect(row.deltaPositions!).toBeLessThan(0);
    }

    // Unjudged documents cannot be said to have improved; the core fixture judges
    // everything it returns, so nothing may be withheld here.
    expect(body.movements.hiddenUnjudgedMovements).toBe(0);
    for (const row of rows) expect(row.relevance).not.toBeNull();

    // Every query appears once, ordered by id, so two identical reports diff cleanly.
    const ids = body.movements.queries.map((query) => query.queryId);
    expect([...ids].sort()).toEqual(ids);
    expect(body.movements.categoryGroupsOverlap).toBe(false);
  });

  it("is byte-identical when the same comparison is requested twice", async () => {
    const h = await createHarness();
    const baselineId = await startFixtureRun(h, { strategy: "single", providerId: "beta" });
    const candidateId = await startFixtureRun(h, { strategy: "rrf", k: 20 });
    await waitForRun(h, baselineId);
    await waitForRun(h, candidateId);

    const url = `/api/admin/quality/compare?baseline=${baselineId}&candidate=${candidateId}`;
    const first = await h.app.inject({ method: "GET", url, cookies: { sh_session: h.cookie } });
    const second = await h.app.inject({ method: "GET", url, cookies: { sh_session: h.cookie } });
    expect(first.statusCode, first.body).toBe(200);
    expect(JSON.stringify(first.json().movements)).toBe(JSON.stringify(second.json().movements));
  });
});
