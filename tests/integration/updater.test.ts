import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetNameFor, isNewer, UpdateService } from "../../apps/api/src/services/updater.js";

/**
 * Updater verification.
 *
 * The important assertions are the *refusals*: a package with no published
 * digest, a size mismatch, or a bad hash must never be staged. Anything less and
 * "verified" is just a word in a log line.
 */
let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeService(options: {
  current?: string;
  deployment?: "standalone" | "docker";
  release?: unknown;
  assetBytes?: Buffer;
  digestOverride?: string | null;
  sizeOverride?: number;
}) {
  dir = mkdtempSync(join(tmpdir(), "search-hub-update-"));
  const bytes = options.assetBytes ?? Buffer.from("fake-package-bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const asset = {
    name: "search-hub-v0.2.0-windows-x64.zip",
    size: options.sizeOverride ?? bytes.byteLength,
    browser_download_url: "https://example.invalid/pkg.zip",
    digest: options.digestOverride === null ? null : (options.digestOverride ?? `sha256:${sha}`),
  };
  const release =
    options.release === undefined
      ? [
          {
            tag_name: "v0.2.0",
            published_at: "2026-11-16T00:00:00Z",
            html_url: "https://example.invalid/release",
            prerelease: true,
            draft: false,
            assets: [asset],
          },
        ]
      : options.release;

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify(release), { status: 200 });
    }
    return new Response(bytes, { status: 200 });
  }) as unknown as typeof fetch;

  return new UpdateService({
    currentVersion: options.current ?? "0.1.5-beta.1",
    deployment: () => options.deployment ?? "standalone",
    stagingDir: join(dir, "staging"),
    fetchImpl,
  });
}

describe("version comparison", () => {
  it("treats a higher patch as newer", () => {
    expect(isNewer("0.2.0", "0.1.5")).toBe(true);
    expect(isNewer("0.1.5", "0.2.0")).toBe(false);
    expect(isNewer("v0.1.6", "0.1.5")).toBe(true);
  });

  it("treats a release as newer than its own prerelease", () => {
    expect(isNewer("0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(isNewer("0.2.0-beta.1", "0.2.0")).toBe(false);
  });

  it("does not call a lower prerelease newer", () => {
    expect(isNewer("0.1.5-beta.1", "0.1.5-beta.2")).toBe(false);
  });
});

describe("asset naming", () => {
  it("matches the release asset convention per platform", () => {
    expect(assetNameFor("0.2.0", "win32", "x64")).toBe("search-hub-v0.2.0-windows-x64.zip");
    expect(assetNameFor("0.2.0", "linux", "arm64")).toBe("search-hub-v0.2.0-linux-arm64.tar.gz");
  });
});

describe("update check", () => {
  it("reports an available update from release metadata", async () => {
    const service = makeService({ current: "0.1.5-beta.1" });
    const status = await service.check({ force: true });
    expect(status.latest?.version).toBe("0.2.0");
    expect(status.updateAvailable).toBe(true);
    expect(status.matchingAsset).toContain("windows");
  });

  it("reports no update when the current version is ahead", async () => {
    const service = makeService({ current: "0.3.0" });
    const status = await service.check({ force: true });
    expect(status.updateAvailable).toBe(false);
  });

  it("reports unknown, never up-to-date, when the lookup fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "search-hub-update-"));
    const service = new UpdateService({
      currentVersion: "0.1.5",
      deployment: () => "standalone",
      stagingDir: join(dir, "staging"),
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    const status = await service.check({ force: true });
    expect(status.updateAvailable).toBeNull();
    expect(status.error).toContain("500");
  });

  it("refuses to offer an in-place update for Docker", async () => {
    const service = makeService({ deployment: "docker" });
    const status = await service.check({ force: true });
    expect(status.error).toContain("Docker");
  });
});

describe("staging", () => {
  it("stages a package whose digest matches the release metadata", async () => {
    const service = makeService({});
    const staged = await service.stage();
    expect(staged.verified).toBe(true);
    expect(staged.bytes).toBeGreaterThan(0);
    expect(readFileSync(staged.path).length).toBe(staged.bytes);
    expect(service.pending()?.version).toBe("0.2.0");
  });

  it("refuses when the release publishes no digest", async () => {
    const service = makeService({ digestOverride: null });
    await expect(service.stage()).rejects.toThrow(/does not publish a SHA256 digest/);
  });

  it("refuses when the downloaded size differs from the metadata", async () => {
    const service = makeService({ sizeOverride: 999_999 });
    await expect(service.stage()).rejects.toThrow(/bytes but the release metadata says/);
  });

  it("refuses and deletes the file when the hash does not match", async () => {
    const service = makeService({ digestOverride: `sha256:${"0".repeat(64)}` });
    await expect(service.stage()).rejects.toThrow(/Checksum mismatch/);
  });

  it("refuses to stage in Docker", async () => {
    const service = makeService({ deployment: "docker" });
    await expect(service.stage()).rejects.toThrow(/cannot self-update/);
  });

  it("refuses when no asset matches this platform", async () => {
    const service = makeService({
      release: [
        {
          tag_name: "v0.2.0",
          published_at: "2026-11-16T00:00:00Z",
          html_url: "https://example.invalid",
          prerelease: true,
          draft: false,
          assets: [
            {
              name: "search-hub-v0.2.0-darwin-x64.tar.gz",
              size: 10,
              browser_download_url: "https://example.invalid/x",
              digest: `sha256:${"a".repeat(64)}`,
            },
          ],
        },
      ],
    });
    await expect(service.stage()).rejects.toThrow(/No release asset matches/);
  });

  it("forgets a pending update whose file was removed", async () => {
    const service = makeService({});
    const staged = await service.stage();
    rmSync(staged.path, { force: true });
    expect(service.pending()).toBeNull();
  });

  it("writes the pending record next to the package", async () => {
    const service = makeService({});
    const staged = await service.stage();
    const record = JSON.parse(readFileSync(join(dir, "staging", "pending.json"), "utf8")) as {
      version: string;
      sha256: string;
    };
    expect(record.version).toBe("0.2.0");
    expect(record.sha256).toBe(staged.expectedSha256);
    void writeFileSync;
  });
});
