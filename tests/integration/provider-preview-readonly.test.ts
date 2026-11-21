import { afterEach, describe, expect, it } from "vitest";
import { providerHealthBilling, providerHealthChecks, providerTestBatches } from "../../packages/db/src/schema.js";
import { rowCount, startBatchHarness, type BatchHarness } from "../helpers/batch-harness.js";
import { addKey, createProvider } from "../helpers/vendor-stubs.js";

const WATCHED_TABLES = [
  "api_keys",
  "provider_test_batches",
  "provider_health_checks",
  "provider_health_billing",
  "health_probe_budget",
  "audit_logs",
  "settings",
] as const;

type WatchedTable = (typeof WATCHED_TABLES)[number];

interface BudgetView {
  day: string;
  maxPerRun: number;
  maxPerDay: number;
  anonymousMaxPerRun: number;
  anonymousMaxPerDay: number;
  connectMaxPerProbe: number;
  connectMaxPerDay: number;
  usedToday: number;
  anonymousSearchUsedToday: number;
  connectUsedToday: number;
  remainingToday: number;
  anonymousRemainingToday: number;
  connectRemainingToday: number;
  paidProbesEnabled: boolean;
  scheduledEnabled: boolean;
  intervalMinutes: number;
}

interface McpHealthView {
  available: boolean;
  budget: {
    maxPerRun: number;
    maxPerDay: number;
    usedToday: number;
    paidProbesEnabled: boolean;
  };
  providers: Array<{ providerId: string }>;
}

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

async function freshHarness(): Promise<BatchHarness> {
  const harness = await startBatchHarness();
  harnesses.push(harness);
  return harness;
}

function snapshotRows(harness: BatchHarness): Record<WatchedTable, unknown[]> {
  return Object.fromEntries(
    WATCHED_TABLES.map((table) => [table, harness.ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  ) as Record<WatchedTable, unknown[]>;
}

function expectRowsUnchanged(harness: BatchHarness, before: Record<WatchedTable, unknown[]>): void {
  expect(snapshotRows(harness)).toEqual(before);
}

async function configureHealth(harness: BatchHarness): Promise<void> {
  const response = await harness.app.inject({
    method: "PUT",
    url: "/api/admin/provider-health/settings",
    ...harness.write(),
    payload: {
      paidProbesEnabled: true,
      scheduledEnabled: false,
      intervalMinutes: 60,
      maxRequestsPerRun: 4,
      maxRequestsPerDay: 10,
      anonymousMaxRequestsPerRun: 4,
      anonymousMaxRequestsPerDay: 8,
      connectMaxRequestsPerProbe: 3,
      connectMaxRequestsPerDay: 12,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function mintMcpToken(harness: BatchHarness): Promise<string> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/admin/tokens",
    ...harness.write(),
    payload: { name: "preview-readonly-mcp", scopes: ["mcp:use"], rateLimitPerMin: 600 },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().token as string;
}

function parseMcpResponse(body: string): Record<string, unknown> {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  expect(dataLines.length, body).toBeGreaterThan(0);
  return JSON.parse(dataLines[dataLines.length - 1]!) as Record<string, unknown>;
}

async function readMcpHealth(harness: BatchHarness, token: string): Promise<McpHealthView> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_provider_health", arguments: {} },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const rpc = parseMcpResponse(response.body);
  expect(rpc.error).toBeUndefined();
  const result = rpc.result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as McpHealthView;
}

function expectedBudget(
  day: string,
  usage: { paid: number; anonymous: number; connect: number },
): BudgetView {
  return {
    day,
    maxPerRun: 4,
    maxPerDay: 10,
    anonymousMaxPerRun: 4,
    anonymousMaxPerDay: 8,
    connectMaxPerProbe: 3,
    connectMaxPerDay: 12,
    usedToday: usage.paid,
    anonymousSearchUsedToday: usage.anonymous,
    connectUsedToday: usage.connect,
    remainingToday: 10 - usage.paid,
    anonymousRemainingToday: 8 - usage.anonymous,
    connectRemainingToday: 12 - usage.connect,
    paidProbesEnabled: true,
    scheduledEnabled: false,
    intervalMinutes: 60,
  };
}

function expectMcpBudget(view: McpHealthView, budget: BudgetView): void {
  expect(view.available).toBe(true);
  expect(view.budget).toEqual({
    maxPerRun: budget.maxPerRun,
    maxPerDay: budget.maxPerDay,
    usedToday: budget.usedToday,
    paidProbesEnabled: budget.paidProbesEnabled,
  });
}

async function seedBillingWithoutLedger(harness: BatchHarness): Promise<string> {
  const paidProviderId = await createProvider(harness.app, harness.write(), {
    name: "paid-billing-seed",
    type: "brave",
  });
  const anonymousProviderId = await createProvider(harness.app, harness.write(), {
    name: "anonymous-billing-seed",
    type: "mock",
    config: { resultCount: 1 },
  });
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const yesterday = new Date(Date.parse(`${day}T12:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

  harness.ctx.db
    .insert(providerHealthChecks)
    .values([
      {
        id: "seed-paid-spent",
        providerId: paidProviderId,
        kind: "search",
        status: "healthy",
        healthScore: 100,
        detailJson: '{"cause":"ok"}',
        trigger: "manual",
        checkedAt: now,
      },
      {
        id: "seed-anonymous-spent",
        providerId: anonymousProviderId,
        kind: "search",
        status: "healthy",
        healthScore: 100,
        detailJson: '{"cause":"ok"}',
        trigger: "manual",
        checkedAt: now,
      },
      {
        id: "seed-anonymous-unspent",
        providerId: anonymousProviderId,
        kind: "search",
        status: "unverified",
        healthScore: 0,
        detailJson: '{"cause":"no_credential"}',
        trigger: "manual",
        checkedAt: now,
      },
      {
        id: "seed-anonymous-legacy",
        providerId: anonymousProviderId,
        kind: "search",
        status: "healthy",
        healthScore: 100,
        detailJson: '{"cause":"ok"}',
        trigger: "manual",
        checkedAt: now,
      },
      {
        id: "seed-connect-spent",
        providerId: anonymousProviderId,
        kind: "connect",
        status: "healthy",
        healthScore: 100,
        detailJson: '{"cause":"ok"}',
        trigger: "manual",
        checkedAt: now,
      },
      {
        id: "seed-yesterday-paid",
        providerId: paidProviderId,
        kind: "search",
        status: "healthy",
        healthScore: 100,
        detailJson: '{"cause":"ok"}',
        trigger: "manual",
        checkedAt: `${yesterday}T12:00:00.000Z`,
      },
    ])
    .run();

  harness.ctx.db
    .insert(providerHealthBilling)
    .values([
      {
        healthCheckId: "seed-paid-spent",
        budgetKind: "search",
        budgetDay: day,
        classification: "exact",
        providerTypeSnapshot: "brave",
        credentialUsed: true,
        spent: true,
        createdAt: now,
      },
      {
        healthCheckId: "seed-anonymous-spent",
        budgetKind: "search_anonymous",
        budgetDay: day,
        classification: "exact",
        providerTypeSnapshot: "mock",
        credentialUsed: false,
        spent: true,
        createdAt: now,
      },
      {
        healthCheckId: "seed-anonymous-unspent",
        budgetKind: "search_anonymous",
        budgetDay: day,
        classification: "exact",
        providerTypeSnapshot: "mock",
        credentialUsed: false,
        spent: false,
        createdAt: now,
      },
      {
        healthCheckId: "seed-anonymous-legacy",
        budgetKind: "search_anonymous",
        budgetDay: day,
        classification: "legacy_conservative",
        providerTypeSnapshot: "mock",
        credentialUsed: false,
        spent: true,
        createdAt: now,
      },
      {
        healthCheckId: "seed-connect-spent",
        budgetKind: "connect",
        budgetDay: day,
        classification: "exact",
        providerTypeSnapshot: "mock",
        credentialUsed: false,
        spent: true,
        createdAt: now,
      },
      {
        healthCheckId: "seed-yesterday-paid",
        budgetKind: "search",
        budgetDay: yesterday,
        classification: "exact",
        providerTypeSnapshot: "brave",
        credentialUsed: true,
        spent: true,
        createdAt: `${yesterday}T12:00:00.000Z`,
      },
    ])
    .run();

  expect(rowCount(harness.ctx, "health_probe_budget")).toBe(0);
  return day;
}

describe("provider health preview reads are side-effect free", () => {
  it("S17 admin previews, overview, settings and MCP health leave every watched table unchanged", async () => {
    const harness = await freshHarness();
    await configureHealth(harness);
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "preview-only-mock",
      type: "mock",
      config: { resultCount: 1 },
    });
    const token = await mintMcpToken(harness);
    const day = new Date().toISOString().slice(0, 10);
    const budget = expectedBudget(day, { paid: 0, anonymous: 0, connect: 0 });
    const before = snapshotRows(harness);

    for (const kind of ["search", "connect"]) {
      const preview = await harness.app.inject({
        method: "GET",
        url: `/api/admin/provider-health/batch-test/preview?kind=${kind}&includeKeyless=true`,
        ...harness.read(),
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const body = preview.json() as {
        total: number;
        counts: Record<string, number>;
        budget: BudgetView & { remainingRun: number };
      };
      expect(body.total).toBe(1);
      expect(body.counts.eligible).toBe(1);
      expect(body.budget).toEqual({ ...budget, remainingRun: budget.maxPerRun });
    }

    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health",
      ...harness.read(),
    });
    expect(overview.statusCode, overview.body).toBe(200);
    const overviewBody = overview.json() as {
      providers: Array<{ providerId: string }>;
      budget: BudgetView;
    };
    expect(overviewBody.providers.map((provider) => provider.providerId)).toContain(providerId);
    expect(overviewBody.budget).toEqual(budget);

    const settings = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/settings",
      ...harness.read(),
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const settingsBody = settings.json() as { policy: Record<string, unknown>; budget: BudgetView };
    expect(settingsBody.policy).toMatchObject({
      paidProbesEnabled: true,
      scheduledEnabled: false,
      intervalMinutes: 60,
      maxRequestsPerRun: 4,
      maxRequestsPerDay: 10,
      anonymousMaxRequestsPerRun: 4,
      anonymousMaxRequestsPerDay: 8,
      connectMaxRequestsPerProbe: 3,
      connectMaxRequestsPerDay: 12,
    });
    expect(settingsBody.budget).toEqual(budget);

    const mcp = await readMcpHealth(harness, token);
    expectMcpBudget(mcp, budget);
    expect(mcp.providers.map((provider) => provider.providerId)).toContain(providerId);

    expectRowsUnchanged(harness, before);
    expect(rowCount(harness.ctx, "health_probe_budget")).toBe(0);
  });

  it("S17 dirty key snapshots are not flushed by preview, overview, settings or MCP health", async () => {
    const harness = await freshHarness();
    await configureHealth(harness);
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "preview-dirty-key",
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });
    await addKey(harness.app, harness.write(), providerId, "sk-PREVIEW-DIRTY-KEY-0000000000");
    harness.ctx.providers.stopFlusher();
    const runtime = harness.ctx.providers.activeRuntimes().find((item) => item.config.id === providerId);
    expect(runtime).toBeDefined();
    const lease = await runtime!.scheduler.acquire({ maxWaitMs: 0 });
    expect(lease).not.toBeNull();
    lease!.release({ ok: true, latencyMs: 1 });
    const token = await mintMcpToken(harness);
    const before = snapshotRows(harness);

    for (const url of [
      "/api/admin/provider-health/batch-test/preview?kind=connect&includeKeyless=true",
      "/api/admin/provider-health",
      "/api/admin/provider-health/settings",
      `/api/admin/providers/${providerId}/keys`,
    ]) {
      const response = await harness.app.inject({ method: "GET", url, ...harness.read() });
      expect(response.statusCode, response.body).toBe(200);
      expectRowsUnchanged(harness, before);
    }
    await readMcpHealth(harness, token);
    expectRowsUnchanged(harness, before);
  });

  it.each(["quota_exhausted", "forbidden"] as const)(
    "S17 a clean scheduler recovers %s after cooldown and UTC rollover without writing",
    async (status) => {
      const harness = await freshHarness();
      const providerId = await createProvider(harness.app, harness.write(), {
        name: `utc-readonly-${status}`,
        type: "brave",
        baseUrl: "http://127.0.0.1:9",
        dailyQuota: 1,
      });
      await addKey(harness.app, harness.write(), providerId, `sk-UTC-${status.toUpperCase()}-0000000000`);
      const keyId = harness.ctx.sqlite
        .prepare("SELECT id FROM api_keys WHERE provider_id = ?")
        .get(providerId) as { id: string };
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.parse(`${today}T12:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
      harness.ctx.sqlite
        .prepare("UPDATE api_keys SET status = ?, quota_used_today = 1, quota_date = ?, cooldown_until = ? WHERE id = ?")
        .run(status, yesterday, new Date(Date.now() - 1_000).toISOString(), keyId.id);
      harness.ctx.providers.reload();
      const before = snapshotRows(harness);

      const overview = await harness.app.inject({
        method: "GET",
        url: "/api/admin/provider-health",
        ...harness.read(),
      });
      expect(overview.statusCode, overview.body).toBe(200);
      const provider = (overview.json() as { providers: Array<{ providerId: string; keyAvailable: number }> })
        .providers.find((item) => item.providerId === providerId);
      expect(provider?.keyAvailable).toBe(1);
      expectRowsUnchanged(harness, before);
    },
  );

  it("normalizes a pre-v0.1.12 batch budget snapshot without inventing connect usage", async () => {
    const harness = await freshHarness();
    const now = new Date().toISOString();
    harness.ctx.db
      .insert(providerTestBatches)
      .values({
        id: "bt_legacy_budget",
        kind: "connect",
        status: "completed",
        total: 0,
        done: 0,
        okCount: 0,
        failedCount: 0,
        pendingCount: 0,
        skippedCount: 0,
        concurrency: 1,
        optionsJson: JSON.stringify({ includeKeyless: true }),
        itemsJson: "[]",
        budgetJson: JSON.stringify({
          day: "2026-11-20",
          maxPerRun: 3,
          maxPerDay: 20,
          usedToday: 4,
          anonymousSearchUsedToday: 2,
          anonymousMaxPerRun: 3,
          anonymousMaxPerDay: 10,
          remainingToday: 16,
          anonymousRemainingToday: 8,
          paidProbesEnabled: true,
          scheduledEnabled: false,
          intervalMinutes: 60,
        }),
        createdAt: now,
        finishedAt: now,
      })
      .run();
    const before = snapshotRows(harness);

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/bt_legacy_budget",
      ...harness.read(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().budget).toMatchObject({
      day: "2026-11-20",
      maxPerRun: 3,
      maxPerDay: 20,
      usedToday: 4,
      anonymousSearchUsedToday: 2,
      remainingToday: 16,
      anonymousRemainingToday: 8,
      connectUsedToday: 0,
      connectMaxPerProbe: 0,
      connectMaxPerDay: 0,
      connectRemainingToday: 0,
    });
    expectRowsUnchanged(harness, before);
  });

  it("S17 a missing ledger is computed from spent billing rows without materializing it", async () => {
    const harness = await freshHarness();
    await configureHealth(harness);
    const day = await seedBillingWithoutLedger(harness);
    const token = await mintMcpToken(harness);
    const budget = expectedBudget(day, { paid: 1, anonymous: 1, connect: 1 });
    const before = snapshotRows(harness);
    expect(before.health_probe_budget).toHaveLength(0);
    expect(before.provider_health_checks).toHaveLength(6);
    expect(before.provider_health_billing).toHaveLength(6);

    for (const kind of ["search", "connect"]) {
      const preview = await harness.app.inject({
        method: "GET",
        url: `/api/admin/provider-health/batch-test/preview?kind=${kind}&includeKeyless=true`,
        ...harness.read(),
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const body = preview.json() as { budget: BudgetView & { remainingRun: number } };
      expect(body.budget).toEqual({ ...budget, remainingRun: budget.maxPerRun });
    }

    const overview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health",
      ...harness.read(),
    });
    expect(overview.statusCode, overview.body).toBe(200);
    expect((overview.json() as { budget: BudgetView }).budget).toEqual(budget);

    const settings = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/settings",
      ...harness.read(),
    });
    expect(settings.statusCode, settings.body).toBe(200);
    expect((settings.json() as { budget: BudgetView }).budget).toEqual(budget);

    const mcp = await readMcpHealth(harness, token);
    expectMcpBudget(mcp, budget);

    expectRowsUnchanged(harness, before);
    expect(harness.ctx.sqlite.prepare("SELECT * FROM health_probe_budget").all()).toEqual([]);
  });
});
