#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPublicEvidence, codeFingerprint, sha256 } from "../scripts/lib/resource-evidence.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIREMENTS = Object.freeze([
  ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
]);
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT IMPLEMENTED"]);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") &&
    !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && !value.split("/").includes("..");
}

function parseSums(text) {
  const entries = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    check(Boolean(match), `invalid_dr_sha256_line:${line}`);
    const [, digest, name] = match;
    check(safeRelative(name) && !entries.has(name), `unsafe_or_duplicate_dr_sum:${name}`);
    entries.set(name, digest);
  }
  return entries;
}

function listFiles(root) {
  const files = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const directory = path.join(root, relativeDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`dr_evidence_symlink:${relativePath}`);
      if (relativePath === "SHA256SUMS") continue;
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`dr_evidence_non_file:${relativePath}`);
    }
  }
  return files.sort();
}

function evidenceReferences(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.map((entry) => typeof entry === "string" ? { path: entry } : entry);
}

export function verifyDisasterRecoveryEvidence({ repoRoot = REPO_ROOT, commit, evidenceDir = path.join(repoRoot, "docs", "evidence", "v0.1.15", "disaster-recovery"), requireAllPass = true }) {
  check(/^[0-9a-f]{40}$/.test(commit ?? ""), "dr_commit_invalid");
  const gatePath = path.join(evidenceDir, "gate.json");
  const sumsPath = path.join(evidenceDir, "SHA256SUMS");
  check(existsSync(gatePath), "dr_gate_missing");
  check(existsSync(sumsPath), "dr_sums_missing");
  const gateBytes = readFileSync(gatePath);
  const gate = JSON.parse(gateBytes.toString("utf8"));
  assertPublicEvidence(gate);
  check(gate.schemaVersion === 1, "dr_gate_schema_unsupported");
  check(gate.suite === "search-hub-disaster-recovery-v0.1.15", "dr_gate_suite_mismatch");
  check(gate.releaseCommit === commit, "dr_gate_commit_mismatch");
  check(gate.releaseCodeFingerprint === codeFingerprint(repoRoot, commit), "dr_gate_code_fingerprint_mismatch");
  check(STATUSES.has(gate.verdict), "dr_gate_verdict_invalid");
  if (gate.source) check(gate.source.dirty === false, "dr_gate_dirty_source");

  const requirements = gate.requirements;
  check(requirements && typeof requirements === "object" && !Array.isArray(requirements), "dr_requirements_missing");
  check(JSON.stringify(Object.keys(requirements).sort()) === JSON.stringify([...REQUIREMENTS].sort()), "dr_requirement_set_mismatch");
  for (const id of REQUIREMENTS) check(STATUSES.has(requirements[id]), `dr_requirement_status_invalid:${id}=${requirements[id]}`);
  const values = REQUIREMENTS.map((id) => requirements[id]);
  const expectedVerdict = values.includes("FAIL") ? "FAIL" : values.every((status) => status === "PASS") ? "PASS" : "BLOCKED";
  check(gate.verdict === expectedVerdict, "dr_gate_verdict_mismatch");
  if (requireAllPass) {
    check(gate.verdict === "PASS", "dr_gate_not_pass");
    for (const id of REQUIREMENTS) check(requirements[id] === "PASS", `dr_requirement_not_pass:${id}=${requirements[id]}`);
  }

  const sums = parseSums(readFileSync(sumsPath, "utf8"));
  const files = listFiles(evidenceDir);
  check(JSON.stringify([...sums.keys()].sort()) === JSON.stringify(files), "dr_evidence_file_set_mismatch");
  for (const name of files) {
    const filePath = path.join(evidenceDir, name);
    check(lstatSync(filePath).isFile() && !lstatSync(filePath).isSymbolicLink(), `dr_evidence_non_regular:${name}`);
    check(sha256(readFileSync(filePath)) === sums.get(name), `dr_evidence_sha256_mismatch:${name}`);
  }
  const evidence = gate.evidence;
  check(evidence && typeof evidence === "object" && !Array.isArray(evidence), "dr_requirement_evidence_missing");
  for (const id of REQUIREMENTS) {
    const references = evidenceReferences(evidence[id]);
    if (requirements[id] === "PASS") check(references.length > 0, `dr_requirement_evidence_empty:${id}`);
    for (const reference of references) {
      check(reference && safeRelative(reference.path) && sums.has(reference.path), `dr_requirement_evidence_unlisted:${id}/${reference?.path}`);
      if (reference.sha256 !== undefined) check(reference.sha256 === sums.get(reference.path), `dr_requirement_evidence_digest_mismatch:${id}/${reference.path}`);
    }
  }
  return {
    ok: true,
    releaseCommit: commit,
    releaseCodeFingerprint: gate.releaseCodeFingerprint,
    verdict: gate.verdict,
    requirementCount: REQUIREMENTS.length,
    evidenceFileCount: files.length,
    gateSha256: sha256(gateBytes),
    sumsSha256: sha256(readFileSync(sumsPath)),
  };
}

async function main() {
  const commit = arg("commit");
  if (!commit) throw new Error("--commit is required");
  const evidenceDir = arg("evidence-dir", path.join(REPO_ROOT, "docs", "evidence", "v0.1.15", "disaster-recovery"));
  const result = verifyDisasterRecoveryEvidence({ commit, evidenceDir });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`disaster recovery evidence verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
