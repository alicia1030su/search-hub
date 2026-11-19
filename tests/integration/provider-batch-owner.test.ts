/**
 * A bulk test job belongs to the account that started it.
 *
 * The rule mirrors `cancelRun` in the evaluation lab: one actor cannot stop, or
 * read, another actor's work. For a bulk provider test the stakes are concrete —
 * the job's items name the sources that account configured and the vendor
 * answers it received — so a cross-account read is not cosmetic.
 *
 * The test drives the real HTTP surface with two different admin sessions. It
 * asserts the rule at the boundary that enforces it (the route), not on the
 * helper, because a helper that is never called proves nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import { providerTestBatches } from "../../packages/db/src/schema.js";

interface Session {
  cookie: string;
  csrf: string;
  label: string;
}

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  owner: Session;
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
    dbPath: join(dir, "batch-owner.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-batch-owner-"));
  const ctx = createContext(testConfig(dir));
  const app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      email: "owner@example.com",
      password: "A-very-long-password-1",
      name: "Owner",
      setupToken: ctx.setupToken.value!,
    },
  });
  expect(setup.statusCode, setup.body).toBe(200);
  const harness: Harness = {
    app,
    ctx,
    dir,
    owner: {
      cookie: setup.cookies.find((item) => item.name === "sh_session")!.value,
      csrf: setup.json().csrfToken as string,
      label: "admin:owner@example.com",
    },
  };
  harnesses.push(harness);
  return harness;
}

/**
 * Inserts a job owned by someone else.
 *
 * Written directly because the only way to obtain a *second* administrator in a
 * single-tenant test instance would be to create one, and the rule under test is
 * about the `created_by` column, not about how that column is populated.
 */
function seedForeignJob(ctx: AppContext, id: string): void {
  const now = new Date().toISOString();
  ctx.db
    .insert(providerTestBatches)
    .values({
      id,
      kind: "connect",
      status: "running",
      total: 1,
      done: 0,
      okCount: 0,
      failedCount: 0,
      pendingCount: 0,
      skippedCount: 0,
      concurrency: 1,
      optionsJson: "{}",
      itemsJson: JSON.stringify([
        {
          providerId: "p_foreign",
          providerName: "Foreign",
          state: "unknown",
          code: "unknown",
          latencyMs: null,
          resultCount: null,
          requests: null,
          checkId: null,
          reason: null,
        },
      ]),
      budgetJson: "{}",
      createdBy: "admin:someone-else@example.com",
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    })
    .run();
}

describe("a job started by another account", () => {
  it("is not readable through the progress endpoint", async () => {
    const h = await createHarness();
    seedForeignJob(h.ctx, "bt_foreign_read");

    const response = await h.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/bt_foreign_read",
      cookies: { sh_session: h.owner.cookie },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("is not cancellable through the cancel endpoint", async () => {
    const h = await createHarness();
    seedForeignJob(h.ctx, "bt_foreign_cancel");

    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test/bt_foreign_cancel/cancel",
      cookies: { sh_session: h.owner.cookie },
      headers: { "x-csrf-token": h.owner.csrf },
    });
    expect(response.statusCode, response.body).toBe(403);

    // The row is untouched: a refused cancel must not stop the owner's run.
    const row = h.ctx.sqlite
      .prepare("SELECT status FROM provider_test_batches WHERE id = ?")
      .get("bt_foreign_cancel") as { status: string };
    expect(row.status).toBe("running");
  });

  it("is readable by the account that owns it", async () => {
    const h = await createHarness();
    const now = new Date().toISOString();
    h.ctx.db
      .insert(providerTestBatches)
      .values({
        id: "bt_own",
        kind: "connect",
        status: "running",
        total: 1,
        done: 0,
        okCount: 0,
        failedCount: 0,
        pendingCount: 0,
        skippedCount: 0,
        concurrency: 1,
        optionsJson: "{}",
        itemsJson: "[]",
        budgetJson: "{}",
        createdBy: h.owner.label,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
      })
      .run();

    const response = await h.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/bt_own",
      cookies: { sh_session: h.owner.cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { jobId: string }).jobId).toBe("bt_own");
  });

  it("leaves a job with no recorded owner readable, rather than stranding it", async () => {
    const h = await createHarness();
    const now = new Date().toISOString();
    h.ctx.db
      .insert(providerTestBatches)
      .values({
        id: "bt_orphan",
        kind: "connect",
        status: "running",
        total: 0,
        done: 0,
        okCount: 0,
        failedCount: 0,
        pendingCount: 0,
        skippedCount: 0,
        concurrency: 1,
        optionsJson: "{}",
        itemsJson: "[]",
        budgetJson: "{}",
        createdBy: null,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
      })
      .run();

    const response = await h.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/bt_orphan",
      cookies: { sh_session: h.owner.cookie },
    });
    // A row from before ownership existed cannot be attributed, and refusing it
    // would make its result permanently unreadable.
    expect(response.statusCode, response.body).toBe(200);
  });
});
