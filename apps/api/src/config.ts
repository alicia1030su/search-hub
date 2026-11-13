import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, independent of the process working directory. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  publicBaseUrl: string | null;
  setupToken: string | null;
  corsOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  logLevel: string;
  encryptionKey: string | undefined;
  staticDir: string | null;
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

  return {
    nodeEnv,
    host: env("SEARCH_HUB_HOST") ?? "0.0.0.0",
    port: Number.isFinite(port) ? port : 8787,
    dataDir,
    dbPath: env("SEARCH_HUB_DB_PATH") ?? join(dataDir, "search-hub.db"),
    publicBaseUrl,
    setupToken: env("SEARCH_HUB_SETUP_TOKEN") ?? null,
    corsOrigins: (env("SEARCH_HUB_CORS_ORIGINS") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    cookieSecure: boolEnv("SEARCH_HUB_COOKIE_SECURE", nodeEnv === "production"),
    trustProxy: boolEnv("SEARCH_HUB_TRUST_PROXY", false),
    logLevel: env("SEARCH_HUB_LOG_LEVEL") ?? "info",
    encryptionKey: env("SEARCH_HUB_ENCRYPTION_KEY"),
    staticDir: existsSync(staticDir) ? staticDir : null,
    version: "0.1.0",
  };
}
