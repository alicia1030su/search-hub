#!/usr/bin/env node
import { benchmarkMetadata, runStampedeSearch, startProcessSampler, writeBenchmarkReport } from "./lib/cache-bench.mjs";

function parseArgs(args) {
  const options = { concurrency: 100, label: "baseline" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--concurrency") options.concurrency = Number(args[++index]);
    else if (arg === "--label") options.label = args[++index];
    else throw new TypeError(`unknown_argument:${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 1000 || !/^[a-zA-Z0-9_-]+$/.test(options.label)) {
    throw new TypeError("concurrency must be 1..1000 and label must be path-safe");
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const sampler = await startProcessSampler();
let exitCode = 0;
let result = null;
let error = null;
try {
  result = await runStampedeSearch(options.concurrency);
} catch (cause) {
  exitCode = 1;
  error = cause instanceof Error ? cause.message : String(cause);
}
const processSample = await sampler.stop();
const report = {
  schemaVersion: 1,
  benchmark: "cache-stampede",
  label: options.label,
  metadata: benchmarkMetadata({ concurrency: options.concurrency, stub: "127.0.0.1 HTTP server, 40ms fixed latency", query: "cold stampede fixture" }),
  upstreamCalls: result?.upstreamCalls ?? null,
  responseCount: result?.responseCount ?? 0,
  consistent: result?.consistent ?? false,
  completed: result?.completed ?? false,
  cacheRows: result?.cacheRows ?? null,
  wallMs: result?.wallMs ?? null,
  p50Ms: result ? result.latencyMs.sort((a, b) => a - b)[Math.max(0, Math.ceil(result.latencyMs.length * 0.5) - 1)] : null,
  p95Ms: result ? result.latencyMs.sort((a, b) => a - b)[Math.max(0, Math.ceil(result.latencyMs.length * 0.95) - 1)] : null,
  latencySamplesMs: result?.latencyMs ?? [],
  rssPeakBytes: processSample.rssPeakBytes,
  heapPeakBytes: processSample.heapPeakBytes,
  dbFileBytes: result?.dbFileBytes ?? null,
  walFileBytes: result?.walFileBytes ?? null,
  osPageCacheBytes: result?.osPageCacheBytes ?? null,
  osPageCacheSource: result?.osPageCacheSource ?? "unavailable",
  osPageCacheReason: result?.osPageCacheReason ?? "baseline_storage_not_recorded",
  mutatingSql: result?.mutatingSql ?? null,
  mutatingSqlReason: result ? null : "search_path_not_completed",
  commits: result?.commits ?? null,
  sqliteTotalChanges: result?.sqliteTotalChanges ?? null,
  evictedBytes: null,
  oom: false,
  exitCode,
  residualPids: [],
  error,
};
const outputPath = await writeBenchmarkReport(options.label, report);
console.log(JSON.stringify({ outputPath, upstreamCalls: report.upstreamCalls, responseCount: report.responseCount, exitCode }, null, 2));
process.exitCode = exitCode;
