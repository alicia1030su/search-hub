import { CLI_VERSION } from "../version.js";
import { HttpClient, isCompatibleServerVersion } from "../client/http.js";
import { EXIT_CODES } from "../errors/index.js";
import { table, writeJson, writeText, type OutputFormat } from "../output/index.js";

export async function runStatus(
  client: HttpClient,
  format: OutputFormat,
  verbose: boolean,
): Promise<number> {
  const health = await client.health();
  const compatible = isCompatibleServerVersion(health.version);
  const output = { ...health, cliVersion: CLI_VERSION, compatible };
  if (format === "json") {
    writeJson(output);
  } else {
    writeText(
      table(
        ["Field", "Value"],
        [
          ["CLI version", CLI_VERSION],
          ["Server version", health.version],
          ["Compatible", compatible],
          ["API reachable", true],
          ["Status", health.status],
          ["Uptime (s)", health.uptimeSeconds],
          ["Initialized", !health.setupRequired],
          ["Providers", `${health.providers.enabled}/${health.providers.total} enabled`],
          ["Healthy providers", health.providers.healthy],
          ["Open circuits", health.providers.circuitOpen],
        ],
      ),
    );
  }
  if (verbose) process.stderr.write(`shub: server=${client.baseUrl}\n`);
  return compatible ? EXIT_CODES.ok : EXIT_CODES.incompatible;
}
