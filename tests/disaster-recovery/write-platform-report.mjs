#!/usr/bin/env node
/** Write an aggregator-compatible report for an executed platform drill. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codeFingerprint } from "../../scripts/lib/resource-evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REQUIREMENTS = [
  ...Array.from({ length: 38 }, (_, index) => `R${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
];
const STATUSES = new Set(["PASS", "FAIL", "BLOCKED", "NOT TESTED", "NOT IMPLEMENTED"]);
const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
}
if (args.includes("--help")) {
  process.stdout.write("usage: write-platform-report.mjs --self-check\n       write-platform-report.mjs --evidence-dir <dir> --kind <kind> --verdict <PASS|FAIL|BLOCKED> [--scope <text>] (--statuses <json-object> | --statuses-file <file>) [--evidence-map <json-object> | --evidence-map-file <file>]\n");
  process.exit(0);
}
const selfCheck = args.includes("--self-check");
let selfCheckRoot = null;
if (selfCheck) {
  selfCheckRoot = mkdtempSync(path.join(tmpdir(), "sh-dr-platform-report-self-check-"));
  process.on("exit", () => { if (selfCheckRoot) rmSync(selfCheckRoot, { recursive: true, force: true }); });
  writeFileSync(path.join(selfCheckRoot, "smoke.txt"), "synthetic platform report evidence\n");
  args.push("--evidence-dir", selfCheckRoot, "--kind", "search-hub-platform-report-self-check", "--verdict", "BLOCKED", "--statuses", '{"R01":"NOT TESTED","R02":"BLOCKED"}', "--evidence-map", '{"R02":["smoke.txt"]}');
}
const evidenceDir = path.resolve(arg("evidence-dir") ?? "");
const kind = arg("kind");
const verdict = arg("verdict");
const scope = arg("scope");
const statuses = JSON.parse(arg("statuses-file") ? readFileSync(path.resolve(arg("statuses-file")), "utf8") : arg("statuses") ?? "{}");
const evidenceMap = JSON.parse(arg("evidence-map-file") ? readFileSync(path.resolve(arg("evidence-map-file")), "utf8") : arg("evidence-map") ?? "{}");
if (!evidenceDir || !kind || !STATUSES.has(verdict)) throw new Error("evidence-dir, kind and valid verdict are required");
for (const [id, status] of Object.entries(statuses)) {
  if (!REQUIREMENTS.includes(id) || !STATUSES.has(status)) throw new Error(`invalid requirement status: ${id}=${status}`);
}
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout.trim().length > 0;
const fingerprint = codeFingerprint(ROOT, commit);
const requirements = Object.fromEntries(REQUIREMENTS.map((id) => [id, "NOT TESTED"]));
const evidence = Object.fromEntries(REQUIREMENTS.map((id) => [id, []]));
for (const [id, status] of Object.entries(statuses)) {
  requirements[id] = status;
  const references = Array.isArray(evidenceMap[id]) ? evidenceMap[id] : [];
  if (status === "PASS" && references.length === 0) throw new Error(`PASS requirement ${id} needs at least one evidence path`);
  for (const reference of references) {
    if (typeof reference !== "string" || reference.includes("\\") || reference.startsWith("/") || /^[A-Za-z]:/.test(reference) || reference.split("/").includes("..") || !existsSync(path.join(evidenceDir, reference))) {
      throw new Error(`invalid evidence reference for ${id}: ${reference}`);
    }
    evidence[id].push({ path: reference });
  }
}
const report = {
  schemaVersion: 1,
  kind,
  source: { commit, releaseCodeFingerprint: fingerprint, dirty },
  verdict: dirty && verdict === "PASS" ? "BLOCKED" : verdict,
  ...(scope ? { scope } : {}),
  requirements,
  requirementEvidence: evidence,
  evidence,
  generatedAt: new Date().toISOString(),
};
if (JSON.stringify(report.requirementEvidence) !== JSON.stringify(report.evidence)) throw new Error("platform report evidence aliases disagree");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const files = [];
function walk(directory, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, relative);
    else if (entry.isFile() && entry.name !== "SHA256SUMS") files.push(relative);
  }
}
walk(evidenceDir);
const sums = files.sort().map((relative) => {
  const bytes = readFileSync(path.join(evidenceDir, relative));
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${digest}  ${relative}`;
});
writeFileSync(path.join(evidenceDir, "SHA256SUMS"), `${sums.join("\n")}\n`, { mode: 0o600 });
if (selfCheck) {
  const written = JSON.parse(readFileSync(path.join(evidenceDir, "report.json"), "utf8"));
  if (JSON.stringify(written.requirementEvidence) !== JSON.stringify(written.evidence) || written.requirements.R02 !== "BLOCKED" || !readFileSync(path.join(evidenceDir, "SHA256SUMS"), "utf8").includes("report.json")) {
    throw new Error("platform report self-check failed");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, canonical: "requirementEvidence", alias: "evidence", tempCleanedOnExit: true })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ verdict: report.verdict, report: "report.json", requirementCount: Object.keys(statuses).length, dirty })}\n`);
}
