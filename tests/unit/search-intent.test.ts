import { describe, expect, it } from "vitest";
import { resolveSearchIntent } from "@search-hub/core";
import { searchRequestSchema } from "@search-hub/shared";

describe("search intent strategy compatibility", () => {
  it("keeps legacy default mode when no strategy or mode is supplied", () => {
    expect(resolveSearchIntent({ query: "q" }, "basic")).toMatchObject({ mode: "basic", routeVersion: "v1" });
    expect(resolveSearchIntent({ query: "q" }, "rrf")).toMatchObject({ mode: "rrf" });
  });

  it("maps fast to basic without adding a model stage", () => {
    expect(resolveSearchIntent({ query: "q", strategy: "fast" })).toMatchObject({
      strategy: "fast",
      mode: "basic",
      effectiveStrategy: "fast",
    });
    expect(() => resolveSearchIntent({ query: "q", strategy: "fast", mode: "rrf" })).toThrow(/incompatible/i);
  });

  it("maps balanced to rrf and rejects a conflicting explicit basic mode", () => {
    expect(resolveSearchIntent({ query: "q", strategy: "balanced" })).toMatchObject({
      strategy: "balanced",
      mode: "rrf",
      effectiveStrategy: "balanced",
    });
    expect(() => resolveSearchIntent({ query: "q", strategy: "balanced", mode: "basic" })).toThrow(/incompatible/i);
  });

  it("keeps quality basic explicit and only defaults quality to rrf", () => {
    expect(resolveSearchIntent({ query: "q", strategy: "quality" })).toMatchObject({ mode: "rrf" });
    expect(resolveSearchIntent({ query: "q", strategy: "quality", mode: "basic" })).toMatchObject({ mode: "basic" });
    expect(resolveSearchIntent({ query: "q", strategy: "quality", mode: "rerank" })).toMatchObject({ mode: "rerank" });
    expect(() => resolveSearchIntent({ query: "q", strategy: "quality", mode: "embedding" })).toThrow(/incompatible/i);
  });

  it("maps deep to deep and rejects conflicting legacy modes", () => {
    expect(resolveSearchIntent({ query: "q", strategy: "deep" })).toMatchObject({ mode: "deep" });
    expect(resolveSearchIntent({ query: "q", strategy: "deep", mode: "deep" })).toMatchObject({ mode: "deep" });
    expect(() => resolveSearchIntent({ query: "q", strategy: "deep", mode: "rrf" })).toThrow(/incompatible/i);
  });

  it("lets auto preserve an explicit legacy mode", () => {
    expect(resolveSearchIntent({ query: "q", strategy: "auto", mode: "rerank" })).toMatchObject({
      strategy: "auto",
      mode: "rerank",
    });
  });

  it("accepts strategy and expansion fields without defaulting mode in the schema", () => {
    const parsed = searchRequestSchema.parse({
      query: "q",
      strategy: "balanced",
      queryExpansion: true,
      maxSubqueries: 4,
      maxRounds: 2,
      stream: "sse",
      render: true,
    });
    expect(parsed.mode).toBeUndefined();
    expect(parsed.strategy).toBe("balanced");
    expect(parsed.queryExpansion).toBe(true);
  });
});
