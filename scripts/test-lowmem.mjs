#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { collectSnapshot } from "./lib/resource/snapshot.mjs";
import { runChildAttempt, pnpmInvocation } from "./lib/resource/child-runner.mjs";
import { normalizeList, compareLowmem } from "./lib/resource/lowmem.mjs";
import { sanitizeLog } from "./lib/resource/report.mjs";
import { OwnedProcessTree, adapter } from "./lib/resource/process-tree.mjs";
import { createArtifactRun, EXIT_CODES } from "./lib/resource/artifacts.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function captureList(run) {
  const listPath = `${run.rootPath}/vitest-list.json`;
  const invocation = pnpmInvocation(["vitest", "list", `--json=${listPath}`]);
  const child = spawn(invocation.command, invocation.args, { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform === "win32" });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const outcomePromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 5, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code: code ?? (signal === "SIGKILL" ? 137 : 1), signal, error: null }));
  });
  const io = adapter(process.platform);
  const root = child.pid && child.exitCode === null ? await io.readProcess(child.pid) : null;
  const tree = child.pid && root ? new OwnedProcessTree(child.pid, root.identity.startTime, { io, termGraceMs: 5_000, consoleCtrlOwned: process.platform === "win32" }) : null;
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
  try {
    const outcome = await outcomePromise;
    const cleanup = tree ? await tree.cleanup() : { ok: !child.pid || child.exitCode !== null, residuals: child.pid && child.exitCode === null ? [{ pid: child.pid }] : [], errors: [] };
    if (outcome.error || outcome.code !== 0 || !cleanup.ok) {
      const error = new Error(`vitest_list_failed:${outcome.code}`);
      error.exitCode = EXIT_CODES.childFailed;
      throw error;
    }
    let value;
    try {
      value = JSON.parse(await readFile(listPath, "utf8"));
    } catch {
      value = JSON.parse(stdout);
    }
    const tests = normalizeList(value);
    if (tests.length === 0) throw new Error("vitest_list_empty");
    await run.appendLog("raw/vitest-list.log", sanitizeLog(stdout + stderr));
    return { tests, cleanup };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGTERM");
    if (tree) await tree.cleanup();
  }
}

if (process.argv.length > 2) {
  console.error("usage: pnpm test:lowmem");
  process.exitCode = EXIT_CODES.usage;
} else {
  let run = null;
  try {
    run = await createArtifactRun({ command: "test:lowmem" });
    await collectSnapshot();
    const listed = await captureList(run);
    const attempt = await runChildAttempt({ stage: "vitest", workers: 1, attempt: 1, cwd: repoRoot, artifactRun: run });
    const resultPath = `${run.rootPath}/vitest-result-attempt-1.json`;
    let result = { testResults: [] };
    try {
      result = JSON.parse(await readFile(resultPath, "utf8"));
    } catch (error) {
      if (attempt.exitCode === 0) throw error;
    }
    const comparison = compareLowmem(listed.tests, result, { listCleanup: listed.cleanup, runCleanup: attempt.cleanup, runExitCode: attempt.exitCode });
    const { missing, unexpected, nonPassed: skipped } = comparison;
    await run.writeJson("lowmem-comparison.json", comparison);
    const exitCode = comparison.passed ? EXIT_CODES.success : listed.cleanup.ok && attempt.cleanup.ok ? EXIT_CODES.childFailed : EXIT_CODES.internal;
    await run.finish({ exitCode, reason: comparison.passed ? null : "lowmem_suite_mismatch_or_failure", details: { comparison } });
    console.log(`test:lowmem ${comparison.passed ? "PASS" : "FAIL"} expected=${comparison.expectedCount} actual=${comparison.actualCount} missing=${missing.length} unexpected=${unexpected.length} nonPassed=${skipped.length}`);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`test:lowmem failed: ${error instanceof Error ? error.message : String(error)}`);
    if (run) {
      try {
        await run.finish({ exitCode: error?.exitCode ?? EXIT_CODES.internal, reason: "lowmem_internal" });
      } catch {
        // Keep the original diagnostic.
      }
    }
    process.exitCode = error?.exitCode ?? EXIT_CODES.internal;
  }
}
