import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { addKey, allowLocalhost, closeStubs, createProvider } from "../helpers/vendor-stubs.js";
import { startBatchHarness, type BatchHarness } from "../helpers/batch-harness.js";

type AdapterType = "serpapi" | "searchapi";
type StubMode = "401" | "403" | "429" | "500" | "json-200" | "html-500" | "encoded-401";

interface EchoStub {
  base: string;
  hits(): number;
  seenKeys(): string[];
}

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  await closeStubs();
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

async function echoStub(): Promise<EchoStub> {
  let hits = 0;
  const seenKeys: string[] = [];
  const server: Server = createServer((request, response) => {
    hits += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const mode = url.pathname.split("/")[1] as StubMode;
    const key = url.searchParams.get("api_key") ?? url.searchParams.get("custom_auth") ?? "";
    seenKeys.push(key);
    const status = mode === "json-200"
      ? 200
      : mode === "html-500"
        ? 500
        : mode === "encoded-401"
          ? 401
          : Number(mode);
    const message = mode === "encoded-401"
      ? [
          `literal=${key}`,
          `uri=${encodeURIComponent(key)}`,
          `lower=${encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase())}`,
          `form=${encodeURIComponent(key).replace(/%20/g, "+")}`,
          `double=${encodeURIComponent(encodeURIComponent(key))}`,
        ].join("&")
      : `upstream echoed request ${url.toString()}`;
    if (mode === "html-500") {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(`<html><body><h1>upstream failure</h1><p>${url.toString()}</p></body></html>`);
      return;
    }
    response.writeHead(status, {
      "content-type": "application/json",
      ...(mode === "429" ? { "retry-after": "120" } : {}),
    });
    response.end(JSON.stringify(mode === "json-200" ? { error: message } : { error: { message } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub did not bind");
  return {
    base: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    seenKeys: () => seenKeys,
  };
}

async function setUp(type: AdapterType, mode: StubMode) {
  const harness = await startBatchHarness();
  harnesses.push(harness);
  await allowLocalhost(harness.app, harness.write());
  const stub = await echoStub();
  const secret = `TEST_SECRET_${randomBytes(24).toString("hex")} +/=&`;
  const providerId = await createProvider(harness.app, harness.write(), {
    name: `${type}-${mode}-${randomBytes(4).toString("hex")}`,
    type,
    baseUrl: `${stub.base}/${mode}`,
  });
  await addKey(harness.app, harness.write(), providerId, secret);
  return { harness, stub, secret, providerId };
}

function assertNoSecret(text: string, secret: string): void {
  const encoded = encodeURIComponent(secret);
  const variants = [
    secret,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
    encoded.replace(/%20/g, "+"),
    encodeURIComponent(encoded),
  ];
  for (const variant of variants) {
    expect(text).not.toContain(variant);
    expect(text.toLowerCase()).not.toContain(variant.toLowerCase());
  }
}

describe("query-key redaction S01-S05", () => {
  it.each([
    ["401", "auth_invalid"],
    ["403", "forbidden"],
    ["429", "rate_limited"],
    ["500", "server_error"],
  ] as const)("S01/S05 %s JSON errors keep classification and redact the query key", async (mode, cause) => {
    for (const type of ["serpapi", "searchapi"] as const) {
      const { harness, stub, secret, providerId } = await setUp(type, mode);
      const response = await harness.app.inject({
        method: "POST",
        url: `/api/admin/provider-health/${providerId}/probe`,
        ...harness.write(),
        payload: { kind: "connect" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { result: { cause: string; requests: number | null; message: string } };
      expect(body.result.cause).toBe(cause);
      expect(body.result.requests).toBe(1);
      expect(stub.hits()).toBe(1);
      expect(stub.seenKeys()).toEqual([secret]);
      assertNoSecret(response.body, secret);

      const history = harness.ctx.sqlite
        .prepare("SELECT detail_json, diagnostics_sanitized FROM provider_health_checks WHERE provider_id = ?")
        .get(providerId) as { detail_json: string; diagnostics_sanitized: number };
      expect(history.diagnostics_sanitized).toBe(1);
      assertNoSecret(history.detail_json, secret);
      const key = harness.ctx.sqlite
        .prepare("SELECT last_error_message, last_error_sanitized FROM api_keys WHERE provider_id = ?")
        .get(providerId) as { last_error_message: string | null; last_error_sanitized: number };
      expect(key.last_error_sanitized).toBe(1);
      assertNoSecret(key.last_error_message ?? "", secret);
      const audits = harness.ctx.sqlite
        .prepare("SELECT detail_json FROM audit_logs")
        .all() as Array<{ detail_json: string }>;
      for (const audit of audits) assertNoSecret(audit.detail_json, secret);
    }
  });

  it.each(["serpapi", "searchapi"] as const)("S02 %s HTML errors do not expose the request URL", async (type) => {
    const { harness, secret, providerId } = await setUp(type, "html-500");
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...harness.write(),
      payload: { kind: "connect" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result.cause).toBe("server_error");
    assertNoSecret(response.body, secret);
  });

  it.each(["serpapi", "searchapi"] as const)("S03 %s URL-encoded credentials are redacted", async (type) => {
    const { harness, secret, providerId } = await setUp(type, "encoded-401");
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...harness.write(),
      payload: { kind: "connect" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result.cause).toBe("auth_invalid");
    assertNoSecret(response.body, secret);
  });

  it("redacts a generic-http credential under a custom query parameter name", async () => {
    const harness = await startBatchHarness();
    harnesses.push(harness);
    await allowLocalhost(harness.app, harness.write());
    const stub = await echoStub();
    const secret = `TEST_SECRET_${randomBytes(24).toString("hex")} +/=&`;
    const providerId = await createProvider(harness.app, harness.write(), {
      name: `generic-custom-${randomBytes(4).toString("hex")}`,
      type: "generic-http",
      baseUrl: stub.base,
      config: {
        path: "/401/search",
        keyInjection: { in: "query", name: "custom_auth" },
        resultsPath: "results",
      },
    });
    await addKey(harness.app, harness.write(), providerId, secret);
    await harness.app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      ...harness.write(),
      payload: { health: { paidProbesEnabled: true } },
    });
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...harness.write(),
      payload: { kind: "search" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(stub.seenKeys()).toEqual([secret]);
    expect(response.json().result.cause).toBe("auth_invalid");
    assertNoSecret(response.body, secret);
  });

  it.each(["serpapi", "searchapi"] as const)("S01 %s vendor error fields in a 200 envelope are redacted", async (type) => {
    const { harness, secret, providerId } = await setUp(type, "json-200");
    const response = await harness.app.inject({
      method: "POST",
      url: `/api/admin/provider-health/${providerId}/probe`,
      ...harness.write(),
      payload: { kind: "connect" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result).toMatchObject({
      cause: "bad_response",
      errorCode: "server_error",
      status: "degraded",
      message: expect.stringContaining("[redacted]"),
    });
    assertNoSecret(response.body, secret);
  });
});
