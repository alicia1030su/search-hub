import { describe, expect, it } from "vitest";
import { routeSearchStrategy } from "@search-hub/core";

describe("automatic strategy routing", () => {
  it("selects Fast for exact URL navigation", () => {
    expect(routeSearchStrategy({ query: "https://example.com/docs" })).toMatchObject({
      selected: "fast",
      ruleId: "fast_intent",
      matchedSignals: ["exact_url"],
    });
  });

  it("selects Quality for comparison and research intent", () => {
    expect(routeSearchStrategy({ query: "compare database versus search engine" }).selected).toBe("quality");
    expect(routeSearchStrategy({ query: "research paper on retrieval" }).selected).toBe("quality");
  });

  it("selects Deep for multi-constraint intent", () => {
    expect(routeSearchStrategy({ query: "design a secure search system with privacy and performance constraints" }).selected).toBe("deep");
  });

  it("defaults to Balanced and is deterministic across repeated calls", () => {
    const request = { query: "weather forecast for tomorrow afternoon" };
    const first = routeSearchStrategy(request);
    for (let index = 0; index < 100; index += 1) expect(routeSearchStrategy(request)).toEqual(first);
    expect(first).toMatchObject({ selected: "balanced", ruleId: "balanced_default" });
  });
});
