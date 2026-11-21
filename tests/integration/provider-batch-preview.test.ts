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

/**
 * The pre-flight confirmation dialog's data source.
 *
 * Everything asserted here is a claim the UI will make *before* a request is
 * sent, so the tests focus on two failure modes that would make it lie:
 *
 *  1. the seven counters not adding up to the scope (the operator would be told
 *     "12 testable" and "8 skipped" out of 19 sources);
 *  2. the preview having a side effect (opening and dismissing the dialog would
 *     consume quota or leave rows behind).
 *
 * `paidRisk` is the third: an operator must never start a search run believing
 * it is free, nor be blocked from a connectivity run believing it costs money.
 */

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  await closeStubs();
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function track<T extends BatchHarness>(harness: T): T {
  harnesses.push(harness);
  return harness;
}

/** Adds a credentialed provider pointing at a local Brave-shaped stub. */
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

/** Adds a keyless provider pointing at a local HN-shaped stub. */
async function addKeyless(harness: BatchHarness, name: string): Promise<string> {
  const stub = await startHnStub({ hits: 2 });
  return createProvider(harness.app, harness.write(), {
    name,
    type: "hackernews",
    baseUrl: stub.base,
    resultsPerPage: 5,
  });
}

async function allowLocal(harness: BatchHarness): Promise<void> {
  await allowLocalhost(harness.app, harness.write());
}

describe("batch test preview", () => {
  /**
   * T05 — the 20/12/5/3 scenario, through the real endpoint.
   *
   * The unit suite proves the decision logic; this proves the route wires the
   * scenario's buckets to the response the dialog renders.
   */
  it("T05 reports 12 testable / 5 without key / 3 disabled for 20 sources", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    for (let index = 1; index <= 12; index += 1) {
      await addKeyed(harness, `ok-${index}`, `sk-OK-${String(index).padStart(3, "0")}-000000000000`);
    }
    // 3 sources with no credential at all.
    for (let index = 1; index <= 3; index += 1) {
      await createProvider(harness.app, harness.write(), {
        name: `nokey-${index}`,
        type: "brave",
        baseUrl: "http://127.0.0.1:9",
        enabled: true,
      });
    }
    // 2 sources whose only credential is disabled.
    for (let index = 1; index <= 2; index += 1) {
      const providerId = await addKeyed(harness, `disabledkey-${index}`, `sk-DISABLED-${index}-0000000000000`);
      const keys = await harness.app.inject({
        method: "GET",
        url: `/api/admin/providers/${providerId}/keys`,
        ...harness.read(),
      });
      const keyId = (keys.json() as Array<{ id: string }>)[0]!.id;
      const disabledKey = await harness.app.inject({
        method: "PATCH",
        url: `/api/admin/keys/${keyId}`,
        ...harness.write(),
        payload: { enabled: false },
      });
      expect(disabledKey.statusCode, disabledKey.body).toBe(200);
    }
    // 3 disabled sources (each with a usable credential: the switch wins).
    for (let index = 1; index <= 3; index += 1) {
      const providerId = await addKeyed(harness, `off-${index}`, `sk-OFF-${index}-000000000000000000`);
      await harness.app.inject({
        method: "PATCH",
        url: `/api/admin/providers/${providerId}`,
        ...harness.write(),
        payload: { enabled: false },
      });
    }

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...harness.read(),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      kind: string;
      total: number;
      counts: Record<string, number>;
      budget: { paidProbesEnabled: boolean; remainingToday: number };
      paidRisk: boolean;
      estimatedPaidProbes: number;
    };

    expect(body.kind).toBe("search");
    expect(body.total).toBe(20);
    // 付费开关关闭时，需凭据源明确进入策略跳过桶，不再冒充可执行项。
    expect(body.counts["eligible"]).toBe(0);
    expect(body.counts["coolingSkipped"]).toBe(12);
    expect(body.counts["noKey"]).toBe(3);
    expect(body.counts["noEnabledKey"]).toBe(2);
    expect(body.counts["disabled"]).toBe(3);
    expect(body.counts["configError"]).toBe(0);
    expect(body.budget.paidProbesEnabled).toBe(false);
    expect(body.paidRisk).toBe(false);
    // 仍报告潜在付费探测数，供前端解释纯付费范围为何不能启动。
    expect(body.estimatedPaidProbes).toBe(12);

    // Flipping the switch on is what turns those 12 testable sources into a
    // reported cost — and that is when the dialog must warn.
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 20, maxRequestsPerDay: 100 } },
    });
    const paid = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...harness.read(),
    });
    expect(paid.json().paidRisk).toBe(true);
    expect(paid.json().estimatedPaidProbes).toBe(12);
    expect(paid.json().counts.eligible).toBe(12);
    expect(paid.json().counts.coolingSkipped).toBe(0);
  });

  /**
   * T06 — a connectivity preview must never claim a paid risk.
   *
   * `connect` probes are free, so the paid switch is irrelevant to them. The
   * bucket split also has to stay honest: a source that needs a key still needs
   * one for a connectivity probe.
   */
  it("T06 connect preview ignores the paid budget and never claims paid risk", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    await addKeyed(harness, "free-connect", "sk-FREE-CONNECT-0000000000");
    await createProvider(harness.app, harness.write(), {
      name: "no-key-connect",
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=connect",
      ...harness.read(),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      counts: Record<string, number>;
      paidRisk: boolean;
      estimatedPaidProbes: number;
    };
    expect(body.paidRisk).toBe(false);
    expect(body.estimatedPaidProbes).toBe(0);
    // The key requirement is a *source* property, not a budget property: a
    // connectivity probe of a credential-backed source still needs its key.
    expect(body.counts["eligible"]).toBe(1);
    expect(body.counts["noKey"]).toBe(1);
    // Nothing is cooling: `coolingSkipped` must reflect cooldown/budget only.
    expect(body.counts["coolingSkipped"]).toBe(0);

    // 同一范围改为真实搜索时，付费开关关闭会使唯一需凭据源明确跳过；
    // 潜在付费数仍为 1，但 paidRisk 为 false，因为本次不会发出付费请求。
    const paid = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...harness.read(),
    });
    const paidBody = paid.json() as {
      counts: Record<string, number>;
      paidRisk: boolean;
      estimatedPaidProbes: number;
    };
    expect(paidBody.paidRisk).toBe(false);
    expect(paidBody.counts["eligible"]).toBe(0);
    expect(paidBody.counts["coolingSkipped"]).toBe(1);
    expect(paidBody.estimatedPaidProbes).toBe(1);
  });

  /**
   * T07 — with paid probes off, a paid run is refused, and it is refused as a
   * *validation* error the UI can explain, not as a 500 or a silent empty run.
   */
  it("T07 paid probes disabled blocks a search run with 409", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const providerId = await addKeyed(harness, "paid-blocked", "sk-PAID-BLOCKED-000000000");

    const preview = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...harness.read(),
    });
    expect(preview.json().paidRisk).toBe(false);

    const create = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [providerId] },
    });
    expect(create.statusCode, create.body).toBe(409);
    const error = create.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe("validation_error");
    expect(error.error.message).toContain("Paid search probes are disabled");

    // Nothing was written: the refusal happens before the insert, so there is no
    // `running` row for a poller to wait on forever.
    expect(rowCount(harness.ctx, "provider_test_batches")).toBe(0);
    expect(rowCount(harness.ctx, "provider_health_checks")).toBe(0);

    // A connectivity run of the same source is still allowed: it costs nothing.
    const connect = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [providerId] },
    });
    expect(connect.statusCode, connect.body).toBe(201);
  });

  /** T07 (second half) — an exhausted daily budget is refused the same way. */
  it("T07 an exhausted daily budget blocks a paid run before anything is spent", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const providerId = await addKeyed(harness, "budget-empty", "sk-BUDGET-EMPTY-0000000000");
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 4, maxRequestsPerDay: 1 } },
    });
    // Burn the single allowed probe.
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/:id/probe".replace(":id", providerId),
      ...harness.write(),
      payload: { kind: "search" },
    });
    expect(first.statusCode, first.body).toBe(200);
    const rowsAfterFirst = rowCount(harness.ctx, "provider_health_checks");

    const create = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "search", providerIds: [providerId] },
    });
    expect(create.statusCode, create.body).toBe(409);
    expect(create.json().error.message).toContain("budget exhausted");
    // The refusal must not have probed anything.
    expect(rowCount(harness.ctx, "provider_health_checks")).toBe(rowsAfterFirst);
  });

  /**
   * T08 — a preview is a read.
   *
   * The dialog is opened by a human to decide whether to spend money; a side
   * effect here would spend it for them.
   */
  it("T08 a preview writes neither health rows nor job rows", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    await addKeyed(harness, "preview-read-only", "sk-PREVIEW-READONLY-000000");
    await addKeyless(harness, "preview-keyless");

    const healthBefore = rowCount(harness.ctx, "provider_health_checks");
    const jobsBefore = rowCount(harness.ctx, "provider_test_batches");

    for (const kind of ["search", "connect"]) {
      const response = await harness.app.inject({
        method: "GET",
        url: `/api/admin/provider-health/batch-test/preview?kind=${kind}`,
        ...harness.read(),
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    expect(rowCount(harness.ctx, "provider_health_checks")).toBe(healthBefore);
    expect(rowCount(harness.ctx, "provider_test_batches")).toBe(jobsBefore);
    expect(healthBefore).toBe(0);
    expect(jobsBefore).toBe(0);
  });

  /**
   * T09 — the counters must partition the scope.
   *
   * A preview where the parts do not add up to the whole is worse than no
   * preview: the operator cannot tell whether the missing sources are skipped,
   * broken or invisible.
   */
  it("T09 the seven counters sum to total for a mixed scope", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    await addKeyed(harness, "sum-keyed", "sk-SUM-KEYED-000000000000000");
    await addKeyless(harness, "sum-keyless");
    await createProvider(harness.app, harness.write(), {
      name: "sum-nokey",
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });
    const disabled = await addKeyed(harness, "sum-disabled", "sk-SUM-DISABLED-0000000000");
    await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/providers/${disabled}`,
      ...harness.write(),
      payload: { enabled: false },
    });

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      ...harness.read(),
    });
    const body = response.json() as { total: number; counts: Record<string, number> };
    const sum =
      body.counts["eligible"]! +
      body.counts["noKey"]! +
      body.counts["noEnabledKey"]! +
      body.counts["configError"]! +
      body.counts["disabled"]! +
      body.counts["keylessSkipped"]! +
      body.counts["coolingSkipped"]!;
    expect(sum).toBe(body.total);
    expect(body.total).toBe(4);
  });

  /**
   * T45 — includeKeyless 是任务级参数，preview 与 runner 读取同一请求快照。
   * 全局 includeUnverified 既不决定默认值，也不会被弹窗切换修改。
   */
  it("T45 task-level includeKeyless defaults false and does not write global settings", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const keyless = await addKeyless(harness, "policy-keyless");
    const keyed = await addKeyed(harness, "policy-keyed", "sk-POLICY-KEYED-000000000000");
    const patched = await harness.app.inject({
      method: "PUT",
      url: "/api/admin/provider-health/settings",
      ...harness.write(),
      payload: { includeUnverified: true },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const excluded = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=connect",
      ...harness.read(),
    });
    expect(excluded.statusCode, excluded.body).toBe(200);
    const before = excluded.json() as { total: number; counts: Record<string, number> };
    expect(before.counts["keylessSkipped"]).toBe(1);
    expect(before.counts["eligible"]).toBe(1);

    const included = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=connect&includeKeyless=true",
      ...harness.read(),
    });
    expect(included.statusCode, included.body).toBe(200);
    const after = included.json() as { total: number; counts: Record<string, number> };
    expect(after.counts["keylessSkipped"]).toBe(0);
    expect(after.counts["eligible"]).toBe(2);
    expect(
      after.counts["eligible"]! +
        after.counts["noKey"]! +
        after.counts["noEnabledKey"]! +
        after.counts["configError"]! +
        after.counts["disabled"]! +
        after.counts["keylessSkipped"]! +
        after.counts["coolingSkipped"]!,
    ).toBe(after.total);

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", includeKeyless: false },
    });
    expect(created.statusCode, created.body).toBe(201);
    const jobId = created.json().jobId as string;

    interface JobView {
      status: string;
      includeKeyless: boolean;
      counts: { remaining: number };
      items: Array<{ providerId: string; state: string; code: string }>;
    }
    let view = (
      await harness.app.inject({
        method: "GET",
        url: `/api/admin/provider-health/batch-test/${jobId}`,
        ...harness.read(),
      })
    ).json() as JobView;
    await waitFor(
      async () => {
        view = (
          await harness.app.inject({
            method: "GET",
            url: `/api/admin/provider-health/batch-test/${jobId}`,
            ...harness.read(),
          })
        ).json() as JobView;
        return view.status !== "running" && view.counts.remaining === 0;
      },
      { label: "task-level keyless run to settle" },
    );

    expect(view.status).toBe("completed");
    expect(view.includeKeyless).toBe(false);
    const keylessItem = view.items.find((item) => item.providerId === keyless);
    expect(keylessItem?.state).toBe("skipped");
    expect(keylessItem?.code).toBe("SKIPPED_KEYLESS_BY_POLICY");
    expect(view.items.find((item) => item.providerId === keyed)?.state).toBe("ok");

    const settings = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/settings",
      ...harness.read(),
    });
    expect(settings.json().policy.includeUnverified).toBe(true);
    const rows = harness.ctx.sqlite
      .prepare("SELECT provider_id FROM provider_health_checks")
      .all() as Array<{ provider_id: string }>;
    expect(rows.map((row) => row.provider_id)).toEqual([keyed]);
  });

  /** A selected subset must not silently grow to the whole scope. */
  it("respects an explicit providerIds selection, including a comma-separated one", async () => {
    const harness = track(await startBatchHarness());
    await allowLocal(harness);
    const first = await addKeyed(harness, "subset-a", "sk-SUBSET-A-000000000000000");
    await addKeyed(harness, "subset-b", "sk-SUBSET-B-000000000000000");

    const single = await harness.app.inject({
      method: "GET",
      url: `/api/admin/provider-health/batch-test/preview?kind=search&providerIds=${first}`,
      ...harness.read(),
    });
    expect(single.json().total).toBe(1);
    // 纯付费范围在付费开关关闭时明确跳过，但 estimatedPaidProbes 仍报告潜力。
    expect(single.json().counts.eligible).toBe(0);
    expect(single.json().counts.coolingSkipped).toBe(1);
    expect(single.json().counts.disabled).toBe(0);
    expect(single.json().estimatedPaidProbes).toBe(1);

    const both = await harness.app.inject({
      method: "GET",
      url: `/api/admin/provider-health/batch-test/preview?kind=connect&providerIds=${first},`,
      ...harness.read(),
    });
    // A trailing comma must not become an empty provider id.
    expect(both.json().total).toBe(1);

    // An explicit empty selection is a defect, not "all of them": starting a run
    // on a scope the operator did not choose would spend their quota.
    const empty = await harness.app.inject({
      method: "POST",
      url: "/api/admin/provider-health/batch-test",
      ...harness.write(),
      payload: { kind: "connect", providerIds: [] },
    });
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.json().error.code).toBe("validation_error");
    expect(empty.json().error.message).toContain("nothing to test");
    expect(rowCount(harness.ctx, "provider_test_batches")).toBe(0);
  });

  /** The preview is admin-only: source inventory is not search-scope data. */
  it("rejects a search-scope token", async () => {
    const harness = track(await startBatchHarness());
    const minted = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...harness.write(),
      payload: { name: "searcher", scopes: ["search"], rateLimitPerMin: 600 },
    });
    const token = minted.json().token as string;
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/admin/provider-health/batch-test/preview?kind=search",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });
});
