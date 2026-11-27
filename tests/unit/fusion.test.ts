import { describe, expect, it } from "vitest";
import { normalizeTitle, normalizeUrl } from "@search-hub/shared";
import { dedupeResults, fuseWithRrf, type CandidateResult } from "@search-hub/core";

function candidate(
  providerId: string,
  rank: number,
  url: string,
  title: string,
  snippet = "a sufficiently long shared snippet for near duplicate detection",
): CandidateResult {
  return {
    title,
    url,
    snippet,
    providerId,
    providerName: providerId,
    providerType: "mock",
    rank,
    retrievedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("URL normalization", () => {
  it("lowercases host, removes default ports and fragments", () => {
    expect(normalizeUrl("HTTPS://Example.COM:443/Path/#frag")).toBe("https://example.com/Path");
  });

  it("strips tracking parameters but keeps semantic ones", () => {
    const normalized = normalizeUrl(
      "https://example.com/a?utm_source=x&b=2&a=1&fbclid=abc&gclid=1",
    );
    expect(normalized).toBe("https://example.com/a?a=1&b=2");
  });

  it("sorts query parameters so order does not matter", () => {
    expect(normalizeUrl("https://example.com/x?b=2&a=1")).toBe(
      normalizeUrl("https://example.com/x?a=1&b=2"),
    );
  });

  it("removes a trailing slash but keeps the root", () => {
    expect(normalizeUrl("https://example.com/docs/")).toBe("https://example.com/docs");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("rejects non-http protocols and malformed URLs", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("de-duplication", () => {
  it("merges the same URL from two providers and keeps both sources", () => {
    const { results } = dedupeResults([
      candidate("p1", 1, "https://example.com/a?utm_source=x", "Shared result"),
      candidate("p2", 3, "https://example.com/a/", "Shared result"),
    ]);
    expect(results).toHaveLength(1);
    const sources = results[0]!.sources;
    expect(sources.map((source) => source.providerId).sort()).toEqual(["p1", "p2"]);
  });

  it("merges near-duplicate titles on the same domain", () => {
    const { results } = dedupeResults([
      candidate("p1", 1, "https://example.com/a", "TypeScript Monorepo Guide"),
      candidate("p2", 2, "https://example.com/b", "TypeScript Monorepo Guide!"),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.sources).toHaveLength(2);
  });

  it("does not merge similar titles when the bodies differ", () => {
    const { results } = dedupeResults([
      candidate("p1", 1, "https://example.com/docs/api", "OpenAI API Documentation Guide", "Endpoint reference and authentication"),
      candidate("p2", 2, "https://example.com/guides/api", "OpenAI API Documentation Guide", "Step-by-step migration guide with examples"),
    ]);
    expect(results).toHaveLength(2);
  });

  it("does not merge on title alone when the body is too short", () => {
    const { results } = dedupeResults([
      candidate("p1", 1, "https://example.com/a", "TypeScript Monorepo Guide", "short"),
      candidate("p2", 2, "https://example.com/b", "TypeScript Monorepo Guide", "short"),
    ]);
    expect(results).toHaveLength(2);
  });

  it("does not merge similar titles across different domains", () => {
    const { results } = dedupeResults([
      candidate("p1", 1, "https://a.com/x", "TypeScript Monorepo Guide"),
      candidate("p2", 2, "https://b.com/y", "TypeScript Monorepo Guide"),
    ]);
    expect(results).toHaveLength(2);
  });

  it("never invents a title or URL", () => {
    const { results } = dedupeResults([
      { ...candidate("p1", 1, "https://example.com/a", "t"), title: "" },
    ]);
    expect(results).toHaveLength(0);
  });

  it("tracks why a duplicate was dropped", () => {
    const { dropped } = dedupeResults([
      candidate("p1", 1, "https://example.com/a", "A"),
      candidate("p2", 2, "https://example.com/a?utm_source=z", "A"),
    ]);
    expect(dropped[0]?.reason).toBe("exact_url");
  });
});

describe("Reciprocal Rank Fusion", () => {
  it("matches the hand-calculated RRF score", () => {
    const deduped = dedupeResults([
      candidate("p1", 1, "https://a.com/1", "A"),
      candidate("p1", 2, "https://a.com/2", "B"),
      candidate("p2", 1, "https://a.com/1", "A"),
    ]).results;

    const fused = fuseWithRrf(deduped, { k: 60 }).results;
    const top = fused.find((item) => item.url === "https://a.com/1")!;
    // 1/(60+1) + 1/(60+1)
    expect(top.fusionScore).toBeCloseTo(2 / 61, 10);
    expect(fused[0]!.url).toBe("https://a.com/1");
    const second = fused.find((item) => item.url === "https://a.com/2")!;
    expect(second.fusionScore).toBeCloseTo(1 / 62, 10);
  });

  it("is independent of provider input order", () => {
    const one = dedupeResults([
      candidate("p1", 1, "https://a.com/1", "A"),
      candidate("p2", 2, "https://a.com/2", "B"),
    ]).results;
    const two = dedupeResults([
      candidate("p2", 2, "https://a.com/2", "B"),
      candidate("p1", 1, "https://a.com/1", "A"),
    ]).results;
    const a = fuseWithRrf(one).results.map((item) => [item.url, item.fusionScore]);
    const b = fuseWithRrf(two).results.map((item) => [item.url, item.fusionScore]);
    expect(a).toEqual(b);
  });

  it("rewards results found by more than one provider", () => {
    const deduped = dedupeResults([
      candidate("p1", 1, "https://a.com/multi", "Multi"),
      candidate("p2", 1, "https://a.com/multi", "Multi"),
      candidate("p1", 2, "https://a.com/single", "Single"),
    ]).results;
    const fused = fuseWithRrf(deduped).results;
    expect(fused[0]!.url).toBe("https://a.com/multi");
    expect(fused[0]!.sources).toHaveLength(2);
  });

  it("keeps the best rank for tie-breaking", () => {
    const deduped = dedupeResults([
      candidate("p1", 5, "https://a.com/x", "X"),
      candidate("p1", 1, "https://a.com/y", "Y"),
    ]).results;
    const fused = fuseWithRrf(deduped).results;
    expect(fused[0]!.url).toBe("https://a.com/y");
  });

  it("breaks complete ties by normalized URL", () => {
    const deduped = dedupeResults([
      candidate("p1", 1, "https://a.com/z?utm_source=x", "Z"),
      candidate("p1", 1, "https://a.com/a", "A"),
    ]).results;
    const fused = fuseWithRrf(deduped).results;
    expect(fused.map((item) => item.normalizedUrl)).toEqual(["https://a.com/a", "https://a.com/z"]);
  });
});

describe("title normalization", () => {
  it("normalizes punctuation and case", () => {
    expect(normalizeTitle("  Hello, World!  ")).toBe("hello world");
  });
});
