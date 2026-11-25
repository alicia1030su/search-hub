import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM documentation gate
import { checkReadmeLinks } from "../../scripts/check-readme-consistency.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "search-hub-readme-links-"));
  temporary.push(root);
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "guide.md"), '<a id="explicit"></a>\n## Generated Heading\n');
  return root;
}

describe("README relative-link gate", () => {
  it("accepts all real relative links in both READMEs", () => {
    for (const file of ["README.md", "README_EN.md"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(checkReadmeLinks({ text, label: file, file, root: ROOT })).toEqual([]);
    }
  });

  it("rejects a missing relative file", () => {
    const root = fixtureRoot();
    const problems = checkReadmeLinks({
      text: "[missing](./docs/missing.md)",
      label: "README.md",
      file: "README.md",
      root,
    });
    expect(problems.join("\n")).toContain("links to missing file");
  });

  it("rejects relative paths that escape the repository root after decoding", () => {
    const root = fixtureRoot();
    for (const target of ["../../outside.md", "%2e%2e/%2e%2e/outside.md"]) {
      const problems = checkReadmeLinks({
        text: `[escape](${target})`,
        label: "README.md",
        file: "README.md",
        root,
      });
      expect(problems.join("\n")).toContain("escapes the repository root");
    }
  });

  it("checks explicit and generated anchors in the target document", () => {
    const root = fixtureRoot();
    expect(checkReadmeLinks({
      text: "[explicit](./docs/guide.md#explicit) [heading](./docs/guide.md#generated-heading)",
      label: "README.md",
      file: "README.md",
      root,
    })).toEqual([]);
    expect(checkReadmeLinks({
      text: "[broken](./docs/guide.md#not-there)",
      label: "README.md",
      file: "README.md",
      root,
    }).join("\n")).toContain("links to missing anchor");
  });

  it("checks same-document anchors without requiring a file lookup", () => {
    const root = fixtureRoot();
    expect(checkReadmeLinks({
      text: '<a id="top"></a>\n# Search Hub\n[back](#top)',
      label: "README.md",
      file: "README.md",
      root,
    })).toEqual([]);
    expect(checkReadmeLinks({
      text: "# Search Hub\n[broken](#missing)",
      label: "README.md",
      file: "README.md",
      root,
    }).join("\n")).toContain("links to missing anchor");
  });

  it("ignores external URLs but rejects root-absolute local links", () => {
    const root = fixtureRoot();
    expect(checkReadmeLinks({
      text: "[site](https://example.com/docs) [mail](mailto:team@example.com)",
      label: "README.md",
      file: "README.md",
      root,
    })).toEqual([]);
    expect(checkReadmeLinks({
      text: "[absolute](/docs/guide.md)",
      label: "README.md",
      file: "README.md",
      root,
    }).join("\n")).toContain("non-relative local link");
  });

  it("treats image targets as files and rejects a missing screenshot", () => {
    const root = fixtureRoot();
    const text = "![missing](./docs/screenshots/v0116/dashboard.png)";
    expect(checkReadmeLinks({ text, label: "README.md", file: "README.md", root }).join("\n"))
      .toContain("links to missing file");
  });
});
