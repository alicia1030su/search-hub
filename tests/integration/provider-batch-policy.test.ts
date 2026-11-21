import { afterEach, describe, expect, it } from "vitest";
import {
  addKey,
  allowLocalhost,
  closeStubs,
  createProvider,
  startBraveStub,
  startHnStub,
} from "../helpers/vendor-stubs.js";
import { rowCount, startBatchHarness, waitFor, type BatchHarness } from "../helpers/batch-harness.js";

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  await closeStubs();
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function track<T extends BatchHarness>(harness: T): T {
  harnesses.push(harness);
  return harness;
}

async function allowLocal(harness: BatchHarness): Promise<void> {
  await allowLocalhost(harness.app, harness.write());
}

async function addKeyless(harness: BatchHarness, name: string): Promise<string> {
  const stub = await startHnStub({ hits: 2 });
  return createProvider(harness.app, harness.write(), {
    name,
    type: "hackernews",
    baseUrl: stub.base,
    resultsPerPage: 5,
  });
}

async function addKeyed(harness: BatchHarness, name: string, key: string): Promise<string> {
  const stub = await startBraveStub({ results: 2 });
  const providerId = await createProvider(harness.app, harness.write(), {
    name,
    type: "brave",
    baseUrl: stub.base,
    resultsPerPage: 5,
  });
  await addKey(harness.app, harness.write(), providerId, key);
  return providerId;
}

interface PreviewBody {
  total: number;
  counts: Record<string, number>;
  paidRisk: boolean;
  estimatedPaidProbes: number;
  estimatedAnonymousProbes: number;
  budget: {
    paidProbesEnabled: boolean;
    anonymousRemainingToday: number;
    remainingToday: number;
  };
}

interface JobBody {
  status: string;
  includeKeyless: boolean;
  counts: { done: number; skipped: number; remaining: number };
  items: Array<{ providerId: string; state: string; code: string }>;
}

async function preview(
  harness: BatchHarness,
  query: string,
): Promise<PreviewBody> {
  const response = await harness.app.inject({
    method: "GET",
    url: `/api/admin/provider-health/batch-test/preview?${query}`,
    ...harness.read(),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as PreviewBody;
}

async function waitForJob(harness: BatchHarness, jobId: string): Promise<JobBody> {
  let last: JobBody | null = null;
  await waitFor(
    async () => {
      const response = await harness.app.inject({
        method: "GET",
        url: `/api/admin/provider-health/batch-test/${jobId}`,
        ...harness.read(),
      });
      expect(response.statusCode, response.body).toBe(200);
      last = response.json() as JobBody;
      return last.status !== "running" && last.counts.remaining === 0;
    },
    { label: `batch ${jobId} to settle` },
  );
  return last as unknown as JobBody;
}

describe("batch task-level keyless policy", () => {
  it("defaults includeKeyless to false and ignores the global includeUnverified setting", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const keyless = await addKeyless(harness, "policy-default-keyless");
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/provider-health/settings",
      ...harness.write(),
      payload: { includeUnverified: true },
    });

    const excluded = await preview(harness, "kind=connect");
    expect(excluded.counts["eligible"]).toBe(0);
    expect(excluded.counts["keylessSkipped"]).toBe(1);
    expect(excluded.estimatedAnonymousProbes).toBe(0);

    const included = await preview(harness, "kind=connect&includeKeyless=true");
    expect(included.counts["eligible"]).toBe(1);
    expect(included.counts["keylessSkipped"]).toBe(0);
    expect(included.estimatedAnonymousProbes).toBe(1);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [keyless] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.includeKeyless).toBe(false);
    expect(job.items[0]).toMatchObject({ state: "skipped", code: "SKIPPED_KEYLESS_BY_POLICY" });
    expect(rowCount(harness.ctx, "provider_health_checks")).toBe(0);
  });

  it("stores includeKeyless as a read-only snapshot and never changes global settings", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const keyless = await addKeyless(harness, "policy-snapshot-keyless");
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/provider-health/settings",
      ...harness.write(),
      payload: { includeUnverified: false },
    });

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [keyless], includeKeyless: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().jobId as string;
    const job = await waitForJob(harness, jobId);
    expect(job.includeKeyless).toBe(true);
    expect(job.items[0]).toMatchObject({ providerId: keyless, state: "ok", code: "ok" });

    const row = harness.ctx.sqlite
      .prepare("SELECT options_json FROM provider_test_batches WHERE id = ?")
      .get(jobId) as { options_json: string };
    expect(JSON.parse(row.options_json)).toMatchObject({ providerIds: [keyless], includeKeyless: true });

    const settings = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/settings",
      ...harness.read(),
    });
    expect(settings.json().policy.includeUnverified).toBe(false);
    const nextPreview = await preview(harness, "kind=connect");
    expect(nextPreview.counts["keylessSkipped"]).toBe(1);
    expect(nextPreview.counts["eligible"]).toBe(0);
  });

  it("allows an anonymous-only search while paid probes are disabled", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const keyless = await addKeyless(harness, "policy-anonymous-only");
    const before = await preview(harness, "kind=search&includeKeyless=true");
    expect(before.budget.paidProbesEnabled).toBe(false);
    expect(before.paidRisk).toBe(false);
    expect(before.estimatedPaidProbes).toBe(0);
    expect(before.estimatedAnonymousProbes).toBe(1);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [keyless], includeKeyless: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.items[0]).toMatchObject({ providerId: keyless, state: "ok" });
  });

  it("applies the independent anonymous-search cap without touching the paid cap", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const keyless = await addKeyless(harness, "policy-anonymous-cap");
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: {
        health: {
          paidProbesEnabled: false,
          anonymousMaxRequestsPerRun: 1,
          anonymousMaxRequestsPerDay: 1,
        },
      },
    });

    const initial = await preview(harness, `kind=search&includeKeyless=true&providerIds=${keyless}`);
    const paidRemaining = initial.budget.remainingToday;
    expect(paidRemaining).toBeGreaterThan(0);

    const first = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [keyless], includeKeyless: true },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect((await waitForJob(harness, first.json().jobId as string)).items[0]?.state).toBe("ok");

    const exhausted = await preview(harness, `kind=search&includeKeyless=true&providerIds=${keyless}`);
    expect(exhausted.counts["eligible"]).toBe(0);
    expect(exhausted.counts["coolingSkipped"]).toBe(1);
    expect(exhausted.estimatedAnonymousProbes).toBe(0);
    expect(exhausted.budget).toMatchObject({
      paidProbesEnabled: false,
      anonymousRemainingToday: 0,
      remainingToday: paidRemaining,
    });

    const second = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [keyless], includeKeyless: true },
    });
    expect(second.statusCode, second.body).toBe(201);
    const job = await waitForJob(harness, second.json().jobId as string);
    expect(job.items[0]).toMatchObject({ state: "skipped", code: "SKIPPED_BUDGET" });
    expect(rowCount(harness.ctx, "provider_health_checks")).toBe(1);
  });

  it("skips only credentialed sources in a mixed search when paid probes are disabled", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const brave = await startBraveStub({ results: 2 });
    const keyed = await createProvider(harness.app, harness.write(), {
      name: "policy-mixed-keyed",
      type: "brave",
      baseUrl: brave.base,
      resultsPerPage: 5,
    });
    await addKey(harness.app, harness.write(), keyed, "sk-POLICY-MIXED-0000000000");
    const keyless = await addKeyless(harness, "policy-mixed-keyless");

    const before = await preview(harness, `kind=search&includeKeyless=true&providerIds=${keyed},${keyless}`);
    expect(before.estimatedPaidProbes).toBe(1);
    expect(before.estimatedAnonymousProbes).toBe(1);
    expect(before.paidRisk).toBe(false);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [keyed, keyless], includeKeyless: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.items.find((item) => item.providerId === keyed)).toMatchObject({
      state: "skipped",
      code: "SKIPPED_PAID_DISABLED",
    });
    expect(job.items.find((item) => item.providerId === keyless)).toMatchObject({ state: "ok" });
    expect(brave.hits()).toBe(0);
  });

  it("rejects credentialed generic connectivity in preview and run without upstream work", async () => {
    const harness = track(await startBatchHarness());
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "policy-generic-credentialed-connect",
      type: "generic-http",
      baseUrl: "http://127.0.0.1:9",
      config: { path: "/search", keyInjection: { in: "header", name: "X-API-Key" } },
    });
    await addKey(harness.app, harness.write(), providerId, "sk-GENERIC-CONNECT-0000000000");

    const before = await preview(harness, `kind=connect&includeKeyless=true&providerIds=${providerId}`);
    expect(before.counts["eligible"]).toBe(0);
    expect(before.counts["configError"]).toBe(1);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [providerId], includeKeyless: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.items[0]).toMatchObject({ state: "failed", code: "configuration_error", checkId: null });
    expect(rowCount(harness.ctx, "provider_health_checks")).toBe(0);
  });

  it("applies the anonymous cap to generic connectivity but not builtin keyless connectivity", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const stub = await startHnStub({ hits: 2 });
    const generic = await createProvider(harness.app, harness.write(), {
      name: "policy-generic-anonymous-connect",
      type: "generic-http",
      baseUrl: stub.base,
      config: { path: "/api/v1/search", resultsPath: "hits", mapping: { title: "title", url: "url" } },
    });
    const builtin = await createProvider(harness.app, harness.write(), {
      name: "policy-builtin-anonymous-connect",
      type: "hackernews",
      baseUrl: stub.base,
    });
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: { health: { anonymousMaxRequestsPerRun: 1, anonymousMaxRequestsPerDay: 1 } },
    });
    const day = harness.ctx.health.budget().day;
    harness.ctx.sqlite
      .prepare(
        "INSERT INTO health_probe_budget (day, kind, used, updated_at) VALUES (?, 'search_anonymous', 1, ?) " +
          "ON CONFLICT(day, kind) DO UPDATE SET used = 1",
      )
      .run(day, new Date().toISOString());

    const before = await preview(
      harness,
      `kind=connect&includeKeyless=true&providerIds=${generic},${builtin}`,
    );
    expect(before.counts["eligible"]).toBe(1);
    expect(before.counts["coolingSkipped"]).toBe(1);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [generic, builtin], includeKeyless: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.items.find((item) => item.providerId === generic)).toMatchObject({
      state: "skipped",
      code: "SKIPPED_BUDGET",
    });
    expect(job.items.find((item) => item.providerId === builtin)).toMatchObject({ state: "ok" });
    expect(stub.hits()).toBe(1);
    expect(rowCount(harness.ctx, "provider_health_checks")).toBe(1);
  });

  it("does not turn an optional-key source into a paid source when paid probes are disabled", async () => {
    const harness = track(await startBatchHarness());
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "policy-optional-key",
      type: "mock",
      config: { resultCount: 2, latencyMs: 1, namespace: "optional-key" },
    });
    await addKey(harness.app, harness.write(), providerId, "sk-OPTIONAL-KEY-000000000000");

    const before = await preview(harness, `kind=search&includeKeyless=true&providerIds=${providerId}`);
    expect(before.estimatedPaidProbes).toBe(0);
    expect(before.estimatedAnonymousProbes).toBe(1);
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [providerId], includeKeyless: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.items[0]).toMatchObject({ state: "ok", code: "ok" });
  });

  it("runs one paid and one anonymous source under independent per-run caps", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const keyed = await addKeyed(harness, "policy-split-paid", "sk-POLICY-SPLIT-00000000000");
    const keyless = await addKeyless(harness, "policy-split-anonymous");
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: {
        health: {
          paidProbesEnabled: true,
          maxRequestsPerRun: 1,
          maxRequestsPerDay: 10,
          anonymousMaxRequestsPerRun: 1,
          anonymousMaxRequestsPerDay: 10,
        },
      },
    });

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [keyed, keyless], includeKeyless: true, concurrency: 2 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.items.every((item) => item.state === "ok")).toBe(true);
    const budget = harness.ctx.health.budget();
    expect(budget.usedToday).toBe(1);
    expect(budget.anonymousSearchUsedToday).toBe(1);
  });

  it("does not let includeKeyless bypass a generic keyInjection credential requirement", async () => {
    const harness = track(await startBatchHarness());
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "policy-generic-injection",
      type: "generic-http",
      baseUrl: "http://127.0.0.1:9",
      config: { path: "/search", keyInjection: { in: "header", name: "X-API-Key" } },
    });

    const before = await preview(harness, `kind=search&includeKeyless=true&providerIds=${providerId}`);
    expect(before.counts["eligible"]).toBe(0);
    expect(before.counts["noKey"]).toBe(1);
    expect(before.counts["keylessSkipped"]).toBe(0);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [providerId], includeKeyless: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    const job = await waitForJob(harness, created.json().jobId as string);
    expect(job.items[0]).toMatchObject({ state: "skipped", code: "SKIPPED_NO_KEY" });
  });

  it("does not let includeKeyless bypass a generic {{key}} placeholder requirement", async () => {
    const harness = track(await startBatchHarness());
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "policy-generic-placeholder",
      type: "generic-http",
      baseUrl: "http://127.0.0.1:9",
      config: { path: "/search", headers: { "X-API-Key": "{{key}}" } },
    });

    const before = await preview(harness, `kind=search&includeKeyless=true&providerIds=${providerId}`);
    expect(before.counts["eligible"]).toBe(0);
    expect(before.counts["noKey"]).toBe(1);
  });

  it("never marks a required-key source eligible when its key is invalid or quota-exhausted", async () => {
    const harness = track(await startBatchHarness());
    const invalid = await addKeyed(harness, "policy-invalid-key", "sk-POLICY-INVALID-000000000");
    const quota = await addKeyed(harness, "policy-quota-key", "sk-POLICY-QUOTA-0000000000");
    harness.ctx.sqlite.prepare("UPDATE api_keys SET status = 'invalid' WHERE provider_id = ?").run(invalid);
    harness.ctx.sqlite
      .prepare("UPDATE api_keys SET quota_used_today = 10, quota_date = ? WHERE provider_id = ?")
      .run(new Date().toISOString().slice(0, 10), quota);
    harness.ctx.sqlite
      .prepare("UPDATE provider_instances SET daily_quota = 10 WHERE id = ?")
      .run(quota);
    harness.ctx.providers.reload();

    const before = await preview(harness, `kind=connect&providerIds=${invalid},${quota}`);
    expect(before.counts["eligible"]).toBe(0);
    expect(
      before.counts["noKey"]! +
        before.counts["noEnabledKey"]! +
        before.counts["configError"]! +
        before.counts["coolingSkipped"]!,
    ).toBe(2);
  });
});
