import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeServerUrl } from "../security/url.js";
import { usageError } from "../errors/index.js";

export interface CliConfig {
  url?: string;
}

export function configDir(): string {
  const override = process.env["SEARCH_HUB_CLI_CONFIG_DIR"];
  if (override && override.trim().length > 0) return override;
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "SearchHubCLI");
  }
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "search-hub-cli");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw usageError(`CLI config is not valid JSON: ${path}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`CLI config must be a JSON object: ${path}`);
  }
  const config = parsed as Record<string, unknown>;
  if (config["url"] !== undefined && typeof config["url"] !== "string") {
    throw usageError(`CLI config url must be a string: ${path}`);
  }
  return config["url"] === undefined ? {} : { url: normalizeServerUrl(config["url"]) };
}

export function saveConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temp, 0o600);
  renameSync(temp, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function resetConfig(): void {
  const path = configPath();
  if (existsSync(path)) unlinkSync(path);
}

export function resolveUrl(explicit?: string): string {
  const raw = explicit ?? process.env["SEARCH_HUB_URL"] ?? loadConfig().url ?? "http://127.0.0.1:8787";
  return normalizeServerUrl(raw);
}

export async function resolveToken(useStdin: boolean): Promise<string | undefined> {
  const fromEnv = process.env["SEARCH_HUB_TOKEN"]?.trim();
  if (fromEnv) return fromEnv;
  if (!useStdin) return undefined;
  if (process.stdin.isTTY) {
    throw usageError("--token-stdin requires piped input; refusing to echo a token typed on a terminal");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const token = Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0]?.trim();
  if (!token) throw usageError("--token-stdin received no token");
  return token;
}
