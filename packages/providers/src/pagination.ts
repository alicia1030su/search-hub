import type { RawSearchResult, ResolvedSearchConfig } from "@search-hub/shared";

/**
 * Multi-request pagination for adapters.
 *
 * Each vendor pages differently (offset, page number, cursor), so the adapter
 * supplies a `fetchPage` and this helper handles the parts that are easy to get
 * wrong: the request budget, stopping when the vendor returns a short page, and
 * de-duplicating rows that appear on two pages.
 *
 * It never pads results. If the vendor has fewer rows, the caller gets fewer
 * rows — the count we report must be the count we actually received.
 */
export interface PaginateOptions {
  /** Resolved platform config (target rows, page size, budgets). */
  search: ResolvedSearchConfig;
  /** Fetches one page. `index` is 0-based. Return an empty array to stop. */
  fetchPage: (index: number, pageSize: number) => Promise<RawSearchResult[]>;
  /** Hard stop when the adapter knows the vendor cannot page further. */
  maxPages?: number;
  signal?: AbortSignal;
}

export interface PaginateResult {
  results: RawSearchResult[];
  /** Requests actually made (never more than the budget). */
  requests: number;
  /** True when the plan wanted more rows but the vendor ran out. */
  exhausted: boolean;
}

export async function paginate(options: PaginateOptions): Promise<PaginateResult> {
  const { search, fetchPage } = options;
  const budget = Math.max(1, search.maxRequestsPerSearch);
  const pageLimit = Math.max(1, Math.min(search.maxPages, options.maxPages ?? Number.MAX_SAFE_INTEGER));

  const collected: RawSearchResult[] = [];
  const seen = new Set<string>();
  let requests = 0;
  let exhausted = false;

  for (let index = 0; index < Math.min(budget, pageLimit); index += 1) {
    if (options.signal?.aborted) break;
    const page = await fetchPage(index, search.pageSize);
    requests += 1;
    for (const item of page) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      collected.push(item);
    }
    if (collected.length >= search.targetResults) break;
    // A short page means the vendor has nothing further; asking again would
    // waste a paid request.
    if (page.length < search.pageSize) {
      exhausted = true;
      break;
    }
  }

  return {
    results: collected.slice(0, search.targetResults),
    requests,
    exhausted: exhausted || collected.length < search.targetResults,
  };
}

/**
 * Splits a comma/space separated domain list into vendor-safe hostnames.
 * Paths and schemes are stripped because most vendors reject them.
 */
export function normalizeDomains(value: string[] | undefined): string[] {
  if (!value) return [];
  return value
    .map((item) => item.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, ""))
    .filter((item) => item.length > 0 && item.includes("."))
    .slice(0, 50);
}
