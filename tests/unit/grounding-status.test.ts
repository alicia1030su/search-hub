import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSafeFetch, type ProviderContext, type ProviderRuntimeConfig, type SafeFetch } from "@search-hub/shared";
import { AccountQuotaRegistry, KeyScheduler, type SchedulerKeySeed } from "@search-hub/core";
import { geminiAdapter, parseSearchEntryPoint, stepfunAdapter } from "@search-hub/providers";

/**
 * Regression tests for the v0.1.4 review round:
 *  - Google grounding display metadata and safe HTML handling,
 *  - groundingSupports index mapping,
 *  - StepFun rank attribution (rank is not a source),
 *  - account-level quota shared by several keys.
 */

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const allowLocalFetch: SafeFetch = createSafeFetch({
  policy: { allowPrivateHosts: ["127.0.0.1"], maxRedirects: 0, allowHttp: true },
});

async function startServer(body: unknown): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function geminiCtx(baseUrl: string): ProviderContext {
  const config: ProviderRuntimeConfig = {
    id: "prv_gemini",
    name: "gemini",
    type: "gemini",
    baseUrl,
    timeoutMs: 5000,
    maxResults: 10,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config: { model: "gemini-3.8-flash" },
  };
  return {
    fetch: allowLocalFetch,
    apiKey: "key",
    config,
    signal: AbortSignal.timeout(5000),
    logger: console as never,
  };
}

describe("Gemini grounding display", () => {
  it("keeps search queries, supports and chunk order; HTML is withheld", async () => {
    const html =
      '<div class="gs"><a href="https://www.google.com/search?q=euro+2024">Euro 2024 winner</a>' +
      "<script>alert('xss')</script></div>";
    const baseUrl = await startServer({
      candidates: [
        {
          content: { parts: [{ text: "Spain won Euro 2024." }] },
          groundingMetadata: {
            webSearchQueries: ["UEFA Euro 2024 winner", "who won euro 2024"],
            searchEntryPoint: { renderedContent: html },
            groundingChunks: [
              { web: { uri: "https://vertexaisearch.cloud.google.com/1", title: "aljazeera.com" } },
              { web: { uri: "https://vertexaisearch.cloud.google.com/2", title: "uefa.com" } },
            ],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: 20 }, groundingChunkIndices: [0, 1] },
            ],
          },
        },
      ],
    });
    const output = await geminiAdapter.search({ query: "who won euro 2024", limit: 5, signal: AbortSignal.timeout(5000) }, geminiCtx(baseUrl));
    const answer = output.answer!;

    expect(answer.searchQueries).toEqual(["UEFA Euro 2024 winner", "who won euro 2024"]);
    // Both chunks kept in vendor order so support indices stay correct.
    expect(answer.citations).toHaveLength(2);
    expect(answer.citations[0]!.providerIndex).toBe(1);
    expect(answer.supports).toEqual([{ startIndex: 0, endIndex: 20, chunkIndices: [0, 1] }]);
    // No vendor HTML in the payload; only plain suggestion data.
    expect(JSON.stringify(answer)).not.toContain("<script");
    expect(answer.display?.vendorHtmlWithheld).toBe(true);
    expect(answer.display?.suggestions[0]).toEqual({
      label: "Euro 2024 winner",
      url: "https://www.google.com/search?q=euro+2024",
    });
    expect(answer.status).toMatchObject({
      toolProvided: true,
      toolInvoked: true,
      retrievalSucceeded: true,
      hasVerifiableSources: true,
      answerSupported: true,
    });
    expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("drops out-of-range support indices instead of highlighting the wrong text", async () => {
    const baseUrl = await startServer({
      candidates: [
        {
          content: { parts: [{ text: "Answer text." }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://a.example/1", title: "a" } }],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] },
              // Index 9 does not exist: must be discarded, not clamped.
              { segment: { startIndex: 6, endIndex: 9 }, groundingChunkIndices: [9] },
            ],
          },
        },
      ],
    });
    const output = await geminiAdapter.search({ query: "x", limit: 5, signal: AbortSignal.timeout(5000) }, geminiCtx(baseUrl));
    expect(output.answer!.supports).toEqual([{ startIndex: 0, endIndex: 5, chunkIndices: [0] }]);
  });

  it("keeps a grounding report with zero chunks as invoked-but-no-source", async () => {
    const baseUrl = await startServer({
      candidates: [
        {
          content: { parts: [{ text: "Answer." }] },
          groundingMetadata: { webSearchQueries: ["q"], groundingChunks: [] },
        },
      ],
    });
    const output = await geminiAdapter.search({ query: "x", limit: 5, signal: AbortSignal.timeout(5000) }, geminiCtx(baseUrl));
    expect(output.answer!.status.toolInvoked).toBe(true);
    expect(output.answer!.status.hasVerifiableSources).toBe(false);
    expect(output.warnings?.[0]).toContain("no verifiable citation");
  });
});

describe("searchEntryPoint sanitisation", () => {
  it("never returns markup, event handlers or javascript: URLs", () => {
    const display = parseSearchEntryPoint(
      '<div onclick="steal()"><a href="javascript:alert(1)">bad</a>' +
        '<a href="https://ok.example/x">good</a><img src=x onerror=alert(1)></div>',
    )!;
    expect(display.vendorHtmlWithheld).toBe(true);
    expect(display.suggestions).toEqual([{ label: "good", url: "https://ok.example/x" }]);
    expect(JSON.stringify(display)).not.toContain("onclick");
    expect(JSON.stringify(display)).not.toContain("javascript:");
    expect(JSON.stringify(display)).not.toContain("<img");
  });

  it("returns undefined for empty or non-string content", () => {
    expect(parseSearchEntryPoint(undefined)).toBeUndefined();
    expect(parseSearchEntryPoint("")).toBeUndefined();
    expect(parseSearchEntryPoint({ html: "<b>x</b>" })).toBeUndefined();
  });
});

describe("StepFun attribution", () => {
  it("stores position as upstreamRank and never as a provider name", async () => {
    const baseUrl = await startServer({
      results: [
        { url: "https://a.example/1", position: 1, title: "A", time: "2026-03-22T00:00:00Z", snippet: "a" },
        { url: "https://b.example/2", position: 2, title: "B", snippet: "b" },
      ],
    });
    const config: ProviderRuntimeConfig = {
      id: "prv_stepfun",
      name: "stepfun",
      type: "stepfun",
      baseUrl,
      timeoutMs: 5000,
      maxResults: 10,
      language: null,
      freshness: null,
      model: null,
      maxRetries: 0,
      breakerThreshold: 3,
      breakerCooldownMs: 30_000,
      config: {},
    };
    const ctx: ProviderContext = {
      fetch: allowLocalFetch,
      apiKey: "key",
      config,
      signal: AbortSignal.timeout(5000),
      logger: console as never,
    };
    const output = await stepfunAdapter.search({ query: "x", limit: 5, signal: ctx.signal }, ctx);
    expect(output.results[0]!.upstreamRank).toBe(1);
    expect(output.results[1]!.upstreamRank).toBe(2);
    // The bug being fixed: rank leaking into providerName.
    expect(output.results[0]!.upstream).toBeUndefined();
    expect(JSON.stringify(output.results)).not.toContain("rank 1");
  });
});

function seed(id: string): SchedulerKeySeed {
  return {
    id,
    label: id,
    maskedKey: `…${id}`,
    weight: 10,
    enabled: true,
    status: "healthy",
  };
}

describe("account-level quota group", () => {
  it("two keys in one account share one RPM budget", () => {
    const registry = new AccountQuotaRegistry();
    const limits = { rpmLimit: 2, dailyQuota: null };
    const a = new KeyScheduler({
      providerId: "p1",
      strategy: "round_robin",
      perKeyConcurrency: 5,
      rpmLimit: 100,
      dailyQuota: null,
      cooldownMs: 1000,
      breakerThreshold: 3,
      keys: [seed("k1")],
      accountGroup: "acct-1",
      accountLimits: limits,
      registry,
    });
    const b = new KeyScheduler({
      providerId: "p2",
      strategy: "round_robin",
      perKeyConcurrency: 5,
      rpmLimit: 100,
      dailyQuota: null,
      cooldownMs: 1000,
      breakerThreshold: 3,
      keys: [seed("k2")],
      accountGroup: "acct-1",
      accountLimits: limits,
      registry,
    });

    const now = Date.UTC(2026, 10, 15, 3, 0, 0);
    const l1 = a.tryAcquire(now);
    const l2 = b.tryAcquire(now);
    expect(l1).not.toBeNull();
    expect(l2).not.toBeNull();
    // Third request through either scheduler must be refused: the account, not
    // the key, is the limit.
    expect(a.tryAcquire(now)).toBeNull();
    expect(b.tryAcquire(now)).toBeNull();
    expect(a.accountSnapshot(now)).toMatchObject({ rpmUsed: 2, rpmLimit: 2 });
    l1!.release({ ok: true, latencyMs: 10 });
    l2!.release({ ok: true, latencyMs: 10 });
  });

  it("different account groups do not share a budget", () => {
    const registry = new AccountQuotaRegistry();
    const limits = { rpmLimit: 1, dailyQuota: null };
    const build = (group: string) =>
      new KeyScheduler({
        providerId: group,
        strategy: "round_robin",
        perKeyConcurrency: 2,
        rpmLimit: 100,
        dailyQuota: null,
        cooldownMs: 1000,
        breakerThreshold: 3,
        keys: [seed(`${group}-k`)],
        accountGroup: group,
        accountLimits: limits,
        registry,
      });
    const now = Date.UTC(2026, 10, 15, 3, 0, 0);
    const a = build("acct-a");
    const b = build("acct-b");
    expect(a.tryAcquire(now)).not.toBeNull();
    expect(b.tryAcquire(now)).not.toBeNull();
  });

  it("refunds the account slot when no key is available", () => {
    const registry = new AccountQuotaRegistry();
    const limits = { rpmLimit: 2, dailyQuota: null };
    const scheduler = new KeyScheduler({
      providerId: "p1",
      strategy: "round_robin",
      perKeyConcurrency: 1,
      rpmLimit: 100,
      dailyQuota: null,
      cooldownMs: 1000,
      breakerThreshold: 3,
      keys: [],
      accountGroup: "acct-refund",
      accountLimits: limits,
      registry,
    });
    const now = Date.UTC(2026, 10, 15, 3, 0, 0);
    expect(scheduler.tryAcquire(now)).toBeNull();
    // The reservation must be returned: no request was made.
    expect(registry.snapshot("acct-refund", now)?.rpmUsed).toBe(0);
  });

  it("zero RPM with a daily quota enforces only the daily budget", () => {
    const registry = new AccountQuotaRegistry();
    const limits = { rpmLimit: 0, dailyQuota: 1 };
    const scheduler = new KeyScheduler({
      providerId: "p1",
      strategy: "round_robin",
      perKeyConcurrency: 5,
      rpmLimit: 100,
      dailyQuota: null,
      cooldownMs: 1000,
      breakerThreshold: 3,
      keys: [seed("k")],
      accountGroup: "acct-daily",
      accountLimits: limits,
      registry,
    });
    const now = Date.UTC(2026, 10, 15, 3, 0, 0);
    expect(scheduler.tryAcquire(now)).not.toBeNull();
    expect(scheduler.tryAcquire(now)).toBeNull();
    expect(scheduler.accountSnapshot(now)).toMatchObject({ quotaUsedToday: 1, dailyQuota: 1 });
  });
});

describe("MCP result mapping keeps attribution separate from rank", () => {
  it("exposes upstream and upstreamRank without inventing a source", async () => {
    const { toToolResult } = await import("@search-hub/mcp");
    const mapped = toToolResult({
      id: "https://a.example/1",
      title: "A",
      url: "https://a.example/1",
      snippet: "a",
      source: "stepfun",
      provider: "prv_1",
      providerType: "stepfun",
      providerName: "StepFun",
      retrievedAt: "2026-11-15T00:00:00.000Z",
      score: 0,
      sources: [],
      upstreamRank: 3,
    } as never);
    expect(mapped).toMatchObject({ upstreamRank: 3, source: "stepfun" });
    expect(mapped).not.toHaveProperty("upstream");
  });
});
