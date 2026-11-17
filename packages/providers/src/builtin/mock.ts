import {
  ProviderError,
  fnv1a,
  sleep,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
  type ProviderContext,
} from "@search-hub/shared";

export type MockFailMode =
  | "none"
  | "empty"
  | "server_error"
  | "rate_limited"
  | "auth_invalid"
  | "timeout"
  /** Account-level budget exhausted: distinct from a rate limit on purpose. */
  | "quota_exceeded"
  /** Permission problem (403 / missing entitlement), not a bad credential. */
  | "forbidden"
  /**
   * The caller aborted the request. Exists so tests can prove that a cancelled
   * probe is not counted as evidence about the source.
   */
  | "cancelled";

export interface MockConfig {
  resultCount?: number;
  latencyMs?: number;
  failMode?: MockFailMode;
  /** Adds a URL shared with other mock instances so de-dup can be exercised. */
  sharedUrl?: boolean;
  /** Stable prefix for generated URLs; useful to distinguish instances. */
  namespace?: string;
}

/**
 * Deterministic provider used by unit, integration and E2E tests.
 * It is clearly labelled as a test provider in the UI and catalog.
 */
export const mockAdapter: SearchProviderAdapter = {
  type: "mock",
  requiresKey: false,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    const config = (ctx.config.config ?? {}) as MockConfig;
    const failMode = config.failMode ?? "none";
    const latency = Math.max(0, Math.min(Number(config.latencyMs ?? 15), 5000));

    if (failMode === "timeout") {
      // Waits until the caller's deadline aborts the request.
      await sleep(Math.max(latency, 60_000), input.signal);
      throw new ProviderError(ctx.config.id, "mock", "timeout", "Mock timeout", {
        retryable: true,
      });
    }
    if (latency > 0) await sleep(latency, input.signal);

    if (failMode === "rate_limited") {
      throw new ProviderError(
        ctx.config.id,
        "mock",
        "rate_limited",
        "Mock HTTP 429 (rate limited)",
        { retryable: true, statusCode: 429, retryAfterMs: 2000 },
      );
    }
    if (failMode === "auth_invalid") {
      throw new ProviderError(ctx.config.id, "mock", "auth_invalid", "Mock HTTP 401 (invalid key)", {
        retryable: false,
        statusCode: 401,
      });
    }
    if (failMode === "quota_exceeded") {
      throw new ProviderError(ctx.config.id, "mock", "quota_exceeded", "Mock quota exhausted (account level)", {
        retryable: false,
      });
    }
    if (failMode === "cancelled") {
      throw new ProviderError(ctx.config.id, "mock", "cancelled", "Mock request cancelled", {
        retryable: false,
      });
    }
    if (failMode === "forbidden") {
      throw new ProviderError(ctx.config.id, "mock", "blocked", "Mock HTTP 403 (not entitled)", {
        retryable: false,
        statusCode: 403,
      });
    }
    if (failMode === "server_error") {
      throw new ProviderError(ctx.config.id, "mock", "server_error", "Mock HTTP 503", {
        retryable: true,
        statusCode: 503,
      });
    }
    if (failMode === "empty") {
      return { results: [] };
    }

    const count = Math.max(0, Math.min(Number(config.resultCount ?? 6), 30));
    const namespace = config.namespace ?? "mock";
    const topic = fnv1a(input.query.trim().toLowerCase());
    const results: RawSearchResult[] = [];

    if (config.sharedUrl !== false && count > 0) {
      results.push({
        title: `${input.query} — 跨源共享结果`,
        url: `https://example.com/shared/${topic}`,
        snippet:
          "这条结果由多个 Mock 源返回同一个 URL，用于验证 URL 规范化、去重与来源合并。",
        publishedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        language: input.language ?? "zh",
      });
    }

    for (let index = results.length; index < count; index += 1) {
      results.push({
        title: `${input.query} · ${namespace} 结果 ${index + 1}`,
        url: `https://example.com/${namespace}/${topic}/${index + 1}`,
        snippet: `Mock Provider 为「${input.query}」生成的确定性测试结果 #${index + 1}，仅用于验证聚合、去重与排序流程。`,
        publishedAt: new Date(Date.UTC(2025, 10, 1 + (index % 28))).toISOString(),
        score: Number((1 - index * 0.05).toFixed(3)),
        language: input.language ?? "zh",
      });
    }

    return { results };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    const { results } = await mockAdapter.search(
      { query: "search hub test", limit: 1, signal: ctx.signal },
      ctx,
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      resultCount: results.length,
      message: `Mock provider responded with ${results.length} result(s)`,
      sample: results.slice(0, 1).map((item) => ({ title: item.title, url: item.url })),
    };
  },
};
