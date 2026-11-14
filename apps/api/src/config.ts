import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutboundProxyInput } from "@search-hub/shared";

/**
 * Repository / install root.
 *
 * When running from source this resolves to the repository root; when the API
 * is bundled to `apps/api/dist/server.mjs` the same expression still resolves
 * to the install root (`../../..` from `apps/api/dist`). Callers must not
 * assume the presence of `src/`.
 */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  publicBaseUrl: string | null;
  /** Explicit setup token from the environment; a generated one is layered on later. */
  setupToken: string | null;
  /** Hostnames accepted in the Host header. IP literals are always accepted. */
  allowedHosts: string[];
  corsOrigins: string[];
  cookieSecure: boolean;
  /** `false`, or a comma-separated CIDR list of trusted reverse proxies. */
  trustProxy: boolean | string;
  logLevel: string;
  encryptionKey: string | undefined;
  staticDir: string | null;
  migrationsDir: string;
  version: string;
  /** Hard cap for `POST /api/admin/backup/verify` raw uploads (default 64 MB). */
  maxBackupUploadBytes: number;
  /** Global per-IP request budget (default 300/min). Raise for load testing. */
  rateLimitPerMin: number;
  /**
   * Outbound proxy configuration for every provider/model request.
   * Deployment configuration only: it is intentionally NOT part of the
   * settings table, so the admin UI, settings export and backups cannot
   * redirect or disable egress control.
   */
  outboundProxy: OutboundProxyInput;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function listEnv(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Hostname (without port) -> lowercase, IPv6 brackets stripped. */
export function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  // A single colon with a numeric suffix is a port; anything else is IPv6.
  if (colon > -1 && value.indexOf(":") === colon) return value.slice(0, colon);
  return value;
}

function deriveAllowedHosts(publicBaseUrl: string | null): string[] {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  if (publicBaseUrl) {
    try {
      hosts.add(new URL(publicBaseUrl).hostname.toLowerCase());
    } catch {
      // Invalid public URL is reported by the settings UI, not by blocking boot.
    }
  }
  return [...hosts];
}

/**
 * Proxy settings are deployment-controlled on purpose.
 *
 * Canonical names: `SEARCH_HUB_PROXY`, `SEARCH_HUB_NO_PROXY`,
 * `SEARCH_HUB_PROXY_TRUST`. The `SEARCH_HUB_OUTBOUND_*` spellings are accepted
 * as aliases so an operator who followed an earlier draft of the docs is not
 * silently left on a direct connection.
 *
 * Ambient `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` are ignored
 * unless `SEARCH_HUB_PROXY_FROM_ENV=true` explicitly opts in, because those
 * variables are frequently inherited from a shell, CI runner or base image and
 * would silently reroute every provider request (including API keys) through an
 * endpoint the operator never chose. Opting in still requires an explicit
 * `SEARCH_HUB_PROXY_TRUST`, so an inherited proxy can never become "trusted" by
 * accident.
 *
 * Validation happens in `resolveOutboundProxy` (scheme allowlist, port range,
 * trust level), which the context calls at boot so a bad value fails closed
 * instead of falling back to a direct connection.
 */
function readOutboundProxy(): OutboundProxyInput {
  const fromEnv = boolEnv("SEARCH_HUB_PROXY_FROM_ENV", boolEnv("SEARCH_HUB_OUTBOUND_PROXY_FROM_ENV", false));
  const explicit = env("SEARCH_HUB_PROXY") ?? env("SEARCH_HUB_OUTBOUND_PROXY");
  const conventional = fromEnv
    ? (env("HTTPS_PROXY") ?? env("HTTP_PROXY") ?? env("ALL_PROXY"))
    : undefined;
  const proxy = explicit ?? conventional ?? null;
  const noProxy =
    env("SEARCH_HUB_NO_PROXY") ??
    env("SEARCH_HUB_OUTBOUND_NO_PROXY") ??
    (fromEnv ? (env("NO_PROXY") ?? env("no_proxy")) : undefined);
  const proxyTrust =
    env("SEARCH_HUB_PROXY_TRUST") ?? env("SEARCH_HUB_OUTBOUND_PROXY_TRUST") ?? null;

  // An opt-in to ambient env vars without a declared trust level is exactly the
  // "undeclared proxy" the design forbids. Fail at boot with an actionable
  // message rather than running with a silent downgrade.
  if (!explicit && conventional && !proxyTrust) {
    throw new Error(
      "HTTP_PROXY/HTTPS_PROXY was picked up because SEARCH_HUB_PROXY_FROM_ENV=true, but " +
        "SEARCH_HUB_PROXY_TRUST is not set. Set it (untrusted | trusted-networks) so the " +
        "egress trust boundary is explicit, or unset SEARCH_HUB_PROXY_FROM_ENV.",
    );
  }

  return {
    proxy,
    noProxy: noProxy ?? null,
    proxyTrust,
    source: !proxy ? "none" : explicit ? "search-hub-env" : "conventional-env",
  };
}

export function loadConfig(): AppConfig {
  const envFile = join(process.cwd(), ".env");
  if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envFile);
    } catch {
      // A malformed .env must not prevent boot; real config comes from the environment.
    }
  }

  const nodeEnv = (env("NODE_ENV") ?? "development") as AppConfig["nodeEnv"];
  const dataDir = resolve(env("SEARCH_HUB_DATA_DIR") ?? join(REPO_ROOT, "data"));
  const port = Number(env("SEARCH_HUB_PORT") ?? env("PORT") ?? "8787");
  const publicBaseUrl = env("SEARCH_HUB_PUBLIC_URL") ?? null;
  const staticDir = env("SEARCH_HUB_STATIC_DIR") ?? join(REPO_ROOT, "apps", "web", "dist");
  const migrationsDir =
    env("SEARCH_HUB_MIGRATIONS_DIR") ?? join(REPO_ROOT, "packages", "db", "migrations");

  const trustProxySetting = env("SEARCH_HUB_TRUST_PROXY");
  let trustProxy: boolean | string = false;
  if (trustProxySetting === "true" || trustProxySetting === "1") {
    // Only trust the loopback proxy. Trusting every peer would let any client
    // spoof X-Forwarded-For and bypass IP-based login throttling/audit.
    trustProxy = "127.0.0.1/8,::1/128";
  } else if (trustProxySetting && trustProxySetting !== "false" && trustProxySetting !== "0") {
    trustProxy = trustProxySetting;
  }

  const extraHosts = listEnv("SEARCH_HUB_ALLOWED_HOSTS");
  const allowedHosts = [...new Set([...deriveAllowedHosts(publicBaseUrl), ...extraHosts])];

  return {
    nodeEnv,
    host: env("SEARCH_HUB_HOST") ?? "0.0.0.0",
    port: Number.isFinite(port) ? port : 8787,
    dataDir,
    dbPath: env("SEARCH_HUB_DB_PATH") ?? join(dataDir, "search-hub.db"),
    publicBaseUrl,
    setupToken: env("SEARCH_HUB_SETUP_TOKEN") ?? null,
    allowedHosts,
    corsOrigins: (env("SEARCH_HUB_CORS_ORIGINS") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    cookieSecure: boolEnv("SEARCH_HUB_COOKIE_SECURE", nodeEnv === "production"),
    trustProxy,
    logLevel: env("SEARCH_HUB_LOG_LEVEL") ?? "info",
    encryptionKey: env("SEARCH_HUB_ENCRYPTION_KEY"),
    staticDir: existsSync(staticDir) ? staticDir : null,
    migrationsDir,
    version: "0.1.4",
    rateLimitPerMin: Number(env("SEARCH_HUB_RATE_LIMIT_PER_MIN") ?? 300),
    maxBackupUploadBytes: Math.min(
      // Clamp: too small makes verification useless, too large lets one upload
      // exhaust the temp disk.
      Math.max(Number(env("SEARCH_HUB_BACKUP_MAX_UPLOAD_BYTES") ?? 64 * 1024 * 1024), 1024 * 1024),
      1024 * 1024 * 1024,
    ),
    outboundProxy: readOutboundProxy(),
  };
}
