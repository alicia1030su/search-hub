import { describe, expect, it } from "vitest";
import type { ProviderRuntime } from "@search-hub/core";
import { SearchHubError } from "@search-hub/shared";
import { classifyQueryIntent, routeProviders } from "../../packages/core/src/routing/route.js";

function runtime(type: string, id = `prv_${type}`, capability: "raw_search" | "grounded_answer" = "raw_search"): ProviderRuntime {
  return {
    config: {
      id,
      name: type,
      type,
      baseUrl: null,
      timeoutMs: 5_000,
      maxResults: 100,
      language: null,
      freshness: null,
      model: null,
      maxRetries: 0,
      breakerThreshold: 5,
      breakerCooldownMs: 1_000,
      config: {},
    },
    adapter: { type, requiresKey: false, supportsTest: false, capability, search: async () => ({ results: [] }) },
    scheduler: {} as ProviderRuntime["scheduler"],
    enabled: true,
    requiresKey: false,
    breaker: { failures: 0, openUntilMs: null },
  };
}

describe("rule-based provider routing", () => {
  it("classifies common intents without a model", () => {
    expect(classifyQueryIntent("latest AI news").intent).toBe("news");
    expect(classifyQueryIntent("TypeScript async cancellation bug").intent).toBe("code");
    expect(classifyQueryIntent("randomized controlled trial metadata").intent).toBe("academic");
    expect(classifyQueryIntent("今天天气").intent).toBe("chinese");
    expect(classifyQueryIntent("blue whale migration").intent).toBe("general");
  });

  it("prefers code providers for programming questions", () => {
    const result = routeProviders({
      query: "github api pagination bug",
      runtimes: [runtime("brave"), runtime("github"), runtime("hackernews")],
    });
    expect(result.selectedProviderIds.slice(0, 2)).toEqual(["prv_github", "prv_hackernews"]);
    expect(result.decisions.find((item) => item.providerId === "prv_github")?.reasons.join(" ")).toContain("code intent");
  });

  it("explains news intent and prefers news-capable providers", () => {
    const result = routeProviders({
      query: "latest AI news",
      runtimes: [runtime("brave"), runtime("searxng"), runtime("github"), runtime("arxiv")],
    });
    expect(result.intent).toBe("news");
    expect(result.matchedRules).toEqual(["news_terms"]);
    expect(result.selectedProviderIds.slice(0, 2)).toEqual(["prv_brave", "prv_searxng"]);
    expect(result.decisions.find((item) => item.providerId === "prv_brave")?.reasons).toContain(
      "provider capability matches news intent",
    );
  });

  it("explains academic intent and prefers academic providers", () => {
    const result = routeProviders({
      query: "randomized controlled trial metadata",
      runtimes: [runtime("brave"), runtime("arxiv"), runtime("pubmed"), runtime("openalex")],
    });
    expect(result.intent).toBe("academic");
    expect(result.matchedRules).toEqual(["academic_terms"]);
    expect(result.selectedProviderIds.slice(0, 3)).toEqual(["prv_arxiv", "prv_openalex", "prv_pubmed"]);
    expect(result.decisions.find((item) => item.providerId === "prv_pubmed")?.reasons).toContain(
      "provider capability matches academic intent",
    );
  });

  it("keeps explicit provider selection authoritative and ordered", () => {
    const result = routeProviders({
      query: "latest news",
      runtimes: [runtime("brave"), runtime("github")],
      explicitProviderIds: ["prv_github", "prv_brave", "prv_github"],
    });
    expect(result.selectedProviderIds).toEqual(["prv_github", "prv_brave"]);
    expect(result.matchedRules).toEqual(["explicit_provider_selection"]);
  });

  it("caps explicit provider selection at eight and reports truncation", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `prv_${index}`);
    const result = routeProviders({
      query: "web",
      runtimes: ids.map((id) => runtime("brave", id)),
      explicitProviderIds: ids,
    });
    expect(result.selectedProviderIds).toEqual(ids.slice(0, 8));
    expect(result.selectedProviderCount).toBe(8);
    expect(result.truncatedProviderIds).toEqual(ids.slice(8));
  });

  it("rejects unknown explicit provider ids instead of silently dropping them", () => {
    expect(() => routeProviders({
      query: "web",
      runtimes: [runtime("brave")],
      explicitProviderIds: ["prv_missing"],
    })).toThrow(/unknown|disabled|capability/i);
  });

  it.each<[string, ProviderRuntime]>([
    ["disabled", { ...runtime("brave", "prv_disabled"), enabled: false }],
    ["capability-incompatible", runtime("grounded", "prv_grounded", "grounded_answer")],
  ])("returns validation_error for an explicit %s provider", (_label, invalidRuntime) => {
    try {
      routeProviders({
        query: "web",
        runtimes: [runtime("brave"), invalidRuntime],
        explicitProviderIds: [invalidRuntime.config.id],
        capability: "raw_search",
      });
      throw new Error("expected routeProviders to reject the explicit provider");
    } catch (error) {
      expect(error).toBeInstanceOf(SearchHubError);
      expect(error).toMatchObject({ code: "validation_error" });
    }
  });

  it("does not silently remove a blocked provider", () => {
    const result = routeProviders({
      query: "general web",
      runtimes: [runtime("brave"), runtime("searxng")],
      observations: { prv_brave: { blocked: true, quality: 1 }, prv_searxng: { quality: 0 } },
    });
    expect(result.selectedProviderIds).toHaveLength(2);
    expect(result.decisions.find((item) => item.providerId === "prv_brave")?.reasons.join(" ")).toContain("does not remove");
  });

  it("filters capability and bounds automatic selection to eight providers", () => {
    const runtimes = Array.from({ length: 10 }, (_, index) => runtime("brave", `prv_${index}`));
    runtimes.push(runtime("grounded", "prv_grounded", "grounded_answer"));
    const result = routeProviders({ query: "web", runtimes, capability: "raw_search" });
    expect(result.requestedProviderCount).toBe(10);
    expect(result.selectedProviderCount).toBe(8);
    expect(result.truncatedProviderIds).toHaveLength(2);
    expect(result.selectedProviderIds).not.toContain("prv_grounded");
  });
});
