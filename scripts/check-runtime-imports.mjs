#!/usr/bin/env node
/**
 * Resolve every external import of the production bundles from the location
 * they will actually run at.
 *
 * The bundler keeps third-party packages external (`packages: "external"`) and
 * inlines only `@search-hub/*`. That means a bundle can build successfully and
 * still crash at startup if a transitive dependency is not reachable from
 * `apps/api/dist` in a production-only install. This check fails before an
 * image is built, instead of letting the container discover it.
 *
 * Usage: node scripts/check-runtime-imports.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const BUNDLES = ["apps/api/dist/server.mjs", "packages/mcp/dist/stdio.mjs"];
// Only real module specifiers: `from "x"`, `import("x")`, `require("x")`.
// A looser pattern also matches identifiers such as `importHandler` inside
// bundled source text and produces phantom findings.
const SPECIFIER =
  /\bfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

let missing = 0;
for (const file of BUNDLES) {
  if (!existsSync(file)) {
    console.error(`FAIL: ${file} is missing; run \`pnpm build\` first`);
    missing += 1;
    continue;
  }
  const absolute = resolve(file);
  const requireFromBundle = createRequire(resolve(dirname(absolute), "__resolve__.cjs"));
  const source = readFileSync(absolute, "utf8");
  const specifiers = new Set();
  for (const match of source.matchAll(SPECIFIER)) {
    specifiers.add(match[1] ?? match[2] ?? match[3]);
  }

  const external = [...specifiers].filter(
    (specifier) =>
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:") &&
      !specifier.startsWith("data:"),
  );
  const unresolved = [];
  for (const specifier of external) {
    try {
      requireFromBundle.resolve(specifier);
    } catch {
      unresolved.push(specifier);
    }
  }
  console.log(
    `${file}: ${external.length} external specifier(s), ${unresolved.length} unresolved`,
  );
  for (const specifier of unresolved) console.error(`  MISSING ${specifier}`);
  missing += unresolved.length;
}

if (missing > 0) {
  console.error(
    "\nFAIL: the production bundle imports packages that are not installed. " +
      "Add the dependency to the owning workspace package or bundle it.",
  );
  process.exit(1);
}
console.log("PASS: every external import resolves from the bundle location");
