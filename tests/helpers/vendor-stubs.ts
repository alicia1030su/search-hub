import { createServer, type Server } from "node:http";
import { expect } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Local vendor stubs for tests that need a *real* HTTP round trip.
 *
 * Two reasons this exists instead of a stubbed `fetch`:
 *  1. a stubbed fetch proves nothing about the adapter, the SSRF guard or the
 *     socket path — the three places network bugs actually live;
 *  2. the health system's whole job is to observe what a real request does, so a
 *     test that replaces the request can only test the replacement.
 *
 * Nothing here leaves 127.0.0.1 and nothing calls a vendor.
 */

export interface VendorStub {
  /** Base URL to configure on the provider. */
  base: string;
  /** How many requests the stub actually received. */
  hits(): number;
  /** Last request's headers, for asserting what the adapter sent. */
  lastHeaders(): Record<string, string | string[] | undefined>;
  /**
   * Highest number of requests the stub was serving at the same moment.
   *
   * This is the only honest way to measure a concurrency cap: counting *started*
   * requests measures throughput, not simultaneity, and a run that fires twenty
   * requests one after another would look identical.
   */
  peak(): number;
  close(): Promise<void>;
}

const open: Server[] = [];

async function listen(server: Server): Promise<number> {
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("stub did not bind");
  return address.port;
}

/** Closes every stub a test opened. Call from `afterEach`. */
export async function closeStubs(): Promise<void> {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
}

/**
 * Hacker News (Algolia) shape: `{ hits: [...] }`.
 *
 * Keyless, which is exactly why it is useful: it lets a test exercise a real
 * search probe without inventing a credential.
 */
export async function startHnStub(
  options: { hits?: number; delayMs?: number; invalid?: boolean } = {},
): Promise<VendorStub> {
  const count = options.hits ?? 1;
  const delayMs = options.delayMs ?? 0;
  let requests = 0;
  let inFlight = 0;
  let peak = 0;
  let headers: Record<string, string | string[] | undefined> = {};
  const server = createServer((request, response) => {
    requests += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    headers = request.headers;
    const finish = () => {
      inFlight -= 1;
    };
    response.on("close", finish);
    if (!request.url?.startsWith("/api/v1/search")) {
      response.writeHead(404).end("not found");
      return;
    }
    const send = () => {
      if (options.invalid === true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ unexpected: true }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          hits: Array.from({ length: count }, (_, index) => ({
            objectID: String(index + 1),
            title: `Keyless probe result ${index + 1}`,
            url: `https://example.org/keyless-${index + 1}`,
            created_at: "2026-01-01T00:00:00.000Z",
            points: 10,
            author: "stub",
            num_comments: 1,
          })),
          nbHits: count,
        }),
      );
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}`,
    hits: () => requests,
    lastHeaders: () => headers,
    peak: () => peak,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Brave shape: `{ web: { results: [...] } }`.
 *
 * Requires an API key, so it stands for the *credential-backed* class. Budget
 * tests use it because "paid probe" only means something for a provider whose
 * requests are made on the operator's account.
 */
export async function startBraveStub(
  options: { results?: number; delayMs?: number } = {},
): Promise<VendorStub> {
  const count = options.results ?? 2;
  const delayMs = options.delayMs ?? 0;
  let requests = 0;
  let inFlight = 0;
  let peak = 0;
  let headers: Record<string, string | string[] | undefined> = {};
  const server = createServer((request, response) => {
    requests += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    headers = request.headers;
    const finish = () => {
      inFlight -= 1;
    };
    response.on("close", finish);
    if (!request.url?.startsWith("/res/v1/web/search")) {
      response.writeHead(404).end("not found");
      return;
    }
    if (!request.headers["x-subscription-token"]) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "missing token" } }));
      return;
    }
    const send = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          web: {
            results: Array.from({ length: count }, (_, index) => ({
              title: `Brave probe result ${index + 1}`,
              url: `https://example.org/brave-${index + 1}`,
              description: "stub description",
              page_age: "2026-01-01T00:00:00",
              language: "en",
            })),
          },
        }),
      );
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}`,
    hits: () => requests,
    lastHeaders: () => headers,
    peak: () => peak,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Creates a provider through the admin API and asserts it was accepted.
 *
 * Duplicated across suites otherwise, and a silent creation failure turns a
 * budget assertion into a tautology.
 */
export async function createProvider(
  app: FastifyInstance,
  headers: { cookies: Record<string, string>; headers: Record<string, string> },
  payload: Record<string, unknown>,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    ...headers,
    payload: { enabled: true, timeoutMs: 5000, maxRetries: 0, rpmLimit: 6000, ...payload },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().provider.id as string;
}

/** Adds an API key to a provider and asserts it was accepted. */
export async function addKey(
  app: FastifyInstance,
  headers: { cookies: Record<string, string>; headers: Record<string, string> },
  providerId: string,
  key: string,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/providers/${providerId}/keys`,
    ...headers,
    payload: { label: "primary", key, weight: 100, enabled: true },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** Opens the private-host allowlist so a 127.0.0.1 stub is reachable. */
export async function allowLocalhost(
  app: FastifyInstance,
  headers: { cookies: Record<string, string>; headers: Record<string, string> },
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    ...headers,
    payload: { security: { privateHostAllowlist: ["127.0.0.1"] } },
  });
  expect(response.statusCode, response.body).toBe(200);
}
