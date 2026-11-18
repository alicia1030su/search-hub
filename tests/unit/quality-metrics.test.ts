/**
 * Metric correctness.
 *
 * Every expected value here is computed by hand from the definition, not read
 * back from the implementation. When one of these fails, the formula is the
 * first suspect — the assertion is not.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLE,
  aggregateMetric,
  compareRankings,
  costSummary,
  dcg,
  evaluateQuery,
  idcg,
  latencyStats,
  rankSnapshot,
  rateMetric,
  resultSetQuality,
  rrfCandidates,
  splitQueries,
  type QueryJudgments,
  type QuerySnapshot,
  type RankedList,
  type RelevanceGrade,
} from "@search-hub/core";

function judgments(
  grades: Record<string, RelevanceGrade>,
  options: { complete?: boolean; relevantTotal?: number | null } = {},
): QueryJudgments {
  const map = new Map(Object.entries(grades));
  const complete = options.complete ?? true;
  const relevantTotal =
    options.relevantTotal !== undefined
      ? options.relevantTotal
      : complete
        ? [...map.values()].filter((grade) => grade >= 2).length
        : null;
  return { queryId: "q", grades: map, relevantTotal };
}

/** Twelve documents, so a 10-cut always has something left out. */
const docs = (count: number) => Array.from({ length: count }, (_, index) => `https://d${index}.fixture.test/p`);

describe("P@10", () => {
  it("is 1.0 when all ten results are relevant", () => {
    const ranked = docs(10);
    const qrels = judgments(Object.fromEntries(ranked.map((url) => [url, 3 as RelevanceGrade])));
    const metrics = evaluateQuery(ranked, qrels, { cutoff: 10 });
    expect(metrics.precisionAtK.value).toBe(1);
    expect(metrics.precisionAtK.status).toBe("ok");
  });

  it("is 0.6 when six of ten are relevant", () => {
    const ranked = docs(10);
    const grades: Record<string, RelevanceGrade> = {};
    ranked.forEach((url, index) => {
      grades[url] = index < 6 ? 2 : 0;
    });
    const metrics = evaluateQuery(ranked, judgments(grades), { cutoff: 10 });
    expect(metrics.precisionAtK.value).toBe(0.6);
  });

  it("keeps the cutoff as denominator when fewer than ten results come back", () => {
    const ranked = docs(3);
    const grades: Record<string, RelevanceGrade> = {};
    for (const url of ranked) grades[url] = 3;
    const metrics = evaluateQuery(ranked, judgments(grades), { cutoff: 10 });
    // 3 relevant / 10 positions, not 3/3.
    expect(metrics.precisionAtK.value).toBe(0.3);
  });
});

describe("Recall@10", () => {
  it("uses the qrels total as denominator", () => {
    // Five relevant documents exist; three of them are in the top ten.
    const ranked = docs(10);
    const grades: Record<string, RelevanceGrade> = {};
    ranked.slice(0, 3).forEach((url) => (grades[url] = 3));
    for (let index = 3; index < 10; index += 1) grades[ranked[index]!] = 0;
    for (const extra of ["https://x1.fixture.test/a", "https://x2.fixture.test/a"]) grades[extra] = 2;
    const metrics = evaluateQuery(ranked, judgments(grades), { cutoff: 10 });
    expect(metrics.recallAtK.value).toBe(0.6);
  });

  it("is N/A when the judgment set is not complete", () => {
    const ranked = docs(10);
    const grades = Object.fromEntries(ranked.map((url) => [url, 3 as RelevanceGrade]));
    const metrics = evaluateQuery(ranked, judgments(grades, { complete: false }), { cutoff: 10 });
    expect(metrics.recallAtK.status).toBe("na");
    expect(metrics.recallAtK.reason).toBe("qrels_incomplete");
    expect(metrics.recallAtK.value).toBeNull();
  });

  it("is N/A rather than a division by zero when nothing is relevant", () => {
    const ranked = docs(10);
    const grades = Object.fromEntries(ranked.map((url) => [url, 0 as RelevanceGrade]));
    const metrics = evaluateQuery(ranked, judgments(grades, { relevantTotal: 0 }), { cutoff: 10 });
    expect(metrics.recallAtK.status).toBe("na");
    expect(metrics.recallAtK.reason).toBe("no_relevant_documents");
  });
});

describe("MRR@10", () => {
  const make = (firstRelevantIndex: number) => {
    const ranked = docs(10);
    const grades: Record<string, RelevanceGrade> = {};
    ranked.forEach((url, index) => {
      grades[url] = index === firstRelevantIndex ? 3 : 0;
    });
    return evaluateQuery(ranked, judgments(grades), { cutoff: 10 });
  };

  it("is 1 when the first result is relevant", () => {
    expect(make(0).mrrAtK.value).toBe(1);
  });

  it("is 1/3 when the third result is the first relevant one", () => {
    expect(make(2).mrrAtK.value).toBeCloseTo(1 / 3, 10);
  });

  it("is 1/10 when only the tenth result is relevant", () => {
    expect(make(9).mrrAtK.value).toBeCloseTo(0.1, 10);
  });

  it("is 0 when nothing in the top ten is relevant", () => {
    const ranked = docs(10);
    const grades: Record<string, RelevanceGrade> = {};
    for (const url of ranked) grades[url] = 1;
    expect(evaluateQuery(ranked, judgments(grades), { cutoff: 10 }).mrrAtK.value).toBe(0);
  });
});

describe("nDCG@10", () => {
  it("is exactly 1 for an ideal ordering", () => {
    const ranked = docs(4);
    const grades: Record<string, RelevanceGrade> = {};
    [3, 2, 1, 0].forEach((grade, index) => (grades[ranked[index]!] = grade as RelevanceGrade));
    expect(evaluateQuery(ranked, judgments(grades), { cutoff: 10 }).ndcgAtK.value).toBeCloseTo(1, 10);
  });

  it("drops when the ordering is reversed", () => {
    const ranked = docs(4);
    const grades: Record<string, RelevanceGrade> = {};
    [3, 2, 1, 0].forEach((grade, index) => (grades[ranked[index]!] = grade as RelevanceGrade));
    const reversed = [...ranked].reverse();
    const ideal = evaluateQuery(ranked, judgments(grades), { cutoff: 10 });
    const poor = evaluateQuery(reversed, judgments(grades), { cutoff: 10 });
    expect(ideal.ndcgAtK.value!).toBeGreaterThan(poor.ndcgAtK.value!);
    // Hand check: DCG(reversed) = 0/1 + 1/1.585 + 3/2 + 7/2.322
    const expectedDcg = 0 + 1 / Math.log2(3) + 3 / Math.log2(4) + 7 / Math.log2(5);
    const expectedIdcg = 7 / Math.log2(2) + 3 / Math.log2(3) + 1 / Math.log2(4);
    expect(poor.ndcgAtK.value!).toBeCloseTo(expectedDcg / expectedIdcg, 9);
  });

  it("rewards putting the higher grade first inside the same qrels", () => {
    const ranked = docs(2);
    // Identical judgment set, only the order differs. nDCG normalises by the
    // ideal of this query, so the comparison must be within one qrels set.
    const qrels = judgments({ [ranked[0]!]: 3, [ranked[1]!]: 2 });
    const best = evaluateQuery(ranked, qrels);
    const swapped = evaluateQuery([ranked[1]!, ranked[0]!], qrels);
    expect(best.ndcgAtK.value!).toBe(1);
    expect(swapped.ndcgAtK.value!).toBeLessThan(1);
    expect(swapped.ndcgAtK.value!).toBeGreaterThan(0);
  });

  it("is N/A when every judgment is grade 0", () => {
    const ranked = docs(3);
    const grades: Record<string, RelevanceGrade> = {};
    for (const url of ranked) grades[url] = 0;
    const metrics = evaluateQuery(ranked, judgments(grades, { relevantTotal: 0 }));
    expect(metrics.ndcgAtK.status).toBe("na");
    expect(metrics.ndcgAtK.reason).toBe("no_relevant_documents");
  });

  it("uses 2^rel - 1 gain and log2(i+1) discount", () => {
    // Two documents, grades 3 and 1, ideal order already.
    expect(dcg([3, 1], 10)).toBeCloseTo(7 / Math.log2(2) + 1 / Math.log2(3), 12);
    expect(idcg([1, 3], 10)).toBeCloseTo(7 / Math.log2(2) + 1 / Math.log2(3), 12);
  });
});

describe("unjudged documents", () => {
  it("are excluded, not silently scored as irrelevant", () => {
    const ranked = ["https://a.fixture.test/1", "https://b.fixture.test/1", "https://c.fixture.test/1"];
    // Only the third document carries a judgment.
    const qrels = judgments({ [ranked[2]!]: 3 });
    const metrics = evaluateQuery(ranked, qrels, { cutoff: 10, unjudgedPolicy: "exclude" });
    expect(metrics.provisional).toBe(true);
    expect(metrics.unjudgedCount).toBe(2);
    // After exclusion the relevant document sits at position 1 of the window.
    expect(metrics.mrrAtK.value).toBe(1);
    expect(metrics.precisionAtK.value).toBe(0.1);
  });

  it("lower the score when counted as zero, which is why that is not the default", () => {
    const ranked = ["https://a.fixture.test/1", "https://b.fixture.test/1", "https://c.fixture.test/1"];
    const qrels = judgments({ [ranked[2]!]: 3 });
    const excluded = evaluateQuery(ranked, qrels, { unjudgedPolicy: "exclude" });
    const asZero = evaluateQuery(ranked, qrels, { unjudgedPolicy: "as_zero" });
    expect(asZero.mrrAtK.value).toBeCloseTo(1 / 3, 10);
    expect(excluded.mrrAtK.value!).toBeGreaterThan(asZero.mrrAtK.value!);
    expect(asZero.provisional).toBe(true);
  });

  it("make a query with no judgments at all N/A instead of 0", () => {
    const metrics = evaluateQuery(docs(5), judgments({}));
    expect(metrics.precisionAtK.status).toBe("na");
    expect(metrics.precisionAtK.reason).toBe("no_judgments");
    expect(metrics.mrrAtK.value).toBeNull();
  });
});

describe("edge cases", () => {
  it("returns N/A for an empty result list", () => {
    const metrics = evaluateQuery([], judgments({ "https://a.fixture.test/1": 3 }));
    expect(metrics.precisionAtK.reason).toBe("no_results");
    expect(metrics.returnedCount).toBe(0);
  });

  it("never produces NaN or Infinity", () => {
    const cases: Array<[string[], QueryJudgments]> = [
      [[], judgments({})],
      [docs(1), judgments({})],
      [docs(1), judgments({ [docs(1)[0]!]: 0 }, { relevantTotal: 0 })],
      [docs(100), judgments(Object.fromEntries(docs(100).map((url) => [url, 3 as RelevanceGrade])))],
    ];
    for (const [ranked, qrels] of cases) {
      const metrics = evaluateQuery(ranked, qrels);
      for (const value of [metrics.precisionAtK, metrics.recallAtK, metrics.mrrAtK, metrics.ndcgAtK]) {
        if (value.value !== null) expect(Number.isFinite(value.value)).toBe(true);
      }
    }
  });

  it("does not mutate its inputs", () => {
    const ranked = docs(5);
    const snapshot = [...ranked];
    const grades = new Map<string, RelevanceGrade>(ranked.map((url, index) => [url, (index % 4) as RelevanceGrade]));
    const gradesSnapshot = new Map(grades);
    evaluateQuery(ranked, { queryId: "q", grades, relevantTotal: 2 }, { unjudgedPolicy: "as_zero" });
    expect(ranked).toEqual(snapshot);
    expect([...grades.entries()]).toEqual([...gradesSnapshot.entries()]);
  });

  it("is deterministic for identical input", () => {
    const ranked = docs(10);
    const qrels = judgments(Object.fromEntries(ranked.map((url, index) => [url, (index % 4) as RelevanceGrade])));
    expect(evaluateQuery(ranked, qrels)).toEqual(evaluateQuery(ranked, qrels));
  });
});

describe("aggregation", () => {
  const makeMetrics = (values: number[], provisional = false) =>
    values.map((value, index) => {
      const base = evaluateQuery(docs(1), judgments({ [docs(1)[0]!]: value >= 0.5 ? 3 : 0 }), { cutoff: 1 });
      return {
        ...base,
        queryId: `q${index}`,
        provisional,
        ndcgAtK: { value, status: "ok" as const, sampleSize: 1, provisionalCount: 0, lowSample: false },
      };
    });

  it("averages measured queries and reports the sample size", () => {
    const aggregate = aggregateMetric(makeMetrics([1, 0.5, 0]), "ndcgAtK");
    expect(aggregate.value).toBeCloseTo(0.5, 10);
    expect(aggregate.sampleSize).toBe(3);
    expect(aggregate.lowSample).toBe(true);
  });

  it("excludes provisional queries from the headline and counts them", () => {
    const metrics = [...makeMetrics([1, 1, 0], true), ...makeMetrics([0.4])];
    const aggregate = aggregateMetric(metrics, "ndcgAtK");
    expect(aggregate.value).toBeCloseTo(0.4, 10);
    expect(aggregate.provisionalCount).toBe(3);
    expect(aggregate.sampleSize).toBe(1);
  });

  it("is N/A when every query is provisional", () => {
    const aggregate = aggregateMetric(makeMetrics([1, 0.5], true), "ndcgAtK");
    expect(aggregate.status).toBe("na");
    expect(aggregate.reason).toBe("qrels_incomplete");
    expect(aggregate.provisionalCount).toBe(2);
  });

  it("only clears lowSample at the documented threshold", () => {
    const values = Array.from({ length: MIN_SAMPLE }, () => 0.5);
    expect(aggregateMetric(makeMetrics(values), "ndcgAtK").lowSample).toBe(false);
    expect(aggregateMetric(makeMetrics(values.slice(1)), "ndcgAtK").lowSample).toBe(true);
  });
});

describe("non-relevance quality signals", () => {
  it("counts duplicates by normalized URL", () => {
    const quality = resultSetQuality({
      documentUrls: [
        "https://a.fixture.test/1",
        "https://a.fixture.test/1",
        "https://b.fixture.test/2",
        "https://c.fixture.test/3",
      ],
      providersAsked: 3,
      providersContributing: 2,
    });
    expect(quality.resultCount).toBe(3);
    expect(quality.duplicateRate).toBe(0.25);
    expect(quality.uniqueDomainCount).toBe(3);
    expect(quality.providerCoverage).toBe(2);
    expect(quality.sourceDiversity).toBeCloseTo(2 / 3, 10);
  });

  it("reports an empty list without dividing by zero", () => {
    const quality = resultSetQuality({ documentUrls: [], providersAsked: 3, providersContributing: 0 });
    expect(quality.duplicateRate).toBe(0);
    expect(quality.sourceDiversity).toBe(0);
  });

  it("reports rates as N/A when there is no sample", () => {
    expect(rateMetric([]).status).toBe("na");
    expect(rateMetric([true, false, false, false]).value).toBe(0.25);
  });
});

describe("latency and cost", () => {
  it("computes percentiles with interpolation", () => {
    const stats = latencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(stats.count).toBe(10);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.p50).toBeCloseTo(55, 10);
    expect(stats.p95).toBeCloseTo(95.5, 10);
    expect(stats.lowSample).toBe(false);
  });

  it("flags a small latency sample", () => {
    expect(latencyStats([12]).lowSample).toBe(true);
    expect(latencyStats([]).p50).toBeNull();
  });

  it("says a cost is unknown instead of zero when no price exists", () => {
    const cost = costSummary({ requests: 40, cacheHits: 5, requestsByProvider: { brave: 40 } });
    expect(cost.requests).toBe(40);
    expect(cost.knownCost).toBeNull();
    expect(cost.estimatedCost).toBeNull();
    expect(cost.unknownCost).toBe(true);
  });

  it("prices per provider and refuses a total when one is unpriced", () => {
    const priced = costSummary({
      requests: 30,
      cacheHits: 0,
      requestsByProvider: { brave: 20, hn: 10 },
      unitCosts: { brave: 0.005, hn: 0 },
    });
    expect(priced.knownCost).toBeCloseTo(0.1, 6);
    expect(priced.unknownCost).toBe(false);

    const partial = costSummary({
      requests: 30,
      cacheHits: 0,
      requestsByProvider: { brave: 20, mystery: 10 },
      unitCosts: { brave: 0.005 },
    });
    expect(partial.unknownCost).toBe(true);
    expect(partial.estimatedCost).toBeNull();
  });
});

describe("fusion lab", () => {
  const snapshot: QuerySnapshot = {
    queryId: "q1",
    query: "test",
    category: "general",
    capturedAt: "2026-11-01T00:00:00.000Z",
    upstreamRequests: 2,
    cacheHits: 0,
    providers: [
      {
        providerId: "alpha",
        providerName: "Alpha",
        providerType: "fixture",
        ok: true,
        results: [
          { documentId: "https://a.fixture.test/1", title: "A", url: "https://a.fixture.test/1", snippet: "", rank: 1 },
          { documentId: "https://b.fixture.test/1", title: "B", url: "https://b.fixture.test/1", snippet: "", rank: 2 },
        ],
      },
      {
        providerId: "beta",
        providerName: "Beta",
        providerType: "fixture",
        ok: true,
        results: [
          { documentId: "https://b.fixture.test/1", title: "B", url: "https://b.fixture.test/1", snippet: "", rank: 1 },
          { documentId: "https://c.fixture.test/1", title: "C", url: "https://c.fixture.test/1", snippet: "", rank: 2 },
        ],
      },
    ],
  };

  it("gives the single-provider baseline that provider's own order", () => {
    const ranked = rankSnapshot(snapshot, { strategy: "single", providerId: "beta" });
    expect(ranked.documents.map((item) => item.documentId)).toEqual([
      "https://b.fixture.test/1",
      "https://c.fixture.test/1",
    ]);
  });

  it("ranks the shared document first under RRF", () => {
    const ranked = rankSnapshot(snapshot, { strategy: "rrf", k: 60 });
    expect(ranked.documents[0]!.documentId).toBe("https://b.fixture.test/1");
  });

  it("does not count the same provider twice for one document", () => {
    const doubled: QuerySnapshot = {
      ...snapshot,
      providers: [
        {
          ...snapshot.providers[0]!,
          results: [
            { documentId: "https://a.fixture.test/1", title: "A", url: "https://a.fixture.test/1", snippet: "", rank: 1 },
            { documentId: "https://a.fixture.test/1", title: "A again", url: "https://a.fixture.test/1/?utm_source=x", snippet: "", rank: 2 },
          ],
        },
      ],
    };
    const ranked = rankSnapshot(doubled, { strategy: "rrf", k: 60 });
    expect(ranked.documents).toHaveLength(1);
  });

  it("breaks score ties deterministically", () => {
    const tied: QuerySnapshot = {
      ...snapshot,
      providers: [
        {
          ...snapshot.providers[0]!,
          results: [
            { documentId: "https://z.fixture.test/1", title: "Z", url: "https://z.fixture.test/1", snippet: "", rank: 1 },
            { documentId: "https://y.fixture.test/1", title: "Y", url: "https://y.fixture.test/1", snippet: "", rank: 1 },
          ],
        },
      ],
    };
    const first = rankSnapshot(tied, { strategy: "rrf" });
    const second = rankSnapshot(tied, { strategy: "rrf" });
    expect(first.documents.map((item) => item.documentId)).toEqual(second.documents.map((item) => item.documentId));
  });

  it("produces the documented candidate grid", () => {
    expect(rrfCandidates([100, 20, 60, 20]).map((item) => item.k)).toEqual([20, 60, 100]);
    expect(rrfCandidates([0, -5, Number.NaN]).length).toBe(0);
  });
});

describe("development / holdout split", () => {
  it("is deterministic, disjoint and covers every query", () => {
    const ids = Array.from({ length: 14 }, (_, index) => `q${index + 1}`);
    const split = splitQueries(ids);
    expect(splitQueries(ids)).toEqual(split);
    expect(new Set([...split.development, ...split.holdout]).size).toBe(ids.length);
    expect(split.development.some((id) => split.holdout.includes(id))).toBe(false);
  });
});

describe("comparison verdicts", () => {
  const judged = [
    { queryId: "q1", query: "one", category: "general", grades: new Map(), relevantTotal: 1 },
    { queryId: "q2", query: "two", category: "general", grades: new Map(), relevantTotal: 1 },
  ];
  const ranked: RankedList[] = judged.map((item) => ({
    queryId: item.queryId,
    documents: [],
    fusion: { strategy: "rrf" },
  }));

  it("says insufficient evidence when there are too few comparable queries", () => {
    const summary = compareRankings({
      metric: "ndcgAtK",
      baseline: ranked,
      candidate: ranked,
      judgments: judged,
      // Only judged documents, so every query is measured and the reason is
      // about sample size rather than about missing judgments.
      metricsFor: (_r, j) =>
        evaluateQuery(["https://a.fixture.test/1"], {
          queryId: j.queryId,
          grades: new Map([["https://a.fixture.test/1", 3 as RelevanceGrade]]),
          relevantTotal: 1,
        }),
    });
    expect(summary.verdict).toBe("insufficient_evidence");
    expect(summary.baseline.status).toBe("ok");
    expect(summary.comparableQueries).toBe(2);
    expect(summary.reason).toContain("comparable queries");
  });

  it("says insufficient evidence when the metric itself is unmeasurable", () => {
    const summary = compareRankings({
      metric: "ndcgAtK",
      baseline: ranked,
      candidate: ranked,
      judgments: judged,
      metricsFor: (r, j) =>
        evaluateQuery(["https://a.fixture.test/1", "https://b.fixture.test/1"], {
          queryId: j.queryId,
          grades: new Map([["https://a.fixture.test/1", 3 as RelevanceGrade]]),
          relevantTotal: 1,
        }),
    });
    // Unjudged documents make every query provisional; the aggregate has no
    // measured value, and the reason must say so instead of implying a winner.
    expect(summary.verdict).toBe("insufficient_evidence");
    expect(summary.baseline.status).toBe("na");
    expect(summary.reason).toContain("no measured value");
  });

  it("reports not_comparable for a query only one side ran", () => {
    const summary = compareRankings({
      metric: "ndcgAtK",
      baseline: ranked,
      candidate: [ranked[0]!],
      judgments: judged,
      metricsFor: (r, j) =>
        evaluateQuery(["https://a.fixture.test/1"], {
          queryId: j.queryId,
          grades: new Map([["https://a.fixture.test/1", 3 as RelevanceGrade]]),
          relevantTotal: 1,
        }),
    });
    expect(summary.comparableQueries).toBe(1);
    expect(summary.verdict).toBe("insufficient_evidence");
  });
});
