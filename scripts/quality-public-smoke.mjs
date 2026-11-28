#!/usr/bin/env node
/** Real keyless public-provider smoke evidence; never an ABBA quality claim. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSafeFetch } from "../packages/shared/src/safe-fetch.ts";
import { duckduckgoAdapter } from "../packages/providers/src/builtin/duckduckgo.ts";
import { wikipediaAdapter } from "../packages/providers/src/builtin/wikipedia.ts";
import { snapshotFingerprint } from "../packages/core/src/evaluation/snapshot.ts";

const PROVIDERS = {
  wikipedia: { adapter: wikipediaAdapter, baseUrl: "https://en.wikipedia.org" },
  duckduckgo: { adapter: duckduckgoAdapter, baseUrl: "https://api.duckduckgo.com" },
};

export async function runPublicSmoke({ provider, query, out, safeFetch = createSafeFetch({ timeoutMs: 15_000 }) }) {
  if (!PROVIDERS[provider]) throw new Error(`unsupported public provider: ${provider}`);
  if (typeof query !== "string" || !query.trim()) throw new Error("query is required");
  const selected = PROVIDERS[provider];
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
  const ctx = {
    fetch: safeFetch,
    config: {
      id: `public-${provider}`, name: provider, type: provider, baseUrl: selected.baseUrl,
      timeoutMs: 15_000, maxResults: 5, language: "en", freshness: null, model: null,
      maxRetries: 0, breakerThreshold: 5, breakerCooldownMs: 30_000, config: {},
      search: { targetResults: 5, maxPages: 1, maxRequestsPerSearch: 1, pageSize: 5 },
    },
    signal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  let result;
  try {
    const output = await selected.adapter.search({ query, limit: 5, signal }, ctx);
    result = { ok: output.results.length > 0, resultCount: output.results.length, results: output.results, warnings: output.warnings };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    controller.abort();
  }
  const report = {
    format: "search-hub.public-provider-smoke/1",
    evidenceKind: "single_implementation_public_provider",
    abba: false,
    provider,
    query,
    startedAt,
    finishedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    resultHash: snapshotFingerprint(result),
    ...result,
  };
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const provider = flag("provider", "wikipedia");
  const query = flag("query", "search engine");
  const out = flag("out", `deliverables/quality-public-smoke-${provider}.json`);
  runPublicSmoke({ provider, query, out }).then((report) => {
    console.log(JSON.stringify({ ok: report.ok, resultCount: report.resultCount ?? 0, latencyMs: report.latencyMs, error: report.error ?? null, evidenceHash: report.resultHash }));
    if (!report.ok) process.exitCode = 4;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
