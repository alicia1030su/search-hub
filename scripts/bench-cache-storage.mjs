#!/usr/bin/env node
import { benchmarkMetadata, fixtureResponse, openBenchDb, startProcessSampler, storageReadings, writeBenchmarkReport } from "./lib/cache-bench.mjs";

function parseArgs(args) {
  const options = { repeat: 5, label: "baseline" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repeat") options.repeat = Number(args[++index]);
    else if (arg === "--label") options.label = args[++index];
    else throw new TypeError(`unknown_argument:${arg}`);
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || !/^[a-zA-Z0-9_-]+$/.test(options.label)) throw new TypeError("repeat must be positive and label path-safe");
  return options;
}

const options = parseArgs(process.argv.slice(2));
const rounds = [];
let exitCode = 0;
for (let repeat = 0; repeat < options.repeat; repeat += 1) {
  const bench = await openBenchDb("storage");
  const sampler = await startProcessSampler();
  try {
    const large = fixtureResponse(16 * 1024, "storage fixture");
    const small = fixtureResponse(64, "storage fixture");
    for (let index = 0; index < 400; index += 1) bench.cache.put(`storage-${index}`, index % 4 === 0 ? large : small, 3600, "basic");
    const sweepStarted = performance.now();
    const expiredRemoved = bench.cache.sweepExpired();
    const sweepMs = performance.now() - sweepStarted;
    const retimeStarted = performance.now();
    const retime = bench.cache.retime(7200);
    const retimeMs = performance.now() - retimeStarted;
    const logicalBytesBeforeClear = bench.handle.sqlite.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM search_cache").get().n;
    const clearStarted = performance.now();
    const cleared = bench.cache.clear();
    const clearMs = performance.now() - clearStarted;
    const processSample = await sampler.stop();
    const storage = await storageReadings(bench.file);
    const stats = bench.cache.stats({ enabled: true, ttlSeconds: 7200 });
    rounds.push({
      repeat: repeat + 1,
      entriesBeforeClear: 400,
      logicalBytesBeforeClear,
      expiredRemoved,
      retimed: retime.retimed,
      retimeRemoved: retime.removed,
      cleared,
      sweepMs,
      retimeMs,
      clearMs,
      maintenanceMs: sweepMs + retimeMs + clearMs,
      evicted: stats.evicted,
      mutatingSql: bench.counters.mutatingSql,
      commits: bench.counters.commits,
      sqliteTotalChanges: bench.handle.sqlite.totalChanges - bench.counters.totalChanges,
      evictedBytes: stats.evictedBytes ?? null,
      evictedBytesReason: stats.evictedBytes === undefined ? "not_recorded_by_baseline" : null,
      rssPeakBytes: processSample.rssPeakBytes,
      heapPeakBytes: processSample.heapPeakBytes,
      ...storage,
      vacuumPerformed: false,
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
  benchmark: "cache-storage",
  label: options.label,
  metadata: benchmarkMetadata({ repeat: options.repeat, fixture: "400 puts, mixed 16KiB/64B padding; sweep/retime/clear" }),
  rounds,
};
const outputPath = await writeBenchmarkReport(options.label, report);
console.log(JSON.stringify({ outputPath, rounds: rounds.length, exitCode }, null, 2));
process.exitCode = exitCode;
