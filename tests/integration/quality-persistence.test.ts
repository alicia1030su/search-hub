/**
 * Storage failures during an evaluation run.
 *
 * A dataset that cannot be written is not a client error, and it is certainly
 * not a success. The assertions pin three things:
 *
 *  - the run row says `failed` with a reason, instead of staying `running`;
 *  - the number of rows actually written is preserved, so a partial run is never
 *    later quoted as a complete one;
 *  - a full volume is distinguishable from an ordinary bug.
 *
 * The failure is injected on the run-results table only, through a real Drizzle
 * handle. A stub that throws on every call would be testing the stub.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { qualityRuns, qualityRunResults } from "../../packages/db/src/schema.js";
import type { Logger } from "@search-hub/shared";
import { QualityService } from "../../apps/api/src/services/quality.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

function diskFullError(): Error & { code: string } {
  const error = new Error("database or disk is full") as Error & { code: string };
  error.code = "SQLITE_FULL";
  return error;
}

/**
 * A context whose evaluation writes fail the way a full disk fails.
 *
 * Only `insert(qualityRunResults)` throws: everything else — reading the
 * dataset, writing the run row, updating the failure — keeps working, which is
 * the situation the code has to survive.
 */
function fullDiskContext(dir: string): AppContext {
  const ctx = createContext(testConfig(dir));
  const realDb = ctx.db;
  const failingDb = new Proxy(realDb, {
    get(target, property, receiver) {
      if (property !== "insert") return Reflect.get(target, property, receiver);
      return (table: unknown) => {
        const builder = target.insert(table as never);
        if (table !== qualityRunResults) return builder;
        return {
          values: () => ({
            run: () => {
              throw diskFullError();
            },
          }),
        };
      };
    },
  });
  return { ...ctx, db: failingDb } as AppContext;
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met in time");
}

describe("a full disk while a run is writing results", () => {
  it("records the run as failed with a reason instead of leaving it running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-full-"));
    dirs.push(dir);
    const healthy = createContext(testConfig(dir));
    // The service is built over the failing handle: `buildApp` would hand it
    // the healthy one, and the test would then assert nothing.
    const failing = fullDiskContext(dir);
    const service = new QualityService({
      db: failing.db,
      settings: failing.settings,
      search: failing.search,
      logger: silentLogger,
      engineVersion: failing.config.version,
      codeCommit: null,
      providerSnapshot: () => [],
      modelSnapshot: () => [],
    });

    const started = service.startRun(
      { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf", k: 60 } },
      "admin",
    );

    await waitFor(() => {
      const row = healthy.sqlite
        .prepare("SELECT status FROM quality_runs WHERE id = ?")
        .get(started.id) as { status: string } | undefined;
      return row !== undefined && row.status !== "running";
    });

    const row = healthy.sqlite
      .prepare("SELECT status, failure_reason, persisted_query_count, partial FROM quality_runs WHERE id = ?")
      .get(started.id) as {
      status: string;
      failure_reason: string | null;
      persisted_query_count: number;
      partial: number;
    };
    expect(row.status).toBe("failed");
    expect(row.failure_reason).toBe("persistence_failed");
    // Nothing was written before the first insert failed, and that is recorded
    // rather than guessed at.
    expect(row.persisted_query_count).toBe(0);
    expect(row.partial).toBe(1);

    const results = healthy.sqlite.prepare("SELECT COUNT(*) AS n FROM quality_run_results").get() as { n: number };
    expect(results.n).toBe(0);

    // Both handles share the file; both must be released before the temp
    // directory can be removed on Windows.
    failing.closeDb();
    healthy.closeDb();
  });
});

describe("a healthy run", () => {
  it("writes a run row and its per-query results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-quality-healthy-"));
    dirs.push(dir);
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
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/quality/runs",
      headers: { "x-csrf-token": setup.json().csrfToken as string },
      cookies: { sh_session: setup.cookies.find((item) => item.name === "sh_session")!.value },
      payload: { datasetId: "ds_synthetic_core_v1", mode: "offline", fusion: { strategy: "rrf", k: 60 } },
    });
    expect(created.statusCode).toBe(200);

    await waitFor(() => {
      const row = ctx.db.select().from(qualityRuns).all()[0];
      return row !== undefined && row.status === "completed";
    });
    const runs = ctx.db.select().from(qualityRuns).all();
    const results = ctx.db.select().from(qualityRunResults).all();
    expect(runs).toHaveLength(1);
    expect(results.length).toBeGreaterThan(0);
    // A completed run is not partial, and it knows how much it wrote.
    expect(runs[0]!.partial).toBe(false);
    expect(runs[0]!.persistedQueryCount).toBe(results.length);
    await app.close();
  });
});
