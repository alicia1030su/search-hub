#!/usr/bin/env node
/** Builds a standalone shub executable (Node SEA) or a Node 22 portable package. */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "./zip.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env["PACKAGE_TARGET"] ?? (process.platform === "win32" ? "windows-x64" : "linux-x64");
const VERSION = (process.env["SEARCH_HUB_VERSION"]?.trim() || JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version).replace(/^v/, "");
const OUT = join(REPO, "dist", "cli", TARGET);
const IS_WINDOWS = TARGET.startsWith("windows");
const IS_PORTABLE = TARGET === "node22";
const SEA_TARGETS = new Set(["windows-x64", "linux-x64", "linux-arm64"]);

if (!SEA_TARGETS.has(TARGET) && !IS_PORTABLE) throw new Error(`Unsupported CLI target: ${TARGET}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const bundle = join(REPO, "packages", "cli", "dist", "index.cjs");
if (!existsSync(bundle)) {
  execFileSync(process.execPath, [join(REPO, "packaging", "bundle-cli.mjs")], { cwd: REPO, stdio: "inherit" });
}

if (IS_PORTABLE) {
  mkdirSync(join(OUT, "bin"), { recursive: true });
  cpSync(join(REPO, "packages", "cli", "dist", "index.mjs"), join(OUT, "bin", "shub.mjs"));
  writeFileSync(join(OUT, "bin", "shub.cmd"), "@echo off\r\nnode \"%~dp0shub.mjs\" %*\r\n", "utf8");
  writeFileSync(join(OUT, "bin", "shub"), "#!/bin/sh\nexec node \"$(dirname \"$0\")/shub.mjs\" \"$@\"\n", "utf8");
  chmodSync(join(OUT, "bin", "shub"), 0o755);
  writeFileSync(join(OUT, "package.json"), `${JSON.stringify({ name: "shub-portable", version: VERSION, private: true, type: "module", bin: { shub: "bin/shub.mjs" } }, null, 2)}\n`, "utf8");
} else {
  const nodeBinary = process.env["PACKAGE_NODE_BIN"] || process.execPath;
  if (!existsSync(nodeBinary)) throw new Error(`Target Node runtime not found: ${nodeBinary}`);
  const work = join(REPO, "dist", "cli");
  mkdirSync(work, { recursive: true });
  const seaConfig = join(work, "sea-config.json");
  const blob = join(work, "shub.blob");
  writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2), "utf8");
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { cwd: REPO, stdio: "inherit" });
  const executable = join(OUT, IS_WINDOWS ? "shub.exe" : "shub");
  copyFileSync(nodeBinary, executable);
  const postject = join(REPO, "node_modules", "postject", "dist", "cli.js");
  if (!existsSync(postject)) throw new Error("postject is required to build a real standalone CLI");
  execFileSync(process.execPath, [postject, executable, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { cwd: REPO, stdio: "inherit" });
  if (!IS_WINDOWS) chmodSync(executable, 0o755);
}

writeFileSync(join(OUT, IS_WINDOWS ? "README.txt" : "README.md"), readme(TARGET, VERSION), "utf8");
const archive = `shub-v${VERSION}-${TARGET}.${IS_WINDOWS ? "zip" : "tar.gz"}`;
const archivePath = join(REPO, "dist", "cli", archive);
if (IS_WINDOWS) writeZip(OUT, archivePath);
else execFileSync("tar", ["-czf", relative(REPO, archivePath).split("\\").join("/"), "-C", OUT, "."], { cwd: REPO, stdio: "inherit" });
writeFileSync(`${archivePath}.sha256`, `${sha256(archivePath)}  ${archive}\n`, "utf8");
process.stdout.write(`Built ${archive}\n`);

function readme(target, version) {
  if (target === "node22") {
    return `# shub ${version} (Node.js 22+ portable)\n\nRequires Node.js 22 or newer. Run bin/shub.mjs with node, or use bin/shub (POSIX) / bin/shub.cmd (Windows).\n\nSet SEARCH_HUB_URL and SEARCH_HUB_TOKEN, then run:\n  shub status\n  shub search "Linux"\n`;
  }
  return `# shub ${version} (${target})\n\nStandalone Search Hub CLI. No Node.js installation is required.\n\n${IS_WINDOWS ? ".\\shub.exe" : "./shub"} --version\n${IS_WINDOWS ? ".\\shub.exe" : "./shub"} status\n${IS_WINDOWS ? ".\\shub.exe" : "./shub"} search "Linux" --json\n\nSet SEARCH_HUB_URL and SEARCH_HUB_TOKEN. Tokens are never written to disk by shub.\n`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
