#!/usr/bin/env node
/**
 * AC-05 performance breakdown.
 *
 * Measures where the end-to-end time of `POST /api/search` goes, using the
 * server's own `stats.timing` fields plus wall-clock time:
 *
 *   totalMs   = pipeline time reported by the server (up to persistence)
 *   fanoutMs  = slowest provider fan-out
 *   fusionMs  = dedupe + RRF
 *   dbWriteMs = SQLite task insert + final task/event persist (instrumented)
 *   httpMs    = wall - totalMs (transport, Fastify, JSON serialisation)
 *   queueMs   = fanoutMs - providerLatency (scheduler waiting for a slot)
 *
 * It does not decide pass/fail for AC-05; it prints numbers. AC-05's ±20%
 * budget is evaluated separately and is never loosened here.
 *
 * Usage:
 *   node tests/scripts/perf-breakdown.mjs --url http://127.0.0.1:8870 \
 *     --email admin@example.com --password '...' [--latency 50] [--seq 200] [--burst 100] [--runs 3]
 */
import { writeFileSync } from "node:fs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}

const BASE = arg("url", "http://127.0.0.1:8787").replace(/\/+$/, "");
const EMAIL = arg("email", "admin@example.com");
const PASSWORD = arg("password", "");
const LATENCY = Number(arg("latency", "50"));
const SEQ = Number(arg("seq", "200"));
const BURST = Number(arg("burst", "100"));
const RUNS = Number(arg("runs", "3"));
const OUT = arg("out", "docs/performance-baseline.json");

if (!PASSWORD) {
  console.error("ERROR: --password is required (admin password of the test instance)");
  process.exit(2);
}

let cookie = "";
let csrf = "";

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...init.headers,
    },
  });
  return response;
}

async function login() {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  cookie = setCookie.split(";")[0];
  csrf = (await response.json()).csrfToken;
}

async function ensureProvider() {
  const list = await (await api("/api/admin/providers")).json();
  const existing = list.providers.find(
    (item) => item.type === "mock" && item.name === "perf-mock",
  );
  if (existing) return existing.id;

  const created = await api("/api/admin/providers", {
    method: "POST",
    body: JSON.stringify({
      name: "perf-mock",
      type: "mock",
      enabled: true,
      timeoutMs: 60_000,
      maxConcurrency: 2,
      maxRetries: 0,
      rpmLimit: 100_000,
      config: { resultCount: 8, latencyMs: LATENCY, namespace: "perf" },
    }),
  });
  if (!created.ok) throw new Error(`provider create failed: ${await created.text()}`);
  const body = await created.json();
  const id = body.provider?.id ?? body.id;
  for (let index = 0; index < 3; index += 1) {
    const key = await api(`/api/admin/providers/${id}/keys`, {
      method: "POST",
      body: JSON.stringify({
        label: `perf-${index}`,
        key: `sk-PERF-FINGERPRINT-${index}000`,
        weight: 100,
        enabled: true,
      }),
    });
    if (!key.ok) throw new Error(`key create failed: ${await key.text()}`);
  }
  return id;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function oneSearch(providerId) {
  const started = performance.now();
  const response = await api("/api/search", {
    method: "POST",
    body: JSON.stringify({
      query: "perf probe",
      providers: [providerId],
      mode: "rrf",
      limit: 5,
      skipCache: true,
      timeoutMs: 60_000,
    }),
  });
  const wall = performance.now() - started;
  if (!response.ok) throw new Error(`search HTTP ${response.status}`);
  const body = await response.json();
  return { wall, timing: body.stats.timing, status: body.status };
}

function summarise(samples) {
  const values = (key) =>
    samples.map((sample) => sample.timing[key]).filter((value) => typeof value === "number");
  const pct = (arr, p) => percentile([...arr].sort((a, b) => a - b), p);
  const walls = samples.map((sample) => sample.wall);
  const total = values("totalMs");
  const fanout = values("fanoutMs");
  const fusion = values("fusionMs");
  const db = values("dbWriteMs");
  const http = samples
    .map((sample) => sample.wall - sample.timing.totalMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    samples: samples.length,
    wall: { p50: pct(walls, 50), p95: pct(walls, 95), p99: pct(walls, 99) },
    total: { p50: pct(total, 50), p95: pct(total, 95), p99: pct(total, 99) },
    fanout: { p50: pct(fanout, 50), p95: pct(fanout, 95) },
    fusion: { p50: pct(fusion, 50), p95: pct(fusion, 95) },
    dbWrite: { p50: pct(db, 50), p95: pct(db, 95) },
    httpOverhead: { p50: pct(http, 50), p95: pct(http, 95) },
    queue: { p50: pct(fanout, 50) - LATENCY },
  };
}

function fmt(value) {
  return typeof value === "number" ? value.toFixed(1) : "n/a";
}

async function main() {
  await login();
  const providerId = await ensureProvider();
  console.log(`provider=${providerId} latency=${LATENCY}ms`);

  console.log(`sequential: ${SEQ} requests`);
  const sequential = [];
  for (let index = 0; index < SEQ; index += 1) {
    sequential.push(await oneSearch(providerId));
    if ((index + 1) % 50 === 0) process.stdout.write(`  ${index + 1}/${SEQ}\n`);
  }
  const seq = summarise(sequential);

  console.log(`burst: ${RUNS} runs of ${BURST} concurrent requests`);
  const bursts = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: BURST }, () => oneSearch(providerId)),
    );
    const wall = performance.now() - started;
    const maxServer = Math.max(...responses.map((item) => item.timing.totalMs));
    const mean = responses.reduce((sum, item) => sum + item.timing.totalMs, 0) / responses.length;
    const expected = Math.ceil(BURST / 6) * LATENCY;
    bursts.push({
      run: run + 1,
      wallMs: wall,
      maxServerMs: maxServer,
      meanServerMs: mean,
      expectedMs: expected,
      ratioWall: wall / expected,
      ratioServer: maxServer / expected,
    });
    console.log(
      `  run ${run + 1}: wall=${wall.toFixed(0)}ms maxServer=${maxServer.toFixed(0)}ms ratioWall=${(wall / expected).toFixed(2)}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    providerLatencyMs: LATENCY,
    providerId,
    sequential: seq,
    burst: { size: BURST, expectedMs: Math.ceil(BURST / 6) * LATENCY, runs: bursts },
    notes: [
      "server totalMs comes from stats.timing.totalMs and excludes the final response serialisation",
      "httpOverhead = client wall - server totalMs",
      "queue = fanout p50 - provider latency (scheduler waiting for a free slot)",
      "mock provider: no network, so this isolates scheduler/HTTP/SQLite cost",
    ],
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

  console.log("\n=== sequential breakdown (ms) ===");
  console.log(`samples ${seq.samples}`);
  console.log(`wall    p50=${fmt(seq.wall.p50)} p95=${fmt(seq.wall.p95)} p99=${fmt(seq.wall.p99)}`);
  console.log(`total   p50=${fmt(seq.total.p50)} p95=${fmt(seq.total.p95)} p99=${fmt(seq.total.p99)}`);
  console.log(`fanout  p50=${fmt(seq.fanout.p50)} p95=${fmt(seq.fanout.p95)}`);
  console.log(`fusion  p50=${fmt(seq.fusion.p50)} p95=${fmt(seq.fusion.p95)}`);
  console.log(`dbWrite p50=${fmt(seq.dbWrite.p50)} p95=${fmt(seq.dbWrite.p95)}`);
  console.log(`http    p50=${fmt(seq.httpOverhead.p50)} p95=${fmt(seq.httpOverhead.p95)}`);
  console.log(`queue   p50≈${fmt(seq.queue.p50)} (fanout - ${LATENCY}ms provider)`);
  console.log(`\nwrote ${OUT}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
