#!/usr/bin/env node
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const message = "verify:smart is not implemented yet; T02 will provide the five-phase resource-aware runner.";

try {
  const run = await createArtifactRun({ command: "verify:smart" });
  await run.appendLog("raw/verify-smart.log", `${message}\n`);
  await run.writeJson("not-implemented.json", {
    schemaVersion: 1,
    command: "verify:smart",
    status: "not_implemented",
    exitCode: EXIT_CODES.internal,
    reason: "t02_phase_runner_pending",
  });
  await run.finish({ exitCode: EXIT_CODES.internal, reason: "not_implemented_yet" });
  console.error(message);
  process.exitCode = EXIT_CODES.internal;
} catch (error) {
  console.error(`verify:smart failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_CODES.internal;
}
