#!/usr/bin/env node
/** Bundles the CLI for Node 22 execution and as a CommonJS SEA payload. */
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
const out = join(root, "packages", "cli", "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const workspacePlugin = {
  name: "bundle-workspace-packages",
  setup(bundle) {
    bundle.onResolve({ filter: /^@search-hub\// }, (args) => {
      try {
        return { path: require.resolve(args.path, { paths: [args.resolveDir, root] }) };
      } catch (error) {
        return { errors: [{ text: `Cannot resolve ${args.path}: ${error.message}` }] };
      }
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "info",
  plugins: [workspacePlugin],
  define: { __SHUB_VERSION__: JSON.stringify(pkg.version) },
};

await build({
  ...common,
  entryPoints: [join(root, "packages", "cli", "src", "index.ts")],
  outfile: join(out, "index.mjs"),
  format: "esm",
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __shubCreateRequire } from 'node:module';",
      "const require = __shubCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
await build({
  ...common,
  entryPoints: [join(root, "packages", "cli", "src", "index.ts")],
  outfile: join(out, "index.cjs"),
  format: "cjs",
});
process.stdout.write(`Built shub ${pkg.version} (ESM + CommonJS SEA payload)\n`);
