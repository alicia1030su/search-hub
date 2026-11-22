#!/usr/bin/env node
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const message = "cache maintenance is not implemented yet; T02 will provide allowlisted inspect/dry-run/authorized prune.";

try {
  const run = await createArtifactRun({ command: "cache:maintenance" });
  await run.appendLog("raw/cache-maintenance.log", `${message}\n`);
  await run.writeJson("not-implemented.json", {
    schemaVersion: 1,
    command: "cache:maintenance",
    status: "not_implemented",
    exitCode: EXIT_CODES.internal,
    reason: "t02_cache_cli_pending",
    deleted: [],
  });
  await run.finish({ exitCode: EXIT_CODES.internal, reason: "not_implemented_yet" });
  console.error(message);
  process.exitCode = EXIT_CODES.internal;
} catch (error) {
  console.error(`cache maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_CODES.internal;
}
