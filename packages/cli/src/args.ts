import { parseArgs } from "node:util";
import { usageError } from "./errors/index.js";
import type { OutputFormat } from "./output/index.js";

const options = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  url: { type: "string" },
  "token-stdin": { type: "boolean" },
  json: { type: "boolean" },
  format: { type: "string" },
  strict: { type: "boolean" },
  verbose: { type: "boolean" },
  limit: { type: "string" },
  "max-chars": { type: "string" },
  provider: { type: "string", multiple: true },
  group: { type: "string" },
  mode: { type: "string" },
  language: { type: "string" },
  freshness: { type: "string" },
  timeout: { type: "string" },
  enabled: { type: "boolean" },
  all: { type: "boolean" },
  kind: { type: "string" },
  "key-id": { type: "string" },
  "include-keyless": { type: "boolean" },
  "confirm-cost": { type: "boolean" },
  job: { type: "string" },
  cancel: { type: "string" },
  "poll-interval": { type: "string" },
  "passphrase-stdin": { type: "boolean" },
  "data-dir": { type: "string" },
  db: { type: "string" },
  "master-key-file": { type: "string" },
  legacy: { type: "boolean" },
  output: { type: "string" },
  "dry-run": { type: "boolean" },
  apply: { type: "boolean" },
  "start-check": { type: "boolean" },
  local: { type: "boolean" },
  report: { type: "string" },
} as const;

export interface ParsedCliArgs {
  positionals: string[];
  values: Record<string, string | boolean | string[] | undefined>;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { positionals: parsed.positionals, values: parsed.values as ParsedCliArgs["values"] };
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
}

export function stringValue(values: ParsedCliArgs["values"], key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw usageError(`--${key} requires a value`);
  return value;
}

export function numberValue(
  values: ParsedCliArgs["values"],
  key: string,
  range: { min: number; max: number; integer?: boolean },
): number | undefined {
  const raw = stringValue(values, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usageError(`--${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw usageError(`--${key} must be between ${range.min} and ${range.max}`);
  }
  if (range.integer === false && !Number.isInteger(value)) throw usageError(`--${key} must be an integer`);
  return value;
}

export function stringList(values: ParsedCliArgs["values"], key: string): string[] | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string")) throw usageError(`--${key} requires string values`);
    return value.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value !== "string") throw usageError(`--${key} requires a string value`);
  const list = [value];
  const result = list.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  return result.length > 0 ? result : undefined;
}

export function outputFormat(values: ParsedCliArgs["values"]): OutputFormat {
  if (values["json"] === true) return "json";
  const raw = stringValue(values, "format") ?? "table";
  if (raw !== "table" && raw !== "json" && raw !== "ndjson") {
    throw usageError("--format must be one of: table, json, ndjson");
  }
  return raw;
}

export function helpText(): string {
  return `Search Hub CLI (shub)

Usage:
  shub search <query> [options]
  shub fetch <URL> [--max-chars N] [--json]
  shub sources [--enabled] [--json]
  shub status [--json]
  shub doctor [--verbose] [--json]
  shub config <set|get|list|reset> [url]
  shub providers test <provider-id> [options]
  shub providers test --all [options]
  shub providers test --job <job-id>
  shub providers test --cancel <job-id>
  shub backup create --output <file.shbackup> [--db <file>] [--data-dir <dir>] [--master-key-file <file>] [--passphrase-stdin]
  shub backup verify <file.shbackup|file.db> [--legacy] [--master-key-file <file>] [--passphrase-stdin] [--report <file>]
  shub backup restore <file.shbackup> --data-dir <new-dir> [--apply] [--start-check] [--passphrase-stdin] (default: dry-run)
  shub doctor --local [--data-dir <dir>] [--db <file>]

Global options:
  --url <url>                 Search Hub server URL
  --token-stdin               Read SEARCH_HUB_TOKEN equivalent from stdin
  --format <table|json|ndjson> Output format (--json is an alias)
  --timeout <ms>              Request timeout
  --verbose                   Write diagnostics to stderr
  --passphrase-stdin         Read backup passphrase from stdin or hidden TTY input
  --data-dir <dir>            Local data directory
  --db <file>                 Local SQLite path
  --master-key-file <file>    Explicit master key file (default: <data-dir>/master.key)
  -h, --help                  Show help
  -v, --version               Show CLI version

Search options:
  --limit <1..100> --provider <id> --group <name> --mode <mode>
  --language <tag> --freshness <day|week|month|year|all> --strict

Fetch options:
  --max-chars <1..500000>      Maximum Markdown characters to return

Provider test options:
  --kind <connect|search> --include-keyless --confirm-cost --key-id <id>

Environment:
  SEARCH_HUB_URL              Default server URL
  SEARCH_HUB_TOKEN            Bearer token (never written to disk by shub)
  SEARCH_HUB_BACKUP_PASSPHRASE  Backup passphrase (prefer --passphrase-stdin)
  SEARCH_HUB_DATA_DIR         Local/original data directory (required for restore origin guard)
  SEARCH_HUB_INSTALL_DIR      Original install directory (required for restore origin guard)
  SEARCH_HUB_DB_PATH          Custom local SQLite path
`;
}
