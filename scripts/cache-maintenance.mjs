#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createCachePlan } from "./lib/cache-cli/plan.mjs";
import { applyCachePlan, readCachePlan } from "./lib/cache-cli/prune.mjs";
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(args) {
  const command = args[0] === "prune" ? "prune" : args[0] === "inspect" ? "inspect" : null;
  if (!command) throw new Error("usage: cache-maintenance.mjs inspect|prune --dry-run");
  const options = { command, repoRoot, dryRun: false, json: false, authorizeDelete: false };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--authorize-delete") options.authorizeDelete = true;
    else if (arg === "--vitest-cache") options.vitestCacheDir = args[++index];
    else if (arg === "--esbuild-cache") options.esbuildCacheDir = args[++index];
    else if (arg === "--plan") options.planPath = args[++index];
    else if (arg === "--confirm") options.confirmPlanId = args[++index];
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (command === "prune" && !options.dryRun && !options.planPath) throw new Error("prune_requires_dry_run_or_plan");
  return options;
}

async function confirmPhrase(planId) {
  if (!process.stdin.isTTY) throw new Error("interactive_confirmation_required");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Type DELETE ${planId} to authorize: `);
    if (answer !== `DELETE ${planId}`) throw new Error("confirmation_phrase_mismatch");
  } finally {
    rl.close();
  }
}

let parsed = false;
try {
  const options = parseArgs(process.argv.slice(2));
  parsed = true;
  const run = await createArtifactRun({ command: options.command === "prune" ? "cache:prune" : "cache:inspect" });
  if (options.command === "inspect" || options.dryRun) {
    const plan = await createCachePlan(options);
    const output = { ...plan, planPath: `${run.rootPath}/cache-plan.json`, artifactId: run.artifact.runId, deleted: [], dryRun: options.command === "prune" };
    await run.writeJson("cache-plan.json", plan);
    await run.finish({ exitCode: EXIT_CODES.success, details: output });
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = EXIT_CODES.success;
  } else {
    const plan = await readCachePlan(options.planPath);
    if (options.confirmPlanId !== plan.planId || !options.authorizeDelete) throw new Error("delete_authorization_missing");
    if (process.stdin.isTTY) await confirmPhrase(plan.planId);
    const result = await applyCachePlan(plan, { ...options, confirmPlanId: options.confirmPlanId, authorizeDelete: true });
    await run.writeJson("cache-prune-result.json", result);
    await run.finish({ exitCode: result.ok ? EXIT_CODES.success : EXIT_CODES.internal, reason: result.ok ? null : "cache_prune_partial_failure", details: result });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? EXIT_CODES.success : EXIT_CODES.internal;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cache maintenance failed: ${message}`);
  const usageFailure = !parsed || /usage|unknown_argument|requires|authorization|confirmation|expired|drift|invalid_plan/i.test(message);
  process.exitCode = usageFailure ? EXIT_CODES.usage : EXIT_CODES.internal;
}
