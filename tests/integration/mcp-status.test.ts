import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStatusService, readSdkProtocol, resetUpdateCache } from "../../apps/api/src/services/mcp-status.js";

/**
 * MCP status reporting.
 *
 * The point of these tests is that the server must not claim a protocol revision
 * it cannot negotiate. The 2026-07-28 revision is measured (2026-11-16) to be
 * downgraded to 2025-11-25 by the installed SDK, so `revision2026Supported` must
 * be false and the note must say so.
 */

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-status-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

describe("SDK protocol constants", () => {
  it("reads the latest version and the supported list", () => {
    const dir = tmp({
      "schemas.cjs": `LATEST_PROTOCOL_VERSION = "2025-11-25";
SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26"
]`,
    });
    const result = readSdkProtocol({ version: "2.4.0", files: [join(dir, "schemas.cjs")] });
    expect(result.latest).toBe("2025-11-25");
    expect(result.supported).toContain("2025-11-25");
    expect(result.supported).toContain("2025-06-18");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null rather than guessing when the shape changes", () => {
    const dir = tmp({ "schemas.cjs": "export const somethingElse = 1;" });
    const result = readSdkProtocol({ version: "9.9.9", files: [join(dir, "schemas.cjs")] });
    expect(result.latest).toBeNull();
    expect(result.supported).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("server status", () => {
  it("reports 2026-07-28 as unsupported when the SDK does not list it", () => {
    const dir = tmp({
      "schemas.cjs": `LATEST_PROTOCOL_VERSION = "2025-11-25";
SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18"]`,
    });
    const service = new McpStatusService({
      sdkFiles: () => [join(dir, "schemas.cjs")],
      sdkVersion: "2.4.0",
      serverVersion: "0.1.5",
      toolCount: () => 7,
      repoRoot: process.cwd(),
    });
    const status = service.status();
    expect(status.sdkLatest).toBe("2025-11-25");
    expect(status.revision2026Supported).toBe(false);
    expect(status.notes.join(" ")).toContain("does not implement 2026-07-28");
    expect(status.toolCount).toBe(7);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports support when a future SDK does list the revision", () => {
    const dir = tmp({
      "schemas.cjs": `LATEST_PROTOCOL_VERSION = "2026-07-28";
SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-11-25"]`,
    });
    const service = new McpStatusService({
      sdkFiles: () => [join(dir, "schemas.cjs")],
      sdkVersion: "3.0.0",
      serverVersion: "0.1.5",
      toolCount: () => 7,
      repoRoot: process.cwd(),
    });
    const status = service.status();
    expect(status.revision2026Supported).toBe(true);
    expect(status.notes.join(" ")).not.toContain("does not implement");
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns when the constants cannot be read at all", () => {
    const service = new McpStatusService({
      sdkFiles: () => [join(tmpdir(), "definitely-missing-file.cjs")],
      sdkVersion: "2.4.0",
      serverVersion: "0.1.5",
      toolCount: () => 0,
      repoRoot: process.cwd(),
    });
    const status = service.status();
    expect(status.sdkLatest).toBe("unknown");
    expect(status.notes.some((note) => note.includes("version support is unknown"))).toBe(true);
  });
});

describe("update check", () => {
  it("separates protocol, SDK and application updates", async () => {
    resetUpdateCache();
    const service = new McpStatusService({
      sdkFiles: () => [join(tmpdir(), "missing.cjs")],
      sdkVersion: "2.4.0",
      serverVersion: "0.1.5",
      toolCount: () => 3,
      repoRoot: process.cwd(),
    });
    const result = await service.checkUpdates();
    // Network may be unavailable in a sandbox; the shape must still be honest.
    expect(result.kinds.map((item) => item.kind)).toEqual(["protocol", "sdk", "application"]);
    expect(result.kinds.find((item) => item.kind === "protocol")!.requiresRestart).toBe(false);
    expect(result.kinds.find((item) => item.kind === "sdk")!.requiresRestart).toBe(true);
    expect(result.application.currentVersion).toBeTruthy();
    // A failed lookup must report an error, never "up to date".
    if (result.sdk.latest === null) expect(result.sdk.error).toBeTruthy();
    expect(result.sdk.releaseNotesUrl).toContain("modelcontextprotocol");
  });

  it("caches the answer so a refresh loop cannot hammer the registry", async () => {
    resetUpdateCache();
    const service = new McpStatusService({
      sdkFiles: () => [join(tmpdir(), "missing.cjs")],
      sdkVersion: "2.4.0",
      serverVersion: "0.1.5",
      toolCount: () => 3,
      repoRoot: process.cwd(),
    });
    const first = await service.checkUpdates();
    const second = await service.checkUpdates();
    expect(second.checkedAt).toBe(first.checkedAt);
    const forced = await service.checkUpdates({ force: true });
    expect(forced.checkedAt >= first.checkedAt).toBe(true);
  });
});
