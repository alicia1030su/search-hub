import { SearchHubError, type SearchProviderAdapter } from "@search-hub/shared";
import { bochaAdapter } from "./builtin/bocha.js";
import { braveAdapter } from "./builtin/brave.js";
import { genericHttpAdapter } from "./builtin/generic.js";
import { hackerNewsAdapter } from "./builtin/hackernews.js";
import { mockAdapter } from "./builtin/mock.js";
import { searxngAdapter } from "./builtin/searxng.js";
import { tavilyAdapter } from "./builtin/tavily.js";
import { getCatalogEntry, PROVIDER_CATALOG } from "./catalog.js";

const ADAPTERS: SearchProviderAdapter[] = [
  tavilyAdapter,
  bochaAdapter,
  braveAdapter,
  searxngAdapter,
  hackerNewsAdapter,
  genericHttpAdapter,
  mockAdapter,
];

const ADAPTER_MAP = new Map(ADAPTERS.map((adapter) => [adapter.type, adapter]));

export function getAdapter(type: string): SearchProviderAdapter | undefined {
  return ADAPTER_MAP.get(type);
}

export function requireAdapter(type: string): SearchProviderAdapter {
  const adapter = ADAPTER_MAP.get(type);
  if (!adapter) {
    const entry = getCatalogEntry(type);
    const detail = entry
      ? `Provider type "${type}" is ${entry.implementation}: ${entry.description}`
      : `Unknown provider type "${type}"`;
    throw new SearchHubError("unsupported", detail);
  }
  return adapter;
}

export function listAdapters(): Array<{
  type: string;
  name: string;
  requiresKey: boolean;
  supportsTest: boolean;
}> {
  return ADAPTERS.map((adapter) => ({
    type: adapter.type,
    name: getCatalogEntry(adapter.type)?.name ?? adapter.type,
    requiresKey: adapter.requiresKey,
    supportsTest: adapter.supportsTest,
  }));
}

export function isAdapterImplemented(type: string): boolean {
  return ADAPTER_MAP.has(type);
}

export { PROVIDER_CATALOG, getCatalogEntry };
