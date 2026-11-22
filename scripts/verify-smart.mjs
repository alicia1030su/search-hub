#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "./lib/resource/snapshot.mjs";
import { freezeBudget } from "./lib/resource/budget.mjs";
import { PhaseRunner } from "./lib/resource/phase-runner.mjs";
import { printReportSummary } from "./lib/resource/report.mjs";
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length > 2) {
  console.error("usage: pnpm verify:smart");
  process.exitCode = EXIT_CODES.usage;
} else {
  let run = null;
  let runner = null;
  try {
    run = await createArtifactRun({ command: "verify:smart" });
    const snapshot = await collectSnapshot();
    const budget = freezeBudget(snapshot);
    runner = new PhaseRunner({ repoRoot, artifactRun: run, snapshot, budget });
    const report = await runner.run();
    await run.writeJson("report.json", report);
    await run.writeJson("residual-processes.json", report.residuals);
    await run.finish({ exitCode: report.exitCode, stages: report.stages, reason: report.reason, details: { snapshot, frozenBudget: budget, pressure: report.stages[0]?.pressure ?? null, oomRetries: report.oomRetries, residuals: report.residuals } });
    printReportSummary(report, run.rootPath);
    process.exitCode = report.exitCode;
  } catch (error) {
    console.error(`verify:smart failed: ${error instanceof Error ? error.message : String(error)}`);
    if (run) {
      try {
        await run.writeJson("residual-processes.json", runner?.residuals ?? []);
        await run.finish({ exitCode: EXIT_CODES.internal, stages: runner?.stages ?? [], reason: "verify_smart_internal", details: { residuals: runner?.residuals ?? [] } });
      } catch {
        // Preserve the original failure; artifact failure is reported above.
      }
    }
    process.exitCode = EXIT_CODES.internal;
  } finally {
    await runner?.cleanup();
  }
}
