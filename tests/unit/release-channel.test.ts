import { describe, expect, it } from "vitest";
import {
  classifyTag,
  compareVersions,
  parseVersion,
} from "../../packaging/release-channel.mjs";

/**
 * The release workflow reads its publish mode from this function. If it ever
 * classifies a stable tag as a prerelease (or the reverse), the mistake lands on
 * a public Release page where it cannot be quietly corrected — so the mapping is
 * asserted here rather than trusted to a `case` statement in YAML.
 */
describe("release tag classification", () => {
  it("maps a plain semver tag to a stable release", () => {
    const result = classifyTag("v0.1.8");
    expect(result.channel).toBe("stable");
    expect(result.prerelease).toBe(false);
    expect(result.version).toBe("0.1.8");
    expect(result.name).toBe("Search Hub v0.1.8");
    expect(result.pre).toBeNull();
  });

  it("maps beta, rc and alpha tags to prereleases", () => {
    const cases: Array<[string, string]> = [
      ["v0.1.8-beta.1", "0.1.8-beta.1"],
      ["v0.1.8-rc.1", "0.1.8-rc.1"],
      ["v0.1.8-alpha.3", "0.1.8-alpha.3"],
    ];
    for (const [tag, version] of cases) {
      const result = classifyTag(tag);
      expect(result.channel).toBe("prerelease");
      expect(result.prerelease).toBe(true);
      expect(result.version).toBe(version);
    }
  });

  it("does not treat the word beta inside a number as a prerelease", {
    timeout: 5000,
  }, () => {
    // The previous implementation looked for the substring "beta". A stable tag
    // whose version merely contains those letters is not a prerelease, and the
    // parser must classify by structure, not by substring.
    expect(() => classifyTag("v0.2.0-1")).toThrow();
    expect(() => classifyTag("v0.1.8betafix")).toThrow();
    expect(classifyTag("v0.1.8").prerelease).toBe(false);
  });

  it("rejects anything it cannot classify instead of guessing", () => {
    for (const tag of ["", "0.1.8", "v0.1", "v0.1.8.1", "v0.1.8-nightly.1", "v0.1.8-beta", "v0.1.8-beta.0", "release-0.1.8"]) {
      expect(() => classifyTag(tag), tag).toThrow();
    }
  });

  it("keeps the pre-release number as written, without padding", () => {
    expect(classifyTag("v0.1.8-rc.19").version).toBe("0.1.8-rc.19");
    expect(classifyTag("v0.1.8-beta.01").version).toBe("0.1.8-beta.1");
  });
});

function version(value: string) {
  const parsed = parseVersion(value);
  if (!parsed) throw new Error(`test setup: ${value} did not parse`);
  return parsed;
}

describe("version ordering", () => {
  it("sorts a release above its own pre-releases", () => {
    expect(compareVersions(version("0.1.8"), version("0.1.8-beta.1"))).toBeGreaterThan(0);
    expect(compareVersions(version("0.1.8-beta.1"), version("0.1.8"))).toBeLessThan(0);
  });

  it("orders by version components before pre-release names", () => {
    expect(compareVersions(version("0.1.9"), version("0.1.8"))).toBeGreaterThan(0);
    expect(compareVersions(version("0.2.0"), version("0.1.99"))).toBeGreaterThan(0);
    expect(compareVersions(version("0.1.8-rc.1"), version("0.1.8-beta.2"))).toBeGreaterThan(0);
  });

  it("returns null for something that is not a version", () => {
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("0.1")).toBeNull();
  });
});
