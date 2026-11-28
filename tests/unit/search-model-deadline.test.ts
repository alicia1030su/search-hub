import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchHubError, type SafeFetch } from "@search-hub/shared";
import type { ProviderRuntime } from "@search-hub/core";
import { SearchService, type SearchServiceDeps } from "../../apps/api/src/services/search.js";
import type { ResourceSlotLimiter } from "../../apps/api/src/services/resource-budget.js";

const unusedFetch: SafeFetch = async <T>(): Promise<{ status: number; headers: Headers; data: T; url: string }> => ({
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  data: {} as T,
  url: "https://stub.invalid/",
});

function runtime(): ProviderRuntime {
  return {
    config: {
      id: "prv_deadline",
      name: "deadline",
      type: "mock",
      baseUrl: null,
      timeoutMs: 1_000,
      maxResults: 100,
      language: null,
      freshness: null,
      model: null,
      maxRetries: 0,
      breakerThreshold: 5,
      breakerCooldownMs: 1_000,
      config: {},
    },
    adapter: {
      type: "mock",
      requiresKey: false,
      supportsTest: false,
      capability: "raw_search",
      search: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        return { results: [{ title: "Result", url: "https://example.com/result", snippet: "body" }] };
      },
    },
    scheduler: {} as ProviderRuntime["scheduler"],
    enabled: true,
    requiresKey: false,
    breaker: { failures: 0, openUntilMs: null },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("model stage absolute deadline", () => {
  it("uses only the remaining top-level timeout while waiting for a rerank permit", async () => {
    vi.useFakeTimers();
    const rerank = vi.fn(async () => ({ modelId: "rerank", results: [] }));
    let acquisitions = 0;
    const resourceSlots: ResourceSlotLimiter = {
      acquire: async (_signal, deadlineAtMs) => {
        acquisitions += 1;
        if (acquisitions === 1) return () => undefined;
        return await new Promise<() => void>((_resolve, reject) => {
          setTimeout(() => reject(new SearchHubError("timeout", "Resource wait deadline exceeded", { status: 504, retryable: true })), Math.max(0, (deadlineAtMs ?? Date.now()) - Date.now()));
        });
      },
    };
    const service = new SearchService({
      db: {},
      providers: { runtimesFor: () => [runtime()], credentialVersion: () => "v1", redactProviderMessage: (_id: string, message: string) => message },
      models: {
        findDefault: (kind: string) => kind === "rerank" ? { id: "mdl_rerank", modelId: "rerank" } : null,
        resolveConfig: () => ({ id: "mdl_rerank", modelId: "rerank", baseUrl: "https://model.invalid", params: {}, updatedAt: "2026-01-01T00:00:00.000Z" }),
        rerankModel: () => rerank,
      },
      settings: { get: () => ({ defaults: { mode: "basic", limit: 20, timeoutMs: 15_000 }, cache: { enabled: false, ttlSeconds: 0 } }) },
      fetch: unusedFetch,
      logger: { warn: () => undefined },
      health: { blockedProviders: () => new Map() },
      cache: {},
      resourceSlots,
    } as unknown as SearchServiceDeps);

    const pending = service.execute(
      { query: "deadline", mode: "rerank", limit: 5, timeoutMs: 100, skipCache: true },
      { evaluate: true },
    );
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;

    expect(response.status).toBe("failed");
    expect(response.errors.some((error) => error.code === "timeout")).toBe(true);
    expect(rerank).not.toHaveBeenCalled();
    expect(acquisitions).toBe(2);
  });
});
