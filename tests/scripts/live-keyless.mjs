/**
 * Real network verification for the keyless providers.
 *
 * These providers need no credential, so they *can* be exercised for real from
 * a build machine. Everything else in the catalogue stays `documented` because
 * no vendor credential exists in this environment.
 *
 * Usage: node tests/scripts/live-keyless.mjs
 * Exit code 0 when at least one result came back from every provider listed.
 */
import { createSafeFetch } from "../../packages/shared/src/index.ts";

const providers = [
  { type: "openalex", url: "https://api.openalex.org/works?search=transformer&per-page=2" },
  { type: "crossref", url: "https://api.crossref.org/works?query=transformer&rows=2" },
  {
    type: "pubmed-esearch",
    url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=transformer&retmode=json&retmax=2",
  },
];

const fetchSafe = createSafeFetch({
  policy: { allowPrivateHosts: [], maxRedirects: 0, allowHttp: false },
});

let failures = 0;
for (const provider of providers) {
  const started = Date.now();
  try {
    const response = await fetchSafe(provider.url, { method: "GET", timeoutMs: 20_000 });
    const elapsed = Date.now() - started;
    const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
    const ok = response.status === 200 && body.length > 40;
    console.log(`${ok ? "PASS" : "FAIL"}  ${provider.type.padEnd(18)} status=${response.status} bytes=${body.length} ${elapsed}ms`);
    if (!ok) failures += 1;
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${provider.type.padEnd(18)} ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(failures === 0 ? "\nAll keyless providers answered." : `\n${failures} keyless provider(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
