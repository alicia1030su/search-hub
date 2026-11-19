import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

/**
 * A booted API instance on a fresh database, for the bulk-test suites.
 *
 * Two properties this helper exists to provide:
 *
 *  - `dbPath` is exposed, so a test can start a **second** context on the same
 *    file and prove what a restart does to a run that was still going (T14);
 *  - `close()` shuts the instance down without deleting the database unless the
 *    caller asks, which is what makes the restart case expressible at all.
 *
 * Nothing here stubs the network: the suites that need a vendor use the local
 * `http.createServer` stubs, so an assertion about "did a request leave" is
 * about a real socket.
 */
export interface BatchHarness {
  app: FastifyInstance;
  ctx: AppContext;
  dir: string;
  dbPath: string;
  cookie: string;
  csrf: string;
  /** Admin headers for a read-only request. */
  read(): { cookies: { sh_session: string } };
  /** Admin headers for a mutating request (CSRF required). */
  write(): { cookies: { sh_session: string }; headers: { "x-csrf-token": string } };
  /** Closes the app and the database, keeping the files on disk. */
  stop(): Promise<void>;
  /** Closes everything and removes the temporary directory. */
  dispose(): Promise<void>;
}

function testConfig(dir: string, dbPath: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir: dir,
    dbPath,
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    // The suites make hundreds of admin calls; the production limiter would
    // turn a "too many requests" into a false failure.
    rateLimitPerMin: 100_000,
  };
}

export async function startBatchHarness(options: { dir?: string } = {}): Promise<BatchHarness> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "search-hub-batch-"));
  const dbPath = join(dir, "batch.db");
  const ctx = createContext(testConfig(dir, dbPath));
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

  return {
    app,
    ctx,
    dir,
    dbPath,
    cookie,
    csrf,
    read: () => ({ cookies: { sh_session: cookie } }),
    write: () => ({ cookies: { sh_session: cookie }, headers: { "x-csrf-token": csrf } }),
    async stop() {
      await app.close();
      ctx.batch.shutdown();
      try {
        ctx.closeDb();
      } catch {
        /* already closed */
      }
    },
    async dispose() {
      await app.close();
      ctx.batch.shutdown();
      try {
        ctx.closeDb();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Reopens the same database in a new context.
 *
 * This is a restart in the only sense that matters here: a fresh
 * `ProviderBatchService` whose constructor sweeps leftover `running` rows.
 * The administrator already exists on the reopened file, so it logs in with the
 * credential the first harness created instead of running setup again (which the
 * server would refuse).
 */
export async function restartBatchHarness(previous: BatchHarness): Promise<BatchHarness> {
  const ctx = createContext(testConfig(previous.dir, previous.dbPath));
  const app = await buildApp(ctx);
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.com", password: "A-very-long-password-1" },
  });
  const cookie = login.cookies.find((item) => item.name === "sh_session")!.value;
  const csrf = login.json().csrfToken as string;

  return {
    app,
    ctx,
    dir: previous.dir,
    dbPath: previous.dbPath,
    cookie,
    csrf,
    read: () => ({ cookies: { sh_session: cookie } }),
    write: () => ({ cookies: { sh_session: cookie }, headers: { "x-csrf-token": csrf } }),
    async stop() {
      await app.close();
      ctx.batch.shutdown();
      try {
        ctx.closeDb();
      } catch {
        /* already closed */
      }
    },
    // The temporary directory belongs to the first harness: closing the database
    // is all this one may do, or the two would race to delete a file they share.
    async dispose() {
      await app.close();
      ctx.batch.shutdown();
      try {
        ctx.closeDb();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Rows in a table, for the "a preview writes nothing" assertions. */
export function rowCount(ctx: AppContext, table: string): number {
  const row = ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/**
 * Waits until `check` returns true, or fails after `timeoutMs`.
 *
 * Polling a real runner cannot be done with a fixed sleep: the assertion would
 * either be flaky (too short) or slow (too long). A bounded wait on the actual
 * observable state is both.
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.label ?? "condition"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
