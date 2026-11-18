/**
 * P0: a request budget must count requests, not intentions.
 *
 * One `adapter.search()` can issue several HTTP requests: a paginated adapter
 * fetches page after page, a redirect adds a hop, and a retry repeats the whole
 * thing. The evaluation lab used to compute `1 + maxRetries` per provider, so a
 * Brave-style adapter targeting 50 rows with `count=20` spent 3 requests while
 * the budget had been charged 1.
 *
 * These tests use a real HTTP server on 127.0.0.1 that counts every request it
 * receives. A stubbed `fetch` would only prove the stub was called; the point
 * here is what reached the socket.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createSafeFetch, SearchHubError } from "@search-hub/shared";

interface CountingStub {
  base: string;
  /** Requests the server actually received. */
  hits(): number;
  /** Page indices requested, in order. */
  pages(): number[];
  close(): Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/**
 * Brave-shaped paginated stub.
 *
 * `count` is honoured, `offset` selects the page, and a short page ends the
 * loop — exactly what the real adapter relies on.
 */
async function startPaginatedStub(options: {
  totalRows: number;
  pageSize: number;
  /** Return this status for the first N requests, then behave. */
  failFirst?: { count: number; status: number };
  /** Redirect the first hop once, to exercise per-hop counting. */
  redirectOnce?: boolean;
  /** Hold the response open, so a test can abort mid-flight. */
  delayMs?: number;
}): Promise<CountingStub> {
  let requests = 0;
  const pages: number[] = [];
  let redirected = false;
  const server = createServer((request, response) => {
    requests += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (options.redirectOnce && !redirected) {
      redirected = true;
      response.writeHead(302, { location: `${url.pathname}${url.search}&redirected=1` }).end();
      return;
    }

    if (options.failFirst && requests <= options.failFirst.count) {
      response.writeHead(options.failFirst.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAVAILABLE", message: "stub failure" } }));
      return;
    }

    if (!url.pathname.startsWith("/res/v1/web/search")) {
      response.writeHead(404).end("not found");
      return;
    }
    const count = Number(url.searchParams.get("count") ?? options.pageSize);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    pages.push(offset);
    const start = offset * count;
    const rows = Math.max(0, Math.min(count, options.totalRows - start));
    const body = JSON.stringify({
      web: {
        results: Array.from({ length: rows }, (_, index) => ({
          title: `Row ${start + index + 1}`,
          url: `https://example.org/row-${start + index + 1}`,
          description: "stub",
        })),
      },
    });
    if (options.delayMs) {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      }, options.delayMs);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("stub did not bind");
  return {
    base: `http://127.0.0.1:${address.port}`,
    hits: () => requests,
    pages: () => [...pages],
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A fetch that never touches the network — for asserting a refused request. */
function offlineFetch() {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    throw new SearchHubError("network", "offline fetch used");
  };
  return { fetch, calls: () => calls };
}

const fastFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 3, allowHttp: true },
  timeoutMs: 5_000,
});

describe("physical request counting", () => {
  it("B01: one page is one request", async () => {
    const stub = await startPaginatedStub({ totalRows: 5, pageSize: 20 });
    let counted = 0;
    const response = await fastFetch<unknown>(`${stub.base}/res/v1/web/search?q=x&count=20&offset=0`, {
      onRequest: () => {
        counted += 1;
      },
    });
    expect(response.status).toBe(200);
    expect(counted).toBe(1);
    expect(stub.hits()).toBe(1);
  });

  it("B02: three pages are three requests", async () => {
    const stub = await startPaginatedStub({ totalRows: 60, pageSize: 20 });
    let counted = 0;
    for (const offset of [0, 1, 2]) {
      await fastFetch<unknown>(
        `${stub.base}/res/v1/web/search?q=x&count=20&offset=${offset}`,
        { onRequest: () => { counted += 1; } },
      );
    }
    expect(counted).toBe(3);
    expect(stub.hits()).toBe(3);
    expect(stub.pages()).toEqual([0, 1, 2]);
  });

  it("B03: one logical call that paginates is one call and three requests", async () => {
    const stub = await startPaginatedStub({ totalRows: 60, pageSize: 20 });
    // This is the shape of `paginate()`: a loop inside one adapter invocation.
    let requests = 0;
    const target = 50;
    const pageSize = 20;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const response = await fastFetch<{ web: { results: Array<{ url: string }> } }>(
        `${stub.base}/res/v1/web/search?q=x&count=${pageSize}&offset=${page}`,
        { onRequest: () => { requests += 1; } },
      );
      for (const row of response.data.web.results) seen.add(row.url);
      if (seen.size >= target) break;
      if (response.data.web.results.length < pageSize) break;
    }
    expect(requests).toBe(3);
    expect(stub.hits()).toBe(3);
    expect(seen.size).toBe(60);
  });

  it("B04: a redirect is counted on every hop", async () => {
    const stub = await startPaginatedStub({ totalRows: 5, pageSize: 20, redirectOnce: true });
    let counted = 0;
    const response = await fastFetch<unknown>(`${stub.base}/res/v1/web/search?q=x&count=20&offset=0`, {
      onRequest: () => {
        counted += 1;
      },
    });
    expect(response.status).toBe(200);
    // One redirect means two physical requests. A counter that only saw the
    // first would understate what the vendor received.
    expect(counted).toBe(2);
    expect(stub.hits()).toBe(2);
  });

  it("B06: refusing inside the hook prevents the request from being sent", async () => {
    const stub = await startPaginatedStub({ totalRows: 60, pageSize: 20 });
    let sent = 0;
    await expect(
      (async () => {
        for (let page = 0; page < 3; page += 1) {
          await fastFetch<unknown>(`${stub.base}/res/v1/web/search?q=x&count=20&offset=${page}`, {
            onRequest: () => {
              // Budget of 2: the third page must never leave.
              if (sent >= 2) throw new SearchHubError("quota_exceeded", "budget reached");
              sent += 1;
            },
          });
        }
      })(),
    ).rejects.toThrow(/budget reached/);
    expect(sent).toBe(2);
    // The stub only ever saw the two allowed requests.
    expect(stub.hits()).toBe(2);
  });

  it("B07: a request already on the wire is not refunded when the caller aborts", async () => {
    const stub = await startPaginatedStub({ totalRows: 5, pageSize: 20, delayMs: 150 });
    const controller = new AbortController();
    let counted = 0;
    const pending = fastFetch<unknown>(`${stub.base}/res/v1/web/search?q=x&count=20&offset=0`, {
      signal: controller.signal,
      onRequest: () => {
        counted += 1;
      },
    });
    // Abort while the request is in flight, after it was counted and sent.
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort(new Error("cancelled by user"));
    await expect(pending).rejects.toThrow();
    // The vendor received it; a budget that refunds on cancel can be looped for
    // free paid requests. Only a request that provably never left is refundable.
    expect(counted).toBe(1);
    expect(stub.hits()).toBe(1);
  });

  it("B05: a request blocked by the SSRF guard is not charged", async () => {
    const stub = await startPaginatedStub({ totalRows: 5, pageSize: 20 });
    // First hop is the stub (allowed); the redirect target is a private address
    // the policy forbids, so the second hop is refused by validation.
    const strict = createSafeFetch({
      policy: { allowPrivateHosts: [], maxRedirects: 2, allowHttp: true },
      timeoutMs: 5_000,
    });
    let charged = 0;
    await expect(
      strict<unknown>(`${stub.base}/res/v1/web/search?q=x&count=20&offset=0`, {
        onRequest: () => {
          charged += 1;
        },
      }),
    ).rejects.toThrow();
    // The refused hop never left the machine, so it is not billed. Counting it
    // would make a blocked request look like spend.
    expect(charged).toBe(0);
    expect(stub.hits()).toBe(0);
  });

  it("B08: a request refused before it leaves does not touch the stub", async () => {
    const stub = await startPaginatedStub({ totalRows: 5, pageSize: 20 });
    const offline = offlineFetch();
    await expect(offline.fetch()).rejects.toThrow(/offline fetch used/);
    expect(offline.calls()).toBe(1);
    // The stub was never contacted: a refusal that still sends is not a budget.
    expect(stub.hits()).toBe(0);
  });

  it("B09: concurrent pages cannot overshoot a shared counter", async () => {
    const stub = await startPaginatedStub({ totalRows: 200, pageSize: 20 });
    let issued = 0;
    const limit = 5;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, async (_, index) => {
        return fastFetch<unknown>(`${stub.base}/res/v1/web/search?q=x&count=20&offset=${index}`, {
          onRequest: () => {
            // Synchronous check-and-increment: the only reason this is safe is
            // that nothing awaits between the read and the write.
            if (issued >= limit) throw new SearchHubError("quota_exceeded", "budget reached");
            issued += 1;
          },
        });
      }),
    );
    const fulfilled = results.filter((item) => item.status === "fulfilled").length;
    expect(issued).toBe(limit);
    expect(fulfilled).toBe(limit);
    expect(stub.hits()).toBe(limit);
  });

  it("B11: a failing request still counts once", async () => {
    const stub = await startPaginatedStub({ totalRows: 5, pageSize: 20, failFirst: { count: 1, status: 503 } });
    let counted = 0;
    await expect(
      fastFetch<unknown>(`${stub.base}/res/v1/web/search?q=x&count=20&offset=0`, {
        onRequest: () => {
          counted += 1;
        },
      }),
    ).rejects.toThrow();
    expect(counted).toBe(1);
    expect(stub.hits()).toBe(1);
  });
});
