import { describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  SearchHubError,
  type Logger,
  type ProviderRuntimeConfig,
  type SafeFetch,
  type SafeFetchInit,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import {
  AccountQuotaRegistry,
  KeyScheduler,
  RetryBudget,
  fanoutProviders,
  runProvider,
  type ProviderRuntime,
} from "@search-hub/core";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const config: ProviderRuntimeConfig = {
  id: "provider",
  name: "Provider",
  type: "test",
  baseUrl: "https://example.org",
  timeoutMs: 1_000,
  maxResults: 10,
  language: null,
  freshness: null,
  model: null,
  maxRetries: 0,
  breakerThreshold: 5,
  breakerCooldownMs: 1_000,
  config: {},
};

function adapter(overrides: Partial<SearchProviderAdapter> = {}): SearchProviderAdapter {
  return {
    type: "test",
    requiresKey: true,
    supportsTest: true,
    async search() {
      return { results: [] };
    },
    ...overrides,
  };
}

function setup(options: {
  adapter?: SearchProviderAdapter;
  requiresKey?: boolean;
  registry?: AccountQuotaRegistry;
  accountDailyQuota?: number;
} = {}) {
  const registry = options.registry ?? new AccountQuotaRegistry();
  const scheduler = new KeyScheduler({
    providerId: config.id,
    strategy: "failover",
    perKeyConcurrency: 1,
    rpmLimit: 0,
    dailyQuota: options.accountDailyQuota ?? 1,
    cooldownMs: 30_000,
    breakerThreshold: 5,
    keys: [
      {
        id: "key",
        label: "key",
        maskedKey: "••••",
        weight: 100,
        enabled: true,
        status: "healthy",
      },
    ],
    accountGroup: "account",
    accountLimits: { rpmLimit: 0, dailyQuota: options.accountDailyQuota ?? 1 },
    registry,
  });
  const runtime: ProviderRuntime = {
    config,
    adapter: options.adapter ?? adapter(),
    scheduler,
    enabled: true,
    requiresKey: options.requiresKey,
    breaker: { failures: 0, openUntilMs: null },
  };
  return { runtime, scheduler, registry };
}

function options(fetchImpl: SafeFetch, signal = new AbortController().signal) {
  return {
    query: "q",
    limitPerProvider: 3,
    deadlineMs: 2_000,
    retryBudget: new RetryBudget(2),
    signal,
    logger,
    fetch: fetchImpl,
    credentials: { getKeyValue: async () => "secret" },
  };
}

const unexpectedFetch: SafeFetch = async () => {
  throw new Error("unexpected fetch");
};

const countingFetch: SafeFetch = async (url, init) => {
  init?.onRequest?.(String(url));
  throw new Error("unexpected wire request");
};

describe("fanout key lease safety", () => {
  it("refunds the key and account slot when the credential cannot be decrypted", async () => {
    const { runtime, scheduler } = setup();
    const result = await runProvider(runtime, {
      ...options(unexpectedFetch),
      credentials: { getKeyValue: async () => undefined },
    });
    expect(result.error?.code).toBe("auth_invalid");
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 0, quotaUsedToday: 0 });
    expect(scheduler.tryAcquire()).not.toBeNull();
  });

  it("refunds the slot when the credential store throws before any request", async () => {
    const { runtime, scheduler } = setup();
    await expect(
      runProvider(runtime, {
        ...options(unexpectedFetch),
        credentials: {
          getKeyValue: async () => {
            throw new Error("credential store unavailable");
          },
        },
      }),
    ).rejects.toThrow("credential store unavailable");
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 0, quotaUsedToday: 0 });
    expect(scheduler.tryAcquire()).not.toBeNull();
  });

  it("refunds a lease that is granted after the waiting caller was aborted", async () => {
    const { runtime, scheduler } = setup({ accountDailyQuota: 2 });
    const held = scheduler.tryAcquire()!;
    const controller = new AbortController();
    const pending = runProvider(runtime, options(unexpectedFetch, controller.signal));
    held.release({ ok: true, latencyMs: 1 });
    controller.abort(new Error("cancelled while waiting"));
    const result = await pending;
    expect(result.error?.code).toBe("cancelled");
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 1, quotaUsedToday: 1 });
    expect(scheduler.tryAcquire()).not.toBeNull();
  });

  it("refunds the slot when the per-request budget gate refuses before the wire", async () => {
    const { runtime, scheduler } = setup({
      adapter: adapter({
        async search(_input, ctx) {
          await ctx.fetch("https://example.org/search");
          return { results: [] };
        },
      }),
    });
    const result = await runProvider(runtime, {
      ...options(countingFetch),
      beforeRequest: () => {
        throw new SearchHubError("quota_exceeded", "request budget exhausted");
      },
    });
    expect(result.ok).toBe(false);
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 0, quotaUsedToday: 0 });
    expect(scheduler.tryAcquire()).not.toBeNull();
  });

  it("does not refund a reservation when cancellation arrives after the request was sent", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingFetch: SafeFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.onRequest?.(String(_url));
        started();
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const { runtime, scheduler } = setup({
      adapter: adapter({
        async search(_input, ctx) {
          await ctx.fetch("https://example.org/search", { signal: ctx.signal });
          return { results: [] };
        },
      }),
    });
    const controller = new AbortController();
    const pending = runProvider(runtime, options(pendingFetch, controller.signal));
    await didStart;
    controller.abort(new Error("cancelled by user"));
    const result = await pending;
    expect(result.error?.code).toBe("cancelled");
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 1, quotaUsedToday: 1 });
    expect(scheduler.tryAcquire()).toBeNull();
  });

  it("does not turn a mid-search budget refusal into credential quota exhaustion", async () => {
    let calls = 0;
    const twoPageFetch: SafeFetch = async <T>(url: string, init?: SafeFetchInit) => {
      init?.onRequest?.(String(url));
      calls += 1;
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        data: { ok: true } as T,
        url: String(url),
      };
    };
    const { runtime, scheduler } = setup({
      accountDailyQuota: 2,
      adapter: adapter({
        async search(_input, ctx) {
          await ctx.fetch("https://example.org/page/1", { signal: ctx.signal });
          await ctx.fetch("https://example.org/page/2", { signal: ctx.signal });
          return { results: [] };
        },
      }),
    });
    const result = await runProvider(runtime, {
      ...options(twoPageFetch),
      beforeRequest: () => {
        if (calls === 1) throw new SearchHubError("quota_exceeded", "request budget exhausted");
      },
    });
    expect(result.error?.code).toBe("quota_exceeded");
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 1, quotaUsedToday: 1, status: "healthy" });
    expect(scheduler.tryAcquire()).not.toBeNull();
  });

  it("does not turn a local SSRF block after one hop into forbidden", async () => {
    let calls = 0;
    const redirectFetch: SafeFetch = async <T>(url: string, init?: SafeFetchInit) => {
      init?.onRequest?.(String(url));
      calls += 1;
      if (calls === 2) {
        throw new ProviderError(config.id, config.type, "blocked", "private redirect blocked", {
          details: { localBlock: true },
        });
      }
      return {
        status: 302,
        headers: new Headers({ location: "http://127.0.0.1/internal" }),
        data: {} as T,
        url: String(url),
      };
    };
    const { runtime, scheduler } = setup({
      adapter: adapter({
        async search(_input, ctx) {
          await ctx.fetch("https://example.org/start", { signal: ctx.signal });
          await ctx.fetch("http://127.0.0.1/internal", { signal: ctx.signal });
          return { results: [] };
        },
      }),
    });
    const result = await runProvider(runtime, options(redirectFetch));
    expect(result.error?.code).toBe("blocked");
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 1, quotaUsedToday: 1, status: "healthy" });
  });

  it("maps an upstream blocked response to forbidden, never invalid", async () => {
    const blockedFetch: SafeFetch = async (url, init) => {
      init?.onRequest?.(String(url));
      throw new ProviderError(config.id, config.type, "blocked", "No entitlement", {
        statusCode: 403,
        details: { upstreamStatus: 403 },
      });
    };
    const { runtime, scheduler } = setup({
      adapter: adapter({
        async search(_input, ctx) {
          await ctx.fetch("https://example.org/search", { signal: ctx.signal });
          return { results: [] };
        },
      }),
    });
    const result = await runProvider(runtime, options(blockedFetch));
    expect(result.error?.code).toBe("blocked");
    expect(scheduler.snapshot()[0]?.status).toBe("forbidden");
    expect(scheduler.snapshot()[0]?.status).not.toBe("invalid");
  });

  it("waits beyond two seconds for a key slot when the request deadline allows it", async () => {
    vi.useFakeTimers();
    try {
      const successFetch: SafeFetch = async <T>(url: string, init?: SafeFetchInit) => {
        init?.onRequest?.(String(url));
        return {
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          data: { results: [] } as T,
          url: String(url),
        };
      };
      const { runtime, scheduler } = setup({
        accountDailyQuota: 2,
        adapter: adapter({
          async search(_input, ctx) {
            await ctx.fetch("https://example.org/search", { signal: ctx.signal });
            return { results: [] };
          },
        }),
      });
      const held = scheduler.tryAcquire()!;
      const pending = runProvider(runtime, { ...options(successFetch), deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(2_100);
      held.release({ ok: true, latencyMs: 1 });
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 2, quotaUsedToday: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not lease an optional key when the provider does not require credentials", async () => {
    const { runtime, scheduler } = setup({
      requiresKey: false,
      adapter: adapter({
        requiresKey: false,
        async search(_input, ctx) {
          expect(ctx.apiKey).toBeUndefined();
          return { results: [] };
        },
      }),
    });
    const result = await runProvider(runtime, {
      ...options(unexpectedFetch),
      credentials: {
        getKeyValue: async () => {
          throw new Error("optional credential must not be resolved");
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(scheduler.snapshot()[0]).toMatchObject({ inFlight: 0, requestCount: 0, quotaUsedToday: 0 });
  });

  it("does not restart the provider deadline after waiting for a resource slot", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    try {
      const pendingFetch: SafeFetch = async <T>(_url: string, init?: SafeFetchInit) => {
        return await new Promise<T>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("provider timeout")), { once: true });
        });
      };
      const { runtime } = setup({
        requiresKey: false,
        adapter: adapter({
          requiresKey: false,
          async search(_input, ctx) {
            await ctx.fetch("https://example.org/search", { signal: ctx.signal });
            return { results: [] };
          },
        }),
      });
      let settled = false;
      const pending = fanoutProviders([runtime], {
        ...options(pendingFetch),
        deadlineMs: 1_000,
        providerSlot: {
          acquire: async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return () => {};
          },
        },
      }).then((results) => {
        settled = true;
        return results;
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const results = await pending;
      expect(Date.now() - startedAt).toBe(1_000);
      expect(results[0]).toMatchObject({ ok: false, error: { code: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves resource queue rejection codes without starting the provider", async () => {
    const { runtime } = setup({ requiresKey: false });
    let started = false;
    const results = await fanoutProviders([runtime], {
      ...options(unexpectedFetch),
      providerSlot: {
        acquire: async () => {
          throw new SearchHubError("rate_limited", "Resource wait queue is full", { status: 429, retryable: true });
        },
      },
      onProviderStart: () => { started = true; },
    });

    expect(started).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    expect(results[0]!.stat.attempts).toBe(0);
  });
});
