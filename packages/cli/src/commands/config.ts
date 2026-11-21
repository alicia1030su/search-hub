import type { ParsedCliArgs } from "../args.js";
import { configPath, loadConfig, resetConfig, saveConfig } from "../config/index.js";
import { usageError } from "../errors/index.js";
import { writeJson, writeText, type OutputFormat } from "../output/index.js";
import { normalizeServerUrl } from "../security/url.js";

export async function runConfig(args: ParsedCliArgs, format: OutputFormat): Promise<number> {
  const action = args.positionals[1];
  const key = args.positionals[2];
  const value = args.positionals.slice(3).join(" ");
  if (!action) throw usageError("config requires one of: set, get, list, reset");

  if (action === "set") {
    if (key !== "url" || !value) throw usageError("usage: shub config set url <https://search.example.com>");
    const url = normalizeServerUrl(value);
    saveConfig({ ...loadConfig(), url });
    const result = { ok: true, url, configPath: configPath() };
    if (format === "json") writeJson(result);
    else writeText(`Saved ${url} to ${configPath()}`);
    return 0;
  }
  if (action === "get") {
    if (key !== "url") throw usageError("usage: shub config get url");
    const url = loadConfig().url ?? null;
    if (format === "json") writeJson({ url });
    else writeText(url ?? "(not set)");
    return 0;
  }
  if (action === "list") {
    const config = loadConfig();
    const result = { ...config, configPath: configPath() };
    if (format === "json") writeJson(result);
    else writeText(`url=${config.url ?? "(not set)"}\nconfigPath=${configPath()}`);
    return 0;
  }
  if (action === "reset") {
    resetConfig();
    const result = { ok: true, configPath: configPath() };
    if (format === "json") writeJson(result);
    else writeText(`Reset ${configPath()}`);
    return 0;
  }
  throw usageError(`Unknown config action: ${action}`);
}
