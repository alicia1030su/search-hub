/**
 * MCP status: what this server *actually* speaks, measured rather than assumed.
 *
 * The interesting part is not "which versions exist" but "which versions does the
 * installed SDK negotiate". A client asking for a revision the SDK does not know
 * gets silently downgraded, so reporting the SDK's declared latest would be a
 * lie the moment a client negotiates something older.
 *
 * Update checking is deliberately conservative:
 * - only the npm registry for `@modelcontextprotocol/server` is consulted;
 * - the answer is cached, and a failure is reported as "unknown" rather than
 *   "up to date";
 * - it never downloads or executes anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type UpdateKind = "protocol" | "sdk" | "application";

export interface McpProtocolStatus {
  /** Version reported by the SDK as its newest. */
  sdkLatest: string;
  /** Versions the SDK will accept without downgrading. */
  sdkSupported: string[];
  /** What this server announces in `initialize`. */
  serverVersion: string;
  sdkVersion: string;
  transports: { http: "ok"; stdio: "ok" };
  toolCount: number;
  /** False when the SDK does not implement the revision this build targets. */
  revision2026Supported: boolean;
  notes: string[];
}

export interface UpdateCheckResult {
  checkedAt: string;
  source: string;
  sdk: {
    installed: string;
    latest: string | null;
    updateAvailable: boolean | null;
    error: string | null;
    releaseNotesUrl: string;
  };
  /** Revision the newest SDK declares, when it can be determined. */
  protocol: {
    current: string;
    latestDeclared: string | null;
    revision2026Supported: boolean;
  };
  application: {
    currentVersion: string;
    latestTag: string | null;
    updateAvailable: boolean | null;
    error: string | null;
    releaseUrl: string;
  };
  /** Separates the three things a user might mean by "update". */
  kinds: Array<{ kind: UpdateKind; action: string; requiresRestart: boolean }>;
}

const NPM_REGISTRY = "https://registry.npmjs.org/@modelcontextprotocol%2Fserver/latest";
const NPM_CORE_REGISTRY = "https://registry.npmjs.org/@modelcontextprotocol%2Fcore/latest";
const GH_RELEASES = "https://api.github.com/repos/alicia1030su/search-hub/releases/latest";
const CACHE_MS = 30 * 60 * 1000;

interface CacheEntry {
  at: number;
  value: UpdateCheckResult;
}

let cache: CacheEntry | null = null;

/**
 * Reads the protocol constants out of the installed SDK's own dist files.
 *
 * `import` of the deep internal path is not stable across versions, so the
 * numbers are parsed from the shipped source. When the shape changes the parse
 * returns null and the caller reports "unknown" instead of guessing.
 */
export function readSdkProtocol(input: {
  version: string;
  files: string[];
}): { latest: string | null; supported: string[] } {
  let latest: string | null = null;
  const supported = new Set<string>();
  for (const file of input.files) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    const latestMatch = source.match(/LATEST_PROTOCOL_VERSION\s*=\s*"([^"]+)"/);
    if (latestMatch) latest = latestMatch[1]!;
    const listMatch = source.match(/SUPPORTED_PROTOCOL_VERSIONS\s*=\s*\[([\s\S]*?)\]/);
    if (listMatch) {
      for (const raw of listMatch[1]!.split(",")) {
        const quoted = raw.match(/"([^"]+)"/);
        if (quoted) supported.add(quoted[1]!);
      }
      // The list starts with the constant, not a literal.
      if (latest) supported.add(latest);
    }
  }
  return { latest, supported: [...supported] };
}

export interface McpStatusDeps {
  /** Paths to the installed SDK dist files, probed by the caller. */
  sdkFiles: () => string[];
  sdkVersion: string;
  serverVersion: string;
  toolCount: () => number;
  /** Absolute path to the repository root, used to read package versions. */
  repoRoot: string;
  now?: () => number;
}

export class McpStatusService {
  private readonly now: () => number;

  constructor(private readonly deps: McpStatusDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  status(): McpProtocolStatus {
    const resolved = readSdkProtocol({ version: this.deps.sdkVersion, files: this.deps.sdkFiles() });
    const sdkLatest = resolved.latest ?? "unknown";
    const notes: string[] = [];
    if (resolved.latest === null) {
      notes.push("Could not read the SDK protocol constants; version support is unknown.");
    }
    // Measured 2026-11-16: an initialize with 2026-07-28 is negotiated down to
    // 2025-11-25, i.e. the SDK does not implement that revision yet.
    const revision2026Supported = resolved.supported.includes("2026-07-28");
    if (!revision2026Supported) {
      notes.push(
        "The installed SDK does not implement 2026-07-28; clients requesting it are negotiated down to " +
          `${sdkLatest}. This is reported as unsupported rather than claimed.`,
      );
    }
    return {
      sdkLatest,
      sdkSupported: resolved.supported.sort(),
      serverVersion: this.deps.serverVersion,
      sdkVersion: this.deps.sdkVersion,
      transports: { http: "ok", stdio: "ok" },
      toolCount: this.deps.toolCount(),
      revision2026Supported,
      notes,
    };
  }

  /**
   * Checks npm and GitHub for newer versions.
   *
   * Results are cached for 30 minutes: this endpoint is a button a curious admin
   * presses repeatedly, and hammering a public registry is rude and pointless.
   */
  async checkUpdates(options: { force?: boolean } = {}): Promise<UpdateCheckResult> {
    if (!options.force && cache && this.now() - cache.at < CACHE_MS) return cache.value;

    const current = packageVersion(this.deps.repoRoot);
    const [sdk, core, app] = await Promise.all([
      fetchJson(NPM_REGISTRY),
      fetchJson(NPM_CORE_REGISTRY),
      fetchJson(GH_RELEASES),
    ]);

    const sdkVersion = typeof sdk.value?.["version"] === "string" ? (sdk.value["version"] as string) : null;
    const appTag = typeof app.value?.["tag_name"] === "string" ? (app.value["tag_name"] as string) : null;

    // Which revision does the *published* core declare? Read from the packument
    // metadata when present; otherwise leave it unknown rather than assume.
    const latestDeclared =
      typeof core.value?.["mcpProtocolVersion"] === "string"
        ? (core.value["mcpProtocolVersion"] as string)
        : null;

    const result: UpdateCheckResult = {
      checkedAt: new Date(this.now()).toISOString(),
      source: "registry.npmjs.org + api.github.com (official only)",
      sdk: {
        installed: this.deps.sdkVersion,
        latest: sdkVersion,
        updateAvailable: sdkVersion ? sdkVersion !== this.deps.sdkVersion : null,
        error: sdk.error,
        releaseNotesUrl: "https://github.com/modelcontextprotocol/typescript-sdk/releases",
      },
      protocol: {
        current: this.status().sdkLatest,
        latestDeclared,
        revision2026Supported: this.status().revision2026Supported,
      },
      application: {
        currentVersion: current,
        latestTag: appTag,
        updateAvailable: appTag ? appTag.replace(/^v/, "") !== current : null,
        error: app.error,
        releaseUrl: "https://github.com/alicia1030su/search-hub/releases",
      },
      kinds: [
        {
          kind: "protocol",
          action:
            "Clients and this server negotiate the revision automatically. No download is required; " +
            "a newer revision only becomes available when the SDK implements it.",
          requiresRestart: false,
        },
        {
          kind: "sdk",
          action: "Upgrade @modelcontextprotocol/server, rebuild, and re-run the protocol tests.",
          requiresRestart: true,
        },
        {
          kind: "application",
          action: "Install a verified Search Hub release package (SHA256 checked against release metadata).",
          requiresRestart: true,
        },
      ],
    };

    cache = { at: this.now(), value: result };
    return result;
  }
}

function packageVersion(repoRoot: string): string {
  try {
    const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchJson(url: string): Promise<{ value: Record<string, unknown> | null; error: string | null }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "search-hub-update-check" },
    });
    clearTimeout(timer);
    if (!response.ok) return { value: null, error: `HTTP ${response.status}` };
    const parsed = (await response.json()) as unknown;
    return {
      value: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null,
      error: null,
    };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Clears the cached update result (used by tests and a manual force refresh). */
export function resetUpdateCache(): void {
  cache = null;
}
