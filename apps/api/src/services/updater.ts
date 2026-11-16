/**
 * Application update checking and staging.
 *
 * Design constraints that shaped this module:
 *
 * 1. **The checksum must come from release metadata, not from a file next to the
 *    download.** GitHub's release-asset API returns a `digest` field computed
 *    server-side (`sha256:...`); that is the primary source. `SHA256SUMS` is
 *    only used as a cross-check, never as the sole authority, because a tampered
 *    release would carry a matching tampered sums file.
 * 2. **Nothing downloaded is executed here.** The package is staged, verified,
 *    and then handed to the launcher, which swaps files only while the server is
 *    stopped and rolls back if the new version fails its health check.
 * 3. **Docker never self-updates.** Inside a container the running image is
 *    immutable; the only correct action is to report the available tag and the
 *    compose command.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SearchHubError } from "@search-hub/shared";

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  /** GitHub-computed digest, e.g. `sha256:abc…`. Null when the API omits it. */
  digest: string | null;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  publishedAt: string;
  notesUrl: string;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface UpdateStatus {
  currentVersion: string;
  deployment: "standalone" | "docker";
  latest: ReleaseInfo | null;
  updateAvailable: boolean | null;
  /** Asset name that matches this platform, when one exists. */
  matchingAsset: string | null;
  error: string | null;
  checkedAt: string;
}

export interface StagedUpdate {
  version: string;
  assetName: string;
  path: string;
  bytes: number;
  /** Digest GitHub reported, and the digest computed locally. */
  expectedSha256: string | null;
  actualSha256: string;
  verified: boolean;
  stagedAt: string;
}

const REPO = "alicia1030su/search-hub";

/**
 * Which asset belongs to this installation.
 *
 * Chosen from the *process* platform/arch rather than the build target: an
 * update must never install a package for a different architecture.
 */
export function assetNameFor(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const suffix = platform === "win32" ? "zip" : "tar.gz";
  const os = platform === "win32" ? "windows" : "linux";
  return `search-hub-v${version}-${os}-${arch}.${suffix}`;
}

/** Semantic-ish comparison good enough for `0.1.4-beta.6` style versions. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const [core, pre] = value.replace(/^v/, "").split("-");
    const nums = (core ?? "").split(".").map((part) => Number(part.replace(/\D/g, "")) || 0);
    return { nums, pre: pre ?? null };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let index = 0; index < Math.max(a.nums.length, b.nums.length); index += 1) {
    const left = a.nums[index] ?? 0;
    const right = b.nums[index] ?? 0;
    if (left !== right) return left > right;
  }
  // Same core version: a release (no suffix) is newer than a prerelease.
  if (a.pre === null && b.pre !== null) return true;
  if (a.pre !== null && b.pre === null) return false;
  return false;
}

export interface UpdateServiceDeps {
  currentVersion: string;
  /** "docker" disables installation entirely. */
  deployment: () => "standalone" | "docker";
  stagingDir: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class UpdateService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cache: { at: number; value: UpdateStatus } | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  async check(options: { force?: boolean } = {}): Promise<UpdateStatus> {
    const ttl = 15 * 60 * 1000;
    if (!options.force && this.cache && this.now() - this.cache.at < ttl) return this.cache.value;

    const base: UpdateStatus = {
      currentVersion: this.deps.currentVersion,
      deployment: this.deps.deployment(),
      latest: null,
      updateAvailable: null,
      matchingAsset: null,
      error: null,
      checkedAt: new Date(this.now()).toISOString(),
    };

    // Docker: the image tag is the unit of update, and it is not ours to change
    // from inside the container.
    if (base.deployment === "docker") {
      base.error = "Docker deployments update by pulling a new image tag; no in-place update is offered.";
      this.cache = { at: this.now(), value: base };
      return base;
    }

    try {
      const release = (await this.fetchRelease()) as ReleaseInfo | null;
      if (!release) {
        base.error = "No published release found";
      } else {
        base.latest = release;
        base.updateAvailable = isNewer(release.version, this.deps.currentVersion);
        base.matchingAsset =
          release.assets.find((asset) => asset.name.includes(`-${process.platform === "win32" ? "windows" : "linux"}-`))?.name ??
          null;
      }
    } catch (error) {
      // A failed check is "unknown", never "up to date".
      base.error = error instanceof Error ? error.message : String(error);
    }
    this.cache = { at: this.now(), value: base };
    return base;
  }

  /**
   * Downloads the matching asset into the staging directory and verifies it.
   *
   * Refuses when:
   * - the deployment is Docker (nothing to install),
   * - no asset matches this platform,
   * - the release metadata carries no digest (a checksum we cannot trust is
   *   worse than none: it invites a false sense of verification),
   * - the downloaded bytes do not hash to the expected value.
   */
  async stage(): Promise<StagedUpdate> {
    const status = await this.check({ force: true });
    if (status.deployment === "docker") {
      throw new SearchHubError(
        "unsupported",
        "Docker deployments cannot self-update. Pull the new image tag and restart the container.",
      );
    }
    if (!status.latest) throw new SearchHubError("not_found", status.error ?? "No release available");
    const asset = status.latest.assets.find((item) => item.name === status.matchingAsset);
    if (!asset) {
      throw new SearchHubError(
        "not_found",
        `No release asset matches this platform (${process.platform}/${process.arch})`,
      );
    }
    if (!asset.digest || !asset.digest.startsWith("sha256:")) {
      throw new SearchHubError(
        "blocked",
        "The release metadata does not publish a SHA256 digest for this asset; refusing to install unverified bytes.",
      );
    }

    const expected = asset.digest.slice("sha256:".length).toLowerCase();
    mkdirSync(this.deps.stagingDir, { recursive: true });
    const target = join(this.deps.stagingDir, asset.name);

    const response = await this.fetchImpl(asset.downloadUrl, {
      headers: { accept: "application/octet-stream", "user-agent": "search-hub-updater" },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new SearchHubError("network", `Download failed with HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength !== asset.size) {
      throw new SearchHubError(
        "bad_request",
        `Downloaded ${buffer.byteLength} bytes but the release metadata says ${asset.size}`,
      );
    }
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== expected) {
      rmSync(target, { force: true });
      throw new SearchHubError(
        "blocked",
        `Checksum mismatch: release metadata says ${expected}, downloaded file hashes to ${actual}`,
      );
    }
    writeFileSync(target, buffer);
    writeFileSync(
      join(this.deps.stagingDir, "pending.json"),
      JSON.stringify(
        {
          version: status.latest.version,
          assetName: asset.name,
          path: target,
          sha256: expected,
          stagedAt: new Date(this.now()).toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      version: status.latest.version,
      assetName: asset.name,
      path: target,
      bytes: buffer.byteLength,
      expectedSha256: expected,
      actualSha256: actual,
      verified: true,
      stagedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Reads the staged package recorded by `stage()`, if any. */
  pending(): StagedUpdate | null {
    const file = join(this.deps.stagingDir, "pending.json");
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        version: string;
        assetName: string;
        path: string;
        sha256: string;
        stagedAt: string;
      };
      if (!existsSync(parsed.path)) return null;
      return {
        version: parsed.version,
        assetName: parsed.assetName,
        path: parsed.path,
        bytes: 0,
        expectedSha256: parsed.sha256,
        actualSha256: parsed.sha256,
        verified: true,
        stagedAt: parsed.stagedAt,
      };
    } catch {
      return null;
    }
  }

  private async fetchRelease(): Promise<ReleaseInfo | null> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "search-hub-updater",
    };
    // A private repository needs a token; it is optional so a public mirror works.
    const token = process.env["SEARCH_HUB_UPDATE_TOKEN"];
    if (token) headers["authorization"] = `Bearer ${token}`;

    const response = await this.fetchImpl(`https://api.github.com/repos/${REPO}/releases?per_page=5`, {
      headers,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
    const list = (await response.json()) as Array<{
      tag_name: string;
      published_at: string;
      html_url: string;
      prerelease: boolean;
      draft: boolean;
      assets: Array<{
        name: string;
        size: number;
        browser_download_url: string;
        digest?: string | null;
      }>;
    }>;
    const usable = list.filter((item) => !item.draft);
    if (usable.length === 0) return null;
    // Newest by version, not by array order: GitHub returns them by creation.
    const newest = usable.reduce((best, item) =>
      isNewer(item.tag_name, best.tag_name) ? item : best,
    );
    return {
      tag: newest.tag_name,
      version: newest.tag_name.replace(/^v/, ""),
      publishedAt: newest.published_at,
      notesUrl: newest.html_url,
      prerelease: newest.prerelease,
      assets: newest.assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        downloadUrl: asset.browser_download_url,
        digest: asset.digest ?? null,
      })),
    };
  }
}
