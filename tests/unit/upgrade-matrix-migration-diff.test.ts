import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("upgrade matrix migration diff", () => {
  it("accepts a non-empty appliedDiff when health and preservation pass", () => {
    const script = resolve(process.cwd(), "packaging", "upgrade-matrix.mjs");
    const result = spawnSync(process.execPath, [script, "--self-test-migration-diff"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PASS migration upgrade accepts appliedDiff=");
    expect(result.stdout).toContain("0012_api_key_credential_revision.sql");
  });
});
