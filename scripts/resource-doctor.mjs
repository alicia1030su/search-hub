#!/usr/bin/env node
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const message = "resource:doctor is not implemented yet; T02 will provide the read-only resource collector.";

try {
  const run = await createArtifactRun({ command: "resource:doctor" });
  await run.appendLog("raw/resource-doctor.log", `${message}\n`);
  await run.writeJson("not-implemented.json", {
    schemaVersion: 1,
    command: "resource:doctor",
    status: "not_implemented",
    exitCode: EXIT_CODES.internal,
    reason: "t02_resource_collector_pending",
  });
  await run.finish({ exitCode: EXIT_CODES.internal, reason: "not_implemented_yet" });
  console.error(message);
  process.exitCode = EXIT_CODES.internal;
} catch (error) {
  console.error(`resource:doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_CODES.internal;
}
