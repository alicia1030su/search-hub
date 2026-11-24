import { createHash } from "node:crypto";
import { join, parse, resolve } from "node:path";
import type { OriginGuard } from "./types.js";

const DOMAIN = "search-hub-origin-prefix-v1\0";

/** Hashes every normalized path prefix with an explicit domain separator. */
export function originPrefixDigest(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const prefixes = [root];
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = `${current}${current.endsWith("/") || current.endsWith("\\") ? "" : "/"}${component}`;
    prefixes.push(current);
  }
  const hash = createHash("sha256");
  for (const prefix of prefixes) {
    hash.update(Buffer.from(DOMAIN, "utf8"));
    hash.update(Buffer.from(prefix, "utf8"));
    hash.update(Buffer.from("\0", "utf8"));
  }
  return hash.digest("hex");
}

export function createOriginGuard(dataDir: string, installDir: string): OriginGuard {
  return { algorithm: "sha256-prefix-v1", dataDir: originPrefixDigest(dataDir), installDir: originPrefixDigest(installDir) };
}

export function originGuardMatches(guard: OriginGuard, dataDir: string, installDir: string): boolean {
  const expected = createOriginGuard(dataDir, installDir);
  return guard.dataDir === expected.dataDir && guard.installDir === expected.installDir;
}

function normalizedPrefixes(path: string): string[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  const prefixes = [normalize(root)];
  let current = root;
  for (const component of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    prefixes.push(normalize(current));
  }
  return prefixes;
}

/** Rejects equal, descendant and ancestor targets without rejecting disjoint siblings. */
export function assertDisjointRestoreTarget(targetDir: string, sourcePaths: readonly string[]): void {
  const target = resolve(targetDir);
  const targetPrefixes = normalizedPrefixes(target);
  const normalizedTarget = targetPrefixes.at(-1) as string;
  for (const sourcePath of sourcePaths) {
    const sourcePrefixes = normalizedPrefixes(sourcePath);
    const normalizedSource = sourcePrefixes.at(-1) as string;
    if (normalizedTarget === normalizedSource || targetPrefixes.includes(normalizedSource) || sourcePrefixes.includes(normalizedTarget)) {
      throw new Error("Restore target overlaps a source data/install path");
    }
  }
}
