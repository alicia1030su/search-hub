import { execFileSync } from "node:child_process";
// The script is plain ESM without types; declare the one helper the test uses.
// @ts-expect-error -- untyped .mjs script, signature declared below
import { checkCountValue as rawCheckCountValue } from "../../scripts/check-doc-consistency.mjs";

const checkCountValue = rawCheckCountValue as (
  text: string,
  label: string,
  pattern: RegExp,
  expected: number,
  what: string,
) => string | null;
import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG, listAdapters, getAdapter } from "@search-hub/providers";

/**
 * The documentation gate, as a test.
 *
 * `scripts/check-doc-consistency.mjs` runs in CI, but a Vitest case makes the
 * failure show up in the normal test run too — the place a developer looks
 * first after editing a README.
 */
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

  it("passes the README consistency check", () => {
    const run = () =>
      execFileSync("node", ["--import", "tsx", "scripts/check-doc-consistency.mjs"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(run).not.toThrow();
  }, 30_000);
});
