import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM documentation gate
import { checkNodeContract, checkReadmeConsistency, countPhysicalLines, README_ANCHORS } from "../../scripts/check-readme-consistency.mjs";

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
  };
}

function replaceCaptureMarkers(text: string) {
  return text.replace(
    /<!-- CAPTURE_REQUIRED: replace with the real v0\.1\.16 (docs\/screenshots\/v0116\/[^ ]+) after capture\. -->/g,
    (_match, file: string) => `![Search Hub screenshot](./${file})`,
  );
}

describe("README consistency gate", () => {
  it("accepts the real bilingual READMEs in interim mode", () => {
    const { pkg, zh, en } = actualReadmes();
    expect(checkReadmeConsistency({ zh, en, version: pkg.version, mode: "interim", root: ROOT })).toEqual([]);
    expect(checkNodeContract({ engine: pkg.engines.node, zh, en })).toEqual([]);
    expect(countPhysicalLines(zh)).toBeGreaterThanOrEqual(100);
    expect(countPhysicalLines(zh)).toBeLessThanOrEqual(150);
    expect(countPhysicalLines(en)).toBeGreaterThanOrEqual(100);
    expect(countPhysicalLines(en)).toBeLessThanOrEqual(150);
  });

  it("rejects a stale Node engine or missing portable CLI contract", () => {
    const { zh, en } = actualReadmes();
    expect(checkNodeContract({ engine: ">=22.11.0", zh, en }).join("\n")).toContain(">=22.12.0");
    expect(checkNodeContract({ engine: ">=22.12.0", zh: zh.replace("Node.js >=22.12.0", "Node.js 22+"), en }).join("\n"))
      .toContain("README.md must state Node.js >=22.12.0");
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
    const stale = en.replaceAll("0.1.16", "0.1.15");
    const problems = checkReadmeConsistency({ zh, en: stale, version: pkg.version });
    expect(problems.join("\n")).toContain("v0.1.16 Stable");
    expect(problems.join("\n")).toContain("stale release asset");
    const missing = en.replace("`resource-evidence.json`", "`missing.json`");
    expect(checkReadmeConsistency({ zh, en: missing, version: pkg.version }).join("\n"))
      .toContain("missing release asset resource-evidence.json");
  });

  it("requires exactly three interim placeholders and no screenshot links", () => {
    const { pkg, zh, en } = actualReadmes();
    const missingOne = zh.replace("<!-- CAPTURE_REQUIRED: replace with the real v0.1.16 docs/screenshots/v0116/search-lab.png after capture. -->", "");
    expect(checkReadmeConsistency({ zh: missingOne, en, version: pkg.version, mode: "interim" }).join("\n"))
      .toContain("exactly 3 CAPTURE_REQUIRED");
    const linked = zh.replace(
      "<!-- CAPTURE_REQUIRED: replace with the real v0.1.16 docs/screenshots/v0116/dashboard.png after capture. -->",
      "![dashboard](./docs/screenshots/v0116/dashboard.png)",
    );
    expect(checkReadmeConsistency({ zh: linked, en, version: pkg.version, mode: "interim" }).join("\n"))
      .toContain("must not link screenshots before capture");
  });

  it("requires zero placeholders and three real files in final mode", () => {
    const { pkg, zh, en } = actualReadmes();
    const root = mkdtempSync(join(tmpdir(), "search-hub-readme-final-"));
    temporary.push(root);
    const screenshotDir = join(root, "docs", "screenshots", "v0116");
    mkdirSync(screenshotDir, { recursive: true });
    for (const name of ["dashboard.png", "search-lab.png", "provider-health.png"]) {
      writeFileSync(join(screenshotDir, name), "fixture");
    }
    const finalZh = replaceCaptureMarkers(zh);
    const finalEn = replaceCaptureMarkers(en);
    expect(checkReadmeConsistency({ zh: finalZh, en: finalEn, version: pkg.version, mode: "final", root })).toEqual([]);
    expect(checkReadmeConsistency({ zh, en, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("0 CAPTURE_REQUIRED");
    rmSync(join(screenshotDir, "dashboard.png"));
    expect(checkReadmeConsistency({ zh: finalZh, en: finalEn, version: pkg.version, mode: "final", root }).join("\n"))
      .toContain("screenshot file is missing");
  });

  it("rejects untranslated Chinese in the English README", () => {
    const { pkg, zh, en } = actualReadmes();
    const problems = checkReadmeConsistency({ zh, en: `${en}\n中文残留`, version: pkg.version });
    expect(problems.join("\n")).toContain("contains Chinese text");
  });
});
