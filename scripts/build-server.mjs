#!/usr/bin/env node
/**
 * Production bundler.
 *
 * The repository runs TypeScript directly in development (tsx). Shipping tsx
 * and the whole TypeScript toolchain to production is fragile: `pnpm install
 * --prod` drops dev dependencies (including the web build tooling) and the
 * runtime then depends on an interpreter that may not exist.
 *
 * This script compiles the two runtime entrypoints with esbuild:
 *   apps/api/src/index.ts        -> apps/api/dist/server.mjs
 *   packages/mcp/src/stdio.ts    -> packages/mcp/dist/stdio.mjs
 *
 * Third-party packages stay external and are resolved from node_modules at
 * runtime; workspace packages (@search-hub/*) are bundled in. SQL migrations
 * are copied next to the server bundle so a production install does not need
 * the repository layout.
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const releasePackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const mcpPackage = JSON.parse(readFileSync(join(root, "packages", "mcp", "package.json"), "utf8"));
if (mcpPackage.version !== releasePackage.version) throw new Error(`MCP workspace version mismatch: ${mcpPackage.version}/${releasePackage.version}`);

const workspacePlugin = {
  name: "bundle-workspace-packages",
  setup(build) {
    build.onResolve({ filter: /^@search-hub\// }, (args) => {
      try {
        return {
          path: require.resolve(args.path, { paths: [args.resolveDir, root] }),
          sideEffects: true,
        };
      } catch (error) {
        return { errors: [{ text: `Cannot resolve ${args.path}: ${error.message}` }] };
      }
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  plugins: [workspacePlugin],
  define: { __SHUB_VERSION__: JSON.stringify(releasePackage.version) },
  banner: {
    js: [
      "import { createRequire as __searchHubCreateRequire } from 'node:module';",
      "const require = __searchHubCreateRequire(import.meta.url);",
    ].join("\n"),
  },
};

rmSync(join(root, "apps/api/dist"), { recursive: true, force: true });
rmSync(join(root, "packages/mcp/dist"), { recursive: true, force: true });
mkdirSync(join(root, "apps/api/dist"), { recursive: true });
mkdirSync(join(root, "packages/mcp/dist"), { recursive: true });

await build({
  ...common,
  entryPoints: [join(root, "apps/api/src/index.ts")],
  outfile: join(root, "apps/api/dist/server.mjs"),
});

await build({
  ...common,
  entryPoints: [join(root, "packages/mcp/src/stdio.ts")],
  outfile: join(root, "packages/mcp/dist/stdio.mjs"),
});

// The bundled server resolves "../migrations" relative to its own URL, i.e.
// apps/api/migrations. Copying there keeps `node dist/server.mjs` working from
// any working directory. (File-by-file: fs.cpSync recursive crashes on some
// Windows configurations.)
const migrationsSource = join(root, "packages/db/migrations");
const migrationsTarget = join(root, "apps/api/migrations");
mkdirSync(migrationsTarget, { recursive: true });
for (const file of readdirSync(migrationsSource)) {
  if (file.endsWith(".sql")) {
    copyFileSync(join(migrationsSource, file), join(migrationsTarget, file));
  }
}

process.stdout.write("Built apps/api/dist/server.mjs and packages/mcp/dist/stdio.mjs\n");
