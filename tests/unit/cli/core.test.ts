import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs, outputFormat, stringList } from "../../../packages/cli/src/args.js";
import { CLI_VERSION } from "../../../packages/cli/src/version.js";
import { isLoopbackHostname, normalizeServerUrl } from "../../../packages/cli/src/security/url.js";
import { isCompatibleServerVersion, parseServerVersion } from "../../../packages/cli/src/client/http.js";

const root = resolve(import.meta.dirname, "../../..");

describe("CLI core contracts", () => {
  it("C02 keeps the CLI version aligned with package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8"));
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it("accepts loopback HTTP and normalizes a trailing slash", () => {
    expect(normalizeServerUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeServerUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeServerUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
    expect(isLoopbackHostname("127.10.20.30")).toBe(true);
    expect(isLoopbackHostname("192.168.1.1")).toBe(false);
  });

  it("C22 rejects remote plain HTTP", () => {
    expect(() => normalizeServerUrl("http://search.example.com")).toThrow(/HTTPS/);
  });

  it("rejects URL credentials, query strings and fragments", () => {
    expect(() => normalizeServerUrl("https://user:pass@example.com")).toThrow(/userinfo/);
    expect(() => normalizeServerUrl("https://example.com?token=secret")).toThrow(/query/);
    expect(() => normalizeServerUrl("https://example.com/#token")).toThrow(/fragment/);
  });

  it("parses Unicode queries and repeated provider flags without a shell", () => {
    const args = parseCliArgs(["search", "Linux 内核 $(echo unsafe)", "--provider", "prv_1,prv_2", "--provider", "prv_3", "--json"]);
    expect(args.positionals).toEqual(["search", "Linux 内核 $(echo unsafe)"]);
    expect(stringList(args.values, "provider")).toEqual(["prv_1", "prv_2", "prv_3"]);
    expect(outputFormat(args.values)).toBe("json");
  });

  it("recognizes v0.1.12 compatibility and rejects unknown or 0.2 servers", () => {
    expect(parseServerVersion("0.1.12")).toEqual({ major: 0, minor: 1, patch: 12 });
    expect(isCompatibleServerVersion("0.1.12")).toBe(true);
    expect(isCompatibleServerVersion("0.1.13-ci")).toBe(true);
    expect(isCompatibleServerVersion("0.1.11")).toBe(false);
    expect(isCompatibleServerVersion("0.2.0")).toBe(false);
    expect(isCompatibleServerVersion("dev")).toBe(false);
  });
});
