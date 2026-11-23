import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { UpdateError } from "./updater-core.mjs";

const UNIT_CANDIDATES = [
  "/etc/systemd/system/search-hub.service",
  "/lib/systemd/system/search-hub.service",
  "/usr/lib/systemd/system/search-hub.service",
];

function parseAssignment(text) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(text.trim());
  if (!match) return null;
  let value = match[2] ?? "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function shellWords(value) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quote || escaped) throw new UpdateError("invalid_service_config", "Unterminated quoting in systemd ExecStart");
  if (current) words.push(current);
  return words;
}

function readUnit(unitName, platform = process.platform) {
  if (platform === "win32") return null;
  const name = unitName.endsWith(".service") ? unitName : `${unitName}.service`;
  for (const candidate of UNIT_CANDIDATES) {
    if (candidate.endsWith(name)) return candidate;
  }
  const result = spawnSync("systemctl", ["show", name, "--property=FragmentPath", "--value"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const fragment = result.status === 0 ? result.stdout.trim() : "";
  return fragment && existsSync(fragment) ? fragment : null;
}

export function parseSystemdUnit(contents, baseDir = "/") {
  const env = {};
  const exec = [];
  let workingDirectory = baseDir;
  const logical = contents.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  for (const raw of logical) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value === "") continue;
    if (key === "Environment") {
      for (const word of shellWords(value)) {
        const assignment = parseAssignment(word);
        if (assignment) env[assignment[0]] = assignment[1];
      }
    } else if (key === "EnvironmentFile") {
      for (const word of shellWords(value)) {
        const optional = word.startsWith("-");
        const file = optional ? word.slice(1) : word;
        const path = isAbsolute(file) ? file : resolve(baseDir, file);
        if (!existsSync(path)) {
          if (!optional) throw new UpdateError("invalid_service_config", `EnvironmentFile is missing: ${path}`);
          continue;
        }
        for (const entry of readFileSync(path, "utf8").split(/\r?\n/)) {
          const assignment = parseAssignment(entry);
          if (assignment) env[assignment[0]] = assignment[1];
        }
      }
    } else if (key === "WorkingDirectory" && value !== "~") {
      workingDirectory = value.startsWith("~")
        ? join(homedir(), value.slice(1).replace(/^[/\\]/, ""))
        : isAbsolute(value) ? value : resolve(baseDir, value);
    } else if (key === "ExecStart") {
      exec.push(...shellWords(value));
    }
  }
  for (let index = 0; index < exec.length; index += 1) {
    const word = exec[index];
    if (word === "--data-dir" || word === "--db-path") {
      const target = word === "--data-dir" ? "SEARCH_HUB_DATA_DIR" : "SEARCH_HUB_DB_PATH";
      const value = exec[index + 1];
      if (!value) throw new UpdateError("invalid_service_config", `${word} requires a value`);
      env[target] = value;
      index += 1;
    }
  }
  return { env, workingDirectory, execStart: exec };
}

function defaultDataDir(platform, env) {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "SearchHub");
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "search-hub");
}

function configCandidates(root, platform, env) {
  return [
    join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "SearchHub", "launcher-config.json"),
    join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "search-hub", "launcher-config.json"),
    join(root, "data", "launcher-config.json"),
    join(root, "launcher-config.json"),
  ].filter((path) => platform === "win32" || !path.includes("AppData"));
}

/**
 * Resolves the same DATA_DIR/DB_PATH the running service uses. Explicit CLI
 * values win, then process environment, then systemd, then launcher config and
 * platform defaults. Relative DB paths are always relative to the data dir.
 */
export function resolveServiceConfig({
  root,
  dataDirArg,
  dbPathArg,
  portArg,
  env = process.env,
  platform = process.platform,
  unitName = env.SEARCH_HUB_SYSTEMD_UNIT ?? "search-hub",
}) {
  const candidateUnitPath = readUnit(unitName, platform);
  let unitPath = null;
  let unit = { env: {}, workingDirectory: root, execStart: [] };
  if (candidateUnitPath) {
    const parsed = parseSystemdUnit(readFileSync(candidateUnitPath, "utf8"), dirname(candidateUnitPath));
    const rootPath = resolve(root);
    const referencesRoot = parsed.execStart.some((word) => {
      if (!word.startsWith("/") && !word.startsWith(".")) return false;
      const candidate = resolve(parsed.workingDirectory, word);
      return candidate === rootPath || candidate.startsWith(`${rootPath}/`) || candidate.startsWith(`${rootPath}\\`);
    }) || parsed.workingDirectory === rootPath;
    if (env.SEARCH_HUB_SYSTEMD_UNIT || referencesRoot) {
      unitPath = candidateUnitPath;
      unit = parsed;
    }
  }
  const launcher = {};
  let launcherDataDir = null;
  for (const path of configCandidates(resolve(root), platform, env)) {
    if (!existsSync(path)) continue;
    try {
      Object.assign(launcher, JSON.parse(readFileSync(path, "utf8")));
      if (typeof launcher.dataDir === "string") launcherDataDir = launcher.dataDir;
      break;
    } catch {
      throw new UpdateError("invalid_service_config", `Could not parse launcher config: ${path}`);
    }
  }
  const dataValue = dataDirArg ?? env.SEARCH_HUB_DATA_DIR ?? unit.env.SEARCH_HUB_DATA_DIR ?? launcherDataDir ?? defaultDataDir(platform, env);
  const base = isAbsolute(dataValue) ? dataValue : resolve(unit.workingDirectory, dataValue);
  const dataDir = resolve(base);
  const dbValue = dbPathArg ?? env.SEARCH_HUB_DB_PATH ?? unit.env.SEARCH_HUB_DB_PATH ?? launcher.dbPath ?? join(dataDir, "search-hub.db");
  const dbPath = isAbsolute(dbValue) ? resolve(dbValue) : resolve(dataDir, dbValue);
  const portValue = portArg ?? env.SEARCH_HUB_PORT ?? unit.env.SEARCH_HUB_PORT ?? launcher.port ?? 8787;
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UpdateError("invalid_service_config", `Invalid service port: ${String(portValue)}`);
  }
  return { dataDir, dbPath, port, unitName: unitPath ? unitName : null, unitPath, source: { dataDir: dataDir, dbPath } };
}

export function updateWorkRoot(dataDir) {
  return join(dirname(dataDir), `.${dataDir.split(/[/\\]/).filter(Boolean).at(-1) || "search-hub"}.search-hub-updates`);
}
