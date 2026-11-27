import type { FunnelStats, QueryOrigin, SearchResponse, SearchResult, SearchStreamEvent } from "./types";

export function normalizeResultUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

export function resultKey(result: Pick<SearchResult, "id" | "url">): string {
  return normalizeResultUrl(result.url) || result.id;
}

/** Provisional events merge without changing the surviving result order. */
export function mergeProvisionalResults(current: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  const merged = [...current];
  const indices = new Map(merged.map((result, index) => [resultKey(result), index]));
  for (const result of incoming) {
    const key = resultKey(result);
    const index = indices.get(key);
    if (index === undefined) {
      indices.set(key, merged.length);
      merged.push(result);
    } else {
      merged[index] = result;
    }
  }
  return merged;
}

export function resultsFromStreamEvent(event: Extract<SearchStreamEvent, { type: "results" }>): SearchResult[] {
  return Array.isArray(event.data) ? event.data : event.data.results ?? [];
}

export interface ContributionRow {
  providerId: string;
  providerName: string;
  rawCount?: number;
  duplicatesDropped?: number;
  finalCount: number;
  topKCount: number;
  fusionScore?: number;
  failed: boolean;
  skipped: boolean;
  reason?: string;
}

export function sourceContributions(response: SearchResponse): ContributionRow[] {
  const rows = new Map<string, ContributionRow>();
  const ensure = (id: string, name?: string) => {
    if (!rows.has(id)) rows.set(id, { providerId: id, providerName: name ?? id, finalCount: 0, topKCount: 0, failed: false, skipped: false });
    else if (name) rows.get(id)!.providerName = name;
    return rows.get(id)!;
  };
  for (const stat of response.stats.providers) {
    Object.assign(ensure(stat.providerId, stat.providerName), {
      rawCount: stat.resultCount,
      failed: !stat.ok,
      reason: stat.errorCode ? `${stat.errorCode}${stat.errorMessage ? `: ${stat.errorMessage}` : ""}` : stat.warning,
    });
  }
  for (const item of response.stats.contributions ?? []) {
    Object.assign(ensure(item.providerId, item.providerName), {
      rawCount: item.rawCount,
      duplicatesDropped: item.duplicatesDropped,
      finalCount: item.finalCount ?? 0,
      topKCount: item.topKCount ?? 0,
      fusionScore: item.fusionScore,
      failed: item.failed ?? false,
      skipped: item.skipped ?? false,
      reason: item.reason,
    });
  }
  for (const result of response.results) {
    const providerIds = new Set(result.sources.map((source) => source.providerId));
    if (result.provider) providerIds.add(result.provider);
    for (const id of providerIds) ensure(id, result.providerName).finalCount += 1;
  }
  const topK = response.results.slice(0, 10);
  for (const result of topK) {
    for (const id of new Set(result.sources.map((source) => source.providerId))) {
      ensure(id).topKCount += 1;
    }
  }
  for (const item of response.excludedProviders ?? []) {
    Object.assign(ensure(item.providerId, item.providerName), { skipped: true, reason: item.reason });
  }
  return [...rows.values()];
}

export function funnelValues(funnel: FunnelStats) {
  return {
    raw: funnel.raw ?? funnel.rawCount ?? funnel.rawReceived,
    invalid: funnel.invalidDropped ?? funnel.illegalDropped,
    exact: funnel.exactDuplicates ?? funnel.exactDuplicateDropped,
    nearTitle: funnel.nearTitleDuplicates ?? funnel.nearDuplicateDropped,
    duplicates: funnel.duplicatesDropped ?? (funnel.exactDuplicateDropped !== undefined || funnel.nearDuplicateDropped !== undefined ? (funnel.exactDuplicateDropped ?? 0) + (funnel.nearDuplicateDropped ?? 0) : undefined),
    truncated: funnel.truncated ?? funnel.candidateTruncatedCount,
    rerankInput: funnel.rerankInput ?? funnel.rerankInputCount,
    final: funnel.final ?? funnel.finalCount ?? funnel.returnedCount,
  };
}

/** B1 invariant: raw = invalid + duplicates + truncated + final. Never repair server counts. */
export function funnelConsistent(funnel: FunnelStats): boolean | null {
  const values = funnelValues(funnel);
  if (values.raw === undefined || values.invalid === undefined || values.truncated === undefined || values.final === undefined) return null;
  const duplicates = values.duplicates ?? ((values.exact ?? 0) + (values.nearTitle ?? 0));
  return values.raw === values.invalid + duplicates + values.truncated + values.final;
}

export interface ComparisonRow {
  key: string;
  title: string;
  url: string;
  before?: number;
  after?: number;
  movement: "up" | "down" | "entered" | "exited" | "same";
  delta?: number;
}

export function rankingComparison(before: SearchResult[], after: SearchResult[]): ComparisonRow[] {
  const beforeMap = new Map(before.map((result, index) => [resultKey(result), { result, rank: index + 1 }]));
  const afterMap = new Map(after.map((result, index) => [resultKey(result), { result, rank: index + 1 }]));
  const rows: ComparisonRow[] = [];
  for (const [key, value] of beforeMap) {
    const next = afterMap.get(key);
    const delta = next ? value.rank - next.rank : undefined;
    rows.push({ key, title: value.result.title, url: value.result.url, before: value.rank, after: next?.rank,
      movement: !next ? "exited" : delta! > 0 ? "up" : delta! < 0 ? "down" : "same", delta });
  }
  for (const [key, value] of afterMap) {
    if (!beforeMap.has(key)) rows.push({ key, title: value.result.title, url: value.result.url, after: value.rank, movement: "entered" });
  }
  return rows;
}

export function expansionQueries(response: SearchResponse): QueryOrigin[] {
  if (Array.isArray(response.queryExpansion)) return response.queryExpansion;
  return response.queryExpansion?.queries ?? response.debug?.queryOrigins ?? [];
}

export function queryOriginsForResult(result: SearchResult, all: QueryOrigin[] = []): QueryOrigin[] {
  return result.queryOrigins ?? all.filter((origin) => {
    const url = (origin as QueryOrigin & { url?: string }).url;
    return url ? normalizeResultUrl(url) === normalizeResultUrl(result.url) : false;
  });
}

function stripMetadataRaw(result: SearchResult): void {
  delete result.raw;
  if (!result.metadata || typeof result.metadata !== "object") return;
  delete result.metadata.raw;
  if (Object.keys(result.metadata).length === 0) delete result.metadata;
}

/** Clone a response for export while removing upstream raw payloads only. */
export function withoutRawPayloads(response: SearchResponse): SearchResponse {
  const cloned = structuredClone(response);
  for (const result of cloned.results) stripMetadataRaw(result);
  for (const entry of cloned.debug?.perProviderResults ?? []) {
    for (const result of entry.results) stripMetadataRaw(result);
  }
  for (const result of cloned.debug?.rerankComparison?.before ?? []) stripMetadataRaw(result);
  for (const result of cloned.debug?.rerankComparison?.after ?? []) stripMetadataRaw(result);
  return cloned;
}
