#!/usr/bin/env node
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { RESOURCE_RUNTIME_ARTIFACT } from "../packaging/release-evidence.mjs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function stageResourceEvidence({ repoRoot = REPO_ROOT, evidenceDir, runtimePath, doctorPath, disasterRecoveryDir, outputDir }) {
  if (!evidenceDir || !runtimePath || !doctorPath || !outputDir) throw new Error("evidence-dir/runtime/doctor/output are required");
  const resolvedOutput = path.resolve(outputDir);
  for (const source of [repoRoot, evidenceDir, runtimePath, doctorPath, disasterRecoveryDir].filter(Boolean)) {
    const resolvedSource = path.resolve(source);
    if (resolvedOutput === resolvedSource || resolvedSource.startsWith(`${resolvedOutput}${path.sep}`)) throw new Error("stage_output_would_remove_source");
  }
  rmSync(resolvedOutput, { recursive: true, force: true });
  mkdirSync(path.join(outputDir, "raw"), { recursive: true });
  cpSync(runtimePath, path.join(outputDir, RESOURCE_RUNTIME_ARTIFACT));
  cpSync(doctorPath, path.join(outputDir, "resource-doctor.json"));
  cpSync(path.join(evidenceDir, "cache-benchmark-summary.json"), path.join(outputDir, "cache-benchmark-summary.json"));
  cpSync(path.join(evidenceDir, "SHA256SUMS"), path.join(outputDir, "SHA256SUMS"));
  const rawFiles = readdirSync(path.join(evidenceDir, "raw")).filter((name) => name.endsWith(".json.gz")).sort();
  if (rawFiles.length !== 8) throw new Error(`expected 8 raw evidence files, got ${rawFiles.length}`);
  for (const name of rawFiles) cpSync(path.join(evidenceDir, "raw", name), path.join(outputDir, "raw", name));
  const files = [RESOURCE_RUNTIME_ARTIFACT, "resource-doctor.json", "cache-benchmark-summary.json", "SHA256SUMS", ...rawFiles.map((name) => `raw/${name}`)];
  if (disasterRecoveryDir) {
    cpSync(disasterRecoveryDir, path.join(outputDir, "disaster-recovery"));
    files.push("disaster-recovery");
  }
  return files;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const files = stageResourceEvidence({
    evidenceDir: arg("evidence-dir", path.join(REPO_ROOT, "docs", "evidence", "v0.1.14")),
    runtimePath: arg("runtime", path.join(REPO_ROOT, "artifacts", RESOURCE_RUNTIME_ARTIFACT)),
    doctorPath: arg("doctor", path.join(REPO_ROOT, "artifacts", "resource-doctor.json")),
    disasterRecoveryDir: arg("dr-dir"),
    outputDir: arg("output", path.join(REPO_ROOT, "resource-evidence-artifact")),
  });
  console.log(JSON.stringify({ outputDir: arg("output", path.join(REPO_ROOT, "resource-evidence-artifact")), files }, null, 2));
}
