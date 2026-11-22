import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, resolveMigrationsDir, runMigrations } from "../../packages/db/src/index.ts";
import { KeyScheduler } from "../../packages/core/src/index.ts";
import { CacheService } from "../../apps/api/src/services/cache.js";
import { SearchService } from "../../apps/api/src/services/search.js";
import { collectSnapshot } from "./resource/snapshot.mjs";
import { adapter } from "./resource/process-tree.mjs";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const QUIET_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function fixtureResponse(paddingBytes = 0, label = "fixture") {
  return {
    taskId: "bench-task",
    query: label,
    mode: "basic",
    status: "completed",
    results: [
      { title: "Benchmark result", url: "https://example.com/benchmark", snippet: "fixed local fixture", score: 1, sources: [{ providerId: "stub", providerName: "Local Stub", rank: 1 }] },
      ...(paddingBytes > 0 ? [{ title: "Padding", url: "https://example.com/padding", snippet: "x".repeat(paddingBytes), score: 0.5, sources: [{ providerId: "stub", providerName: "Local Stub", rank: 2 }] }] : []),
    ],
    stats: {
      rawCount: paddingBytes > 0 ? 2 : 1,
      dedupedCount: paddingBytes > 0 ? 2 : 1,
      fusedCount: paddingBytes > 0 ? 2 : 1,
      providers: [{ providerId: "stub", providerName: "Local Stub", providerType: "stub", ok: true, attempts: 1, resultCount: paddingBytes > 0 ? 2 : 1, latencyMs: 1 }],
      rerankApplied: false,
      embeddingApplied: false,
      summaryApplied: false,
      partial: false,
      timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 },
    },
    errors: [],
    failedSources: [],
    debug: { rewrittenQueries: [] },
  };
}

export function instrumentSqlite(sqlite) {
  const counters = { mutatingSql: 0, commits: 0, totalChanges: 0 };
  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (source) => {
    const statement = originalPrepare(source);
    if (/^\s*(?:insert|update|delete|replace)\b/i.test(source)) {
      const originalRun = statement.run.bind(statement);
      statement.run = (...args) => {
        counters.mutatingSql += 1;
        if (!sqlite.inTransaction) counters.commits += 1;
        return originalRun(...args);
      };
    }
    return statement;
  };
  const originalTransaction = sqlite.transaction.bind(sqlite);
  sqlite.transaction = (fn) => {
    const transaction = originalTransaction(fn);
    const wrap = (mode) => (...args) => {
      const result = mode === "default" ? transaction(...args) : transaction[mode](...args);
      counters.commits += 1;
      return result;
    };
    const wrapped = wrap("default");
    wrapped.immediate = wrap("immediate");
    wrapped.deferred = wrap("deferred");
    wrapped.exclusive = wrap("exclusive");
    return wrapped;
  };
  counters.reset = () => {
    counters.mutatingSql = 0;
    counters.commits = 0;
    counters.totalChanges = sqlite.totalChanges;
  };
  counters.totalChanges = sqlite.totalChanges;
  return counters;
}

export async function openBenchDb(label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `search-hub-${label}-`));
  const file = path.join(directory, "bench.db");
  const handle = createDb({ file });
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const counters = instrumentSqlite(handle.sqlite);
  const cache = new CacheService({ db: handle.db, logger: QUIET_LOGGER, limits: { maxEntries: 10_000, maxBytes: 256 * 1024 * 1024 } });
  return {
    directory,
    file,
    handle,
    cache,
    counters,
    async close() {
      handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function startProcessSampler(intervalMs = 50) {
  const io = adapter(process.platform);
  const root = await io.readProcess(process.pid);
  if (!root) throw new Error("process_identity_unavailable");
  let rssPeakBytes = 0;
  let heapPeakBytes = 0;
  let stopped = false;
  const sample = async () => {
    const current = await io.readProcess(process.pid);
    if (current?.identity.startTime === root.identity.startTime) rssPeakBytes = Math.max(rssPeakBytes, current.rssBytes.value ?? 0);
    heapPeakBytes = Math.max(heapPeakBytes, process.memoryUsage().heapUsed);
  };
  const timer = setInterval(() => { void sample(); }, intervalMs);
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await sample();
      return { rssPeakBytes, heapPeakBytes };
    },
  };
}

export async function storageReadings(file) {
  const size = async (target) => {
    try { return (await stat(target)).size; } catch { return null; }
  };
  const snapshot = await collectSnapshot({ cpuDelayMs: 20 });
  return {
    dbFileBytes: await size(file),
    walFileBytes: await size(`${file}-wal`),
    osPageCacheBytes: snapshot.host.pageCacheBytes.value,
    osPageCacheSource: snapshot.host.pageCacheBytes.source,
    osPageCacheReason: snapshot.host.pageCacheBytes.reason,
  };
}

export async function writeBenchmarkReport(label, report) {
  const outputDirectory = path.join(REPO_ROOT, "artifacts", "v0.1.14", label);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${report.benchmark}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}

export function benchmarkMetadata(extra = {}) {
  let sourceCommit = "unknown";
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    sourceCommit = "unknown";
  }
  let pnpmVersion = "unknown";
  try {
    pnpmVersion = process.env["npm_config_user_agent"]?.match(/pnpm\/([^\s]+)/)?.[1] ??
      JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).packageManager.split("@")[1];
  } catch {
    pnpmVersion = "unknown";
  }
  return {
    machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, totalMemoryBytes: os.totalmem(), hostname: os.hostname() },
    node: process.version,
    pnpm: pnpmVersion,
    sourceCommit,
    testConcurrency: 1,
    fixture: "fixed-local-no-paid-vendor",
    ...extra,
  };
}

export async function runStampedeSearch(concurrency) {
  let upstreamCalls = 0;
  const server = createServer(async (request, response) => {
    upstreamCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [
      { title: "Local stub one", url: "https://example.com/stub/1", snippet: "fixed" },
      { title: "Local stub two", url: "https://example.com/stub/2", snippet: "fixed" },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const bench = await openBenchDb("stampede");
  const config = {
    id: "prv_stub",
    name: "Local Stub",
    type: "stub",
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 5000,
    maxResults: 5,
    language: null,
    freshness: null,
    model: null,
    maxRetries: 0,
    breakerThreshold: 5,
    breakerCooldownMs: 30_000,
    config: {},
  };
  const adapterInstance = {
    type: "stub",
    requiresKey: false,
    supportsTest: false,
    async search(input, ctx) {
      const response = await ctx.fetch(`${config.baseUrl}/search?q=${encodeURIComponent(input.query)}`, { signal: input.signal });
      return await response.json();
    },
  };
  const scheduler = new KeyScheduler({ providerId: config.id, strategy: "round_robin", perKeyConcurrency: 100, rpmLimit: 100_000, dailyQuota: null, cooldownMs: 0, breakerThreshold: 5, keys: [] });
  const runtime = { config, adapter: adapterInstance, scheduler, enabled: true, breaker: { failures: 0, openUntilMs: null } };
  const settings = {
    get: () => ({ defaults: { mode: "basic", limit: 5, timeoutMs: 5000 }, cache: { enabled: true, ttlSeconds: 3600 }, retention: { taskRetentionDays: 7, logRetentionDays: 7 } }),
  };
  const providers = {
    runtimesFor: () => [runtime],
    credentialVersion: () => "benchmark-v1",
    resolveKey: async () => undefined,
    redactKeyMessage: () => null,
    redactProviderMessage: () => null,
  };
  const models = { getEnabled() { throw new Error("not configured"); }, findDefault: () => null, resolveConfig: () => null };
  const search = new SearchService({
    db: bench.handle.db,
    providers,
    models,
    settings,
    fetch: (url, init) => fetch(url, init),
    logger: QUIET_LOGGER,
    health: { blockedProviders: () => new Map() },
    cache: bench.cache,
  });
  const latencies = [];
  let exitCode = 0;
  let error = null;
  try {
    const started = performance.now();
    const responses = await Promise.all(Array.from({ length: concurrency }, async () => {
      const callStarted = performance.now();
      try {
        const response = await search.execute({ query: "cold stampede fixture", mode: "basic", limit: 5 });
        latencies.push(performance.now() - callStarted);
        return response;
      } catch (cause) {
        latencies.push(performance.now() - callStarted);
        throw cause;
      }
    }));
    const serialized = responses.map((response) => JSON.stringify({ status: response.status, results: response.results, errors: response.errors }));
    const storage = await storageReadings(bench.file);
    return {
      ...storage,
      upstreamCalls,
      responseCount: responses.length,
      consistent: serialized.every((value) => value === serialized[0]),
      completed: responses.every((response) => response.status === "completed"),
      wallMs: performance.now() - started,
      latencyMs: latencies,
      cacheRows: bench.handle.sqlite.prepare("SELECT COUNT(*) AS n FROM search_cache").get().n,
      mutatingSql: bench.counters.mutatingSql,
      commits: bench.counters.commits,
      sqliteTotalChanges: bench.handle.sqlite.totalChanges - bench.counters.totalChanges,
    };
  } catch (cause) {
    exitCode = 1;
    error = cause instanceof Error ? cause.message : String(cause);
    throw cause;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await bench.close();
    if (exitCode !== 0 && error) process.exitCode = exitCode;
  }
}
