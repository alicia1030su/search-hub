#!/usr/bin/env node
/**
 * AC-05 probe: elapsed-time budget and cross-key overlap.
 *
 * The Vitest suite proves the *limits* (per-key in-flight peak is exactly 2,
 * the RPM window rejects the 11th call, the daily quota rejects the 4th) but it
 * does not measure the elapsed time of the 100-request burst, which is the
 * other half of AC-05:
 *
 *   total ≈ ⌈100 / (keys × maxConcurrency)⌉ × single-call latency (±20%)
 *   and different keys must genuinely be in flight at the same time.
 *
 * This script measures both against the real KeyScheduler used by the engine.
 * It prints numbers only; it does not assert provider quality.
 *
 * Usage: node --import tsx tests/scripts/ac05-concurrency.mjs [--runs 3]
 *
 * Exit code 0 when every run stays inside the AC-05 budget and shows overlap,
 * 1 otherwise (the failing numbers are printed).
 */
import { KeyScheduler } from "../../packages/core/src/index.js";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const RUNS = Math.max(1, Number(arg("runs", "3")));
const KEYS = 3;
const PER_KEY = 2;
const REQUESTS = 100;
const HOLD_MS = 12;

function seed(id) {
  return { id, label: id, maskedKey: `…${id.slice(-4)}`, weight: 100, enabled: true, status: "healthy" };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Measure how long `setTimeout(HOLD_MS)` really lasts on this host. */
async function measureActualLatency(samples = 15) {
  const observed = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    observed.push(performance.now() - started);
  }
  return median(observed);
}

async function runOnce() {
  const scheduler = new KeyScheduler({
    providerId: "ac05",
    strategy: "round_robin",
    perKeyConcurrency: PER_KEY,
    rpmLimit: 100_000,
    dailyQuota: null,
    cooldownMs: 30_000,
    breakerThreshold: 5,
    keys: Array.from({ length: KEYS }, (_, index) => seed(`k${index + 1}`)),
  });

  const windows = [];
  const startedAt = Date.now();
  const leases = await Promise.all(
    Array.from({ length: REQUESTS }, async () => {
      const lease = await scheduler.acquire({ maxWaitMs: 60_000 });
      if (!lease) return null;
      const callStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      windows.push({ keyId: lease.keyId, start: callStartedAt, end: Date.now() });
      lease.release({ ok: true, latencyMs: HOLD_MS });
      return lease;
    }),
  );
  const elapsedMs = Date.now() - startedAt;
  const snapshot = scheduler.snapshot();

  let crossKeyOverlapPairs = 0;
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i];
      const b = windows[j];
      if (a.keyId !== b.keyId && a.start < b.end && b.start < a.end) crossKeyOverlapPairs += 1;
    }
  }

  return {
    acquired: leases.filter((lease) => lease !== null).length,
    elapsedMs,
    peaks: snapshot.map((key) => `${key.id}:${key.peakInFlight}`),
    maxPeak: Math.max(...snapshot.map((key) => key.peakInFlight)),
    crossKeyOverlapPairs,
  };
}

async function main() {
  const actualLatencyMs = await measureActualLatency();
  const rounds = Math.ceil(REQUESTS / (KEYS * PER_KEY));
  const expectedMs = rounds * actualLatencyMs;
  const results = [];
  let failed = false;

  for (let run = 1; run <= RUNS; run += 1) {
    const result = await runOnce();
    const ratio = result.elapsedMs / expectedMs;
    const withinBudget = ratio >= 0.8 && ratio <= 1.2;
    const hasOverlap = result.crossKeyOverlapPairs > 0;
    const allAcquired = result.acquired === REQUESTS;
    const peakExact = result.maxPeak === PER_KEY;
    const ok = withinBudget && hasOverlap && allAcquired && peakExact;
    if (!ok) failed = true;
    results.push({
      run,
      acquired: result.acquired,
      requests: REQUESTS,
      rounds,
      actualLatencyMs: Math.round(actualLatencyMs * 100) / 100,
      expectedMs: Math.round(expectedMs),
      elapsedMs: result.elapsedMs,
      ratio: Math.round(ratio * 100) / 100,
      withinBudget,
      peaks: result.peaks,
      peakExact,
      crossKeyOverlapPairs: result.crossKeyOverlapPairs,
      hasOverlap,
      verdict: ok ? "PASS" : "FAIL",
    });
  }

  console.log(JSON.stringify({ keys: KEYS, perKeyConcurrency: PER_KEY, requests: REQUESTS, results }, null, 2));
  if (failed) {
    console.error("FAIL: at least one run missed the AC-05 elapsed-time budget or the cross-key overlap requirement");
    process.exit(1);
  }
  console.log(
    `PASS: ${RUNS}/${RUNS} runs within ±20% of ⌈${REQUESTS}/${KEYS * PER_KEY}⌉ × ${Math.round(actualLatencyMs * 100) / 100}ms and cross-key overlap observed`,
  );
}

main().catch((error) => {
  console.error(`FAIL: ${error?.stack ?? error?.message ?? error}`);
  process.exit(1);
});
