#!/usr/bin/env node
import { benchmarkMetadata, fixtureResponse, openBenchDb, percentile, startProcessSampler, storageReadings, writeBenchmarkReport } from "./lib/cache-bench.mjs";

function parseArgs(args) {
  const options = { requests: 20_000, repeat: 5, label: "baseline" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--requests") options.requests = Number(args[++index]);
    else if (arg === "--repeat") options.repeat = Number(args[++index]);
    else if (arg === "--label") options.label = args[++index];
    else throw new TypeError(`unknown_argument:${arg}`);
  }
  if (!Number.isInteger(options.requests) || options.requests < 1 || !Number.isInteger(options.repeat) || options.repeat < 1 || !/^[a-zA-Z0-9_-]+$/.test(options.label)) {
    throw new TypeError("requests/repeat must be positive integers and label must be path-safe");
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const rounds = [];
let exitCode = 0;
for (let repeat = 0; repeat < options.repeat; repeat += 1) {
  const bench = await openBenchDb("hit");
  const sampler = await startProcessSampler();
  try {
    const response = fixtureResponse(1024, "hit fixture");
    const key = "benchmark-hit-key";
    bench.cache.put(key, response, 3600, "basic");
    for (let index = 0; index < 100; index += 1) bench.cache.get(key);
    bench.counters.reset();
    const latencies = [];
    const started = performance.now();
    for (let index = 0; index < options.requests; index += 1) {
      const callStarted = performance.now();
      const hit = bench.cache.get(key);
      latencies.push(performance.now() - callStarted);
      if (!hit) throw new Error("benchmark_cache_miss");
    }
    const wallMs = performance.now() - started;
    const processSample = await sampler.stop();
    const storage = await storageReadings(bench.file);
    const stats = bench.cache.stats({ enabled: true, ttlSeconds: 3600 });
    rounds.push({
      repeat: repeat + 1,
      requests: options.requests,
      wallMs,
      p50Ms: percentile(latencies, 0.50),
      p95Ms: percentile(latencies, 0.95),
      latencySamplesMs: latencies,
      mutatingSql: bench.counters.mutatingSql,
      mutatingSqlPer1000Hits: bench.counters.mutatingSql / options.requests * 1000,
      commits: bench.counters.commits,
      sqliteTotalChanges: bench.handle.sqlite.totalChanges - bench.counters.totalChanges,
      rssPeakBytes: processSample.rssPeakBytes,
      heapPeakBytes: processSample.heapPeakBytes,
      evicted: stats.evicted,
      evictedBytes: stats.evictedBytes ?? null,
      evictedBytesReason: stats.evictedBytes === undefined ? "not_recorded_by_baseline" : null,
      hits: stats.hits,
      misses: stats.misses,
      ...storage,
      oom: false,
      exitCode: 0,
      residualPids: [],
    });
  } catch (error) {
    exitCode = 1;
    rounds.push({ repeat: repeat + 1, exitCode: 1, error: error instanceof Error ? error.message : String(error), residualPids: [] });
  } finally {
    await sampler.stop();
    await bench.close();
  }
}
const report = {
  schemaVersion: 1,
  benchmark: "cache-hit",
  label: options.label,
  metadata: benchmarkMetadata({ requests: options.requests, repeat: options.repeat, sqlite: "better-sqlite3/WAL", cacheFixture: "single fixed response, 100 warmup hits" }),
  rounds,
  summary: {
    mutatingSqlPer1000HitsMedian: percentile(rounds.filter((round) => round.mutatingSqlPer1000Hits !== undefined).map((round) => round.mutatingSqlPer1000Hits), 0.50),
    p95MsMedian: percentile(rounds.filter((round) => round.p95Ms !== undefined).map((round) => round.p95Ms), 0.50),
  },
};
const outputPath = await writeBenchmarkReport(options.label, report);
console.log(JSON.stringify({ outputPath, summary: report.summary, exitCode }, null, 2));
process.exitCode = exitCode;
