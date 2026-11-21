import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logProviderFailure } from "@search-hub/core";
import type { ProviderErrorCode, SearchResponse } from "@search-hub/shared";
import { addKey, allowLocalhost, createProvider } from "../helpers/vendor-stubs.js";
import { startBatchHarness, type BatchHarness } from "../helpers/batch-harness.js";

type AdapterType = "serpapi" | "searchapi" | "firecrawl";
type KeyVariant =
  | "plaintext"
  | "uri"
  | "lowercase-percent"
  | "query-form"
  | "double-encoded"
  | "mixed-percent";

interface EchoRequest {
  method: string;
  url: string;
  apiKey: string;
  authorization: string;
  echo: string;
}

interface EchoStub {
  base: string;
  requests(): EchoRequest[];
}

const harnesses: BatchHarness[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const harness of harnesses.splice(0).reverse()) await harness.dispose();
});

function mixedPercent(secret: string): string {
  let unsafeIndex = 0;
  return [...secret]
    .map((character) => {
      const encoded = encodeURIComponent(character);
      if (encoded === character) return character;
      const index = unsafeIndex++;
      if (index % 2 === 1) return character;
      return index % 4 === 0 ? encoded.toLowerCase() : encoded;
    })
    .join("");
}

function variants(secret: string): string[] {
  const uri = encodeURIComponent(secret);
  return [
    secret,
    uri,
    uri.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
    uri.replace(/%20/g, "+"),
    encodeURIComponent(uri),
    mixedPercent(secret),
  ];
}

function assertNoSecret(text: string, secret: string): void {
  const folded = text.toLowerCase();
  for (const variant of variants(secret)) {
    expect(folded.includes(variant.toLowerCase()), "surface leaked a provider query-key variant").toBe(false);
  }
}

async function echoStub(variant: KeyVariant, statuses: number[]): Promise<EchoStub> {
  const requests: EchoRequest[] = [];
  const server: Server = createServer((request, response) => {
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, "http://127.0.0.1");
    const apiKey = url.searchParams.get("api_key") ?? "";
    const valueStart = rawUrl.indexOf("api_key=") + "api_key=".length;
    const valueEnd = rawUrl.indexOf("&", valueStart);
    const wireValue = rawUrl.slice(valueStart, valueEnd === -1 ? undefined : valueEnd);
    const replacements: Record<KeyVariant, string> = {
      plaintext: apiKey,
      uri: encodeURIComponent(apiKey),
      "lowercase-percent": encodeURIComponent(apiKey).replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      "query-form": wireValue,
      "double-encoded": encodeURIComponent(encodeURIComponent(apiKey)),
      "mixed-percent": mixedPercent(apiKey),
    };
    const echoedUrl = `${rawUrl.slice(0, valueStart)}${replacements[variant]}${rawUrl.slice(valueStart + wireValue.length)}`;
    const status = statuses[Math.min(requests.length, statuses.length - 1)] ?? 401;
    requests.push({
      method: request.method ?? "",
      url: rawUrl,
      apiKey,
      authorization: String(request.headers.authorization ?? ""),
      echo: echoedUrl,
    });
    response.writeHead(status, {
      "content-type": "application/json",
      ...(status === 429 ? { "retry-after": "1" } : {}),
    });
    response.end(JSON.stringify({ error: { message: `upstream rejected ${echoedUrl}` } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("echo stub did not bind");
  return { base: `http://127.0.0.1:${address.port}`, requests: () => [...requests] };
}

async function firecrawlStub(variant: "plaintext" | "mixed-percent"): Promise<EchoStub> {
  const requests: EchoRequest[] = [];
  const server: Server = createServer((request, response) => {
    request.resume();
    const authorization = String(request.headers.authorization ?? "");
    const apiKey = authorization.replace(/^Bearer\s+/i, "");
    const echo = variant === "plaintext" ? apiKey : mixedPercent(apiKey);
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "/",
      apiKey,
      authorization,
      echo,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, error: `upstream rejected ${echo}` }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Firecrawl stub did not bind");
  return { base: `http://127.0.0.1:${address.port}`, requests: () => [...requests] };
}

async function setUp(
  type: AdapterType,
  variant: KeyVariant,
  options: { statuses?: number[]; maxRetries?: number; secret?: string } = {},
) {
  const harness = await startBatchHarness();
  harnesses.push(harness);
  await allowLocalhost(harness.app, harness.write());
  const stub =
    type === "firecrawl"
      ? await firecrawlStub(variant === "mixed-percent" ? "mixed-percent" : "plaintext")
      : await echoStub(variant, options.statuses ?? [401]);
  const secret = options.secret ?? `TEST_SECRET_${randomBytes(12).toString("hex")} +/=&`;
  const providerId = await createProvider(harness.app, harness.write(), {
    name: `${type}-${variant}-${randomBytes(4).toString("hex")}`,
    type,
    baseUrl: stub.base,
    keyStrategy: "round_robin",
    maxRetries: options.maxRetries ?? 0,
  });
  await addKey(harness.app, harness.write(), providerId, secret);
  await addKey(harness.app, harness.write(), providerId, secret);

  const tokenResponse = await harness.app.inject({
    method: "POST",
    url: "/api/admin/tokens",
    ...harness.write(),
    payload: { name: `${type}-${variant}`, scopes: ["search", "mcp:use"], rateLimitPerMin: 600 },
  });
  expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
  const token = tokenResponse.json().token as string;
  expect(token).toMatch(/^sh_/);
  return { harness, stub, secret, providerId, token };
}

function parseMcp(body: string): Record<string, unknown> {
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(dataLines.at(-1) ?? body) as Record<string, unknown>;
}

interface FailureExpectation {
  code: ProviderErrorCode;
  statusCode: number | null;
  keyStatus: string;
  erroredKeys: number;
}

function assertProviderFailure(
  body: Pick<SearchResponse, "status" | "results" | "errors">,
  providerId: string,
  code: ProviderErrorCode,
): void {
  expect(body.status).toBe("failed");
  expect(body.results).toEqual([]);
  expect(body.errors).toEqual([
    expect.objectContaining({ providerId, code, message: expect.stringContaining("[redacted]") }),
  ]);
}

function assertAuthFailure(
  body: Pick<SearchResponse, "status" | "results" | "errors">,
  providerId: string,
): void {
  assertProviderFailure(body, providerId, "auth_invalid");
}

async function assertPersistedTask(
  harness: BatchHarness,
  taskId: string,
  providerId: string,
  secret: string,
  expected: FailureExpectation,
): Promise<void> {
  const visible = await harness.app.inject({
    method: "GET",
    url: `/api/search/tasks/${taskId}`,
    ...harness.read(),
  });
  expect(visible.statusCode, visible.body).toBe(200);
  expect(visible.json()).toMatchObject({ id: taskId, status: "failed" });
  assertNoSecret(visible.body, secret);

  const row = harness.ctx.sqlite.prepare("SELECT * FROM search_tasks WHERE id = ?").get(taskId) as
    | { status: string; response_json: string; errors_json: string; diagnostics_sanitized: number }
    | undefined;
  expect(row).toBeTruthy();
  expect(row!.status).toBe("failed");
  expect(row!.diagnostics_sanitized).toBe(1);
  const persisted = JSON.parse(row!.response_json) as SearchResponse;
  assertProviderFailure(persisted, providerId, expected.code);
  expect(JSON.parse(row!.errors_json)).toEqual(persisted.errors);
  assertNoSecret(JSON.stringify(row), secret);

  const events = harness.ctx.sqlite
    .prepare("SELECT * FROM search_events WHERE task_id = ?")
    .all(taskId) as Array<Record<string, unknown>>;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    task_id: taskId,
    provider_id: providerId,
    ok: 0,
    status_code: expected.statusCode,
    error_code: expected.code,
    diagnostics_sanitized: 1,
  });
  assertNoSecret(JSON.stringify(events), secret);

  await harness.ctx.providers.flushDirty();
  const keys = harness.ctx.sqlite
    .prepare("SELECT * FROM api_keys WHERE provider_id = ? ORDER BY rowid")
    .all(providerId) as Array<Record<string, unknown>>;
  expect(keys).toHaveLength(2);
  const erroredKeys = keys.filter((key) => key.last_error_code === expected.code);
  expect(erroredKeys).toHaveLength(expected.erroredKeys);
  for (const key of erroredKeys) {
    expect(key.status).toBe(expected.keyStatus);
    expect(key.last_error_sanitized).toBe(1);
    expect(key.last_error_message).toContain("[redacted]");
  }
  assertNoSecret(JSON.stringify(keys), secret);
}

describe.each(["serpapi", "searchapi"] as const)("%s query-key redaction across REST and MCP", (type) => {
  it.each([
    "plaintext",
    "uri",
    "lowercase-percent",
    "query-form",
    "double-encoded",
    "mixed-percent",
  ] as const)("does not expose the %s key through HTTP responses, tasks, events, keys or logs", async (variant) => {
    const { harness, stub, secret, providerId, token } = await setUp(type, variant);
    const logRecords: unknown[] = [];
    vi.spyOn(harness.ctx.logger, "warn").mockImplementation(((...args: unknown[]) => {
      logRecords.push(args);
    }) as typeof harness.ctx.logger.warn);

    const rest = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...harness.write(),
      payload: { query: `rest ${variant}`, mode: "rrf", limit: 5, providers: [providerId], skipCache: true },
    });
    expect(rest.statusCode, rest.body).toBe(503);
    const restBody = rest.json() as SearchResponse;
    assertAuthFailure(restBody, providerId);
    expect(restBody.failedSources).toEqual([{ id: providerId, code: "auth_invalid" }]);
    expect(restBody.stats.providers).toEqual([
      expect.objectContaining({
        providerId,
        ok: false,
        errorCode: "auth_invalid",
        errorMessage: expect.stringContaining("[redacted]"),
        statusCode: 401,
        attempts: 1,
        httpRequests: 1,
      }),
    ]);
    assertNoSecret(rest.body, secret);
    assertNoSecret(JSON.stringify(rest.headers), secret);
    await assertPersistedTask(harness, restBody.taskId, providerId, secret, {
      code: "auth_invalid",
      statusCode: 401,
      keyStatus: "invalid",
      erroredKeys: 1,
    });

    const mcp = await harness.app.inject({
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
        params: { name: "search_web", arguments: { query: `mcp ${variant}`, limit: 5, providers: [providerId] } },
      },
    });
    expect(mcp.statusCode, mcp.body).toBe(200);
    const envelope = parseMcp(mcp.body) as {
      error?: unknown;
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    };
    expect(envelope.error).toBeUndefined();
    expect(envelope.result?.isError).toBe(true);
    expect(envelope.result?.content).toHaveLength(1);
    expect(envelope.result?.content?.[0]?.type).toBe("text");
    const toolBody = JSON.parse(envelope.result!.content![0]!.text) as Pick<
      SearchResponse,
      "taskId" | "status" | "results" | "errors"
    >;
    assertAuthFailure(toolBody, providerId);
    assertNoSecret(mcp.body, secret);
    assertNoSecret(JSON.stringify(mcp.headers), secret);
    await assertPersistedTask(harness, toolBody.taskId, providerId, secret, {
      code: "auth_invalid",
      statusCode: 401,
      keyStatus: "invalid",
      erroredKeys: 2,
    });

    // Search failures are returned rather than thrown, so Fastify's error
    // handler is not involved. Exercise the application's provider-failure log
    // sink with the same sanitized message the search response carries.
    logProviderFailure(harness.ctx.appLogger, providerId, type, "auth_invalid", restBody.errors[0]!.message);
    logProviderFailure(harness.ctx.appLogger, providerId, type, "auth_invalid", toolBody.errors[0]!.message);
    expect(logRecords.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(logRecords)).toContain("[redacted]");
    assertNoSecret(JSON.stringify(logRecords), secret);

    expect(stub.requests()).toHaveLength(2);
    for (const request of stub.requests()) {
      expect(request.method).toBe("GET");
      expect(request.apiKey).toBe(secret);
      expect(request.echo).toContain(variants(secret)[
        ["plaintext", "uri", "lowercase-percent", "query-form", "double-encoded", "mixed-percent"].indexOf(variant)
      ]);
    }
  });
});

it.each(["plaintext", "mixed-percent"] as const)(
  "Firecrawl HTTP 200 success=false envelope does not leak the %s bearer key",
  async (variant) => {
    const { harness, stub, secret, providerId, token } = await setUp("firecrawl", variant);
    const logRecords: unknown[] = [];
    vi.spyOn(harness.ctx.logger, "warn").mockImplementation(((...args: unknown[]) => {
      logRecords.push(args);
    }) as typeof harness.ctx.logger.warn);

    const rest = await harness.app.inject({
      method: "POST",
      url: "/api/search",
      ...harness.write(),
      payload: { query: `firecrawl ${variant}`, mode: "rrf", limit: 5, providers: [providerId], skipCache: true },
    });
    expect(rest.statusCode, rest.body).toBe(503);
    const restBody = rest.json() as SearchResponse;
    assertProviderFailure(restBody, providerId, "bad_request");
    expect(restBody.failedSources).toEqual([{ id: providerId, code: "bad_request" }]);
    expect(restBody.stats.providers).toEqual([
      expect.objectContaining({
        providerId,
        ok: false,
        errorCode: "bad_request",
        errorMessage: expect.stringContaining("[redacted]"),
        attempts: 1,
        httpRequests: 1,
      }),
    ]);
    expect(restBody.stats.providers[0]?.statusCode).toBeUndefined();
    assertNoSecret(rest.body, secret);
    await assertPersistedTask(harness, restBody.taskId, providerId, secret, {
      code: "bad_request",
      statusCode: null,
      keyStatus: "unknown",
      erroredKeys: 1,
    });

    const mcp = await harness.app.inject({
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
        params: { name: "search_web", arguments: { query: `firecrawl mcp ${variant}`, limit: 5, providers: [providerId] } },
      },
    });
    expect(mcp.statusCode, mcp.body).toBe(200);
    const envelope = parseMcp(mcp.body) as {
      error?: unknown;
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    };
    expect(envelope.error).toBeUndefined();
    expect(envelope.result?.isError).toBe(true);
    const toolBody = JSON.parse(envelope.result!.content![0]!.text) as Pick<
      SearchResponse,
      "taskId" | "status" | "results" | "errors"
    >;
    assertProviderFailure(toolBody, providerId, "bad_request");
    assertNoSecret(mcp.body, secret);
    await assertPersistedTask(harness, toolBody.taskId, providerId, secret, {
      code: "bad_request",
      statusCode: null,
      keyStatus: "unknown",
      erroredKeys: 2,
    });

    logProviderFailure(harness.ctx.appLogger, providerId, "firecrawl", "bad_request", restBody.errors[0]!.message);
    logProviderFailure(harness.ctx.appLogger, providerId, "firecrawl", "bad_request", toolBody.errors[0]!.message);
    expect(logRecords.length).toBeGreaterThanOrEqual(2);
    assertNoSecret(JSON.stringify(logRecords), secret);

    expect(stub.requests()).toHaveLength(2);
    for (const request of stub.requests()) {
      expect(request.method).toBe("POST");
      expect(request.authorization).toBe(`Bearer ${secret}`);
      expect(request.echo).toBe(variant === "plaintext" ? secret : mixedPercent(secret));
    }
  },
);

it("redacts an 8192-character mixed bearer key through real HTTP, task, event and key persistence", async () => {
  const secret = `A${" +/=&%".repeat(1365)}B`;
  expect(secret.length).toBe(8192);
  const { harness, stub, providerId } = await setUp("firecrawl", "mixed-percent", { secret });

  const rest = await harness.app.inject({
    method: "POST",
    url: "/api/search",
    ...harness.write(),
    payload: { query: "long key", mode: "rrf", limit: 5, providers: [providerId], skipCache: true },
  });
  expect(rest.statusCode, rest.body).toBe(503);
  const body = rest.json() as SearchResponse;
  assertProviderFailure(body, providerId, "bad_request");
  expect(body.errors[0]?.message).not.toContain("Invalid regular expression");
  assertNoSecret(rest.body, secret);
  await assertPersistedTask(harness, body.taskId, providerId, secret, {
    code: "bad_request",
    statusCode: null,
    keyStatus: "unknown",
    erroredKeys: 1,
  });
  expect(stub.requests()).toHaveLength(1);
  expect(stub.requests()[0]?.authorization).toBe(`Bearer ${secret}`);
  expect(stub.requests()[0]?.echo).toBe(mixedPercent(secret));
}, 20_000);

it("honors Retry-After before retrying, then preserves auth_invalid without leaking the key", async () => {
  const { harness, stub, secret, providerId } = await setUp("serpapi", "uri", {
    statuses: [429, 401],
    maxRetries: 1,
  });
  const started = Date.now();
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/search",
    ...harness.write(),
    payload: { query: "retry after", mode: "rrf", limit: 5, providers: [providerId], skipCache: true },
  });
  const elapsed = Date.now() - started;
  expect(response.statusCode, response.body).toBe(503);
  const body = response.json() as SearchResponse;
  expect(body.status).toBe("failed");
  expect(body.failedSources).toEqual([{ id: providerId, code: "auth_invalid" }]);
  expect(body.errors[0]).toMatchObject({ providerId, code: "auth_invalid" });
  expect(body.stats.providers[0]).toMatchObject({
    providerId,
    ok: false,
    errorCode: "auth_invalid",
    statusCode: 401,
    attempts: 2,
    httpRequests: 2,
  });
  assertNoSecret(response.body, secret);

  expect(stub.requests()).toHaveLength(2);
  expect(stub.requests().map((request) => request.apiKey)).toEqual([secret, secret]);
  expect(elapsed).toBeGreaterThanOrEqual(900);
  expect(elapsed).toBeLessThan(5_000);

  const task = harness.ctx.sqlite.prepare("SELECT * FROM search_tasks WHERE id = ?").get(body.taskId) as
    | { response_json: string; errors_json: string }
    | undefined;
  expect(task).toBeTruthy();
  const persisted = JSON.parse(task!.response_json) as SearchResponse;
  expect(persisted.status).toBe("failed");
  expect(persisted.failedSources).toEqual([{ id: providerId, code: "auth_invalid" }]);
  expect(persisted.errors[0]).toMatchObject({ providerId, code: "auth_invalid" });
  expect(JSON.parse(task!.errors_json)).toEqual(persisted.errors);
  assertNoSecret(JSON.stringify(task), secret);
  const events = harness.ctx.sqlite
    .prepare("SELECT * FROM search_events WHERE task_id = ?")
    .all(body.taskId) as Array<Record<string, unknown>>;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ error_code: "auth_invalid", status_code: 401 });
  assertNoSecret(JSON.stringify(events), secret);

  await harness.ctx.providers.flushDirty();
  const keys = harness.ctx.sqlite
    .prepare("SELECT status, cooldown_until, last_error_code, last_error_message FROM api_keys WHERE provider_id = ? ORDER BY rowid")
    .all(providerId) as Array<Record<string, unknown>>;
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatchObject({ status: "rate_limited", last_error_code: "rate_limited" });
  expect(Date.parse(String(keys[0]!.cooldown_until))).toBeGreaterThanOrEqual(started + 900);
  expect(Date.parse(String(keys[0]!.cooldown_until))).toBeLessThan(started + 2_500);
  expect(keys[1]).toMatchObject({ status: "invalid", last_error_code: "auth_invalid" });
  assertNoSecret(JSON.stringify(keys), secret);
}, 15_000);
