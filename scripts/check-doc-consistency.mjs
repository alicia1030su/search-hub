#!/usr/bin/env node
/**
 * Documentation consistency gate.
 *
 * The catalog is the single source of truth for what Search Hub can do. This
 * script derives the facts from the code and then checks that the documents
 * which people actually read do not contradict them.
 *
 * Rules it enforces (each corresponds to a real past mistake):
 *  1. README / README_EN must not list a provider as "not implemented" while a
 *     native adapter exists for it.
 *  2. Every documented count (total / implemented / live-tested / catalogue
 *     entries) must match the catalog.
 *  3. The version quoted in README must match package.json.
 *  4. The catalog must not contain an entry marked `builtin` without an adapter,
 *     nor an adapter without a catalog entry (an invisible provider is a bug:
 *     users cannot create what the marketplace never lists).
 *  5. `live_tested` must be backed by a recorded evidence file.
 *
 * Exit code 1 on any contradiction, so CI blocks the merge.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkNodeContract, checkReadmeConsistency, checkReadmeLinks, resolveReadmeMode } from "./check-readme-consistency.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);
const note = (message) => notes.push(message);

let catalog = [];
let adapters = [];
let readme = "";
let readmeEn = "";
let pkg = {};
let adapterSet = new Set();
let builtin = [];
let liveTested = [];
let documented = [];
let mockVerified = [];
let unverified = [];
let noApi = [];
let byType = new Map();

/**
 * Runs every check and returns the list of problems.
 * Exported so a test can call it without spawning a process, and so importing
 * the module never terminates the host.
 */
export async function main({ mode = "auto" } = {}) {
  const readmeMode = resolveReadmeMode({ root: REPO, requested: mode });
  const catalog = await loadCatalog();
  const adapters = await loadAdapters();

  // ---------------------------------------------------------------- structural

  const byType = new Map(catalog.map((entry) => [entry.type, entry]));
  const adapterSet = new Set(adapters);

  for (const entry of catalog) {
    if (entry.implementation === "builtin" && !adapterSet.has(entry.type)) {
      fail(`catalog says "${entry.type}" is builtin, but no adapter is registered`);
    }
    if (entry.implementation !== "builtin" && adapterSet.has(entry.type)) {
      // A real adapter that the catalog hides is unreachable from the marketplace.
      fail(`adapter "${entry.type}" is registered but the catalog marks it "${entry.implementation}"`);
    }
  }
  for (const type of adapters) {
    if (!byType.has(type)) {
      fail(`adapter "${type}" has no catalog entry, so users can never create it from the UI`);
    }
  }

  const builtin = catalog.filter((entry) => entry.implementation === "builtin");
  const liveTested = catalog.filter((entry) => entry.verification === "live_tested");
  const documented = catalog.filter((entry) => entry.verification === "documented");
  const mockVerified = catalog.filter((entry) => entry.verification === "mock_verified");
  const unverified = catalog.filter((entry) => entry.verification === "unverified");
  const noApi = catalog.filter((entry) => entry.verification === "no_official_api");

  note(`catalog entries: ${catalog.length}`);
  note(`implemented (builtin): ${builtin.length}`);
  note(`live_tested: ${liveTested.length} (${liveTested.map((e) => e.type).join(", ")})`);
  note(`documented: ${documented.length}`);
  note(`mock_verified: ${mockVerified.length}`);
  note(`unverified (generic presets): ${unverified.length}`);
  note(`no_official_api: ${noApi.length}`);

  // `live_tested` needs evidence on disk: a claim without a recording is exactly
  // the kind of thing this gate exists to stop.
  const evidenceDir = join(REPO, "docs", "live-evidence");
  if (liveTested.length > 0 && !existsSync(evidenceDir)) {
    fail(`docs/live-evidence/ is missing but ${liveTested.length} provider(s) claim live_tested`);
  }
  for (const entry of liveTested) {
    const file = join(evidenceDir, `${entry.type}.json`);
    if (!existsSync(file)) {
      fail(`"${entry.type}" claims live_tested but docs/live-evidence/${entry.type}.json is missing`);
      continue;
    }
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (!record.lastSuccess || record.lastSuccess.httpStatus !== 200 || !record.lastSuccess.resultCount) {
      fail(`docs/live-evidence/${entry.type}.json has no successful recorded call`);
    }
  }

  // ------------------------------------------------------------------ documents

  const readme = read("README.md");
  const readmeEn = read("README_EN.md");
  const pkg = JSON.parse(read("package.json"));

  problems.push(...checkNodeContract({
    engine: pkg.engines?.node,
    zh: readme,
    en: readmeEn,
    cliDoc: read("docs/cli.md"),
    deploymentDoc: read("docs/deployment.md"),
    version: pkg.version,
  }));
  problems.push(...checkReadmeConsistency({ zh: readme, en: readmeEn, version: pkg.version, mode: readmeMode, root: REPO }));
  problems.push(...checkReadmeLinks({ text: readme, label: "README.md", file: "README.md", root: REPO }));
  problems.push(...checkReadmeLinks({ text: readmeEn, label: "README_EN.md", file: "README_EN.md", root: REPO }));

  // 1) no "not implemented" claim for a provider that has an adapter
  for (const [label, text] of [
    ["README.md", readme],
    ["README_EN.md", readmeEn],
  ]) {
    for (const marker of ["未实现", "not implemented", "不能创建", "refuses to create"]) {
      const lines = text.split("\n").filter((line) => line.includes(marker));
      for (const line of lines) {
        const claimed = catalog
          .filter((entry) => adapterSet.has(entry.type))
          .filter((entry) => new RegExp(`\\b${escapeRegex(entry.type)}\\b`).test(line))
          .map((entry) => entry.type);
        const named = catalog
          .filter((entry) => new RegExp(`\\b${escapeRegex(entry.type)}\\b`).test(line))
          .map((entry) => entry.type);
        if (claimed.length > 0) {
          fail(
            `${label} still calls ${claimed.join(", ")} "${marker}" although a native adapter exists: "${line.trim().slice(0, 120)}"`,
          );
        }
        void named;
      }
    }
  }

  // 2) version agreement
  const versionInReadme = readme.match(/\bv?(\d+\.\d+\.\d+(?:-beta\.\d+)?)\b/);
  if (versionInReadme && !readme.includes(pkg.version)) {
    // The README may legitimately mention an older release in the changelog
    // section, but the download block must point at the current version.
    const downloadBlock = readme.slice(readme.indexOf("## 下载安装"), readme.indexOf("## 快速开始"));
    if (downloadBlock && !downloadBlock.includes(pkg.version)) {
      fail(
        `README download block does not mention the current version ${pkg.version} (its first version-like token is ${versionInReadme[1]})`,
      );
    }
  }

  // 3) counts quoted in prose must match
  checkCount(readme, "README.md", /目录共\s*(\d+)\s*条/, catalog.length, "catalog entries");
  checkCount(readme, "README.md", /(\d+)\s*个可用适配器/, builtin.length, "implemented providers");
  // The section header has its own phrasing; it drifted independently before.
  checkCount(readme, "README.md", /已实现适配器（(\d+)\s*类）/, builtin.length, "implemented providers");
  checkCount(readme, "README.md", /(\d+)\s*个\s*generic\s*兼容入口/, unverified.length, "generic presets");
  checkCount(readme, "README.md", /(\d+)\s*个无官方接口/, noApi.length, "no-official-api entries");
  checkCount(readmeEn, "README_EN.md", /Implemented adapters \((\d+)\s*kinds\)/, builtin.length, "implemented providers");
  checkCount(readmeEn, "README_EN.md", /^> (\d+) catalogue entries/m, catalog.length, "catalogue entries");

  // 4) CHANGELOG must have an entry for the current version
  const changelog = read("CHANGELOG.md");
  if (!changelog.includes(pkg.version)) {
    fail(`CHANGELOG.md has no entry for the current version ${pkg.version}`);
  }

  // 4b) documents must not upgrade a non-live provider to "live tested"
  // Markdown table rows contain "|" between the type and the claim, so the check
  // works line by line instead of trying to span separators.
  for (const [label, text] of [["README.md", readme], ["README_EN.md", readmeEn]]) {
    for (const entry of catalog) {
      if (entry.verification === "live_tested") continue;
      const typePattern = new RegExp(`\\b${escapeRegex(entry.type)}\\b`);
      for (const line of text.split("\n")) {
        if (!typePattern.test(line)) continue;
        if (!/已真实联调|live.?tested|已联调/i.test(line)) continue;
        // A line that says "not live-tested" is fine; only a positive claim fails.
        if (/(未联调|not integration-tested|not live-tested|never called)/i.test(line)) continue;
        fail(`${label} presents "${entry.type}" as live-tested, but the catalog says ${entry.verification}`);
      }
    }
  }

  // 5) provider matrix must not contradict the catalog
  const matrixPath = join(REPO, "docs", "provider-matrix.md");
  if (existsSync(matrixPath)) {
    const matrix = readFileSync(matrixPath, "utf8");
    for (const entry of catalog) {
      if (!matrix.includes(entry.type)) continue;
      // A row claiming "not implemented" for a live adapter is the exact drift
      // this check exists to catch.
      const row = matrix.split("\n").find((line) => line.includes(`\`${entry.type}\``)) ?? "";
      // Look at the verification cell, not the prose: a note may legitimately
      // mention an unimplemented *transport*.
      const cells = row.split("|").map((cell) => cell.trim());
      const verificationCell = cells.find((cell) => /^`(documented|live_tested|mock_verified|unverified|no_official_api)`$/.test(cell));
      if (adapterSet.has(entry.type) && !verificationCell) {
        fail(`docs/provider-matrix.md has no verification cell for "${entry.type}"`);
      }
      if (adapterSet.has(entry.type) && !row.includes("`builtin`") && row.includes("planned")) {
        fail(`docs/provider-matrix.md marks "${entry.type}" as planned, but an adapter exists`);
      }
    }
  }


  for (const line of notes) console.log(`  ${line}`);
  return problems;
}

// ------------------------------------------------------------------ helpers

function read(relative) {
  const path = join(REPO, relative);
  if (!existsSync(path)) {
    fail(`${relative} is missing`);
    return "";
  }
  return readFileSync(path, "utf8");
}

/**
 * Pure count check, exported so tests can prove the gate rejects a wrong number
 * without editing README.md on disk.
 * Returns a problem string, or null when the claim matches (or is absent).
 */
export function checkCountValue(text, label, pattern, expected, what) {
  const match = text.match(pattern);
  if (!match) return null;
  const claimed = Number(match[1]);
  return claimed === expected ? null : `${label} says ${claimed} ${what}, but the catalog has ${expected}`;
}

function checkCount(text, label, pattern, expected, what) {
  const match = text.match(pattern);
  if (!match) return; // the phrase is optional; absence is not a contradiction
  const claimed = Number(match[1]);
  if (claimed !== expected) {
    fail(`${label} says ${claimed} ${what}, but the catalog has ${expected}`);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadCatalog() {
  const mod = await import(pathToFileURL(join(REPO, "packages", "providers", "src", "catalog.ts")).href);
  return mod.PROVIDER_CATALOG;
}

async function loadAdapters() {
  const mod = await import(pathToFileURL(join(REPO, "packages", "providers", "src", "registry.ts")).href);
  return mod.listAdapters().map((adapter) => adapter.type);
}


// Only execute when run as a script: importing this module from a test must not
// call process.exit().
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "auto";
  const found = await main({ mode });
  if (found.length === 0) {
    console.log("PASS: documentation matches the catalog");
    process.exit(0);
  }
  console.error(`\nFAIL: ${found.length} documentation inconsistency/ies:`);
  for (const problem of found) console.error(`  - ${problem}`);
  process.exit(1);
}
