import { createSafeFetch, type ProviderContext, type ProviderRuntimeConfig } from "../../packages/shared/src/index.ts";
import { crossrefAdapter, openalexAdapter, pubmedAdapter } from "../../packages/providers/src/index.ts";

const fetchSafe = createSafeFetch({ policy: { allowPrivateHosts: [], maxRedirects: 0, allowHttp: false } });

function ctx(type: string): ProviderContext {
  const config: ProviderRuntimeConfig = {
    id: `prv_${type}`,
    name: type,
    type,
    baseUrl: null,
    timeoutMs: 20_000,
    maxResults: 3,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 3,
    breakerCooldownMs: 30_000,
    config: {},
    search: { targetResults: 3, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 3 },
  };
  return { fetch: fetchSafe, config, signal: AbortSignal.timeout(20_000), logger: console as never };
}

const cases = [
  { name: "crossref", adapter: crossrefAdapter, query: "transformer attention" },
  { name: "openalex", adapter: openalexAdapter, query: "transformer attention" },
  { name: "pubmed", adapter: pubmedAdapter, query: "transformer attention" },
];

let failed = 0;
for (const item of cases) {
  const started = Date.now();
  try {
    const output = await item.adapter.search(
      { query: item.query, limit: 3, signal: AbortSignal.timeout(20_000) },
      ctx(item.name),
    );
    const first = output.results[0];
    const ok = output.results.length > 0 && Boolean(first?.title) && /^https?:\/\//.test(first?.url ?? "");
    console.log(
      `${ok ? "PASS" : "FAIL"} ${item.name.padEnd(10)} rows=${output.results.length} ${Date.now() - started}ms  ${first?.url ?? "-"}`,
    );
    if (!ok) failed += 1;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${item.name.padEnd(10)} ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
