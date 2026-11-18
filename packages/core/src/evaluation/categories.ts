/**
 * Category aggregation for the evaluation reports.
 *
 * A query may carry more than one category label — "typescript satisfies
 * operator" is both `code` and `english` — and the point of labelling it twice
 * is to have it counted in both columns. That has a consequence every caller
 * must state out loud: the per-category query counts do **not** sum to the
 * number of queries in the dataset.
 *
 * Nothing here re-normalises a score. A category with two queries reports the
 * mean of two queries and `lowSample: true`; averaging it into a headline that
 * claims to describe the whole dataset is exactly the false precision this lab
 * exists to prevent.
 */
import { aggregateMetric, type AggregateMetric } from "./metrics.js";
import { MIN_SAMPLE } from "./primitives.js";
import type { MetricValue, QueryCategory, QueryMetrics } from "./types.js";

export interface CategorisedQuery {
  queryId: string;
  /** Primary label first, then the secondary labels. */
  categories: readonly QueryCategory[];
}

export interface CategoryGroup {
  category: QueryCategory;
  /** Queries that carry this label. */
  queryCount: number;
  /** Queries that produced a measured value for the aggregate. */
  comparable: number;
  lowSample: boolean;
  precisionAtK: MetricValue;
  recallAtK: MetricValue;
  mrrAtK: MetricValue;
  ndcgAtK: MetricValue;
}

export interface CategoryBreakdown {
  groups: CategoryGroup[];
  /**
   * True when at least one query carries more than one label, which is what
   * makes the totals overlap.
   */
  overlappingGroups: boolean;
  /**
   * Set only when the caller restricted itself to primary labels: then the
   * groups partition the dataset and `queryCount` sums to the query total.
   */
  primaryOnly: boolean;
}

/**
 * Groups queries by every label they carry.
 *
 * Duplicate labels on one query are collapsed: a query is counted once per
 * category, not once per mention.
 */
export function groupQueriesByCategory(
  queries: readonly CategorisedQuery[],
  options: { primaryOnly?: boolean } = {},
): Map<QueryCategory, string[]> {
  const groups = new Map<QueryCategory, string[]>();
  for (const query of queries) {
    const labels = options.primaryOnly ? query.categories.slice(0, 1) : query.categories;
    const seen = new Set<QueryCategory>();
    for (const label of labels) {
      if (seen.has(label)) continue;
      seen.add(label);
      const list = groups.get(label) ?? [];
      list.push(query.queryId);
      groups.set(label, list);
    }
  }
  return groups;
}

/**
 * Aggregates per-query metrics into one row per category.
 *
 * `metric` only selects which value is used to decide `comparable`; every
 * metric is reported for every group, because a group with a measurable nDCG
 * and an unmeasurable recall is a normal state (shallow qrels) and hiding the
 * measurable one helps nobody.
 */
export function aggregateByCategory(
  perQuery: readonly QueryMetrics[],
  queries: readonly CategorisedQuery[],
  metric: AggregateMetric = "ndcgAtK",
  options: { primaryOnly?: boolean } = {},
): CategoryBreakdown {
  const byId = new Map(perQuery.map((item) => [item.queryId, item]));
  const groups = groupQueriesByCategory(queries, options);
  const overlapping = queries.some((query) => new Set(query.categories).size > 1);

  const rows: CategoryGroup[] = [];
  for (const [category, queryIds] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const measured = queryIds
      .map((id) => byId.get(id))
      .filter((item): item is QueryMetrics => item !== undefined);
    const precisionAtK = aggregateMetric(measured, "precisionAtK");
    const recallAtK = aggregateMetric(measured, "recallAtK");
    const mrrAtK = aggregateMetric(measured, "mrrAtK");
    const ndcgAtK = aggregateMetric(measured, "ndcgAtK");
    rows.push({
      category,
      queryCount: queryIds.length,
      comparable: measured.filter((item) => item[metric].status === "ok").length,
      lowSample: queryIds.length < MIN_SAMPLE,
      precisionAtK,
      recallAtK,
      mrrAtK,
      ndcgAtK,
    });
  }

  return {
    groups: rows,
    overlappingGroups: overlapping,
    primaryOnly: options.primaryOnly === true,
  };
}
