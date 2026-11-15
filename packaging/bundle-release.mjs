#!/usr/bin/env node
/**
 * Builds the production server bundle used by the release packages.
 *
 * The Docker image can rely on `node_modules` being present; a downloaded ZIP
 * cannot. pnpm's tree for this workspace is ~90k files (virtual store plus a
 * node_modules per package), which is both a size problem and above the
 * 65,535-entry limit of a plain ZIP container.
 *
 * So release packages ship one bundled `server.mjs` plus the single native
 * addon: `better_sqlite3.node` cannot live inside a bundle because it is a
 * prebuilt shared object.
 *
 * Output inside <app>:
 *   apps/api/dist/server.mjs
 *   apps/web/dist/**
 *   packages/mcp/dist/stdio.mjs
 *   packages/db/migrations/*.sql
 *   node_modules/better-sqlite3/**
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = process.argv[2];
if (!APP) {
  console.error("usage: node packaging/bundle-release.mjs <app-dir>");
  process.exit(2);
}

const require = createRequire(join(REPO, "package.json"));

const workspacePlugin = {
  name: "bundle-workspace-packages",
  setup(b) {
    b.onResolve({ filter: /^@search-hub\// }, (args) => ({
      path: require.resolve(args.path, { paths: [args.resolveDir, REPO] }),
      sideEffects: true,
    }));
  },
};

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
  // Everything is inlined except the native addon.
  external: ["better-sqlite3"],
  packages: "bundle",
  plugins: [workspacePlugin],
  banner: {
    js: [
      "import { createRequire as __searchHubCreateRequire } from 'node:module';",
      "const require = __searchHubCreateRequire(import.meta.url);",
    ].join("\n"),
  },
};

async function main() {
  console.log("[bundle] step 1: server");
  await build({
    ...shared,
    entryPoints: [join(REPO, "apps/api/src/index.ts")],
    outfile: join(APP, "apps/api/dist/server.mjs"),
  });

  console.log("[bundle] step 2: stdio");
  await build({
    ...shared,
    entryPoints: [join(REPO, "packages/mcp/src/stdio.ts")],
    outfile: join(APP, "packages/mcp/dist/stdio.mjs"),
  });

  console.log("[bundle] step 3: web + migrations + native");
  const webDist = join(REPO, "apps/web/dist");
  if (!existsSync(webDist)) {
    console.error(`[bundle] apps/web/dist is missing at ${webDist}`);
    process.exit(3);
  }
  copyTree(webDist, join(APP, "apps/web/dist"));

  // The migration runner reads this directory at runtime; it cannot be bundled.
  copyTree(join(REPO, "packages/db/migrations"), join(APP, "packages/db/migrations"));

  console.log("[bundle] step 4: native addon");
  const sqliteDst = join(APP, "node_modules/better-sqlite3");
  rmSync(sqliteDst, { recursive: true, force: true });
  mkdirSync(dirname(sqliteDst), { recursive: true });
  // better-sqlite3 13 ships prebuilt binaries under `prebuilds/<platform>-<arch>.node`
  // (lib/binding.js resolves that first), not `build/Release`. Only the binary for
  // the target platform is kept: the full folder is 17 MB of other OSes.
  const sqliteSrc = realpathSync(join(REPO, "apps/api/node_modules/better-sqlite3"));
  const wanted = `${platformKey()}-${archKey()}.node`;
  copyTree(sqliteSrc, sqliteDst, (path, isDirectory) => {
    if (path.endsWith(".map")) return false;
    // Keep the prebuilds directory itself plus the one binary for this target.
    if (path.includes("prebuilds")) return isDirectory || path.endsWith(wanted);
    return true;
  });

  const binding = join(sqliteDst, "prebuilds", wanted);
  if (!existsSync(binding)) {
    // Without this file the server starts and then fails on the first query, so
    // the build fails here instead of shipping a broken package.
    console.error(`[bundle] native addon for ${wanted} is missing at ${binding}`);
    process.exit(4);
  }

  console.log(`[bundle] done; ${count(APP)} files in package app/`);
}

/**
 * Recursive copy built on readdir + copyFile.
 *
 * `fs.cpSync` aborts silently on this size of tree under the sandboxed runner,
 * so the copy is done explicitly and any failure surfaces with a path.
 */
function copyTree(from, to, filter = () => true) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    // The filter sees whether this entry is a directory, so a caller can keep a
    // directory while dropping most of its children.
    if (!filter(source, entry.isDirectory())) continue;
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, filter);
    else copyFileSync(source, target);
  }
}

/** Node's platform name mapped to better-sqlite3's prebuild naming. */
function platformKey() {
  const target = process.env["PACKAGE_TARGET"] ?? "";
  if (target.startsWith("windows")) return "win32";
  if (target.startsWith("macos")) return "darwin";
  return "linux";
}

function archKey() {
  const target = process.env["PACKAGE_TARGET"] ?? "";
  if (target.includes("arm64")) return "arm64";
  return "x64";
}

/** Node's platform name mapped to better-sqlite3's prebuild naming. */
function count(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    total += entry.isDirectory() ? count(join(root, entry.name)) : 1;
  }
  return total;
}

await main();
