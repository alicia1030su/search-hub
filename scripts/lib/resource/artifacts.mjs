import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_VERSION = "v0.1.14";
export const EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  resourceBlocked: 3,
  childFailed: 4,
  internal: 5,
});

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Map a process/tool exit code to the stable v0.1.14 exit contract.
 * @param {number} exitCode
 * @returns {Exclude<import("./types.mjs").RunStatus, "running">}
 */
export function statusForExitCode(exitCode) {
  if (exitCode === EXIT_CODES.success) return "success";
  if (exitCode === EXIT_CODES.usage) return "usage";
  if (exitCode === EXIT_CODES.resourceBlocked) return "resource_blocked";
  if (exitCode === EXIT_CODES.childFailed) return "child_failed";
  return "internal";
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new TypeError("Artifact path must be a non-empty relative path");
  }
  if (path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes("\0")) {
    throw new TypeError("Artifact path must be a normalized relative path");
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError("Artifact path must stay inside its run directory");
  }
  return normalized;
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Artifact JSON must be serializable");
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${serialized}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function createRunId(now) {
  const timestamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create an isolated evidence run. Each invocation must use a new run ID; stage
 * logs are caller-sanitized and summary writes are atomic.
 *
 * @param {{command: string, repoRoot?: string, now?: Date}} [options]
 * @returns {Promise<ArtifactRun>}
 */
export async function createArtifactRun(options = {}) {
  const command = options.command ?? "resource-tool";
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const now = options.now ?? new Date();
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new TypeError("Artifact command must be a non-empty logical name");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Artifact run time must be a valid Date");
  }

  const runId = createRunId(now);
  const rootPath = path.join(repoRoot, "artifacts", ARTIFACT_VERSION, runId);
  const summaryPath = path.join(rootPath, "summary.json");
  const rawPath = path.join(rootPath, "raw");
  await mkdir(rawPath, { recursive: true, mode: 0o700 });

  /** @type {import("./types.mjs").Artifact} */
  const artifact = {
    schemaVersion: 1,
    runId,
    command,
    rootPath,
    summaryPath,
    logPaths: [],
    createdAt: now.toISOString(),
    status: "running",
    exitCode: null,
  };
  /** @type {{schemaVersion: number, runId: string, command: string, startedAt: string, finishedAt: string|null, status: import("./types.mjs").RunStatus, exitCode: number|null, stages: import("./types.mjs").StageResult[], logs: string[]}} */
  let summary = {
    schemaVersion: 1,
    runId,
    command,
    startedAt: artifact.createdAt,
    finishedAt: null,
    status: "running",
    exitCode: null,
    stages: [],
    logs: [],
  };

  return {
    artifact,
    get rootPath() {
      return rootPath;
    },
    get summaryPath() {
      return summaryPath;
    },
    /**
     * Atomically write a JSON value inside this run.
     * @param {string} name Relative JSON file name.
     * @param {unknown} value JSON-serializable evidence value.
     */
    async writeJson(name, value) {
      const relativePath = assertSafeRelativePath(name);
      const filePath = path.join(rootPath, relativePath);
      await atomicWriteJson(filePath, value);
      return filePath;
    },
    /**
     * Append a caller-sanitized UTF-8 stage log and record its path.
     * @param {string} name Relative log name, normally under raw/.
     * @param {string} content Sanitized log text; never pass argv/env/secrets.
     */
    async appendLog(name, content) {
      const relativePath = assertSafeRelativePath(name);
      const filePath = path.join(rootPath, relativePath);
      if (typeof content !== "string") {
        throw new TypeError("Artifact log content must be a string");
      }
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "a" });
      if (!summary.logs.includes(relativePath)) {
        summary.logs.push(relativePath);
        artifact.logPaths.push(relativePath);
      }
      return filePath;
    },
    /**
     * Persist the terminal summary. Repeated calls are rejected so an early
     * success cannot silently overwrite a later failure.
     * @param {{exitCode: number, stages?: import("./types.mjs").StageResult[], reason?: string, now?: Date}} result
     */
    async finish(result) {
      if (summary.finishedAt !== null) {
        throw new Error("Artifact run is already finished");
      }
      if (!Number.isInteger(result?.exitCode)) {
        throw new TypeError("Artifact finish requires an integer exitCode");
      }
      const finishedAt = (result.now ?? new Date()).toISOString();
      const status = statusForExitCode(result.exitCode);
      summary = {
        ...summary,
        finishedAt,
        status,
        exitCode: result.exitCode,
        stages: result.stages ?? [],
        ...(result.reason ? { reason: result.reason } : {}),
      };
      artifact.status = status;
      artifact.exitCode = result.exitCode;
      await atomicWriteJson(summaryPath, summary);
      return summary;
    },
  };
}

/** @typedef {ReturnType<typeof createArtifactRun> extends Promise<infer T> ? T : never} ArtifactRun */
