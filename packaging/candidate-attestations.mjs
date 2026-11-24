#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function subjects(manifest, manifestPath, directory) {
  const files = manifest.assets.map((asset) => ({ file: path.join(directory, asset.name), digest: asset.sha256, bundle: asset.attestation.bundle, name: asset.name }));
  const manifestDigest = digest(readFileSync(manifestPath));
  files.push({ file: manifestPath, digest: manifestDigest, bundle: `sha256-${manifestDigest}.jsonl`, name: "candidate-manifest.json" });
  files.push({ file: `oci://${manifest.image.reference}`, digest: manifest.image.digest.slice(7), bundle: manifest.image.attestation.bundle, name: manifest.image.reference });
  return files;
}

function downloadOne(subject, output, repo) {
  if (existsSync(output) && statSync(output).size > 0) return;
  const temporary = mkdtempSync(path.join(tmpdir(), "search-hub-attestation-"));
  try {
    gh(["attestation", "download", subject.file, "--repo", repo, "--limit", "100"], { cwd: temporary });
    const bundles = readdirSync(temporary).filter((name) => name.endsWith(".jsonl"));
    if (bundles.length === 0) throw new Error(`attestation_download_count:${subject.name}/0`);
    // A reproducible subject (notably resource-evidence.json) may have bundles
    // from several candidate runs. gh accepts a JSON-lines file of bundles.
    const payload = bundles.map((name) => {
      const bytes = readFileSync(path.join(temporary, name));
      return bytes.at(-1) === 10 ? bytes : Buffer.concat([bytes, Buffer.from("\n")]);
    });
    writeFileSync(output, Buffer.concat(payload));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyOne(subject, output, { repo, sourceSha, signerWorkflow, reportPath }) {
  const result = gh([
    "attestation", "verify", subject.file,
    "--repo", repo,
    "--bundle", output,
    "--signer-workflow", signerWorkflow,
    "--source-digest", sourceSha,
    "--format", "json",
  ]);
  const parsed = JSON.parse(result);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`attestation_verification_empty:${subject.name}`);
  writeFileSync(reportPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "download" && mode !== "verify") throw new Error("usage: candidate-attestations.mjs download|verify");
  const manifestPath = path.resolve(arg("manifest"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const directory = path.resolve(arg("dir"));
  const bundleDirectory = path.resolve(arg("attestations"));
  const reportDirectory = path.resolve(arg("reports", path.join(bundleDirectory, "verification")));
  const repo = arg("repo", process.env.GITHUB_REPOSITORY);
  const sourceSha = arg("source-sha");
  const signerWorkflow = arg("signer-workflow", manifest.attestationPolicy?.signerWorkflow);
  if (!repo || !/^[0-9a-f]{40}$/.test(sourceSha ?? "")) throw new Error("--repo and full --source-sha are required");
  if (repo !== manifest.attestationPolicy?.repository || sourceSha !== manifest.sourceSha || signerWorkflow !== manifest.attestationPolicy?.signerWorkflow) {
    throw new Error("attestation_policy_binding_mismatch");
  }
  mkdirSync(bundleDirectory, { recursive: true });
  mkdirSync(reportDirectory, { recursive: true });
  for (const subject of subjects(manifest, manifestPath, directory)) {
    const bundle = path.join(bundleDirectory, subject.bundle);
    if (mode === "download") downloadOne(subject, bundle, repo);
    else {
      if (!existsSync(bundle) || statSync(bundle).size === 0) throw new Error(`attestation_bundle_missing:${subject.name}`);
      verifyOne(subject, bundle, { repo, sourceSha, signerWorkflow, reportPath: path.join(reportDirectory, `${subject.bundle}.json`) });
    }
    console.log(`${mode}: ${subject.name}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`candidate attestation ${process.argv[2] ?? "operation"} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
