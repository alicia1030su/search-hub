#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, resolveMigrationsDir, runMigrations } from "../packages/db/src/index.ts";
import { CacheService } from "../apps/api/src/services/cache.ts";
import { benchmarkMetadata, fixtureResponse } from "./lib/cache-bench.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "candidate";
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("label must be path-safe");
const directory = await mkdtemp(path.join(tmpdir(), "search-hub-capacity-"));
const file = path.join(directory, "capacity.db");
const handle = createDb({ file });
const excluded = new Set(["search_cache", "search_cache_state", "sqlite_sequence"]);
function otherTablesFingerprint() {
  const tables = handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const payload = tables.map(({ name }) => ({ name, rows: excluded.has(name) ? [] : handle.sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
try {
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const before = otherTablesFingerprint();
  const large = fixtureResponse(0, "capacity fixture");
  const targetBytes = 131_131;
  const base = Buffer.byteLength(JSON.stringify(large), "utf8");
  large.results[0].snippet = "x".repeat(targetBytes - base + large.results[0].snippet.length);
  const json = JSON.stringify(large);
  const insert = handle.sqlite.prepare("INSERT INTO search_cache (cache_key,response_json,status,mode,created_at,expires_at,last_accessed_at,size_bytes) VALUES (?,?,?,?,?,?,?,?)");
  for (let index = 0; index < 80; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    insert.run(`old-${index}`, json, "completed", "basic", timestamp, "2027-01-01T00:00:00.000Z", timestamp, targetBytes);
  }
  const cache = new CacheService({ db: handle.db, logger: { debug() {}, info() {}, warn() {}, error() {} }, limits: { maxEntries: 200, maxBytes: 1024 * 1024 } });
  cache.initialize();
  const put = cache.put("new-entry", large, 3600, "basic");
  const actual = handle.sqlite.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes),0) AS bytes FROM search_cache").get();
  const after = otherTablesFingerprint();
  const report = {
    schemaVersion: 1,
    benchmark: `cache-capacity-${label}`,
    metadata: benchmarkMetadata(),
    fixture: { oldRows: 80, responseJsonBytes: targetBytes, maxEntries: 200, maxBytes: 1024 * 1024 },
    put,
    actual,
    invariantPassed: actual.entries <= 200 && actual.bytes <= 1024 * 1024,
    otherTablesUnchanged: before === after,
    totals: cache.totals(),
    exitCode: 0,
  };
  const output = path.join(repoRoot, "artifacts", "v0.1.14", label, "cache-capacity.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally {
  handle.close();
  await rm(directory, { recursive: true, force: true });
}
