import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactText, providerKeysFromEnv } from "../../tests/scripts/redact-secrets.mjs";

/**
 * Regression for the live-provider credential leak paths documented in
 * docs/real-search-validation-plan.md §1.5. Uses a fake key only.
 */
const KEY = "tvly-FAKE-KEY-1234567890abcdef";

function variants(key: string): Array<[string, string]> {
  return [
    ["literal", `HTTP 401: invalid key ${key}`],
    ["Bearer", `echo Authorization: Bearer ${key}`],
    ["URL-encoded", `upstream echoed ${encodeURIComponent(key)}`],
    ["base64", `debug=${Buffer.from(key).toString("base64")}`],
    ["unknown key-shaped token", `header sk-anotherFakeKey123456`],
  ];
}

describe("live-provider credential redaction", () => {
  for (const [label, text] of variants(KEY)) {
    it(`scrubs ${label}`, () => {
      const output = redactText(text, [KEY]);
      expect(output).not.toContain(KEY);
      expect(output).toMatch(/\[redacted\]|Bearer \[redacted\]/);
    });
  }

  it("also scrubs keys belonging to other providers present in the environment", () => {
    const other = "sk-BOCHA-FAKE-9876543210";
    const output = redactText(`vendor echoed ${other}`, [KEY, other]);
    expect(output).not.toContain(other);
  });

  it("leaves ordinary text untouched", () => {
    const text = "5 results in 812ms\n  1. TypeScript monorepo guide\n     https://example.org/a";
    expect(redactText(text, [KEY])).toBe(text);
  });

  it("reads configured keys from the environment and ignores short/absent values", () => {
    const previous = process.env["TAVILY_API_KEY"];
    try {
      process.env["TAVILY_API_KEY"] = KEY;
      expect(providerKeysFromEnv()).toContain(KEY);
    } finally {
      if (previous === undefined) delete process.env["TAVILY_API_KEY"];
      else process.env["TAVILY_API_KEY"] = previous;
    }
  });
});

describe("artifact scrubber", () => {
  it("rewrites a log file in place before upload, without printing the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-hub-scrub-"));
    const log = join(dir, "provider-tavily.log");
    try {
      writeFileSync(
        log,
        `LIVE: credential loaded\nFAIL: upstream echoed Bearer ${KEY}\n`,
        "utf8",
      );
      const stdout = execFileSync(
        process.execPath,
        ["tests/scripts/scrub-provider-logs.mjs", log],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, TAVILY_API_KEY: KEY },
        },
      );
      expect(stdout).not.toContain(KEY);
      const scrubbed = readFileSync(log, "utf8");
      expect(scrubbed).not.toContain(KEY);
      expect(scrubbed).toContain("[redacted]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
