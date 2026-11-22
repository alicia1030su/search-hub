#!/usr/bin/env node
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const message = "test:lowmem is not implemented yet; T02 will provide full-suite serial Vitest verification.";

try {
  const run = await createArtifactRun({ command: "test:lowmem" });
  await run.appendLog("raw/test-lowmem.log", `${message}\n`);
  await run.writeJson("not-implemented.json", {
    schemaVersion: 1,
    command: "test:lowmem",
    status: "not_implemented",
    exitCode: EXIT_CODES.internal,
    reason: "t02_lowmem_runner_pending",
  });
  await run.finish({ exitCode: EXIT_CODES.internal, reason: "not_implemented_yet" });
  console.error(message);
  process.exitCode = EXIT_CODES.internal;
} catch (error) {
  console.error(`test:lowmem failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_CODES.internal;
}
