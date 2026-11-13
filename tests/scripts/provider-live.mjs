#!/usr/bin/env node
/**
 * Live (real network) verification for one builtin general web-search adapter.
 *
 * This is the ONLY script that can move a provider from `documented` to
 * `live_tested`. It calls the real adapter against the real vendor endpoint —
 * no mocks, no fixtures.
 *
 * Usage (tsx is required because the adapters are TypeScript sources):
 *   corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider tavily --key "$TAVILY_API_KEY"
 *   corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider bocha  --key "$BOCHA_API_KEY"
 *   corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider brave  --key "$BRAVE_API_KEY"
 *
 * Options:
 *   --provider tavily|bocha|brave   (required)
 *   --key <value>                   falls back to TAVILY_API_KEY / BOCHA_API_KEY / BRAVE_API_KEY
 *   --base-url <url>                override the official endpoint (staging/proxy)
 *   --limit <n>                     results per query (default 5)
 *
 * Exit codes:
 *   0  LIVE PASSED — both queries returned non-empty, https, non-placeholder URLs
 *   1  FAIL — auth, transport or mapping problem (details printed, no secret)
 *   2  SKIPPED: no credential — deliberately NOT 0 so CI cannot read it as a pass
 *
 * The key is read from --key or the environment, passed straight to the adapter,
 * and never printed, logged or written to disk.
 */

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

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
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
  const key = arg("key") ?? process.env[provider.env] ?? "";
  if (!key) {
    console.log(`SKIPPED: no credential (pass --key or set ${provider.env})`);
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
    console.error("FAIL: the TypeScript adapters could not be loaded.");
    console.error(
      `Run through tsx: corepack pnpm exec tsx tests/scripts/provider-live.mjs --provider ${providerName} --key $${provider.env}`,
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const adapter = adapters.getAdapter(providerName);
  if (!adapter) fail(`no builtin adapter registered for "${providerName}"`);

  const baseUrl = arg("base-url") ?? null;
  const limit = Number(arg("limit") ?? 5);
  const safeFetch = shared.createSafeFetch({ timeoutMs: 20_000 });
  const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

  console.log(`LIVE: provider=${providerName} endpoint=${baseUrl ?? "official default"} limit=${limit}`);
  console.log("LIVE: credential loaded (value never printed)");

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
      console.error(`FAIL ${query.label}: ${code} — ${message}`);
      continue;
    } finally {
      controller.abort();
    }

    const latencyMs = Date.now() - started;
    const results = result.results ?? [];
    console.log(
      `\n[${query.label}] "${query.query}" -> ${results.length} result(s) in ${latencyMs}ms`,
    );
    if (results.length === 0) {
      failures.push(`${query.label}: returned zero results`);
      console.error(`FAIL ${query.label}: returned zero results`);
      continue;
    }

    results.slice(0, 3).forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.title}`);
      console.log(`     ${item.url}`);
      if (item.publishedAt) console.log(`     published: ${item.publishedAt}`);
    });

    const badUrl = results.map((item) => ({ item, check: isUsableUrl(item.url) })).find((entry) => !entry.check.ok);
    if (badUrl) {
      failures.push(`${query.label}: unusable url ${badUrl.item.url} (${badUrl.check.reason})`);
      console.error(`FAIL ${query.label}: unusable url ${badUrl.item.url} (${badUrl.check.reason})`);
    }
    const missingTitle = results.find((item) => !item.title || item.title.trim().length === 0);
    if (missingTitle) {
      failures.push(`${query.label}: a result is missing a title`);
      console.error(`FAIL ${query.label}: a result is missing a title`);
    }
    const duplicateUrls = results.length - new Set(results.map((item) => item.url)).size;
    if (duplicateUrls > 0) {
      failures.push(`${query.label}: ${duplicateUrls} duplicate url(s) in one response`);
      console.error(`FAIL ${query.label}: ${duplicateUrls} duplicate url(s) in one response`);
    }
  }

  if (failures.length > 0) {
    console.log(`\nLIVE FAILED: ${failures.length} problem(s)`);
    failures.forEach((entry) => console.log(`  - ${entry}`));
    process.exit(1);
  }

  console.log(
    `\nLIVE PASSED — ${provider.label} answered both queries with real https results. ` +
      "Record this run before changing the catalog to live_tested.",
  );
}

main().catch((error) => {
  // Never echo the key: provider errors carry codes/messages only.
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
