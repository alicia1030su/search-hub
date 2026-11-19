import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addKey, allowLocalhost, closeStubs, createProvider, startBraveStub } from "../helpers/vendor-stubs.js";
import { startBatchHarness, type BatchHarness } from "../helpers/batch-harness.js";

/**
 * The single-source test endpoint, after it was collapsed onto `checkOne`.
 *
 * The bug this suite exists to prevent is subtle and was shipped: `testProvider`
 * built its own provider config, forgot `search: resolveSearchConfig(...)`, and
 * every paginated adapter silently took its single-page fallback. The endpoint
 * then reported "3 results in 120ms" for a source the scheduled probe had just
 * called degraded — two answers to one question. T02 is the assertion that makes
 * the regression impossible to reintroduce: it counts the requests that actually
 * reached the wire.
 */

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  await closeStubs();
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

function track<T extends BatchHarness>(harness: T): T {
  harnesses.push(harness);
  return harness;
}

interface TestBody {
  ok: boolean;
  latencyMs: number;
  resultCount?: number;
  message: string;
  sample?: Array<{ title: string; url: string }>;
  status: string;
  cause: string;
  errorCode: string | null;
  requests: number | null;
  kind: string;
  keyId: string | null;
  checkedAt: string;
}

const PLAINTEXT_KEY = "sk-SINGLE-TEST-PLAINTEXT-0000000000";

/** A credentialed source whose base URL is a local Brave-shaped stub. */
async function setUpBrave(
  harness: BatchHarness,
  options: { results?: number; searchConfig?: Record<string, unknown> } = {},
): Promise<{ providerId: string; stub: Awaited<ReturnType<typeof startBraveStub>> }> {
  await allowLocalhost(harness.app, harness.write());
  const stub = await startBraveStub({ results: options.results ?? 20 });
  const providerId = await createProvider(harness.app, harness.write(), {
    name: "single-brave",
    type: "brave",
    baseUrl: stub.base,
    resultsPerPage: 20,
    ...(options.searchConfig ? { searchConfig: options.searchConfig } : {}),
  });
  await addKey(harness.app, harness.write(), providerId, PLAINTEXT_KEY);
  return { providerId, stub };
}

async function paidOn(harness: BatchHarness): Promise<void> {
  await harness.app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...harness.write(),
    payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 5, maxRequestsPerDay: 20 } },
  });
}

describe("single provider test", () => {
  /**
   * T01 — one probe path.
   *
   * Two assertions, both mechanical: exactly one health row is written (the
   * endpoint no longer has a side path that skips the log), and no route module
   * constructs a probe config by hand any more. The second is a source scan on
   * purpose — a comment cannot enforce it, and a second implementation would
   * start with exactly that call.
   */
  it("T01 only HealthService.checkOne builds a probe config", async () => {
    const harness = track(await startBatchHarness());
    const { providerId, stub } = await setUpBrave(harness, { results: 3 });
    await paidOn(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);

    const rows = harness.ctx.sqlite
      .prepare("SELECT id, kind, status FROM provider_health_checks WHERE provider_id = ?")
      .all(providerId) as Array<{ id: string; kind: string; status: string }>;
    // Exactly one row: the endpoint delegates to the probe, it does not probe
    // "on the side" as well.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("search");
    expect(stub.hits()).toBeGreaterThanOrEqual(1);

    // No route module may reach for an adapter's search method directly: the
    // probe belongs to the health service.
    const routesDir = join(process.cwd(), "apps", "api", "src", "routes");
    const offenders: string[] = [];
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(routesDir, file), "utf8");
      if (source.includes("adapter.search(")) offenders.push(file);
    }
    expect(offenders, `routes still calling adapter.search: ${offenders.join(", ")}`).toEqual([]);
  });

  /**
   * T02 — the endpoint issues the *production* number of requests.
   *
   * A Brave-shaped stub always returns a full page, `targetResults: 50` and
   * `maxPages: 3`, so the adapter has to page. One request means the endpoint
   * fell back to the single-page path, which is the original bug.
   */
  it("T02 a paginated source test issues more than one upstream request", async () => {
    const harness = track(await startBatchHarness());
    const { providerId, stub } = await setUpBrave(harness, {
      results: 20,
      searchConfig: { targetResults: 50, maxPages: 3 },
    });
    await paidOn(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as TestBody;

    // The wire is the evidence: at least two physical requests really happened.
    expect(stub.hits()).toBeGreaterThanOrEqual(2);
    expect(body.requests).toBeGreaterThanOrEqual(2);
    expect(body.requests).toBe(stub.hits());

    // …and the count is stored, so history can show it after a restart.
    const row = harness.ctx.sqlite
      .prepare("SELECT detail_json FROM provider_health_checks WHERE provider_id = ?")
      .get(providerId) as { detail_json: string };
    const detail = JSON.parse(row.detail_json) as { requests?: number | null };
    expect(detail.requests).toBeGreaterThanOrEqual(2);
  });

  /**
   * T03 — the single test and the scheduled probe agree.
   *
   * Same source, same stub: if the two paths disagree on `resultCount` or on the
   * conclusion, the operator is looking at two different products.
   */
  it("T03 single test equals checkOne for the same source", async () => {
    const harness = track(await startBatchHarness());
    const { providerId, stub } = await setUpBrave(harness, {
      results: 20,
      searchConfig: { targetResults: 40, maxPages: 2 },
    });
    await paidOn(harness);

    const viaEndpoint = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(viaEndpoint.statusCode, viaEndpoint.body).toBe(200);
    const endpointBody = viaEndpoint.json() as TestBody;
    const hitsAfterEndpoint = stub.hits();

    const viaService = await harness.ctx.health.checkOne(providerId, { kind: "search", trigger: "manual" });
    const hitsAfterService = stub.hits() - hitsAfterEndpoint;

    expect(endpointBody.resultCount).toBe(viaService.resultCount);
    expect(endpointBody.cause).toBe(viaService.cause);
    expect(endpointBody.requests).toBe(hitsAfterEndpoint);
    expect(viaService.requests).toBe(hitsAfterService);
    // The two probes are identical, so one request pattern per probe.
    expect(hitsAfterService).toBe(hitsAfterEndpoint);
  });

  /** T04 — additive response shape, unchanged legacy fields, no key material. */
  it("T04 keeps the legacy fields, adds the conclusion fields and leaks no key", async () => {
    const harness = track(await startBatchHarness());
    const { providerId } = await setUpBrave(harness, { results: 3 });
    await paidOn(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as TestBody;

    // The five fields an existing client already reads.
    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.latencyMs).toBe("number");
    expect(typeof body.resultCount).toBe("number");
    expect(typeof body.message).toBe("string");
    expect(Array.isArray(body.sample)).toBe(true);
    expect(body.sample!.length).toBeLessThanOrEqual(3);

    // The fields the new UI needs.
    expect(body.status).toBe("healthy");
    expect(body.cause).toBe("ok");
    expect(body.errorCode).toBeNull();
    expect(typeof body.requests).toBe("number");
    expect(body.kind).toBe("search");
    expect(typeof body.keyId).toBe("string");
    expect(typeof body.checkedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);

    // No credential may appear, in any form the response could carry it.
    expect(response.body).not.toContain(PLAINTEXT_KEY);
    expect(response.body).not.toContain("sk-SINGLE");
    // The key id is an identifier, not the secret.
    const keyRow = harness.ctx.sqlite
      .prepare("SELECT key_ciphertext FROM api_keys WHERE provider_id = ?")
      .get(providerId) as { key_ciphertext: string };
    expect(response.body).not.toContain(keyRow.key_ciphertext);
  });

  /** `ok` is `cause === "ok"`: an empty answer is not a success. */
  it("reports an empty response as degraded, with ok false", async () => {
    const harness = track(await startBatchHarness());
    const { providerId } = await setUpBrave(harness, { results: 0 });
    await paidOn(harness);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    const body = response.json() as TestBody;
    expect(body.ok).toBe(false);
    expect(body.cause).toBe("empty_results");
    expect(body.status).toBe("degraded");
    expect(body.resultCount).toBe(0);
  });

  /** A missing credential is `unverified`, and `requests` is `null`, not `0`. */
  it("reports a source without a credential as unverified with no request count", async () => {
    const harness = track(await startBatchHarness());
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "single-no-key",
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as TestBody;
    expect(body.ok).toBe(false);
    expect(body.status).toBe("unverified");
    expect(body.cause).toBe("no_credential");
    // `0` would claim the wire was measured and untouched; `null` says unknown.
    expect(body.requests).toBeNull();
  });

  /**
   * A budget refusal must surface as the probe's own error, not as a 500.
   *
   * The old implementation had no budget at all, so this is a behaviour change:
   * the endpoint now respects the paid-probe switch instead of quietly spending.
   */
  it("maps a disabled paid switch to a 400 validation error", async () => {
    const harness = track(await startBatchHarness());
    const { providerId } = await setUpBrave(harness, { results: 2 });

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
    expect(response.json().error.message).toContain("Paid search probes are disabled");
  });

  /** An exhausted budget is a 429 that names the ledger, never a 500. */
  it("maps an exhausted budget to a 429 quota error", async () => {
    const harness = track(await startBatchHarness());
    const { providerId } = await setUpBrave(harness, { results: 2 });
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: { health: { paidProbesEnabled: true, maxRequestsPerRun: 5, maxRequestsPerDay: 1 } },
    });
    // Spend the single allowed probe through the same endpoint.
    const first = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(200);

    const second = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(second.statusCode, second.body).toBe(429);
    expect(second.json().error.code).toBe("quota_exceeded");
  });

  /** An unimplemented provider type keeps its `unsupported` mapping. */
  it("keeps the unsupported mapping for a type with no adapter", async () => {
    const harness = track(await startBatchHarness());
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "single-unimplemented",
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });
    // Rewrite the type to one with no adapter, bypassing the create-time check
    // that would refuse it — this simulates a row left by an older release.
    harness.ctx.sqlite
      .prepare("UPDATE provider_instances SET type = ? WHERE id = ?")
      .run("retired-type-with-no-adapter", providerId);

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/providers/${providerId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(501);
    expect(response.json().error.code).toBe("unsupported");
  });

  /** A missing provider stays a 404 rather than becoming a 500. */
  it("keeps the not-found mapping", async () => {
    const harness = track(await startBatchHarness());
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/providers/prv_does_not_exist/test",
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  /**
   * The key test endpoint stays a *connectivity* probe.
   *
   * Its question is "is this credential accepted", not "does the paginated
   * search path work" — and answering that question must not spend the paid
   * budget.
   */
  it("tests a key as a free connectivity probe", async () => {
    const harness = track(await startBatchHarness());
    const { providerId, stub } = await setUpBrave(harness, { results: 5 });
    const keys = await harness.app.inject({
      method: "GET",
      url: `/api/admin/providers/${providerId}/keys`,
      ...harness.read(),
    });
    const keyId = (keys.json() as Array<{ id: string }>)[0]!.id;

    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/keys/${keyId}/test`,
      ...harness.write(),
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as TestBody;
    expect(body.kind).toBe("connect");
    expect(body.ok).toBe(true);

    const rows = harness.ctx.sqlite
      .prepare("SELECT kind FROM provider_health_checks WHERE provider_id = ?")
      .all(providerId) as Array<{ kind: string }>;
    expect(rows.map((row) => row.kind)).toEqual(["connect"]);
    // A connectivity probe is a single request: paging is a search concern.
    expect(stub.hits()).toBe(1);
  });
});
