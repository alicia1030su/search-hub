#!/usr/bin/env node
/**
 * Regenerates docs/provider-matrix.md from the catalog.
 *
 * The matrix used to be hand-maintained, which is how it drifted: it listed
 * MiniMax, Metaso and DuckDuckGo as "planned" long after adapters existed, and
 * claimed DeepSeek "has no standalone web-search API" when `deepseek-search`
 * was already implemented.
 *
 * Two modes:
 *   node scripts/generate-provider-matrix.mjs           → write the file
 *   node scripts/generate-provider-matrix.mjs --check   → exit 1 if it is stale
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(REPO, "docs", "provider-matrix.md");
const CHECK = process.argv.includes("--check");

const mod = await import(pathToFileURL(join(REPO, "packages", "providers", "src", "catalog.ts")).href);
const registry = await import(pathToFileURL(join(REPO, "packages", "providers", "src", "registry.ts")).href);
const catalog = mod.PROVIDER_CATALOG;
const adapters = new Set(registry.listAdapters().map((adapter) => adapter.type));

const builtin = catalog.filter((entry) => entry.implementation === "builtin");
const generic = catalog.filter((entry) => entry.implementation === "generic");
const unavailable = catalog.filter((entry) => entry.implementation === "unavailable");
const liveTested = builtin.filter((entry) => entry.verification === "live_tested");

const counts = {
  total: catalog.length,
  builtin: builtin.length,
  generic: generic.length,
  unavailable: unavailable.length,
  live: liveTested.length,
  documented: builtin.filter((entry) => entry.verification === "documented").length,
  mock: builtin.filter((entry) => entry.verification === "mock_verified").length,
};

const missingAdapter = builtin.filter((entry) => !adapters.has(entry.type));
const orphanAdapter = [...adapters].filter((type) => !catalog.some((entry) => entry.type === type));

const content = `# Provider matrix

One table for every provider type the catalog knows about: what it is, what it needs,
and — the part that matters — **what evidence is still missing before it can be called
\`live_tested\`**.

**This file is generated.** Run \`node scripts/generate-provider-matrix.mjs\` after any
catalog change; CI runs it with \`--check\` and fails on drift, so the counts below can
never quietly disagree with the code again.

## Counts (derived, not typed by hand)

| Metric | Value |
|---|---|
| Catalogue entries | ${counts.total} |
| Native adapters (\`builtin\`) | ${counts.builtin} |
| \`live_tested\` (real vendor call recorded) | ${counts.live} |
| \`documented\` (implemented, never called the vendor) | ${counts.documented} |
| \`mock_verified\` (contract-tested against a local double only) | ${counts.mock} |
| Generic presets (\`generic\`) | ${counts.generic} |
| No official API (\`unavailable\`) | ${counts.unavailable} |
| Adapters registered | ${adapters.size} |

These four states are **not** interchangeable:

| Level | Meaning |
|---|---|
| \`live_tested\` | A recorded run against the real vendor API returned real results. Evidence lives in \`docs/live-evidence/<type>.json\`. |
| \`documented\` | Implemented strictly from the vendor's official documentation and covered by local contract tests. The wire shape is believed correct; the account, quota and live behaviour are unverified. |
| \`mock_verified\` | Exercised only against a deterministic local double. Proves the code path, never the vendor. |
| \`unverified\` | No adapter, or an adapter whose vendor interface could not be confirmed. |

Contract tests use local HTTP fixtures built from the documented wire format. They
prove protocol fidelity, **not** that a key works.

## Implemented providers

| Type | Capability | Category | Auth | Default URL | Verification | Notes |
|---|---|---|---|---|---|---|
${builtin
  .map((entry) => {
    const notes = (entry.notes ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 220);
    return `| \`${entry.type}\` | ${entry.capability ?? "raw_search"} | ${entry.category} | ${entry.authType} | ${entry.defaultBaseUrl ?? "—"} | \`${entry.verification}\` | ${notes} |`;
  })
  .join("\n")}

## Generic declarative presets

These have **no builtin adapter**: users must supply the endpoint and field mapping
through Generic HTTP/JSON. \`generic\` does not mean "broken" — it means "yours to
configure".

| Type | Category | Notes |
|---|---|---|
${generic
  .map((entry) => `| \`${entry.type}\` | ${entry.category} | ${(entry.notes ?? entry.description).replace(/\|/g, "\\|").slice(0, 200)} |`)
  .join("\n")}

## No official API

| Type | Category | Why it stays unavailable |
|---|---|---|
${unavailable
  .map((entry) => `| \`${entry.type}\` | ${entry.category} | ${(entry.notes ?? entry.description).replace(/\|/g, "\\|").slice(0, 220)} |`)
  .join("\n")}

## Structural invariants (checked by the generator and by CI)

- A \`builtin\` entry without an adapter is a bug: **${missingAdapter.length}** found${missingAdapter.length ? ` (${missingAdapter.map((e) => e.type).join(", ")})` : ""}.
- An adapter without a catalog entry is a bug (users can never create it): **${orphanAdapter.length}** found${orphanAdapter.length ? ` (${orphanAdapter.join(", ")})` : ""}.
- Every \`live_tested\` entry must have \`docs/live-evidence/<type>.json\` with a recorded successful call.
`;

if (CHECK) {
  const existing = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
  if (existing !== content) {
    console.error("FAIL: docs/provider-matrix.md is stale. Run node scripts/generate-provider-matrix.mjs");
    if (missingAdapter.length > 0) {
      console.error(`  builtin without adapter: ${missingAdapter.map((e) => e.type).join(", ")}`);
    }
    if (orphanAdapter.length > 0) {
      console.error(`  adapter without catalog entry: ${orphanAdapter.join(", ")}`);
    }
    process.exit(1);
  }
  console.log("PASS: docs/provider-matrix.md matches the catalog");
  process.exit(0);
}

writeFileSync(TARGET, content, "utf8");
console.log(`wrote docs/provider-matrix.md (${counts.builtin} adapters, ${counts.live} live_tested)`);
