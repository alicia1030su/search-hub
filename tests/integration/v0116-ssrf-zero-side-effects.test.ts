import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { RetryBudget, runProvider, type ProviderRuntime } from "@search-hub/core";
import { createSafeFetch } from "@search-hub/shared";

describe("BUG-0116-01 SSRF zero side effects", () => {
  it("does not touch the socket, request budget, or key validity for expanded mapped loopback", async () => {
    let hits = 0;
    const server: Server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"web":{"results":[]}}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const releases: Array<{ ok: boolean; notSent?: boolean; code?: string }> = [];
    const lease = {
      keyId: "key_1",
      keyLabel: "stub",
      release: (outcome: { ok: boolean; notSent?: boolean; code?: string }) => releases.push(outcome),
    };
    const runtime: ProviderRuntime = {
      config: {
        id: "prv_stub",
        name: "stub",
        type: "brave",
        baseUrl: "http://expanded-mapped.test",
        timeoutMs: 2_000,
        maxResults: 10,
        language: null,
        freshness: null,
        model: null,
        maxRetries: 0,
        breakerThreshold: 5,
        breakerCooldownMs: 60_000,
        config: {},
      },
      adapter: {
        type: "brave",
        requiresKey: true,
        supportsTest: false,
        search: async (_input, context) => {
          await context.fetch(`http://expanded-mapped.test:${port}/`);
          return { results: [] };
        },
      },
      scheduler: {
        acquireWithReason: async () => ({ lease }),
      } as unknown as ProviderRuntime["scheduler"],
      enabled: true,
      requiresKey: true,
      breaker: { failures: 0, openUntilMs: null },
    };
    let charged = 0;
    try {
      const result = await runProvider(runtime, {
        query: "q",
        limitPerProvider: 1,
        deadlineMs: 5_000,
        retryBudget: new RetryBudget(0),
        signal: new AbortController().signal,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        fetch: createSafeFetch({
          policy: { allowPrivateHosts: [], maxRedirects: 0, allowHttp: true },
          timeoutMs: 2_000,
          resolveHost: async () => [{ address: "0:0:0:0:0:ffff:127.0.0.1", family: 6 }],
        }),
        credentials: { getKeyValue: async () => "stub-token-value-1234" },
        beforeRequest: () => {
          charged += 1;
        },
      });

      expect(result.ok).toBe(false);
      expect(hits).toBe(0);
      expect(charged).toBe(0);
      expect(releases).toHaveLength(1);
      expect(releases[0]).toMatchObject({ ok: false, notSent: true });
      expect(releases[0]?.code).not.toBe("auth_invalid");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
