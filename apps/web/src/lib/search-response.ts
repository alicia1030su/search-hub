import type { SearchResponse, SearchResult } from "./types";

function stripMetadataRaw(result: SearchResult): void {
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
  return cloned;
}
