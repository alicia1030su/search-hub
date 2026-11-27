#!/usr/bin/env node
/**
 * README structure, fact-parity, screenshot-mode and relative-link gates.
 *
 * Interim mode is used while the real v0.1.16 screenshots are being captured:
 * each README must contain exactly three CAPTURE_REQUIRED comments and no
 * screenshot links. Final mode requires zero placeholders and three real image
 * files, so a release can never ship with capture markers or broken images.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedReleaseAssets } from "../packaging/release-evidence.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const README_ANCHORS = Object.freeze([
  "top",
  "highlights",
  "screenshots",
  "quick-start",
  "interfaces",
  "providers",
  "docs",
  "limits",
  "license",
]);
export const SCREENSHOT_FILES = Object.freeze([
  "docs/screenshots/v0117/dashboard.png",
  "docs/screenshots/v0117/search-lab.png",
  "docs/screenshots/v0117/provider-health.png",
]);
export const README_MIN_LINES = 100;
export const README_MAX_LINES = 150;
const NODE_CONTRACT = ">=22.12.0";

export function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0);
}

export function extractAnchors(text) {
  return [...text.matchAll(/<a\s+id="([^"]+)"\s*>\s*<\/a>/g)].map((match) => match[1]);
}

export function extractMarkdownLinks(text) {
  const links = [];
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of text.matchAll(pattern)) {
    links.push({
      target: match[1],
      line: text.slice(0, match.index).split("\n").length,
      image: match[0].startsWith("!"),
    });
  }
  return links;
}

function headingAnchors(text) {
  const anchors = new Set(extractAnchors(text));
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const slug = match[1]
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    if (slug) anchors.add(slug);
  }
  return anchors;
}

/** Validate relative Markdown links/images and same-document anchors. */
export function checkReadmeLinks({
  text,
  label,
  file,
  root = REPO_ROOT,
  fileExists = existsSync,
  readText = (target) => readFileSync(target, "utf8"),
}) {
  const problems = [];
  const sourceFile = resolve(root, file);
  for (const link of extractMarkdownLinks(text)) {
    const target = link.target;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    if (target.startsWith("/")) {
      problems.push(`${label}:${link.line} uses a non-relative local link: ${target}`);
      continue;
    }

    const hashIndex = target.indexOf("#");
    const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const hash = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
    const sameDocument = pathPart.length === 0;
    const targetFile = sameDocument ? sourceFile : resolve(dirname(sourceFile), decodeURIComponent(pathPart));
    const relativeTarget = relative(root, targetFile);
    if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      problems.push(`${label}:${link.line} relative link escapes the repository root: ${target}`);
      continue;
    }
    if (!sameDocument && !fileExists(targetFile)) {
      problems.push(`${label}:${link.line} links to missing file: ${target}`);
      continue;
    }
    if (hash) {
      const targetText = sameDocument ? text : readText(targetFile);
      if (!headingAnchors(targetText).has(decodeURIComponent(hash))) {
        problems.push(`${label}:${link.line} links to missing anchor: ${target}`);
      }
    }
  }
  return problems;
}

export function checkNodeContract({ engine, zh, en, cliDoc, deploymentDoc, version }) {
  const problems = [];
  if (engine !== NODE_CONTRACT) {
    problems.push(`package.json engines.node must be ${NODE_CONTRACT}, received ${engine ?? "missing"}`);
  }
  for (const [label, text] of [["README.md", zh], ["README_EN.md", en]]) {
    if (!text.includes(`Node.js ${NODE_CONTRACT}`)) {
      problems.push(`${label} must state Node.js ${NODE_CONTRACT} for the portable CLI`);
    }
  }

  if (cliDoc !== undefined) {
    const installBlock = cliDoc.split("## Configuration")[0];
    if (!version || !installBlock.includes(`shub-v${version}-node22.tar.gz`)) {
      problems.push(`docs/cli.md install block must reference the v${version ?? "current"} Node CLI asset`);
    }
    if (!installBlock.includes(`Node.js ${NODE_CONTRACT}`)) {
      problems.push(`docs/cli.md install block must state Node.js ${NODE_CONTRACT}`);
    }
    if (installBlock.includes("Node.js 22+")) problems.push("docs/cli.md install block still uses the ambiguous Node.js 22+ contract");
    if (version) {
      for (const match of installBlock.matchAll(/v\d+\.\d+\.\d+/g)) {
        if (match[0] !== `v${version}`) problems.push(`docs/cli.md install block still references ${match[0]}`);
      }
    }
  }

  if (deploymentDoc !== undefined) {
    const start = deploymentDoc.indexOf("## Release");
    const end = deploymentDoc.indexOf("## Backup and restore");
    const assetBlock = start >= 0 ? deploymentDoc.slice(start, end >= 0 ? end : undefined) : "";
    if (!version || !assetBlock.includes(`shub-v${version}-node22.tar.gz`)) {
      problems.push(`docs/deployment.md release asset block must reference the v${version ?? "current"} Node CLI asset`);
    }
    if (!assetBlock.includes(`Node.js ${NODE_CONTRACT}`)) {
      problems.push(`docs/deployment.md release asset block must state Node.js ${NODE_CONTRACT}`);
    }
    if (assetBlock.includes("Node.js 22+")) problems.push("docs/deployment.md release asset block still uses the ambiguous Node.js 22+ contract");
    if (version) {
      for (const match of assetBlock.matchAll(/v\d+\.\d+\.\d+/g)) {
        if (match[0] !== `v${version}`) problems.push(`docs/deployment.md release asset block still references ${match[0]}`);
      }
    }
  }
  return problems;
}

function checkFactGroups(zh, en, problems) {
  const groups = [
    {
      name: "MCP scopes",
      zh: ["mcp:use", "sources:read", "get_search_sources"],
      en: ["mcp:use", "sources:read", "get_search_sources"],
    },
    {
      name: "live-tested providers",
      zh: ["Hacker News", "Crossref", "OpenAlex", "PubMed"],
      en: ["Hacker News", "Crossref", "OpenAlex", "PubMed"],
    },
    {
      name: "provider verification states",
      zh: ["live_tested", "documented", "mock_verified"],
      en: ["live_tested", "documented", "mock_verified"],
    },
    {
      name: "deployment and recovery",
      zh: ["Windows x64", "Linux x64", "Linux arm64", "Docker Compose", "SHA256SUMS", "resource-evidence.json", "best-effort"],
      en: ["Windows x64", "Linux x64", "Linux arm64", "Docker Compose", "SHA256SUMS", "resource-evidence.json", "best-effort"],
    },
    {
      name: "limits",
      zh: ["多实例未实现", "Redis", "PostgreSQL", "合成基准", "SSE"],
      en: ["Multi-instance deployment is not implemented", "Redis", "PostgreSQL", "synthetic fixtures", "SSE"],
    },
  ];
  for (const group of groups) {
    for (const token of group.zh) {
      if (!zh.includes(token)) problems.push(`README.md is missing ${group.name} fact: ${token}`);
    }
    for (const token of group.en) {
      if (!en.includes(token)) problems.push(`README_EN.md is missing ${group.name} fact: ${token}`);
    }
  }
}

function screenshotLinkTargets(text) {
  return extractMarkdownLinks(text)
    .filter((link) => link.image)
    .map((link) => {
      const withoutQueryOrHash = link.target.split(/[?#]/, 1)[0] ?? "";
      let decoded = withoutQueryOrHash;
      try {
        decoded = decodeURIComponent(withoutQueryOrHash);
      } catch {
        // Keep the undecoded target: link validation will report the bad path.
      }
      return posix.normalize(decoded.replace(/^\.\//, ""));
    })
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//"))
    .filter((target) => target.startsWith("docs/screenshots/"));
}

/** Resolve auto/interim/final without allowing a captured SHA B to fall back. */
export function resolveReadmeMode({ root = REPO_ROOT, requested = "auto", fileExists = existsSync } = {}) {
  if (!["auto", "interim", "final"].includes(requested)) {
    throw new Error(`unsupported_readme_mode:${requested}`);
  }
  const screenshotsPresent = SCREENSHOT_FILES.every((file) => fileExists(join(root, file)));
  if (screenshotsPresent) return "final";
  return requested === "final" ? "final" : "interim";
}

/** Validate both README files against the release version and screenshot mode. */
export function checkReadmeConsistency({ zh, en, version, mode = "interim", root = REPO_ROOT, fileExists = existsSync }) {
  const problems = [];
  if (!["interim", "final"].includes(mode)) problems.push(`unsupported README screenshot mode: ${mode}`);
  const documents = [["README.md", zh], ["README_EN.md", en]];
  const assets = [...expectedReleaseAssets(version), "SHA256SUMS"];

  for (const [label, text] of documents) {
    const lineCount = countPhysicalLines(text);
    if (lineCount < README_MIN_LINES || lineCount > README_MAX_LINES) {
      problems.push(`${label} has ${lineCount} physical lines; expected ${README_MIN_LINES}-${README_MAX_LINES}`);
    }

    const anchors = extractAnchors(text);
    if (JSON.stringify(anchors) !== JSON.stringify(README_ANCHORS)) {
      problems.push(`${label} anchors must be exactly ${README_ANCHORS.join(", ")}; received ${anchors.join(", ") || "none"}`);
    }

    if (!text.includes(`v${version} Stable`)) problems.push(`${label} must identify v${version} Stable`);
    if (!text.includes(`https://github.com/alicia1030su/search-hub/releases/tag/v${version}`)) {
      problems.push(`${label} must link to the v${version} Release`);
    }
    for (const asset of assets) {
      if (!text.includes(asset)) problems.push(`${label} is missing release asset ${asset}`);
    }
    for (const match of text.matchAll(/(?:search-hub|shub)-v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?-[a-z0-9-]+\.(?:zip|tar\.gz)/g)) {
      if (!assets.includes(match[0])) problems.push(`${label} references stale release asset ${match[0]}`);
    }

    const placeholders = (text.match(/CAPTURE_REQUIRED/g) ?? []).length;
    const screenshotLinks = screenshotLinkTargets(text);
    const unexpectedScreenshots = screenshotLinks.filter((target) => !SCREENSHOT_FILES.includes(target));
    if (unexpectedScreenshots.length > 0) {
      problems.push(`${label} links screenshots outside the expected set: ${[...new Set(unexpectedScreenshots)].join(", ")}`);
    }
    if (mode === "interim") {
      if (placeholders !== 3) problems.push(`${label} must contain exactly 3 CAPTURE_REQUIRED placeholders in interim mode`);
      if (screenshotLinks.length !== 0) problems.push(`${label} must not link screenshots before capture in interim mode`);
    } else {
      if (placeholders !== 0) problems.push(`${label} must contain 0 CAPTURE_REQUIRED placeholders in final mode`);
      const unique = [...new Set(screenshotLinks)].sort();
      if (screenshotLinks.length !== SCREENSHOT_FILES.length || JSON.stringify(unique) !== JSON.stringify([...SCREENSHOT_FILES].sort())) {
        problems.push(`${label} final screenshot links must be exactly ${SCREENSHOT_FILES.join(", ")}`);
      }
      for (const screenshot of unique) {
        if (!fileExists(join(root, screenshot))) problems.push(`${label} screenshot file is missing: ${screenshot}`);
      }
    }
  }

  const englishWithoutLanguageSwitch = en.replace(/\[中文\]/g, "");
  if (/[\u3400-\u9fff]/.test(englishWithoutLanguageSwitch)) {
    problems.push("README_EN.md contains Chinese text outside the [中文] language switch");
  }
  checkFactGroups(zh, en, problems);
  return problems;
}

function read(root, relative) {
  return readFileSync(join(root, relative), "utf8");
}

export async function main({ mode = "auto", root = REPO_ROOT } = {}) {
  const readmeMode = resolveReadmeMode({ root, requested: mode });
  const pkg = JSON.parse(read(root, "package.json"));
  const zh = read(root, "README.md");
  const en = read(root, "README_EN.md");
  const cliDoc = read(root, "docs/cli.md");
  const deploymentDoc = read(root, "docs/deployment.md");
  const problems = [
    ...checkNodeContract({ engine: pkg.engines?.node, zh, en, cliDoc, deploymentDoc, version: pkg.version }),
    ...checkReadmeConsistency({ zh, en, version: pkg.version, mode: readmeMode, root }),
    ...checkReadmeLinks({ text: zh, label: "README.md", file: "README.md", root }),
    ...checkReadmeLinks({ text: en, label: "README_EN.md", file: "README_EN.md", root }),
  ];
  return problems;
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "auto";
  const problems = await main({ mode });
  if (problems.length === 0) {
    console.log(`PASS: README consistency (${mode})`);
    process.exit(0);
  }
  console.error(`\nFAIL: ${problems.length} README consistency problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
