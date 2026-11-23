#!/usr/bin/env node
import { collectSnapshot, largestProcesses } from "./lib/resource/snapshot.mjs";
import { freezeBudget } from "./lib/resource/budget.mjs";
import { classifyPressure } from "./lib/resource/pressure.mjs";
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const args = process.argv.slice(2);
const allowed = new Set(["--json", "--include-processes"]);
if (args.some((arg) => !allowed.has(arg))) {
  console.error("usage: pnpm resource:doctor [--json] [--include-processes]");
  process.exitCode = EXIT_CODES.usage;
} else {
  try {
    const run = await createArtifactRun({ command: "resource:doctor" });
    const snapshot = await collectSnapshot({ includeProcesses: args.includes("--include-processes") });
    const budget = freezeBudget(snapshot);
    const pressure = classifyPressure(budget, snapshot);
    const recommendation = {
      suitableForHeavyTasks: budget.safe && pressure.level !== "stop" && pressure.level !== "danger",
      vitestWorkers: budget.vitestWorkers,
      testMemoryBudgetMiB: budget.stages.vitest.requiredMiB,
      blockedStages: budget.blockedStages,
      largestProcesses: largestProcesses(snapshot),
      action: pressure.action,
      reason: budget.reason ?? pressure.reason,
    };
    const report = { schemaVersion: 1, snapshot, frozenBudget: budget, pressure, recommendation };
    await run.writeJson("doctor.json", report);
    await run.finish({ exitCode: EXIT_CODES.success, details: report });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const mib = (value) => value === null ? "unknown" : `${(value / 1024 / 1024).toFixed(0)} MiB`;
      console.log([
        `physical=${mib(snapshot.host.physicalBytes.value)} available=${mib(snapshot.host.availableBytes.value)}`,
        `swapTotal=${mib(snapshot.host.swapTotalBytes.value)} swapFree=${mib(snapshot.host.swapFreeBytes.value)}`,
        `cgroup=${snapshot.cgroup.version} limit=${mib(snapshot.cgroup.limitBytes.value)} current=${mib(snapshot.cgroup.currentBytes.value)}`,
        `cpu=${snapshot.cpu.logicalCpus.value} utilization=${snapshot.cpu.utilizationPercent.value ?? "unknown"}%`,
        `pressure=${pressure.level} recommendedVitestWorkers=${budget.vitestWorkers} testBudget=${budget.stages.vitest.requiredMiB} MiB`,
        `suitableForHeavyTasks=${recommendation.suitableForHeavyTasks}`,
        ...recommendation.largestProcesses.map((entry) => `process pid=${entry.pid} role=${entry.role} rss=${mib(entry.rssBytes)}`),
        `artifacts=${run.rootPath}`,
      ].join("\n"));
    }
    process.exitCode = EXIT_CODES.success;
  } catch (error) {
    console.error(`resource:doctor failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_CODES.internal;
  }
}
