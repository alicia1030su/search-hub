import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    version: "0.1.1",
  };
}
