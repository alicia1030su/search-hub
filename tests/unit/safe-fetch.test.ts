import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetch, type SsrfPolicy } from "../../packages/shared/src/index.js";

let server: Server;
let port = 0;

const policy: SsrfPolicy = {
  allowPrivateHosts: ["127.0.0.1", "localhost"],
  allowHttp: true,
  maxRedirects: 2,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
      return;
    }
    if (req.url === "/redirect-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
      return;
    }
    if (req.url === "/huge") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(4096));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "object" && address) port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("safe-fetch connection guard", () => {
  it("reaches an allowlisted local host through the guarded lookup", async () => {
    // Regression: Node's autoSelectFamily calls lookup({all:true}) and the old
    // callback shape made every real request fail with ERR_INVALID_IP_ADDRESS.
    const safeFetch = createSafeFetch({ policy, timeoutMs: 5_000 });
    const byIp = await safeFetch<{ ok: boolean }>(`http://127.0.0.1:${port}/json`);
    expect(byIp.status).toBe(200);
    expect(byIp.data).toEqual({ ok: true, path: "/json" });
  });

  it("resolves a hostname through the guarded lookup (all:true shape)", async () => {
    // `localhost` resolves to both ::1 and 127.0.0.1 here; the guard must
    // return the array form undici expects instead of a single address.
    const safeFetch = createSafeFetch({
      policy: { allowPrivateHosts: ["localhost"], allowHttp: true, maxRedirects: 2 },
      timeoutMs: 5_000,
    });
    const response = await safeFetch<{ ok: boolean }>(`http://localhost:${port}/json`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true, path: "/json" });
  });

  it("blocks a private destination that is not allowlisted", async () => {
    const safeFetch = createSafeFetch({
      policy: { allowPrivateHosts: [], allowHttp: true, maxRedirects: 2 },
      timeoutMs: 3_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${port}/json`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("validates every redirect hop and refuses cloud metadata", async () => {
    const safeFetch = createSafeFetch({ policy, timeoutMs: 3_000 });
    await expect(safeFetch(`http://127.0.0.1:${port}/redirect-metadata`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("enforces the response size cap", async () => {
    const safeFetch = createSafeFetch({ policy, timeoutMs: 3_000, maxBytes: 512 });
    await expect(safeFetch(`http://127.0.0.1:${port}/huge`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("rejects http when the policy disallows it", async () => {
    const safeFetch = createSafeFetch({
      policy: { allowPrivateHosts: ["127.0.0.1"], allowHttp: false, maxRedirects: 0 },
      timeoutMs: 3_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${port}/json`)).rejects.toMatchObject({
      code: "blocked",
    });
  });
});
