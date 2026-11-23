import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

export const BASELINE_COMMIT = "4d2e25249f90a085b28ea05ee479b393d716c99e";
export const BENCHMARK_COMMIT = "e182f60703d179ec4d28f1dbf23ce04c0f2b0a25";
export const EVIDENCE_VERSION = "v0.1.14";
export const RAW_BENCHMARKS = Object.freeze(["cacheCapacity", "cacheHit", "cacheStampede", "cacheStorage"]);
export const STATUSES = new Set(["PASS", "PASS_NO_OPTIMIZATION", "N/A", "FAIL", "BLOCKED"]);

const CODE_PATHS = Object.freeze([
  "apps", "packages", "scripts", "tests", "package.json", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.node.json",
  "vitest.config.ts", "playwright.config.ts",
]);

const COMMON_SCOPE = Object.freeze(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const SCOPES = Object.freeze({
  cacheCapacity: [...COMMON_SCOPE, "apps/api/src/services/cache.ts", "packages/db", "scripts/bench-cache-capacity.mjs", "tests/integration/cache-capacity.test.ts"],
  cacheHit: [...COMMON_SCOPE, "apps/api/src/services/cache.ts", "packages/db", "scripts/lib/cache-bench.mjs", "scripts/bench-cache-hit.mjs"],
  cacheStampede: [
    ...COMMON_SCOPE, "apps/api/src/services/cache.ts", "apps/api/src/services/search.ts",
    "apps/api/src/services/singleflight.ts", "packages/core", "packages/providers", "packages/db",
    "scripts/lib/cache-bench.mjs", "scripts/bench-cache-stampede.mjs",
    "tests/integration/cache-stampede.test.ts", "tests/integration/cache-singleflight.test.ts",
  ],
  cacheStorage: [...COMMON_SCOPE, "apps/api/src/services/cache.ts", "packages/db", "scripts/lib/cache-bench.mjs", "scripts/bench-cache-storage.mjs"],
});

const FORBIDDEN_KEYS = new Set([
  "hostname", "argv", "env", "environmentvariables", "rawlog", "stderr", "stdout",
  "authorization", "cookie", "token", "apikey", "api_key", "keyciphertext", "keyiv",
  "keytag", "sql", "query",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function resolveCommit(repoRoot, ref = "HEAD") {
  const commit = git(repoRoot, ["rev-parse", `${ref}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`invalid_git_commit:${ref}`);
  return commit;
}

function comparePath(a, b) {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

export function listTreeEntries(repoRoot, ref = "HEAD") {
  const output = git(repoRoot, ["ls-tree", "-r", "-z", ref, "--", ...CODE_PATHS]);
  return output.split("\0").filter(Boolean).map((line) => {
    const match = /^([0-7]+) (blob) ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) return null;
    return { mode: match[1], type: match[2], blobSha: match[3], path: match[4] };
  }).filter(Boolean).sort(comparePath);
}

function fingerprintEntries(entries) {
  return sha256(Buffer.from(JSON.stringify(entries.map(({ path, blobSha }) => ({ path, blobSha }))), "utf8"));
}

export function codeFingerprint(repoRoot, ref = "HEAD") {
  return fingerprintEntries(listTreeEntries(repoRoot, ref));
}

function matchesScope(path, scope) {
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

export function scopeFingerprint(repoRoot, ref, benchmark) {
  const scope = SCOPES[benchmark];
  if (!scope) throw new Error(`unknown_benchmark_scope:${benchmark}`);
  return fingerprintEntries(listTreeEntries(repoRoot, ref).filter((entry) => matchesScope(entry.path, scope)));
}

export function changedPaths(repoRoot, fromRef, toRef) {
  return git(repoRoot, ["diff", "--name-only", fromRef, toRef]).split("\n").map((line) => line.trim()).filter(Boolean).sort((a, b) => comparePath({ path: a }, { path: b }));
}

export function machineFingerprint(machine = {}) {
  const normalized = {
    platform: machine.platform ?? null,
    arch: machine.arch ?? null,
    cpus: machine.cpus ?? null,
    totalMemoryBytes: machine.totalMemoryBytes ?? null,
  };
  return sha256(Buffer.from(JSON.stringify(normalized), "utf8"));
}

function redactPath(value) {
  return value
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[redacted-path]")
    .replace(/\/(?:Users|home|tmp|var\/tmp)\/[^\s"']+/g, "[redacted-path]")
    .replace(/file:\/\/\/[^\s"']+/g, "[redacted-path]");
}

export function sanitizeEvidence(value) {
  if (Array.isArray(value)) return value.map(sanitizeEvidence);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
      result[key] = sanitizeEvidence(child);
    }
    return result;
  }
  if (typeof value === "string") return redactPath(value);
  return value;
}

export function gzipJson(value) {
  const json = `${JSON.stringify(sanitizeEvidence(value), null, 2)}\n`;
  const compressed = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  return { compressed, decompressedSha256: sha256(Buffer.from(json, "utf8")), json };
}

export function readGzipJson(buffer) {
  const json = gunzipSync(buffer).toString("utf8");
  return { value: JSON.parse(json), decompressedSha256: sha256(Buffer.from(json, "utf8")) };
}

export function createRawFile(relativePath, sourcePath) {
  const source = readFileSync(sourcePath);
  const parsed = JSON.parse(source.toString("utf8"));
  const gzip = gzipJson(parsed);
  return {
    relativePath,
    compressed: gzip.compressed,
    descriptor: {
      path: relativePath,
      sha256: sha256(gzip.compressed),
      bytes: gzip.compressed.byteLength,
      decompressedSha256: gzip.decompressedSha256,
      sourceSha256: sha256(source),
      sourceBytes: source.byteLength,
    },
  };
}

export function validateStatus(status, allowNa = false) {
  if (!STATUSES.has(status) || (status === "N/A" && !allowNa)) throw new Error(`invalid_evidence_status:${status}`);
}

export function assertPublicEvidence(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) { stack.push(...current); continue; }
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new Error(`forbidden_evidence_key:${key}`);
      if (typeof child === "string" && (redactPath(child) !== child || /WIN-[A-Z0-9-]+/i.test(child))) {
        throw new Error(`forbidden_evidence_value:${key}`);
      }
      stack.push(child);
    }
  }
}
