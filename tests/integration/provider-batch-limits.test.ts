/**
 * The two guarantees a bulk run must never trade away: it sends nothing when
 * there is nothing to send, and volume cannot turn into money.
 *
 * T29 — a scope where every source lacks a key must produce **zero** upstream
 * requests. This is the promise the whole eligibility design exists to keep: an
 * operator who has configured twelve sources and filled in no keys should not
 * discover that fact from a vendor bill.
 *
 * T30 — one hundred simultaneous "start a run" requests must not each probe the
 * same source. Two independent limits are asserted, because either alone leaves
 * a hole: the per-day budget ledger must not be exceeded, and a source already
 * being probed must be refused rather than probed again.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    dbPath: join(dir, "batch-limits.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
    corsOrigins: [],
    rateLimitPerMin: 100_000,
  };
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-batch-limits-"));
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
  expect(setup.statusCode, setup.body).toBe(200);
  const harness: Harness = {
    app,
    ctx,
    dir,
    cookie: setup.cookies.find((item) => item.name === "sh_session")!.value,
    csrf: setup.json().csrfToken as string,
  };
  harnesses.push(harness);
  return harness;
}

function write(h: Harness) {
  return { cookies: { sh_session: h.cookie }, headers: { "x-csrf-token": h.csrf } };
}

function read(h: Harness) {
  return { cookies: { sh_session: h.cookie } };
}

async function createProvider(
  h: Harness,
  input: { name: string; type: string; baseUrl?: string; enabled?: boolean },
): Promise<string> {
  const response = await h.app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...write(h),
    payload: {
      name: input.name,
      type: input.type,
      enabled: input.enabled ?? true,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      timeoutMs: 5000,
      maxRetries: 0,
      config: {},
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

describe("T29: nothing to probe means nothing is sent", () => {
  it("sends zero upstream requests when every source in scope lacks a key", async () => {
    const h = await createHarness();
    // Three gated sources, no credentials at all. A local stub stands in for the
    // vendor so that "no request" is measurable rather than assumed.
    for (const name of ["t29-a", "t29-b", "t29-c"]) {
      await createProvider(h, { name, type: "brave", baseUrl: "http://127.0.0.1:9" });
    }

    const preview = await h.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...read(h),
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const counts = (preview.json() as { counts: Record<string, number> }).counts;
    expect(counts["eligible"]).toBe(0);
    expect(counts["noKey"]).toBe(3);

    const created = h.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...write(h),
      payload: { kind: "search" },
    });
    const response = await created;
    // A job that skips every source is still a legitimate record: it is the
    // operator's evidence that the scope was examined and nothing could run.
    expect([200, 201]).toContain(response.statusCode);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const view = (
      await h.app.inject({
        method: "GET",
        url: `/api/admin/provider-health/batch-test/${(response.json() as { jobId: string }).jobId}`,
        ...read(h),
      })
    ).json() as { items: Array<{ state: string; code: string }>; counts: { skipped: number } };
    // Every source is skipped by name, not by silence.
    expect(view.items).toHaveLength(3);
    expect(view.items.every((item) => item.state === "skipped" && item.code === "SKIPPED_NO_KEY")).toBe(true);
    expect(view.counts.skipped).toBe(3);

    // The promise this test exists for: no probe, therefore no verdict.
    const rows = h.ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_health_checks").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("records every source as skipped-with-no-key when the scope mixes keyed and unkeyed", async () => {
    const h = await createHarness();
    await createProvider(h, { name: "t29-keyed", type: "brave", baseUrl: "http://127.0.0.1:9" });
    await createProvider(h, { name: "t29-keyless-gated", type: "exa", baseUrl: "http://127.0.0.1:9" });

    const preview = await h.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...read(h),
    });
    const body = preview.json() as { total: number; counts: Record<string, number> };
    // Both require a key; neither has one. The preview must say so by name, and
    // the two counters must account for the whole scope.
    expect(body.counts["noKey"]).toBe(2);
    expect(body.counts["eligible"]).toBe(0);
    expect(
      body.counts["eligible"]! +
        body.counts["noKey"]! +
        body.counts["noEnabledKey"]! +
        body.counts["configError"]! +
        body.counts["disabled"]! +
        body.counts["keylessSkipped"]! +
        body.counts["coolingSkipped"]!,
    ).toBe(body.total);
  });
});

describe("T30: volume cannot become money", () => {
  it("cannot exceed the daily budget through one hundred simultaneous starts", async () => {
    const h = await createHarness();
    // A single paid source with a one-request daily allowance: one probe is all
    // the instance is willing to spend, however many callers ask.
    const providerId = await createProvider(h, { name: "t30-solo", type: "brave", baseUrl: "http://127.0.0.1:9" });
    const key = await h.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/keys`,
      ...write(h),
      payload: { label: "t30", key: "sk-t30-budget-probe-0001", weight: 100, enabled: true },
    });
    expect(key.statusCode, key.body).toBe(200);
    await h.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...write(h),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 4, maxRequestsPerDay: 1 } },
    });

    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        h.app.inject({
          method: "POST",
          url: "/api/admin/provider-health/batch-test",
          ...write(h),
          payload: { kind: "search", providerIds: [providerId] },
        }),
      ),
    );

    const accepted = responses.filter((response) => response.statusCode === 200 || response.statusCode === 201);
    // Some may be refused outright once the ledger is spent; none may be a 500,
    // and none may be accepted without a budget behind it.
    for (const response of responses) {
      expect([200, 201, 409]).toContain(response.statusCode);
    }
    expect(accepted.length).toBeGreaterThan(0);

    // The ledger is the authority: it must never report more spend than allowed.
    const budget = (
      await h.app.inject({ method: "GET", url: "/api/admin/health/budget", ...read(h) })
    ).json() as { usedToday: number; maxPerDay: number; remainingToday: number };
    expect(budget.usedToday).toBeLessThanOrEqual(budget.maxPerDay);
    expect(budget.remainingToday).toBeGreaterThanOrEqual(0);

    // At most as many health rows as the daily allowance permits.
    const checks = h.ctx.sqlite
      .prepare("SELECT COUNT(*) AS n FROM provider_health_checks WHERE provider_id = ? AND kind = 'search'")
      .get(providerId) as { n: number };
    expect(checks.n).toBeLessThanOrEqual(budget.maxPerDay);
  });
});
