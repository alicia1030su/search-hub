import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const PROTECTED_SEGMENTS = new Set(["node_modules", ".git", ".data", "data", "artifacts", ".resource-bench", "dist", "playwright-report", "test-results", "coverage", ".workbuddy", ".worktrees", "worktrees"]);
const DATABASE_SUFFIXES = [".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite-wal", ".sqlite-shm"];
let windowsAttributes = null;

async function fileAttributes(filePath) {
  if (process.platform !== "win32") return null;
  windowsAttributes ??= (async () => {
    const koffi = await import("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    return { koffi, get: kernel32.func("uint32_t __stdcall GetFileAttributesW(str16 path)") };
  })();
  const loaded = await windowsAttributes;
  return loaded.get(filePath);
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isProtected(candidate, repoRoot) {
  const relative = path.relative(repoRoot, candidate);
  const segments = relative.split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) return true;
  if (segments.includes("dist") && segments.includes("package")) return true;
  const lower = candidate.toLowerCase();
  if (DATABASE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (/(?:^|[\\/])(?:master\.key|backups?|search_cache|pnpm-store|playwright-browsers)(?:[\\/]|$)/i.test(candidate)) return true;
  return false;
}

async function validatePath(candidate, repoRoot) {
  if (typeof candidate !== "string" || candidate.includes("\0")) return { ok: false, reason: "invalid_path" };
  if (/^(?:\\\\|\/\/)/.test(candidate) || /^\\\\[?.]/.test(candidate)) return { ok: false, reason: "unc_or_device_path" };
  const resolved = path.resolve(candidate);
  if (path.parse(resolved).root === resolved) return { ok: false, reason: "filesystem_root" };
  if (!inside(repoRoot, resolved)) return { ok: false, reason: "outside_repository" };
  if (isProtected(resolved, repoRoot)) return { ok: false, reason: "protected_path" };
  let current = repoRoot;
  const relative = path.relative(repoRoot, resolved);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return { ok: false, reason: "symbolic_link" };
      if (process.platform === "win32") {
        const attributes = await fileAttributes(current);
        if ((attributes & 0x400) !== 0) return { ok: false, reason: "reparse_point" };
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      return { ok: false, reason: "lstat_failed" };
    }
  }
  try {
    const realRepo = await realpath(repoRoot);
    const realParent = await realpath(path.dirname(resolved));
    if (!inside(realRepo, realParent)) return { ok: false, reason: "realpath_escape" };
  } catch {
    return { ok: false, reason: "realpath_unavailable" };
  }
  return { ok: true, path: resolved };
}

async function readOwnerManifest(directory, expectedRunId = null) {
  try {
    const value = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
    if (value.owner !== "search-hub-resource" || value.version !== 1 || typeof value.createdAt !== "string") return null;
    if (expectedRunId && value.runId !== expectedRunId) return null;
    return value;
  } catch {
    return null;
  }
}

async function treeFiles(root) {
  const files = [];
  let rejected = null;
  const walk = async (directory) => {
    if (files.length >= 100_000) {
      rejected = "file_limit_exceeded";
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) {
        rejected = "symbolic_link";
        return;
      }
      if (process.platform === "win32" && ((await fileAttributes(filePath)) & 0x400) !== 0) {
        rejected = "reparse_point";
        return;
      }
      if (info.isDirectory()) await walk(filePath);
      else if (info.isFile()) files.push({ path: filePath, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
      else {
        rejected = "unsupported_file_type";
        return;
      }
    }
  };
  try {
    const info = await lstat(root);
    if (info.isFile()) return { files: [{ path: root, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) }], rejected: null };
    if (!info.isDirectory()) return { files: [], rejected: "unsupported_file_type" };
    await walk(root);
  } catch (error) {
    if (error?.code !== "ENOENT") rejected = "scan_failed";
  }
  return { files, rejected };
}

function descriptor(category, candidatePath, owner, reason) {
  return { category, path: candidatePath, owner, reason };
}

/** Find only explicitly allowlisted, ownership-proven cache paths. */
export async function collectCacheCandidates(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const descriptors = [];
  const resourceRoot = path.join(repoRoot, ".cache", "search-hub-resource", "v1");
  try {
    const runIds = await readdir(resourceRoot, { withFileTypes: true });
    for (const entry of runIds) {
      if (!entry.isDirectory() || entry.name === "locks") continue;
      const runPath = path.join(resourceRoot, entry.name);
      if (await readOwnerManifest(runPath, entry.name)) descriptors.push(descriptor("tool-owned-run", runPath, "search-hub-resource", "owned_run_manifest"));
    }
  } catch {
    // No tool-owned run cache is a normal empty result.
  }
  if (options.vitestCacheDir) descriptors.push(descriptor("vitest-cache", path.resolve(repoRoot, options.vitestCacheDir), "explicit-config", "explicit_vitest_cache"));
  if (options.esbuildCacheDir) {
    const esbuildPath = path.resolve(repoRoot, options.esbuildCacheDir);
    if (await readOwnerManifest(esbuildPath)) descriptors.push(descriptor("esbuild-cache", esbuildPath, "search-hub-resource", "explicit_esbuild_cache_with_owner"));
  }
  for (const configPath of options.tsBuildInfoFiles ?? []) descriptors.push(descriptor("tsbuildinfo", path.resolve(repoRoot, configPath), "build-config", "explicit_tsbuildinfo"));
  const items = [];
  const rejected = [];
  for (const entry of descriptors) {
    const valid = await validatePath(entry.path, repoRoot);
    if (!valid.ok) {
      rejected.push({ ...entry, reason: valid.reason });
      continue;
    }
    if (entry.category === "vitest-cache" && valid.path !== path.join(repoRoot, ".cache", "vitest")) {
      rejected.push({ ...entry, reason: "not_explicit_dot_cache_vitest" });
      continue;
    }
    if (entry.category === "esbuild-cache" && valid.path !== path.join(repoRoot, ".cache", "esbuild")) {
      rejected.push({ ...entry, reason: "not_explicit_dot_cache_esbuild" });
      continue;
    }
    if (entry.category === "tsbuildinfo" && !valid.path.endsWith(".tsbuildinfo")) {
      rejected.push({ ...entry, reason: "not_tsbuildinfo" });
      continue;
    }
    const scanned = await treeFiles(valid.path);
    if (scanned.rejected || scanned.files.length === 0) {
      if (scanned.rejected) rejected.push({ ...entry, reason: scanned.rejected });
      continue;
    }
    const size = scanned.files.reduce((sum, file) => sum + file.size, 0);
    const mtimeMs = scanned.files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0);
    const info = await lstat(valid.path);
    items.push({ ...entry, path: valid.path, size, mtimeMs, files: scanned.files.length, fileEntries: scanned.files, type: info.isDirectory() ? "directory" : "file" });
  }
  return { repoRoot, items: items.sort((a, b) => a.path.localeCompare(b.path)), rejected };
}

/** Discover only exact tsBuildInfoFile values declared by repository configs. */
export async function discoverTsBuildInfo(repoRoot) {
  const configs = [path.join(repoRoot, "tsconfig.json"), ...["apps", "packages"].flatMap((group) => ["", ".node", ".app", ".build"].map((suffix) => path.join(repoRoot, group, "*", `tsconfig${suffix}.json`)))];
  const found = [];
  for (const configPath of configs) {
    if (configPath.includes("*")) {
      const parent = path.dirname(configPath);
      const name = path.basename(configPath);
      const matcher = new RegExp(`^${name.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      try {
        for (const entry of await readdir(parent)) {
          if (matcher.test(entry)) {
            const candidate = path.join(parent, entry);
            try {
              const value = JSON.parse(await readFile(candidate, "utf8"));
              const output = value.compilerOptions?.tsBuildInfoFile;
              if (typeof output === "string" && output.endsWith(".tsbuildinfo")) found.push(path.resolve(parent, output));
            } catch {
              // Invalid/unreadable config is not evidence for deletion.
            }
          }
        }
      } catch {
        // Missing workspace group is normal.
      }
    } else {
      try {
        const value = JSON.parse(await readFile(configPath, "utf8"));
        const output = value.compilerOptions?.tsBuildInfoFile;
        if (typeof output === "string" && output.endsWith(".tsbuildinfo")) found.push(path.resolve(path.dirname(configPath), output));
      } catch {
        // Missing config is normal.
      }
    }
  }
  return [...new Set(found)];
}

export { inside, isProtected, validatePath };
