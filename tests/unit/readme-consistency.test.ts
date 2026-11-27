import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM documentation gate
import { checkNodeContract, checkReadmeConsistency, countPhysicalLines, main as checkReadmeMain, README_ANCHORS, resolveReadmeMode } from "../../scripts/check-readme-consistency.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function actualReadmes() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return {
    pkg,
    zh: readFileSync(join(ROOT, "README.md"), "utf8"),
    en: readFileSync(join(ROOT, "README_EN.md"), "utf8"),
    cliDoc: readFileSync(join(ROOT, "docs", "cli.md"), "utf8"),
    deploymentDoc: readFileSync(join(ROOT, "docs", "deployment.md"), "utf8"),
  };
}

function captureComment(file: string, version: string) {
  return `<!-- CAPTURE_REQUIRED: replace with the real v${version} docs/screenshots/v0117/${file} after capture. -->`;
}

function replaceScreenshotsWithCaptureMarkers(text: string, version: string) {
  return text.replace(
    /!\[[^\]]*\]\(\.\/docs\/screenshots\/v0117\/([^)\s]+)\)/g,
    (_match, file: string) => captureComment(file, version),
  );
}

function finalScreenshotRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "search-hub-readme-final-"));
  temporary.push(root);
  const screenshotDir = join(root, "docs", "screenshots", "v0117");
  mkdirSync(screenshotDir, { recursive: true });
  for (const name of ["onboarding.png", "dashboard.png", "search-lab.png", "provider-health.png"]) {
    writeFileSync(join(screenshotDir, name), "fixture");
  }
  return root;
}

describe("README consistency gate", () => {
  it("accepts the real bilingual READMEs in auto mode", async () => {
    const { pkg, zh, en, cliDoc, deploymentDoc } = actualReadmes();
    expect(await checkReadmeMain({ mode: "auto", root: ROOT })).toEqual([]);
    expect(checkNodeContract({ engine: pkg.engines.node, zh, en, cliDoc, deploymentDoc, version: pkg.version })).toEqual([]);
    expect(countPhysicalLines(zh)).toBeGreaterThanOrEqual(100);
    expect(countPhysicalLines(zh)).toBeLessThanOrEqual(150);
    expect(countPhysicalLines(en)).toBeGreaterThanOrEqual(100);
    expect(countPhysicalLines(en)).toBeLessThanOrEqual(150);
  });

  it("accepts interim README content when auto mode resolves to interim", () => {
    const { pkg, zh, en } = actualReadmes();
    const root = mkdtempSync(join(tmpdir(), "search-hub-readme-auto-interim-"));
    temporary.push(root);
    const interimZh = replaceScreenshotsWithCaptureMarkers(zh, pkg.version);
    const interimEn = replaceScreenshotsWithCaptureMarkers(en, pkg.version);
    const mode = resolveReadmeMode({ root, requested: "auto" });
    expect(mode).toBe("interim");
    expect(checkReadmeConsistency({ zh: interimZh, en: interimEn, version: pkg.version, mode, root })).toEqual([]);
  });

  it("accepts final README content when auto mode resolves to final", () => {
    const { pkg, zh, en } = actualReadmes();
    const root = finalScreenshotRoot();
    const mode = resolveReadmeMode({ root, requested: "auto" });
    expect(mode).toBe("final");
    expect(checkReadmeConsistency({ zh, en, version: pkg.version, mode, root })).toEqual([]);
  });

  it("rejects a stale Node engine or missing portable CLI contract", () => {
    const { pkg, zh, en, cliDoc, deploymentDoc } = actualReadmes();
    expect(checkNodeContract({ engine: ">=22.11.0", zh, en, cliDoc, deploymentDoc, version: pkg.version }).join("\n")).toContain(">=22.12.0");
    expect(checkNodeContract({ engine: ">=22.12.0", zh: zh.replaceAll("Node.js >=22.12.0", "Node.js 22+"), en, cliDoc, deploymentDoc, version: pkg.version }).join("\n"))
      .toContain("README.md must state Node.js >=22.12.0");
    expect(checkNodeContract({ engine: ">=22.12.0", zh, en, cliDoc: cliDoc.replace("Node.js >=22.12.0", "Node.js 22+"), deploymentDoc, version: pkg.version }).join("\n"))
      .toContain("docs/cli.md install block must state Node.js >=22.12.0");
    expect(checkNodeContract({ engine: ">=22.12.0", zh, en, cliDoc, deploymentDoc: deploymentDoc.replace(`shub-v${pkg.version}-node22.tar.gz`, "shub-v0.0.0-node22.tar.gz"), version: pkg.version }).join("\n"))
      .toContain("docs/deployment.md release asset block must reference");
  });

  it("rejects line-count and anchor drift", () => {
    const { pkg, zh, en } = actualReadmes();
    expect(checkReadmeConsistency({ zh: "too short", en, version: pkg.version }).join("\n")).toContain("physical lines");
    const drifted = en.replace('<a id="limits"></a>', '<a id="other"></a>');
    const problems = checkReadmeConsistency({ zh, en: drifted, version: pkg.version });
    expect(problems.join("\n")).toContain("anchors must be exactly");
    expect(README_ANCHORS).toHaveLength(9);
  });

  it("rejects stale release versions and missing assets", () => {
    const { pkg, zh, en } = actualReadmes();
    const stale = en.replaceAll(pkg.version, "0.1.16");
    const problems = checkReadmeConsistency({ zh, en: stale, version: pkg.version });
    expect(problems.join("\n")).toContain(`v${pkg.version} Stable`);
    expect(problems.join("\n")).toContain("stale release asset");
    const missing = en.replace("`resource-evidence.json`", "`missing.json`");
    expect(checkReadmeConsistency({ zh, en: missing, version: pkg.version }).join("\n"))
      .toContain("missing release asset resource-evidence.json");
  });

  it("requires exactly four interim placeholders and no screenshot links", () => {
    const { pkg, zh, en } = actualReadmes();
    const interimZh = replaceScreenshotsWithCaptureMarkers(zh, pkg.version);
    const interimEn = replaceScreenshotsWithCaptureMarkers(en, pkg.version);
    const missingOne = interimZh.replace(captureComment("search-lab.png", pkg.version), "");
    expect(checkReadmeConsistency({ zh: missingOne, en: interimEn, version: pkg.version, mode: "interim" }).join("\n"))
      .toContain("exactly 4 CAPTURE_REQUIRED");
    const linked = interimZh.replace(
      captureComment("dashboard.png", pkg.version),
      "![dashboard](./docs/screenshots/v0117/dashboard.png)",
    );
    expect(checkReadmeConsistency({ zh: linked, en: interimEn, version: pkg.version, mode: "interim" }).join("\n"))
      .toContain("must not link screenshots before capture");
  });

  it("requires zero placeholders and four real files in final mode", () => {
    const { pkg, zh, en } = actualReadmes();
    const root = finalScreenshotRoot();
    expect(checkReadmeConsistency({ zh, en, version: pkg.version, mode: "final", root })).toEqual([]);
    const interimZh = replaceScreenshotsWithCaptureMarkers(zh, pkg.version);
    const interimEn = replaceScreenshotsWithCaptureMarkers(en, pkg.version);
    expect(checkReadmeConsistency({ zh: interimZh, en: interimEn, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("0 CAPTURE_REQUIRED");
    rmSync(join(root, "docs", "screenshots", "v0117", "dashboard.png"));
    expect(checkReadmeConsistency({ zh, en, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("screenshot file is missing");
  });

  it("rejects old, duplicate, and out-of-scope screenshot links in final mode", () => {
    const { pkg, zh, en } = actualReadmes();
    const root = mkdtempSync(join(tmpdir(), "search-hub-readme-paths-"));
    temporary.push(root);
    const screenshotDir = join(root, "docs", "screenshots", "v0117");
    mkdirSync(screenshotDir, { recursive: true });
    for (const name of ["onboarding.png", "dashboard.png", "search-lab.png", "provider-health.png"]) {
      writeFileSync(join(screenshotDir, name), "fixture");
    }
    const oldVersion = zh.replace(
      "(./docs/screenshots/v0117/dashboard.png)",
      "(./docs/screenshots/v0115/dashboard.png)",
    );
    expect(checkReadmeConsistency({ zh: oldVersion, en, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("outside the expected set");
    const duplicate = zh.replace(
      "(./docs/screenshots/v0117/search-lab.png)",
      "(./docs/screenshots/v0117/dashboard.png)",
    );
    expect(checkReadmeConsistency({ zh: duplicate, en, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("final screenshot links must be exactly");
    const outOfScope = zh.replace(
      "(./docs/screenshots/v0117/provider-health.png)",
      "(./docs/screenshots/v0117/../private.png)",
    );
    expect(checkReadmeConsistency({ zh: outOfScope, en, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("outside the expected set");
    const outsideTree = zh.replace(
      "(./docs/screenshots/v0117/provider-health.png)",
      "(./assets/dashboard.png)",
    );
    expect(checkReadmeConsistency({ zh: outsideTree, en, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("final screenshot links must be exactly");
    const normalized = zh.replace(
      "(./docs/screenshots/v0117/dashboard.png)",
      "(./docs/screenshots/v0117/../v0117/%64ashboard.png?cache=1#preview)",
    );
    expect(checkReadmeConsistency({ zh: normalized, en, version: pkg.version, mode: "final", root })).toEqual([]);
    const withOrdinaryAsset = zh.replace("\n\n", "\n![ordinary asset](./assets/logo.png)\n");
    expect(checkReadmeConsistency({ zh: withOrdinaryAsset, en, version: pkg.version, mode: "final", root })).toEqual([]);
  });

  it("rejects untranslated Chinese in the English README", () => {
    const { pkg, zh, en } = actualReadmes();
    const problems = checkReadmeConsistency({ zh, en: `${en}\n中文残留`, version: pkg.version });
    expect(problems.join("\n")).toContain("contains Chinese text");
  });
});
