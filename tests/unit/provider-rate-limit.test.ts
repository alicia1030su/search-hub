import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderContext,
  ProviderRuntimeConfig,
  SafeFetch,
  SafeFetchResponse,
} from "@search-hub/shared";
import { arxivAdapter, githubAdapter, wikipediaAdapter, resetProviderRateLimitsForTests } from "@search-hub/providers";

const REPOSITORY_URL = "https://github.com/alicia1030su/search-hub";

function runtimeConfig(
  type: string,
  overrides: Partial<ProviderRuntimeConfig> = {},
): ProviderRuntimeConfig {
  return {
    id: `prv_${type}`,
    name: type,
    type,
    baseUrl: "https://stub.invalid",
    timeoutMs: 5_000,
    maxResults: 50,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config: {},
    ...overrides,
  };
}

function providerContext(
  type: string,
  fetch: SafeFetch,
  overrides: Partial<ProviderRuntimeConfig> = {},
  apiKey?: string,
): ProviderContext {
  return {
    fetch,
    ...(apiKey === undefined ? {} : { apiKey }),
    config: runtimeConfig(type, overrides),
    signal: new AbortController().signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

function response(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): SafeFetchResponse<unknown> {
  return {
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    data,
    url: "https://stub.invalid",
  };
}

function arxivXml(entries = 1): string {
  const rows = Array.from({ length: entries }, (_, index) => `
    <entry>
      <title>Paper ${index + 1}</title>
      <id>https://arxiv.org/abs/${index + 1}</id>
      <summary>Abstract ${index + 1}</summary>
      <published>2026-01-02T00:00:00Z</published>
    </entry>`).join("");
  return `<feed xmlns="http://www.w3.org/2005/Atom">${rows}</feed>`;
}

function wikipediaEmpty(): unknown {
  return { query: { search: [] } };
}

function githubEmpty(): unknown {
  return { items: [] };
}

beforeEach(() => {
  resetProviderRateLimitsForTests();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("public provider rate limits", () => {
  it("serializes arXiv searches at least 3000ms apart with one in-flight request", async () => {
    const starts: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = (async () => {
      starts.push(Date.now());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return response(arxivXml(), 200, { "content-type": "application/atom+xml" });
    }) as SafeFetch;
    const ctx = providerContext("arxiv", fetch);

    const first = arxivAdapter.search({ query: "first", limit: 1, signal: ctx.signal }, ctx);
    const second = arxivAdapter.search({ query: "second", limit: 1, signal: ctx.signal }, ctx);
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(3_000);
    expect(maxInFlight).toBe(1);
  });

  it("sends the full repository URL in Wikipedia's default User-Agent", async () => {
    let userAgent = "";
    const fetch = (async (_url: string, init?: Parameters<SafeFetch>[1]) => {
      userAgent = new Headers(init?.headers).get("user-agent") ?? "";
      return response(wikipediaEmpty());
    }) as SafeFetch;
    const ctx = providerContext("wikipedia", fetch);

    await wikipediaAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx);

    expect(userAgent).toContain(REPOSITORY_URL);
  });

  it("keeps keyless Wikipedia below 60 requests per minute and two in flight", async () => {
    const starts: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = (async () => {
      starts.push(Date.now());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return response(wikipediaEmpty());
    }) as SafeFetch;
    const ctx = providerContext("wikipedia", fetch);

    const pending = Array.from({ length: 65 }, () =>
      wikipediaAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx),
    );
    await vi.runAllTimersAsync();
    await Promise.all(pending);

    expect(starts.filter((startedAt) => startedAt < 60_000)).toHaveLength(60);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("keeps keyless GitHub at or below 10 requests per minute", async () => {
    const starts: number[] = [];
    const fetch = (async () => {
      starts.push(Date.now());
      return response(githubEmpty());
    }) as SafeFetch;
    const ctx = providerContext("github", fetch);

    const pending = Array.from({ length: 12 }, () =>
      githubAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx),
    );
    await vi.runAllTimersAsync();
    await Promise.all(pending);

    expect(starts.filter((startedAt) => startedAt < 60_000)).toHaveLength(10);
  });

  it("keeps keyless GitHub at or below 60 requests per hour", async () => {
    const starts: number[] = [];
    const fetch = (async () => {
      starts.push(Date.now());
      return response(githubEmpty());
    }) as SafeFetch;
    const ctx = providerContext("github", fetch);
    const pending: Array<ReturnType<typeof githubAdapter.search>> = [];

    for (let index = 0; index < 61; index += 1) {
      if (index > 0) await vi.advanceTimersByTimeAsync(59_000);
      pending.push(githubAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx));
    }
    await vi.runAllTimersAsync();
    await Promise.all(pending);

    expect(starts.filter((startedAt) => startedAt < 3_600_000)).toHaveLength(60);
  });

  it("rejects keyless GitHub code search before sending a request", async () => {
    let requests = 0;
    const fetch = (async () => {
      requests += 1;
      return response(githubEmpty());
    }) as SafeFetch;
    const ctx = providerContext("github", fetch, { config: { kind: "code" } });

    await expect(
      githubAdapter.search({ query: "x", limit: 1, signal: ctx.signal }, ctx),
    ).rejects.toThrow(/token|auth|key/i);
    expect(requests).toBe(0);
  });
});
