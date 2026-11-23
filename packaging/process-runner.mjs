import { spawn } from "node:child_process";
import { OwnedProcessTree, adapter } from "../scripts/lib/resource/process-tree.mjs";

/**
 * Run a packaging child with PID/start-time ownership tracking and finally
 * cleanup. Nonzero exits are returned so callers can preserve the real code.
 * Reports contain only the command and argument count, never argv or env.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean, stdio?: string, termGraceMs?: number}} [options]
 */
export async function runOwnedProcess(command, args, options = {}) {
  const platform = process.platform;
  const io = adapter(platform);
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
    detached: platform === "win32",
  });
  let tree = null;
  let aborted = false;
  let outcomePromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  const abort = () => {
    aborted = true;
    if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    if (child.pid && child.exitCode === null) {
      const root = await io.readProcess(child.pid);
      if (root) {
        tree = new OwnedProcessTree(child.pid, root.identity.startTime, { platform, io, termGraceMs: options.termGraceMs, consoleCtrlOwned: platform === "win32" });
      } else if (child.exitCode === null) {
        child.kill("SIGTERM");
        throw new Error("packaging_root_identity_unavailable");
      }
    }
    const outcome = await outcomePromise;
    if (outcome.error) throw outcome.error;
    const cleanup = tree ? await tree.cleanup() : { ok: true, residuals: [], errors: [] };
    return {
      exitCode: aborted ? 143 : outcome.code ?? (outcome.signal === "SIGKILL" ? 137 : 1),
      signal: outcome.signal,
      cleanup,
      command,
      argumentCount: args.length,
    };
  } catch (error) {
    let cleanup = { ok: true, residuals: [], errors: [] };
    if (tree) {
      cleanup = await tree.cleanup();
    } else if (child.pid && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([outcomePromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.race([outcomePromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if (child.exitCode === null) {
        cleanup = { ok: false, residuals: [{ pid: child.pid, ppid: process.pid, startTime: "unknown", owned: true, role: "unknown" }], errors: [] };
      }
    }
    return { exitCode: 5, signal: null, cleanup, error: error instanceof Error ? error.message : String(error), command, argumentCount: args.length };
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

/** Run an owned process and throw on failure while retaining cleanup evidence. */
export async function execOwnedProcess(command, args, options = {}) {
  const result = await runOwnedProcess(command, args, options);
  if (result.exitCode !== 0 || !result.cleanup.ok) {
    const error = new Error(`owned_process_failed:${result.exitCode}:${result.error ?? result.cleanup.residuals.length}`);
    error.result = result;
    throw error;
  }
  return result;
}
