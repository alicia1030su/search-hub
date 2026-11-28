import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;
let csrf: string;

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "stream.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

function parseSse(payload: string): Array<Record<string, unknown>> {
  return payload
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-stream-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email: "admin@example.com", password: "A-very-long-password-1", name: "Admin", setupToken: ctx.setupToken.value! },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  csrf = setup.json().csrfToken as string;
  const provider = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { name: "stream-mock", type: "mock", enabled: true, config: { resultCount: 3, latencyMs: 1, namespace: "stream" } },
  });
  expect(provider.statusCode).toBe(200);
  const settings = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { cache: { enabled: true, ttlSeconds: 3600 } },
  });
  expect(settings.statusCode, settings.body).toBe(200);
});

afterAll(async () => {
  await app.close();
  ctx.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("search stream route", () => {
  it("streams SSE with gap-free sequences and a complete terminal snapshot", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/search/stream",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { query: "stream", mode: "basic", limit: 5, stream: "sse", skipCache: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(response.payload);
    expect(events[0]).toMatchObject({ type: "meta", sequence: 1, final: false });
    expect(events.map((event) => event["sequence"])).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event["type"] === "results")).toBe(true);
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({ type: "done", final: true, status: "completed" });
    expect(terminal["results"]).toBeInstanceOf(Array);
    expect(terminal["stats"]).toBeTypeOf("object");
    expect(terminal["errors"]).toBeInstanceOf(Array);
    expect(terminal["failedSources"]).toBeInstanceOf(Array);
  });

  it("streams NDJSON with one compact JSON object per line", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/search/stream",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { query: "stream", mode: "basic", limit: 5, stream: "ndjson", skipCache: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    const events = response.payload.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ type: "meta", sequence: 1, final: false });
    expect(events.at(-1)).toMatchObject({ type: "done", final: true, status: "completed" });
    expect(events.map((event) => event["sequence"])).toEqual(events.map((_, index) => index + 1));
  });

  it("emits only meta and done for a cache hit", async () => {
    const payload = { query: "cached stream", mode: "basic", limit: 5, stream: "ndjson" };
    const first = await app.inject({
      method: "POST",
      url: "/api/search/stream",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload,
    });
    expect(first.statusCode).toBe(200);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const second = await app.inject({
      method: "POST",
      url: "/api/search/stream",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload,
    });
    expect(second.statusCode).toBe(200);
    const events = second.payload.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event["type"])).toEqual(["meta", "done"]);
    expect(events[1]).toMatchObject({ final: true, cached: true });
  });

  it("validates before opening the stream", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/search/stream",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { query: "", stream: "sse" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
  });
});
