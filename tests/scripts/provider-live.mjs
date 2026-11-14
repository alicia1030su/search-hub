#!/usr/bin/env node
/**
 * Live (real network) verification for one builtin general web-search adapter.
 *
 * This is the ONLY script that can move a provider from `documented` to
 * `live_tested`. It calls the real adapter against the real vendor endpoint —
 * no mocks, no fixtures.
 *
 * Usage (tsx is required because the adapters are TypeScript sources):
 *   TAVILY_API_KEY=... corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider tavily
 *   BOCHA_API_KEY=...  corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider bocha
 *   BRAVE_API_KEY=...  corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider brave
 *
 * Options:
 *   --provider tavily|bocha|brave   (required)
 *   --base-url <url>                override the official endpoint (staging/proxy)
 *   --limit <n>                     results per query (default 5)
 *
 * Exit codes:
 *   0  LIVE PASSED — both queries returned non-empty, https, non-placeholder URLs
 *   1  FAIL — auth, transport or mapping problem (details printed, no secret)
 *   2  SKIPPED: no credential — deliberately NOT 0 so CI cannot read it as a pass
 *
 * CREDENTIAL HANDLING (deliberately strict):
 * - The key is read ONLY from the process environment. There is no --key
 *   option: a command-line value would appear in argv of this process AND of
 *   any re-exec child, and could be echoed by shell tracing.
 * - Every string that may contain third-party data (upstream error bodies,
 *   titles, URLs, dates) is passed through `scrub()` before it is printed.
 *   GitHub masks registered secret values in job logs, but it does NOT mask
 *   URL-encoded/base64/transformed echoes, and it does NOT mask artifact files.
 * - The workflow therefore does not upload raw logs as artifacts.
 */

import { redactText, providerKeysFromEnv } from "./redact-secrets.mjs";

const PROVIDERS = {
  tavily: { env: "TAVILY_API_KEY", label: "Tavily" },
  bocha: { env: "BOCHA_API_KEY", label: "Bocha" },
  brave: { env: "BRAVE_API_KEY", label: "Brave" },
};

const PLACEHOLDER_HOSTS = ["example.com", "example.org", "example.net", "localhost", "127.0.0.1"];

const QUERIES = [
  // Chinese current-affairs style query (exercises CJK handling + freshness path).
  { label: "zh-current-affairs", query: "中国 新能源汽车 产业 最新政策", freshness: "month" },
  // English technical query (exercises latin text + general web index).
  { label: "en-tech", query: "typescript monorepo best practices" },
];

/** All configured keys, so a cross-provider echo is redacted too. */
const CONFIGURED_KEYS = providerKeysFromEnv();

/** Scrub anything that may contain third-party data before printing it. */
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

async function main() {
  const providerName = arg("provider");
  if (!providerName || !(providerName in PROVIDERS)) {
    fail(`--provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  const provider = PROVIDERS[providerName];

  // Credential gate runs BEFORE any import/network work: a missing key must be a
  // cheap, unambiguous SKIPPED (exit 2), never a silent success.
  const key = process.env[provider.env] ?? "";
  if (!key) {
    say(`SKIPPED: no credential (set ${provider.env})`);
    process.exit(2);
  }

  let adapters;
  let shared;
  try {
    // Relative paths (not the workspace package names) so tsx resolves the TS
    // sources without needing a node_modules link at the repo root.
    adapters = await import("../../packages/providers/src/index.ts");
    shared = await import("../../packages/shared/src/index.ts");
  } catch (error) {
    // Plain `node` cannot import the TypeScript sources (the workspace uses
    // `.js` specifiers that tsx remaps). Re-exec once through tsx so the
    // documented `node tests/scripts/provider-live.mjs ...` invocation works.
    // The child inherits the environment (that is the only credential channel)
    // and receives no credential in argv. CI runs through `pnpm exec tsx`
    // directly, so this child never exists there.
    if (process.env["PROVIDER_LIVE_TSX"] !== "1") {
      const { spawnSync } = await import("node:child_process");
      const reexec = spawnSync(
        process.execPath,
        ["--import", "tsx", process.argv[1], ...process.argv.slice(2)],
        {
          stdio: "inherit",
          env: { ...process.env, PROVIDER_LIVE_TSX: "1" },
        },
      );
      process.exit(reexec.status ?? 1);
    }
    warn("FAIL: the TypeScript adapters could not be loaded.");
    warn(`Run through tsx: ${provider.env}=... corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider ${providerName}`);
    warn(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const adapter = adapters.getAdapter(providerName);
  if (!adapter) fail(`no builtin adapter registered for "${providerName}"`);

  const baseUrl = arg("base-url") ?? null;
  const limit = Number(arg("limit") ?? 5);
  const safeFetch = shared.createSafeFetch({ timeoutMs: 20_000 });
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

  say(`LIVE: provider=${providerName} endpoint=${baseUrl ?? "official default"} limit=${limit}`);
  say("LIVE: credential loaded (value never printed)");

  const failures = [];

  for (const query of QUERIES) {
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
      config: {},
    };
    const controller = new AbortController();
    const ctx = {
      fetch: safeFetch,
      apiKey: key,
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
      warn(`FAIL ${query.label}: ${code} — ${message}`);
      continue;
    } finally {
      controller.abort();
    }

    const latencyMs = Date.now() - started;
    const results = result.results ?? [];
    say(`\n[${query.label}] "${query.query}" -> ${results.length} result(s) in ${latencyMs}ms`);
    if (results.length === 0) {
      failures.push(`${query.label}: returned zero results`);
      warn(`FAIL ${query.label}: returned zero results`);
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
      warn(`FAIL ${query.label}: ${duplicateUrls} duplicate url(s) in one response`);
    }
  }

  if (failures.length > 0) {
    say(`\nLIVE FAILED: ${failures.length} problem(s)`);
    failures.forEach((entry) => say(`  - ${entry}`));
    process.exit(1);
  }

  say(
    `\nLIVE PASSED — ${provider.label} answered both queries with real https results. ` +
      "Record this run before changing the catalog to live_tested. " +
      "This verifies the ADAPTER only, not the REST/MCP end-to-end chain.",
  );
}

main().catch((error) => {
  // Never echo the key: provider errors carry codes/messages only, and scrub()
  // handles transformed third-party echoes as well.
  warn(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
