import { execFileSync } from "node:child_process";
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

  it("passes the README consistency check", () => {
    const run = () =>
      execFileSync("node", ["--import", "tsx", "scripts/check-doc-consistency.mjs"], {
        encoding: "utf8",
        stdio: "pipe",
      });
    expect(run).not.toThrow();
  }, 30_000);
});
