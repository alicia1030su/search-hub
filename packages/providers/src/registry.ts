import { SearchHubError, type SearchProviderAdapter } from "@search-hub/shared";
import { bochaAdapter } from "./builtin/bocha.js";
import { braveAdapter } from "./builtin/brave.js";
import { genericHttpAdapter } from "./builtin/generic.js";
import { hackerNewsAdapter } from "./builtin/hackernews.js";
import { legacySearchHubAdapter } from "./builtin/legacy-search-hub.js";
import { duckduckgoAdapter } from "./builtin/duckduckgo.js";
import { genericMcpAdapter } from "./builtin/generic-mcp.js";
import { anthropicWebSearchAdapter } from "./builtin/anthropic-websearch.js";
import { crossrefAdapter } from "./builtin/crossref.js";
import { dataforseoAdapter } from "./builtin/dataforseo.js";
import { europepmcAdapter } from "./builtin/europepmc.js";
import { gdeltAdapter } from "./builtin/gdelt.js";
import { jinaSearchAdapter } from "./builtin/jina-search.js";
import { kakaoAdapter } from "./builtin/kakao.js";
import { linkupSearchAdapter } from "./builtin/linkup-search.js";
import { mistralWebSearchAdapter } from "./builtin/mistral-websearch.js";
import { naverAdapter } from "./builtin/naver.js";
import { openaiWebSearchAdapter } from "./builtin/openai-websearch.js";
import { openalexAdapter } from "./builtin/openalex.js";
import { parallelSearchAdapter } from "./builtin/parallel-search.js";
import { perplexitySearchAdapter } from "./builtin/perplexity-search.js";
import { perplexitySonarAdapter } from "./builtin/perplexity-sonar.js";
import { pubmedAdapter } from "./builtin/pubmed.js";
import { searchapiAdapter } from "./builtin/searchapi.js";
import { semanticscholarAdapter } from "./builtin/semanticscholar.js";
import { serpapiAdapter } from "./builtin/serpapi.js";
import { wikipediaAdapter } from "./builtin/wikipedia.js";
import { yandexAdapter } from "./builtin/yandex.js";
import { youcomAdapter } from "./builtin/youcom.js";
import { arxivAdapter } from "./builtin/arxiv.js";
import { exaAdapter } from "./builtin/exa.js";
import { firecrawlAdapter } from "./builtin/firecrawl.js";
import { githubAdapter } from "./builtin/github.js";
import { serperAdapter } from "./builtin/serper.js";
import { geminiAdapter } from "./builtin/gemini.js";
import { grokAdapter } from "./builtin/grok.js";
import { mimoAdapter } from "./builtin/mimo.js";
import { bailianAdapter } from "./builtin/bailian.js";
import { stepfunAdapter } from "./builtin/stepfun.js";
import { tencentYuanbaoAdapter } from "./builtin/tencent-yuanbao.js";
import { doubaoAdapter } from "./builtin/doubao.js";
import { deepseekSearchAdapter } from "./builtin/deepseek-search.js";
import { qianfanSearchAdapter } from "./builtin/qianfan-search.js";
import { anySearchAdapter } from "./builtin/anysearch.js";
import { mockAdapter } from "./builtin/mock.js";
import { searxngAdapter } from "./builtin/searxng.js";
import { tavilyAdapter } from "./builtin/tavily.js";
import { getCatalogEntry, PROVIDER_CATALOG } from "./catalog.js";

const ADAPTERS: SearchProviderAdapter[] = [
  duckduckgoAdapter,
  genericMcpAdapter,
  perplexitySearchAdapter,
  youcomAdapter,
  jinaSearchAdapter,
  parallelSearchAdapter,
  linkupSearchAdapter,
  serpapiAdapter,
  searchapiAdapter,
  dataforseoAdapter,
  openaiWebSearchAdapter,
  anthropicWebSearchAdapter,
  mistralWebSearchAdapter,
  perplexitySonarAdapter,
  naverAdapter,
  kakaoAdapter,
  yandexAdapter,
  wikipediaAdapter,
  crossrefAdapter,
  openalexAdapter,
  pubmedAdapter,
  semanticscholarAdapter,
  europepmcAdapter,
  gdeltAdapter,
  exaAdapter,
  firecrawlAdapter,
  serperAdapter,
  githubAdapter,
  arxivAdapter,
  geminiAdapter,
  grokAdapter,
  mimoAdapter,
  bailianAdapter,
  stepfunAdapter,
  tencentYuanbaoAdapter,
  doubaoAdapter,
  deepseekSearchAdapter,
  qianfanSearchAdapter,
  anySearchAdapter,
  tavilyAdapter,
  bochaAdapter,
  braveAdapter,
  searxngAdapter,
  hackerNewsAdapter,
  genericHttpAdapter,
  legacySearchHubAdapter,
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
