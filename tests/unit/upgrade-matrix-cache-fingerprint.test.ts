import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("upgrade matrix cache fingerprint schema identity", () => {
  it("distinguishes legacy and credential_revision schemas", () => {
    const script = resolve(process.cwd(), "packaging", "upgrade-matrix.mjs");
    const result = spawnSync(process.execPath, [script, "--self-test-cache-fingerprint"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("credentialIdentityVersion=1->2");
    expect(result.stdout).toContain("fingerprint=changed");
  });
});
