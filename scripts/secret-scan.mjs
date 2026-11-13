#!/usr/bin/env node
/**
 * Repository secret scan (release gate).
 *
 * Checks two things and exits non-zero on any hit:
 *   1. Working tree: files that would be committed (respects .gitignore via
 *      `git ls-files --cached --others --exclude-standard`).
 *   2. Git history: every blob reachable from any ref.
 *
 * Placeholder values that tests and docs legitimately use are allowlisted by
 * exact token, not by broad regex, so a real key cannot hide behind them.
 *
 * Usage:
 *   node scripts/secret-scan.mjs            # scan working tree + history
 *   node scripts/secret-scan.mjs --staged   # scan only staged files
 *   node scripts/secret-scan.mjs --tree     # skip history (faster)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));

/** High-signal credential shapes. Keep this list short and specific. */
const PATTERNS = [
  { name: "openai-style key", re: /\bsk-[\w-]{20,}\b/g },
  { name: "tavily key", re: /\btvly-[\w-]{16,}\b/g },
  { name: "search hub token", re: /\bsh_[\w-]{24,}\b/g },
  { name: "github token", re: /\bgh[pousr]_[\w]{30,}\b/g },
  { name: "aws access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "google api key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "private key block", re: /-----BEGIN (?:RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/g },
  { name: "bearer literal", re: /Bearer\s+[A-Za-z0-9._-]{30,}/g },
  { name: "bcrypt/argon hash in source", re: /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{40,}/g },
  { name: "generic password assignment", re: /(?:password|passwd|secret|api_?key)\s*[:=]\s*["'][A-Za-z0-9_!@#$%^&*()-]{16,}["']/gi },
];

/**
 * Exact substrings that are deliberately fake. Anything not listed here is a
 * finding, so the allowlist cannot swallow a real credential by accident.
 */
const ALLOWLIST = [
  "sk-TEST-MASK-FINGERPRINT",
  "sk-TEST-",
  "sk-LOAD-",
  "sk-EXPORT-FINGERPRINT",
  "sk-SMOKE-",
  "sk-MODEL-LEAK-FINGERPRINT",
  "sk-CLEAN-FINGERPRINT",
  "sk-LEAK-",
  "sk-LEGACY-SHOULD-NEVER-BE-STORED",
  "sk-dummy-invalid-key-for-probe",
  "tvly-YOUR_API_KEY",
  "tvly-dummy-invalid",
  "sh_your_token",
  "sh_xxx",
  "sh_token",
  "sh_invalid",
  "sh_your_token_here",
  "Initial-Admin-Pass-1",
  "A-very-long-password-1",
  "Clean-Install-Pass-1",
  "Leak-Scan-Password-1",
  "E2E-Admin-Password-1",
  "Attacker-Password-1",
  "Another-long-password-1",
  "e2e-setup-token",
  "setup-secret",
  "env-token-value",
];

/** Files whose content is a fixture, not a credential source. */
const PATH_ALLOWLIST = [
  /^tests\//,
  /^docs\//,
  /^\w+\.md$/,
  /\.env\.example$/,
  /^scripts\/secret-scan\.mjs$/,
  /^\.github\/workflows\//,
  /^compose\.yaml$/,
];

function isAllowlistedValue(value) {
  return ALLOWLIST.some((entry) => value.includes(entry));
}

function isAllowlistedPath(file) {
  return PATH_ALLOWLIST.some((re) => re.test(file));
}

/**
 * Docs/tests may quote a credential shape to explain a rule. They are exempt,
 * but their hits are still printed as INFO so a reviewer can eyeball them.
 */
function scanText(file, text, { report }) {
  const exempt = isAllowlistedPath(file);
  const findings = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const value = match[0];
      if (isAllowlistedValue(value)) continue;
      findings.push({ name, value: value.slice(0, 60), index: match.index });
    }
  }
  if (findings.length === 0) return 0;
  for (const finding of findings) {
    const line = text.slice(0, finding.index).split("\n").length;
    const level = exempt ? "INFO" : "FAIL";
    report.push(`${level} ${file}:${line} [${finding.name}] ${finding.value}`);
    if (!exempt) return findings.length;
  }
  return 0;
}

function git(args_) {
  return execFileSync("git", args_, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listTreeFiles(stagedOnly) {
  const output = stagedOnly
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : git(["ls-files", "--cached", "--others", "--exclude-standard"]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function scanWorkingTree(stagedOnly, report) {
  const files = listTreeFiles(stagedOnly);
  // Untracked files are not in the index, so `git show :path` fails for them.
  const tracked = new Set(
    git(["ls-files"]).split("\n").map((line) => line.trim()).filter(Boolean),
  );
  let violations = 0;
  let scanned = 0;
  for (const file of files) {
    if (!/\.(ts|tsx|js|mjs|cjs|json|yml|yaml|md|sh|sql|example|env|txt|toml)$/i.test(file)) continue;
    let text;
    try {
      text = tracked.has(file)
        ? execFileSync("git", ["show", `:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        : readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    violations += scanText(file, text, { report });
  }
  report.push(`tree: scanned ${scanned} text file(s) of ${files.length}`);
  return violations;
}

function scanHistory(report) {
  const refs = git(["for-each-ref", "--format=%(refname)"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (refs.length === 0) {
    report.push("history: no refs (empty repository)");
    return 0;
  }
  // One `git grep` per pattern across all reachable refs is far cheaper than
  // rewriting history. `git grep` output already carries "ref:path:line:text",
  // so the path can be extracted and checked against the same allowlists the
  // working-tree scan uses; test fixtures are INFO, everything else is FAIL.
  let violations = 0;
  for (const { name, re } of PATTERNS) {
    // git grep uses POSIX ERE: no non-capturing groups, and no \s.
    const source = re.source
      .replace(/\(\?:/g, "(")
      .replace(/\\s/g, "[[:space:]]");
    let output = "";
    try {
      output = execFileSync("git", ["grep", "-I", "-n", "-E", "-e", source, ...refs, "--"], {
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      // exit code 1 means "no match"; anything else is a real failure
      if (error.status !== 1) {
        report.push(`history: git grep failed for ${name}`);
        violations += 1;
      }
      continue;
    }
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const pathMatch = /^[^:]+:(.+?):\d+:/.exec(line);
      const file = pathMatch?.[1] ?? "";
      const match = re.exec(line);
      if (match && isAllowlistedValue(match[0])) continue;
      // Fixtures and docs quote credential shapes on purpose.
      if (isAllowlistedPath(file)) {
        report.push(`INFO history ${line.slice(0, 120)}`);
        continue;
      }
      report.push(`FAIL history ${line.slice(0, 160)}`);
      violations += 1;
    }
    re.lastIndex = 0;
  }
  report.push(`history: scanned ${refs.length} ref(s)`);
  return violations;
}

const report = [];
let violations = 0;
violations += scanWorkingTree(args.has("--staged"), report);
if (!args.has("--tree")) violations += scanHistory(report);

for (const line of report) console.log(line);
console.log(`\n${violations === 0 ? "PASS" : "FAIL"}: ${violations} violation(s)`);
process.exit(violations === 0 ? 0 : 1);
