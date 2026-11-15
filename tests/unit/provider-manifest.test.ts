import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type ProviderContext, type ProviderRuntimeConfig, type SafeFetch } from "@search-hub/shared";
import {
  braveAdapter,
  buildManifest,
  getCatalogEntry,
  planPagination,
  resolveSearchConfig,
  validateSearchConfig,
  PROVIDER_CATALOG,
  type PaginationPlan,
} from "@search-hub/providers";

/**
 * Regression tests for the v0.1.4 marketplace/manifest round.
 *
 * Focus: manifests describe real vendor limits, unsupported parameters are
 * rejected instead of ignored, and a 50-row target actually pages.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 0, allowHttp: true },
});

function ctxFor(
  type: string,
  baseUrl: string,
  config: Record<string, unknown> = {},
  search?: ProviderRuntimeConfig["search"],
): ProviderContext {
  const runtime: ProviderRuntimeConfig = {
    id: `prv_${type}`,
    name: type,
    type,
    baseUrl,
    timeoutMs: 5000,
    maxResults: 50,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config,
    ...(search === undefined ? {} : { search }),
  };
  return {
    fetch: allowLocalFetch,
    apiKey: "test-key",
    config: runtime,
    signal: AbortSignal.timeout(5000),
    logger: console as never,
  };
}

describe("provider manifest", () => {
  it("every builtin catalog entry produces a coherent manifest", () => {
    for (const entry of PROVIDER_CATALOG) {
      const manifest = buildManifest(entry);
      expect(manifest.providerId).toBe(entry.type);
      expect(manifest.manifestVersion).toBe(1);
      expect(manifest.capability).toBe(entry.capability ?? "raw_search");
      expect(manifest.implementationStatus).toBe(entry.implementation);
      expect(manifest.verificationStatus).toBe(entry.verification);
      // Parameters must be a set: duplicates would confuse validation.
      expect(new Set(manifest.parameters.supported).size).toBe(manifest.parameters.supported.length);
      // Baseline parameters are always present.
      expect(manifest.parameters.supported).toContain("targetResults");
      if (manifest.pagination.supported) {
        expect(manifest.pagination.pageSize).toBeGreaterThan(0);
        expect(manifest.parameters.limits.targetResults?.pageSize).toBe(manifest.pagination.pageSize);
      }
    }
  });

  it("declares pagination exactly where the vendor allows it", () => {
    const brave = buildManifest(getCatalogEntry("brave")!);
    expect(brave.pagination).toMatchObject({ supported: true, mode: "offset", pageSize: 20, maxPages: 10 });

    // Exa's /search has no offset parameter.
    const exa = buildManifest(getCatalogEntry("exa")!);
    expect(exa.pagination.supported).toBe(false);

    const firecrawl = buildManifest(getCatalogEntry("firecrawl")!);
    expect(firecrawl.pagination.supported).toBe(false);
  });

  it("marks whether a vendor bills per account or per key", () => {
    const exa = buildManifest(getCatalogEntry("exa")!);
    expect(exa.accountQuota.scope).toBe("account");
    expect(exa.accountQuota.sharedAcrossKeys).toBe(true);

    const arxiv = buildManifest(getCatalogEntry("arxiv")!);
    expect(arxiv.accountQuota.scope).toBe("none");
  });

  it("rejects parameters the vendor does not support", () => {
    const manifest = buildManifest(getCatalogEntry("exa")!);
    // Exa has no pagination, so maxPages must be refused.
    expect(validateSearchConfig(manifest, { maxPages: 3 })).toEqual([
      expect.stringContaining("does not support pagination"),
    ]);
    // targetResults above the vendor cap is refused instead of silently clamped.
    expect(validateSearchConfig(manifest, { targetResults: 500 })).toEqual([
      expect.stringContaining("at most 100"),
    ]);
    expect(validateSearchConfig(manifest, { targetResults: 20 })).toEqual([]);
  });

  it("accepts pagination for a paginated provider and enforces its page cap", () => {
    const manifest = buildManifest(getCatalogEntry("brave")!);
    expect(validateSearchConfig(manifest, { targetResults: 50, maxPages: 3 })).toEqual([]);
    expect(validateSearchConfig(manifest, { maxPages: 99 })).toEqual([
      expect.stringContaining("at most 10 pages"),
    ]);
  });
});

describe("pagination planning", () => {
  const brave = buildManifest(getCatalogEntry("brave")!);

  it("plans 3 requests for a 50-row target with a 20-row page", () => {
    const plan = planPagination(brave, { targetResults: 50 });
    expect(plan).toMatchObject({ requests: 3, pageSize: 20, expectedRows: 50 });
  });

  it("respects an explicit request budget below what is needed", () => {
    const plan = planPagination(brave, { targetResults: 50, maxRequestsPerSearch: 2 });
    expect(plan.requests).toBe(2);
    // It must not pretend the budget can produce 50 rows.
    expect(plan.expectedRows).toBe(40);
  });

  it("never plans more than the vendor page cap", () => {
    const plan = planPagination(brave, { targetResults: 200, maxPages: 40, maxRequestsPerSearch: 40 });
    expect(plan.requests).toBe(10);
  });

  it("uses a single request for a non-paginated provider", () => {
    const exa = buildManifest(getCatalogEntry("exa")!);
    expect(planPagination(exa, { targetResults: 80 })).toMatchObject({ requests: 1, expectedRows: 80 });
  });
});

describe("search config precedence", () => {
  const brave = buildManifest(getCatalogEntry("brave")!);

  it("lets a request override an unlocked instance value", () => {
    const resolved = resolveSearchConfig(brave, { targetResults: 20 }, { targetResults: 50 });
    expect(resolved.targetResults).toBe(50);
    expect(resolved.maxPages).toBe(3);
  });

  it("ignores the request override when the admin locked the instance", () => {
    const resolved = resolveSearchConfig(brave, { targetResults: 20, locked: true }, { targetResults: 50 });
    expect(resolved.targetResults).toBe(20);
  });

  it("clamps to the vendor maximum instead of trusting the input", () => {
    const resolved = resolveSearchConfig(brave, { targetResults: 9999 });
    expect(resolved.targetResults).toBe(200);
  });

  it("normalises domain lists and drops schemes/paths", () => {
    const resolved = resolveSearchConfig(brave, {
      includeDomains: "https://a.example/path, b.example",
    });
    expect(resolved.includeDomains).toEqual(["a.example", "b.example"]);
  });

  it("carries safeSearch / region / sort through when declared", () => {
    const resolved = resolveSearchConfig(brave, {
      safeSearch: "strict",
      region: "us",
      sort: "relevance",
    });
    expect(resolved).toMatchObject({ safeSearch: "strict", region: "us", sort: "relevance" });
  });
});

describe("brave pagination against a fake vendor", () => {
  it("fetches 3 pages for a 50-row target and reports 50 rows", async () => {
    const requests: number[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const count = Number(url.searchParams.get("count") ?? "20");
      requests.push(offset);
      const items = Array.from({ length: count }).map((_, index) => ({
        title: `Result ${offset * 20 + index}`,
        url: `https://example.com/${offset}-${index}`,
        description: "snippet",
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ web: { results: items } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const ctx = ctxFor("brave", `http://127.0.0.1:${port}`, {}, {
      targetResults: 50,
      maxPages: 3,
      maxRequestsPerSearch: 3,
      pageSize: 20,
    });
    const output = await braveAdapter.search({ query: "x", limit: 50, signal: ctx.signal }, ctx);

    expect(requests).toEqual([0, 1, 2]);
    expect(output.results).toHaveLength(50);
    expect(output.warnings).toBeUndefined();
  });

  it("stops early and reports the real count when the vendor runs out", async () => {
    const requests: number[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      requests.push(offset);
      // Only 12 rows exist in total, so page 0 is already short.
      const items = offset === 0
        ? Array.from({ length: 12 }).map((_, index) => ({
            title: `R${index}`,
            url: `https://example.com/r${index}`,
            description: "s",
          }))
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ web: { results: items } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const ctx = ctxFor("brave", `http://127.0.0.1:${port}`, {}, {
      targetResults: 50,
      maxPages: 3,
      maxRequestsPerSearch: 3,
      pageSize: 20,
    });
    const output = await braveAdapter.search({ query: "x", limit: 50, signal: ctx.signal }, ctx);

    // One request only: a short page means the vendor has nothing more.
    expect(requests).toEqual([0]);
    expect(output.results).toHaveLength(12);
    expect(output.warnings?.[0]).toContain("returned 12 of 50");
  });

  it("never exceeds the request budget", async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls += 1;
      const items = Array.from({ length: 20 }).map((_, index) => ({
        title: `R${calls}-${index}`,
        url: `https://example.com/${calls}-${index}`,
        description: "s",
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ web: { results: items } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const ctx = ctxFor("brave", `http://127.0.0.1:${port}`, {}, {
      targetResults: 60,
      maxPages: 1,
      maxRequestsPerSearch: 1,
      pageSize: 20,
    });
    const output = await braveAdapter.search({ query: "x", limit: 60, signal: ctx.signal }, ctx);
    expect(calls).toBe(1);
    expect(output.results).toHaveLength(20);
  });
});

describe("the plan type stays honest", () => {
  it("expectedRows never exceeds target or budget", () => {
    const brave = buildManifest(getCatalogEntry("brave")!);
    const plans: PaginationPlan[] = [
      planPagination(brave, { targetResults: 5 }),
      planPagination(brave, { targetResults: 50, maxRequestsPerSearch: 1 }),
      planPagination(brave, { targetResults: 200, maxPages: 2 }),
    ];
    for (const plan of plans) {
      expect(plan.expectedRows).toBeLessThanOrEqual(plan.requests * plan.pageSize);
    }
  });
});
