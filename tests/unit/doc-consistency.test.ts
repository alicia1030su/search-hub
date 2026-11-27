import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The scripts are plain ESM without types; declare the helpers the tests use.
// @ts-expect-error -- untyped .mjs script, signature declared below
import { checkCountValue as rawCheckCountValue, validateLiveEvidence as rawValidateLiveEvidence } from "../../scripts/check-doc-consistency.mjs";
// @ts-expect-error -- untyped .mjs script, signature declared below
import { resolveReadmeMode as rawResolveReadmeMode, SCREENSHOT_FILES as rawScreenshotFiles } from "../../scripts/check-readme-consistency.mjs";

const checkCountValue = rawCheckCountValue as (
  text: string,
  label: string,
  pattern: RegExp,
  expected: number,
  what: string,
) => string | null;
const resolveReadmeMode = rawResolveReadmeMode as (options?: {
  requested?: "auto" | "interim" | "final";
  root?: string;
  fileExists?: (file: string) => boolean;
}) => "interim" | "final";
const SCREENSHOT_FILES = rawScreenshotFiles as string[];
const validateLiveEvidence = rawValidateLiveEvidence as (record: unknown, expectedProvider: string) => string[];
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG, listAdapters, getAdapter } from "@search-hub/providers";

/**
 * The documentation gate, as a test.
 *
 * `scripts/check-doc-consistency.mjs` runs in CI, but a Vitest case makes the
 * failure show up in the normal test run too — the place a developer looks
 * first after editing a README.
 */
describe("live evidence schema", () => {
  const valid = {
    schemaVersion: 2,
    provider: "wikipedia",
    status: "live_tested",
    sourceCommit: "a".repeat(40),
    adapterVersion: "0.1.17",
    lastSuccess: {
      checkedAt: "2026-11-27T00:00:00.000Z",
      requestUrl: "https://en.wikipedia.org/w/api.php?action=query",
      httpStatus: 200,
      resultCount: 5,
      sampleUrls: ["https://en.wikipedia.org/?curid=1"],
      latencyMs: 100,
      recordedBy: "test",
    },
    lastAttempt: { checkedAt: "2026-11-27T00:00:00.000Z", httpStatus: 200, ok: true },
    attempts: [{ label: "en", query: "search engine", ok: true, httpStatus: 200, resultCount: 5, latencyMs: 100, requestUrl: "https://en.wikipedia.org/w/api.php?action=query" }],
  };

  it("accepts a complete v2 record", () => {
    expect(validateLiveEvidence(valid, "wikipedia")).toEqual([]);
  });

  it("requires a non-empty per-query attempts array", () => {
    expect(validateLiveEvidence({ ...valid, attempts: undefined }, "wikipedia").join("\n")).toContain("attempts must contain at least one");
    expect(validateLiveEvidence({ ...valid, attempts: [] }, "wikipedia").join("\n")).toContain("attempts must contain at least one");
  });

  it("rejects provider mismatch, missing provenance and insecure URLs", () => {
    const problems = validateLiveEvidence({
      ...valid,
      provider: "arxiv",
      sourceCommit: "abc",
      lastSuccess: { ...valid.lastSuccess, requestUrl: "http://en.wikipedia.org/w/api.php", sampleUrls: [] },
    }, "wikipedia");
    expect(problems.join("\n")).toContain('provider must be "wikipedia"');
    expect(problems.join("\n")).toContain("sourceCommit");
    expect(problems.join("\n")).toContain("https URL");
    expect(problems.join("\n")).toContain("sampleUrls");
  });
});

describe("catalog ↔ docs consistency", () => {
  it("every builtin entry has an adapter and every adapter has an entry", () => {
    const adapters = new Set(listAdapters().map((adapter) => adapter.type));
    const catalogTypes = new Set(PROVIDER_CATALOG.map((entry) => entry.type));

    const builtin = PROVIDER_CATALOG.filter((entry) => entry.implementation === "builtin");
    const missing = builtin.filter((entry) => !adapters.has(entry.type)).map((entry) => entry.type);
    expect(missing, "catalog says builtin but no adapter registered").toEqual([]);

    const orphans = [...adapters].filter((type) => !catalogTypes.has(type));
    // An adapter the catalog hides cannot be created from the marketplace.
    expect(orphans, "adapter registered but missing from the catalog").toEqual([]);
  });

  it("reports the true counts (guards against a stale matrix)", () => {
    const builtin = PROVIDER_CATALOG.filter((entry) => entry.implementation === "builtin");
    expect(builtin.length).toBe(listAdapters().length);
    // Regression: the three new adapters were once registered but invisible.
    for (const type of ["minimax", "metaso", "metaso-mcp", "duckduckgo"]) {
      expect(getAdapter(type), `${type} must have an adapter`).toBeTruthy();
      expect(
        PROVIDER_CATALOG.some((entry) => entry.type === type),
        `${type} must be in the catalog`,
      ).toBe(true);
    }
  });

  it("passes the generated-matrix check", () => {
    const run = () =>
      execFileSync("node", ["--import", "tsx", "scripts/generate-provider-matrix.mjs", "--check"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(run).not.toThrow();
  }, 30_000);

  it("rejects a README count that disagrees with the catalog", () => {
    // Proves the gate is not a rubber stamp: the same comparison the script runs
    // is applied to a mutated string, so no repository file is touched.
    const builtinCount = PROVIDER_CATALOG.filter((entry) => entry.implementation === "builtin").length;
    const pattern = /已实现适配器（(\d+)\s*类）/;
    expect(checkCountValue(`**已实现适配器（${builtinCount} 类）**`, "README.md", pattern, builtinCount, "providers")).toBeNull();
    expect(checkCountValue("**已实现适配器（7 类）**", "README.md", pattern, builtinCount, "providers")).toContain(
      `the catalog has ${builtinCount}`,
    );
    // A missing phrase is not a contradiction, so it must not fail either.
    expect(checkCountValue("no counts here", "README.md", pattern, builtinCount, "providers")).toBeNull();
  });

  it("auto-promotes a complete screenshot set without allowing final to downgrade", () => {
    const root = mkdtempSync(join(tmpdir(), "search-hub-doc-mode-"));
    try {
      expect(resolveReadmeMode({ root })).toBe("interim");
      expect(resolveReadmeMode({ requested: "auto", root })).toBe("interim");
      expect(resolveReadmeMode({ requested: "final", root })).toBe("final");
      const screenshotDir = join(root, "docs", "screenshots", "v0117");
      mkdirSync(screenshotDir, { recursive: true });
      for (const file of SCREENSHOT_FILES) writeFileSync(join(root, file), "fixture");
      expect(resolveReadmeMode({ root })).toBe("final");
      expect(resolveReadmeMode({ requested: "interim", root })).toBe("final");
      expect(() => resolveReadmeMode({ requested: "invalid" as "auto", root })).toThrow(/unsupported_readme_mode/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the README consistency check", () => {
    const run = () =>
      execFileSync("node", ["--import", "tsx", "scripts/check-doc-consistency.mjs"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(run).not.toThrow();
  }, 30_000);
});
