/**
 * Category aggregation and document movements.
 *
 * Both functions decide what a report is allowed to claim, so the assertions
 * below are about *claims*, not just numbers:
 *
 *  - a category that a query belongs to twice must count it once;
 *  - a group of two queries must be marked as a small sample rather than
 *    silently averaged into a headline;
 *  - a document that appears on one side only did not "move by N", and its
 *    delta must be null rather than 0 or Infinity.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateByCategory,
  evaluateQuery,
  groupQueriesByCategory,
  queryMovements,
  type CategorisedQuery,
  type QueryJudgments,
  type RelevanceGrade,
} from "@search-hub/core";

function judgments(grades: Record<string, RelevanceGrade>): QueryJudgments {
  const map = new Map(Object.entries(grades));
  return {
    queryId: "q",
    grades: map,
    relevantTotal: [...map.values()].filter((grade) => grade >= 2).length,
  };
}

describe("groupQueriesByCategory", () => {
  const queries: CategorisedQuery[] = [
    { queryId: "q1", categories: ["code", "english"] },
    { queryId: "q2", categories: ["code"] },
    { queryId: "q3", categories: ["news"] },
  ];

  it("counts a multi-label query once in each of its categories", () => {
    const groups = groupQueriesByCategory(queries);
    expect(groups.get("code")).toEqual(["q1", "q2"]);
    expect(groups.get("english")).toEqual(["q1"]);
    expect(groups.get("news")).toEqual(["q3"]);
  });

  it("counts a query once even when a label repeats", () => {
    const groups = groupQueriesByCategory([{ queryId: "q1", categories: ["code", "code"] }]);
    expect(groups.get("code")).toEqual(["q1"]);
  });

  it("restricts to the primary label when asked", () => {
    const groups = groupQueriesByCategory(queries, { primaryOnly: true });
    expect(groups.get("code")).toEqual(["q1", "q2"]);
    expect(groups.get("english")).toBeUndefined();
  });
});

describe("aggregateByCategory", () => {
  const queries: CategorisedQuery[] = [
    { queryId: "q1", categories: ["code", "english"] },
    { queryId: "q2", categories: ["code"] },
  ];
  const ranked = ["https://a.fixture.test/1", "https://b.fixture.test/1"];
  const metricsFor = (queryId: string) => ({
    ...evaluateQuery(ranked, judgments({ [ranked[0]!]: 3 }), { cutoff: 10 }),
    queryId,
  });
  const perQuery = [metricsFor("q1"), metricsFor("q2")];

  it("reports one row per category with its own query count", () => {
    const breakdown = aggregateByCategory(perQuery, queries);
    const code = breakdown.groups.find((group) => group.category === "code");
    const english = breakdown.groups.find((group) => group.category === "english");
    expect(code?.queryCount).toBe(2);
    expect(english?.queryCount).toBe(1);
  });

  it("says the groups overlap, which is why the counts exceed the query total", () => {
    const breakdown = aggregateByCategory(perQuery, queries);
    expect(breakdown.overlappingGroups).toBe(true);
    const summed = breakdown.groups.reduce((total, group) => total + group.queryCount, 0);
    expect(summed).toBeGreaterThan(queries.length);
  });

  it("partitions the dataset when restricted to primary labels", () => {
    const breakdown = aggregateByCategory(perQuery, queries, "ndcgAtK", { primaryOnly: true });
    expect(breakdown.overlappingGroups).toBe(true);
    const summed = breakdown.groups.reduce((total, group) => total + group.queryCount, 0);
    expect(summed).toBe(queries.length);
  });

  it("flags a two-query group as a small sample", () => {
    const breakdown = aggregateByCategory(perQuery, queries);
    expect(breakdown.groups.every((group) => group.lowSample)).toBe(true);
  });

  it("keeps recall N/A rather than zero when the qrels are shallow", () => {
    const shallow: QueryJudgments = {
      queryId: "q1",
      grades: new Map([["https://a.fixture.test/1", 3 as RelevanceGrade]]),
      relevantTotal: null,
    };
    const metrics = { ...evaluateQuery(ranked, shallow, { cutoff: 10 }), queryId: "q1" };
    const breakdown = aggregateByCategory([metrics], [{ queryId: "q1", categories: ["code"] }]);
    const code = breakdown.groups.find((group) => group.category === "code");
    expect(code?.recallAtK.status).toBe("na");
    expect(code?.recallAtK.value).toBeNull();
  });
});

describe("queryMovements", () => {
  const doc = (id: string, title = id) => ({
    documentId: `https://${id}.fixture.test/p`,
    url: `https://${id}.fixture.test/p`,
    title,
  });
  const grades = new Map<string, RelevanceGrade>([
    [doc("a").documentId, 3],
    [doc("b").documentId, 2],
    [doc("c").documentId, 1],
  ]);

  it("reports a rise as a positive delta and a fall as a negative one", () => {
    const baseline = [doc("a"), doc("b"), doc("c")];
    const candidate = [doc("b"), doc("a"), doc("c")];
    const movements = queryMovements("q1", "code", baseline, candidate, grades);
    const a = movements.rows.find((row) => row.url === doc("a").url);
    const b = movements.rows.find((row) => row.url === doc("b").url);
    expect(a?.movement).toBe("down");
    expect(a?.deltaPositions).toBe(-1);
    expect(b?.movement).toBe("up");
    expect(b?.deltaPositions).toBe(1);
  });

  it("marks a new document as entered with a null delta, never zero", () => {
    const baseline = [doc("a")];
    const candidate = [doc("a"), doc("b")];
    const movements = queryMovements("q1", "code", baseline, candidate, grades);
    const b = movements.rows.find((row) => row.url === doc("b").url);
    expect(b?.movement).toBe("entered");
    expect(b?.baselineRank).toBeNull();
    expect(b?.candidateRank).toBe(2);
    expect(b?.deltaPositions).toBeNull();
  });

  it("marks a dropped document as exited with a null delta", () => {
    const baseline = [doc("a"), doc("b")];
    const candidate = [doc("a")];
    const movements = queryMovements("q1", "code", baseline, candidate, grades);
    const b = movements.rows.find((row) => row.url === doc("b").url);
    expect(b?.movement).toBe("exited");
    expect(b?.candidateRank).toBeNull();
    expect(b?.deltaPositions).toBeNull();
  });

  it("does not report a document that was in neither ranking", () => {
    const movements = queryMovements("q1", "code", [doc("a")], [doc("a")], grades);
    expect(movements.rows.find((row) => row.url === doc("b").url)).toBeUndefined();
  });

  it("withholds unjudged movements by default and counts them", () => {
    const baseline = [doc("a")];
    const candidate = [doc("z"), doc("a")];
    const movements = queryMovements("q1", "code", baseline, candidate, grades);
    expect(movements.rows.find((row) => row.url === doc("z").url)).toBeUndefined();
    expect(movements.hiddenUnjudgedMovements).toBe(1);
  });

  it("shows them when explicitly asked, still flagged as unjudged", () => {
    const baseline = [doc("a")];
    const candidate = [doc("z"), doc("a")];
    const movements = queryMovements("q1", "code", baseline, candidate, grades, { includeUnjudged: true });
    const z = movements.rows.find((row) => row.url === doc("z").url);
    expect(z?.relevance).toBeNull();
    expect(z?.movement).toBe("entered");
  });

  it("is deterministic and caps the rows it returns", () => {
    const baseline = [doc("a"), doc("b"), doc("c")];
    const candidate = [doc("c"), doc("b"), doc("a")];
    const first = queryMovements("q1", "code", baseline, candidate, grades, { maxPerQuery: 1 });
    const second = queryMovements("q1", "code", baseline, candidate, grades, { maxPerQuery: 1 });
    expect(first).toEqual(second);
    expect(first.rows).toHaveLength(1);
    expect(first.truncatedCount).toBe(1);
  });
});
