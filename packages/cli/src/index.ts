import { parseCliArgs, helpText, outputFormat, numberValue, stringValue } from "./args.js";
import { resolveToken, resolveUrl } from "./config/index.js";
import { HttpClient } from "./client/http.js";
import { asCliError, usageError } from "./errors/index.js";
import { writeError, writeText, type OutputFormat } from "./output/index.js";
import { runSearch } from "./commands/search.js";
import { runSources } from "./commands/sources.js";
import { runStatus } from "./commands/status.js";
import { runDoctor } from "./commands/doctor.js";
import { runConfig } from "./commands/config.js";
import { runProvidersTest } from "./commands/providers.js";
import { runBackup } from "./commands/backup.js";
import { runLocalDoctor } from "./commands/local-doctor.js";
import { CLI_VERSION } from "./version.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  if (args.values["version"] === true) {
    writeText(CLI_VERSION);
    return 0;
  }
  if (args.values["help"] === true || args.positionals.length === 0) {
    writeText(helpText());
    return 0;
  }

  const format = outputFormat(args.values);
  const command = args.positionals[0];
  if (command === "config") return runConfig(args, format);
  if (command === "backup") return runBackup(args, format);
  if (command === "doctor" && args.values["local"] === true) return runLocalDoctor(args, format);

  const url = resolveUrl(stringValue(args.values, "url"));
  const token = await resolveToken(args.values["token-stdin"] === true);
  const timeoutMs = numberValue(args.values, "timeout", { min: 1000, max: 120_000 }) ?? 30_000;
  const pollInterval = numberValue(args.values, "poll-interval", { min: 100, max: 60_000 }) ?? 1000;
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const client = new HttpClient(url, token, timeoutMs, controller.signal);
    switch (command) {
      case "search":
        return await runSearch(args, client, format);
      case "sources":
        return await runSources(args, client, token, format);
      case "status":
        return await runStatus(client, format, args.values["verbose"] === true);
      case "doctor":
        return await runDoctor(args, client, token, format);
      case "providers":
        if (args.positionals[1] !== "test") throw usageError("usage: shub providers test <id|--all|--job <id>|--cancel <id>>");
        return await runProvidersTest(args, client, token, format, pollInterval, controller.signal);
      default:
        throw usageError(`Unknown command: ${command}`);
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

if (process.argv[1] && /(?:^|[\\/])(?:index\.(?:ts|mjs|cjs)|shub(?:\.exe|\.mjs)?)$/.test(process.argv[1])) {
  main()
    .then(async (code) => {
      // Token resolution may have consumed stdin; nothing else needs it now.
      process.exitCode = code;
    })
    .catch((error) => {
      let format: OutputFormat = "table";
      try {
        format = outputFormat(parseCliArgs(process.argv.slice(2)).values);
      } catch {
        const argv = process.argv.slice(2);
        const formatIndex = argv.indexOf("--format");
        if (argv.includes("--json") || argv.includes("--format=json") || (formatIndex >= 0 && argv[formatIndex + 1] === "json")) {
          format = "json";
        }
      }
      const token = process.env["SEARCH_HUB_TOKEN"]?.trim();
      const cliError = asCliError(error, token ? [token] : []);
      writeError(cliError, format);
      process.exitCode = cliError.exitCode;
    });
}
