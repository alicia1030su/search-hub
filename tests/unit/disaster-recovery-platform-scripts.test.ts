import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function restoreBlocks(relative: string): string[] {
  const lines = readFileSync(resolve(root, relative), "utf8").split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes("backup restore")) continue;
    let start = index;
    while (start > 0 && lines[start - 1]!.trimEnd().endsWith("\\")) start -= 1;
    let end = index;
    while (lines[end]?.trimEnd().endsWith("\\")) end += 1;
    blocks.push(lines.slice(start, end + 1).join("\n"));
  }
  return blocks;
}

describe("platform restore origin environment", () => {
  const cases = [
    { script: "tests/disaster-recovery/platform-linux.sh", data: 'SEARCH_HUB_DATA_DIR="$WORK/source-data"', install: 'SEARCH_HUB_INSTALL_DIR="$PACKAGE_ROOT"' },
    { script: "tests/disaster-recovery/platform-docker.sh", data: "SEARCH_HUB_DATA_DIR=/data", install: "SEARCH_HUB_INSTALL_DIR=/app" },
    { script: "tests/disaster-recovery/platform-systemd.sh", data: 'SEARCH_HUB_DATA_DIR="$DATA"', install: 'SEARCH_HUB_INSTALL_DIR="$BASE"' },
  ];

  it.each(cases)("$script sets the original data and install directories on every restore", ({ script, data, install }) => {
    const blocks = restoreBlocks(script);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).toContain(data);
      expect(block).toContain(install);
    }
    const startCheck = blocks.find((block) => block.includes("--start-check"));
    expect(startCheck).toBeDefined();
    expect(startCheck).toContain("SEARCH_HUB_APP_ENTRY");
  });
});
