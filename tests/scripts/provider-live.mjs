#!/usr/bin/env node
/**
 * Live (real network) verification for one builtin search adapter.
 *
 * This is the ONLY script that may produce a candidate `live_tested` evidence
 * record. It calls the real adapter against the real vendor endpoint — no
 * mocks, no fixtures. A green run still requires human review before the
 * catalog is changed.
 *
 * Usage (tsx is required because the adapters are TypeScript sources):
 *   pnpm exec tsx tests/scripts/provider-live.mjs --provider wikipedia --output docs/live-evidence/wikipedia.json
 *   TAVILY_API_KEY=... pnpm exec tsx tests/scripts/provider-live.mjs --provider tavily --output docs/live-evidence/tavily.json
 *
 * Options:
 *   --provider <name>       required; see PROVIDERS below
 *   --base-url <url>        override the official endpoint (staging/proxy)
 *   --limit <n>             results per query (default 5)
 *   --output <file>         write a structured, redacted evidence JSON record
 *
 * Exit codes:
 *   0  LIVE PASSED — every query returned non-empty, https, non-placeholder URLs
 *   1  FAIL — auth, transport, business or mapping problem
 *   2  SKIPPED: required credential missing — deliberately NOT 0
 *
 * CREDENTIAL HANDLING:
 * - Keys are read only from the environment. There is no --key option.
 * - Every string that may contain third-party data is scrubbed before printing
 *   or writing an evidence file.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText, providerKeysFromEnv } from "./redact-secrets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLACEHOLDER_HOSTS = ["example.com", "example.org", "example.net", "localhost", "127.0.0.1"];

const GENERAL_QUERIES = [
  { label: "zh-current-affairs", query: "中国 新能源汽车 产业 最新政策", freshness: "month" },
  { label: "en-tech", query: "typescript monorepo best practices" },
];

const PROVIDERS = {
  tavily: { env: "TAVILY_API_KEY", label: "Tavily", credential: "required", queries: GENERAL_QUERIES },
  bocha: { env: "BOCHA_API_KEY", label: "Bocha", credential: "required", queries: GENERAL_QUERIES },
  brave: { env: "BRAVE_API_KEY", label: "Brave", credential: "required", queries: GENERAL_QUERIES },
  wikipedia: {
    env: null,
    label: "Wikipedia",
    credential: "none",
    queries: [
      { label: "en-encyclopedia", query: "search engine" },
      { label: "zh-encyclopedia", query: "人工智能" },
    ],
    config: { language: "en" },
    allowedHosts: ["wikipedia.org"],
  },
  arxiv: {
    env: null,
    label: "arXiv",
    credential: "none",
    queries: [
      { label: "en-preprint", query: "transformer attention" },
      { label: "en-preprint-2", query: "graph neural networks" },
    ],
    config: {},
    allowedHosts: ["arxiv.org"],
  },
  github: {
    env: null,
    label: "GitHub",
    credential: "none",
    queries: [
      { label: "en-repositories", query: "search engine" },
      { label: "en-repositories-2", query: "typescript monorepo" },
    ],
    config: { kind: "repositories" },
    allowedHosts: ["api.github.com"],
  },
};

const CONFIGURED_KEYS = providerKeysFromEnv();

function scrub(text) {
  return redactText(text, CONFIGURED_KEYS);
}

function say(message) {
  console.log(scrub(message));
}

function warn(message) {
  console.error(scrub(message));
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function fail(message) {
  warn(`FAIL: ${message}`);
  process.exit(1);
}

function isUsableUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not an absolute URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol}` };
  const host = url.hostname.toLowerCase();
  if (PLACEHOLDER_HOSTS.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return { ok: false, reason: `placeholder host ${host}` };
  }
  return { ok: true };
}

function hostAllowed(rawUrl, allowedHosts) {
  if (!allowedHosts?.length) return true;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return allowedHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function sourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function adapterVersion() {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function writeEvidence(output, evidence) {
  if (!output) return;
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), scrub(`${JSON.stringify(evidence, null, 2)}\n`), "utf8");
}

async function main() {
  const providerName = arg("provider");
  if (!providerName || !(providerName in PROVIDERS)) {
    fail(`--provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  const provider = PROVIDERS[providerName];
  const key = provider.env ? (process.env[provider.env] ?? "") : "";
  if (provider.credential === "required" && !key) {
    say(`SKIPPED: no credential (set ${provider.env})`);
    process.exit(2);
  }

  let adapters;
  let shared;
  try {
    adapters = await import("../../packages/providers/src/index.ts");
    shared = await import("../../packages/shared/src/index.ts");
  } catch (error) {
    if (process.env["PROVIDER_LIVE_TSX"] !== "1") {
      const { spawnSync } = await import("node:child_process");
      const reexec = spawnSync(
        process.execPath,
        ["--import", "tsx", process.argv[1], ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, PROVIDER_LIVE_TSX: "1" } },
      );
      process.exit(reexec.status ?? 1);
    }
    warn("FAIL: the TypeScript adapters could not be loaded.");
    warn(`Run through tsx: pnpm exec tsx tests/scripts/provider-live.mjs --provider ${providerName}`);
    warn(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const adapter = adapters.getAdapter(providerName);
  if (!adapter) fail(`no builtin adapter registered for "${providerName}"`);

  const baseUrl = arg("base-url") ?? null;
  if (baseUrl && !hostAllowed(baseUrl, provider.allowedHosts)) {
    fail(`--base-url host is not allowed for ${providerName}`);
  }
  const limit = Number(arg("limit") ?? 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("--limit must be an integer from 1 to 50");
  const output = arg("output");
  const safeFetch = shared.createSafeFetch({
    timeoutMs: 20_000,
    ...(process.env["SEARCH_HUB_LIVE_PROXY"] || process.env["HTTPS_PROXY"] || process.env["HTTP_PROXY"]
      ? {
          proxy: {
            proxy: process.env["SEARCH_HUB_LIVE_PROXY"] || process.env["HTTPS_PROXY"] || process.env["HTTP_PROXY"],
            noProxy: process.env["NO_PROXY"] ?? process.env["no_proxy"] ?? null,
            proxyTrust: "untrusted",
          },
        }
      : {}),
  });
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const observations = [];
  const recordingFetch = async (url, init) => {
    const response = await safeFetch(url, init);
    observations.push({
      url: shared.sanitizeUrl(response.url || String(url), key ? [key] : []),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
    });
    return response;
  };

  say(`LIVE: provider=${providerName} endpoint=${baseUrl ?? "official default"} limit=${limit}`);
  say(provider.credential === "none" ? "LIVE: keyless provider" : "LIVE: credential loaded (value never printed)");

  const failures = [];
  const attempts = [];
  let lastSuccess = null;

  for (const query of provider.queries) {
    const config = {
      id: `live_${providerName}`,
      name: provider.label,
      type: providerName,
      baseUrl,
      timeoutMs: 20_000,
      maxResults: limit,
      language: null,
      freshness: null,
      model: null,
      maxRetries: 0,
      breakerThreshold: 3,
      breakerCooldownMs: 30_000,
      config: provider.config ?? {},
    };
    const controller = new AbortController();
    const ctx = {
      fetch: recordingFetch,
      ...(key ? { apiKey: key } : {}),
      config,
      signal: controller.signal,
      logger: silentLogger,
    };

    const started = Date.now();
    let result;
    try {
      result = await adapter.search(
        {
          query: query.query,
          limit,
          ...(query.freshness === undefined ? {} : { freshness: query.freshness }),
          signal: controller.signal,
        },
        ctx,
      );
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${query.label}: ${code} — ${message}`);
      attempts.push({ label: query.label, query: query.query, ok: false, code, message: scrub(message) });
      warn(`FAIL ${query.label}: ${code} — ${message}`);
      continue;
    } finally {
      controller.abort();
    }

    const latencyMs = Date.now() - started;
    const results = result.results ?? [];
    const observation = observations.at(-1) ?? { url: result.requestUrl ?? "", status: 0, contentType: "" };
    const attempt = {
      label: query.label,
      query: query.query,
      ok: results.length > 0 && observation.status === 200,
      httpStatus: observation.status,
      resultCount: results.length,
      latencyMs,
      requestUrl: observation.url,
    };
    attempts.push(attempt);

    say(`\n[${query.label}] "${query.query}" -> ${results.length} result(s) in ${latencyMs}ms (HTTP ${observation.status})`);
    if (results.length === 0) {
      failures.push(`${query.label}: returned zero results`);
      warn(`FAIL ${query.label}: returned zero results`);
      continue;
    }
    if (observation.status !== 200) {
      failures.push(`${query.label}: unexpected HTTP ${observation.status}`);
      continue;
    }

    results.slice(0, 3).forEach((item, index) => {
      say(`  ${index + 1}. ${item.title}`);
      say(`     ${item.url}`);
      if (item.publishedAt) say(`     published: ${item.publishedAt}`);
    });

    const badUrl = results.map((item) => ({ item, check: isUsableUrl(item.url) })).find((entry) => !entry.check.ok);
    if (badUrl) {
      failures.push(`${query.label}: unusable url ${badUrl.item.url} (${badUrl.check.reason})`);
      warn(`FAIL ${query.label}: unusable url ${badUrl.item.url} (${badUrl.check.reason})`);
    }
    const missingTitle = results.find((item) => !item.title || item.title.trim().length === 0);
    if (missingTitle) {
      failures.push(`${query.label}: a result is missing a title`);
      warn(`FAIL ${query.label}: a result is missing a title`);
    }
    const duplicateUrls = results.length - new Set(results.map((item) => item.url)).size;
    if (duplicateUrls > 0) {
      failures.push(`${query.label}: ${duplicateUrls} duplicate url(s) in one response`);
      warn(`FAIL ${query.label}: ${duplicateUrls} duplicate url(s)`);
    }

    if (!lastSuccess && failures.length === 0) {
      lastSuccess = {
        checkedAt: new Date().toISOString(),
        requestUrl: observation.url,
        httpStatus: observation.status,
        resultCount: results.length,
        sampleUrls: results.slice(0, 3).map((item) => item.url),
        latencyMs,
        recordedBy: process.env["GITHUB_RUN_ID"] ? "provider-live workflow" : "local provider-live.mjs",
      };
    }
  }

  const checkedAt = new Date().toISOString();
  const lastAttempt = attempts.at(-1) ?? { checkedAt, httpStatus: 0, ok: false };
  const evidence = {
    schemaVersion: 2,
    provider: providerName,
    status: failures.length === 0 && lastSuccess ? "live_tested" : "failed",
    sourceCommit: sourceCommit(),
    adapterVersion: adapterVersion(),
    ...(process.env["GITHUB_RUN_ID"]
      ? { runUrl: `${process.env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${process.env["GITHUB_REPOSITORY"]}/actions/runs/${process.env["GITHUB_RUN_ID"]}` }
      : {}),
    ...(lastSuccess ? { lastSuccess } : {}),
    lastAttempt: { checkedAt, ...lastAttempt },
    attempts,
  };
  writeEvidence(output, evidence);

  if (failures.length > 0 || !lastSuccess) {
    say(`\nLIVE FAILED: ${failures.length || 1} problem(s)`);
    failures.forEach((entry) => say(`  - ${entry}`));
    process.exit(1);
  }

  say(
    `\nLIVE PASSED — ${provider.label} answered ${provider.queries.length} quer${provider.queries.length === 1 ? "y" : "ies"} with real https results. ` +
      "Review the evidence record before changing the catalog to live_tested. " +
      "This verifies the ADAPTER only, not the REST/MCP end-to-end chain.",
  );
}

main().catch((error) => {
  warn(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
