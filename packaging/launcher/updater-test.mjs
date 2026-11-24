#!/usr/bin/env node
/**
 * End-to-end update test, using real files and a real launcher.
 *
 * Nothing is mocked: the updater is spawned as its own process, the launcher
 * starts a stub server, the archive is a real .zip/.tar.gz, and the health probe
 * is a real HTTP call. That is the only way to know the swap and rollback work.
 *
 * Cases:
 *  1. a healthy package installs, the server answers and the version marker moves
 *  2. a package whose server never becomes healthy is rolled back
 *  3. a tampered package is refused before anything is touched
 *  4. a downgrade is refused
 *  5. a wrong-architecture asset is refused
 *  6. the pre-update data (database + master key) is preserved across an update
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "../zip.mjs";
import { updateWorkRoot } from "./updater-config.mjs";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const BASE_PORT = Number(process.env["UPDATER_TEST_PORT"] ?? 8871);

let port = BASE_PORT;
const nextPort = () => (port += 1);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

/** A server that either answers /api/health or refuses to. */
function stubServer(mode) {
  if (mode === "broken") {
    return `import { createServer } from "node:http";
const server = createServer((req, res) => { res.writeHead(503); res.end("nope"); });
server.listen(Number(process.env.SEARCH_HUB_PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;
  }
  return `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    let version = "unknown";
    try { version = readFileSync(new URL("./version.txt", import.meta.url), "utf8").trim(); } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(Number(process.env.SEARCH_HUB_PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;
}

function fixtureDatabase(path, userVersion = 3) {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO fixture(value) VALUES ('preserved');");
    db.exec(`PRAGMA user_version = ${userVersion}`);
  } finally {
    db.close();
  }
}

function fixtureValue(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM fixture").get()?.value ?? null;
  } finally {
    db.close();
  }
}

function makeInstallRoot(currentVersion) {
  const root = mkdtempSync(join(tmpdir(), "search-hub-update-e2e-"));
  mkdirSync(join(root, "app", "apps", "api", "dist"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "launcher.json"), JSON.stringify({ defaultPort: port }), "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "search-hub", version: currentVersion }), "utf8");
  writeFileSync(join(root, "app", "apps", "api", "dist", "server.mjs"), stubServer("healthy"), "utf8");
  writeFileSync(join(root, "app", "apps", "api", "dist", "version.txt"), `${currentVersion}\n`, "utf8");
  fixtureDatabase(join(root, "data", "search-hub.db"), 3);
  writeFileSync(join(root, "data", "master.key"), "PRE-EXISTING-KEY", "utf8");
  // The real launcher, so the update goes through the same process management the
  // user's install uses.
  writeFileSync(join(root, "launcher.mjs"), readFileSync(join(HERE, "launcher.mjs")), "utf8");
  return root;
}

/** Builds a release archive whose program tree is `app/...`. */
function makePackage({ version, mode }) {
  const stage = mkdtempSync(join(tmpdir(), "search-hub-update-pkg-"));
  mkdirSync(join(stage, "app", "apps", "api", "dist"), { recursive: true });
  writeFileSync(join(stage, "app", "apps", "api", "dist", "server.mjs"), stubServer(mode), "utf8");
  writeFileSync(join(stage, "app", "apps", "api", "dist", "version.txt"), `${version}\n`, "utf8");

  const os = process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch;
  const name = `search-hub-v${version}-${os}-${arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const out = join(stage, name);
  if (process.platform === "win32") {
    // GNU tar treats an absolute "C:..." path as a remote host, and Windows has
    // no `zip` binary; the repo's own writer produces a real zip.
    writeZip(join(stage, "app"), out);
  } else {
    execFileSync("tar", ["-czf", out, "-C", stage, "app"], { stdio: "inherit" });
  }
  const bytes = readFileSync(out);
  return {
    path: out,
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

function runUpdater(root, pkg, overrides = {}) {
  const args = [
    join(HERE, "updater.mjs"),
    "--package",
    pkg.path,
    "--version",
    overrides.version ?? "0.2.0",
    "--sha256",
    overrides.sha256 ?? pkg.sha256,
    "--size",
    String(pkg.size),
    "--root",
    root,
    "--data",
    join(root, "data"),
    "--port",
    String(port),
  ];
  const result = spawn(NODE, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  result.stdout.on("data", (chunk) => output.push(String(chunk)));
  result.stderr.on("data", (chunk) => output.push(String(chunk)));
  return new Promise((resolveRun) => {
    result.on("exit", (code) => resolveRun({ code, output: output.join("") }));
  });
}

async function healthy(portToProbe) {
  try {
    const res = await fetch(`http://127.0.0.1:${portToProbe}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function killStray(root) {
  // Ask the launcher to stop, then make sure nothing is left on the port.
  try {
    execFileSync(NODE, [join(root, "launcher.mjs"), "--stop"], {
      env: { ...process.env, SEARCH_HUB_DATA_DIR: join(root, "data"), SEARCH_HUB_PORT: String(port) },
      stdio: "ignore",
      timeout: 30_000,
    });
  } catch {
    /* not running */
  }
}

const roots = [];

/** Waits until nothing answers on the port, so the next case starts clean. */
async function waitUntilDown(portToProbe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await healthy(portToProbe))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
try {
  // 1) healthy update
  {
    const p = nextPort();
    const root = makeInstallRoot("0.1.0");
    roots.push(root);
    const pkg = makePackage({ version: "0.2.0", mode: "healthy" });
    const run = await runUpdater(root, pkg, { version: "0.2.0" });
    check("healthy update exits 0", run.code === 0, `code=${run.code}`);
    check("new program is in place", readFileSync(join(root, "app", "apps", "api", "dist", "version.txt"), "utf8").trim() === "0.2.0");
    check("service answers after update", await healthy(p));
    check(
      "data preserved across update",
      fixtureValue(join(root, "data", "search-hub.db")) === "preserved" &&
        readFileSync(join(root, "data", "master.key"), "utf8") === "PRE-EXISTING-KEY",
    );
    check("a backup was taken", existsSync(join(updateWorkRoot(join(root, "data")), "backups")));
    killStray(root);
    await waitUntilDown(p);
  }

  // 2) broken package rolls back
  {
    const p = nextPort();
    const root = makeInstallRoot("0.1.0");
    roots.push(root);
    const pkg = makePackage({ version: "0.3.0", mode: "broken" });
    const run = await runUpdater(root, pkg, { version: "0.3.0" });
    // Exit 3 means "rolled back and healthy again"; that is the pass condition.
    check(
      "broken update rolls back",
      run.code === 3,
      `code=${run.code} ${run.output.split("\n").filter((l) => /REFUSED|failed|rollback/.test(l)).slice(-2).join(" | ").slice(0, 200)}`,
    );
    check(
      "old program restored",
      readFileSync(join(root, "app", "apps", "api", "dist", "version.txt"), "utf8").trim() === "0.1.0",
    );
    check("service is healthy again after rollback", await healthy(p));
    // The manifest lives outside app/, so restoring only the program would leave
    // the failed build's version in place — the restored server would then
    // report a version that never ran.
    check(
      "manifest restored with the old program",
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version === "0.1.0",
    );
    check(
      "data survived the failed update",
      fixtureValue(join(root, "data", "search-hub.db")) === "preserved",
    );
    killStray(root);
    await waitUntilDown(p);
  }

  // 3) tampered package refused
  {
    const root = makeInstallRoot("0.1.0");
    roots.push(root);
    const pkg = makePackage({ version: "0.2.0", mode: "healthy" });
    const run = await runUpdater(root, pkg, { version: "0.2.0", sha256: "0".repeat(64) });
    check("tampered package refused", run.code === 1, `code=${run.code}`);
    check("refusal names the checksum", run.output.includes("checksum_mismatch"));
    check(
      "program untouched after a refusal",
      readFileSync(join(root, "app", "apps", "api", "dist", "version.txt"), "utf8").trim() === "0.1.0",
    );
  }

  // 4) downgrade refused
  {
    const root = makeInstallRoot("1.0.0");
    roots.push(root);
    const pkg = makePackage({ version: "0.9.0", mode: "healthy" });
    const run = await runUpdater(root, pkg, { version: "0.9.0" });
    check("downgrade refused", run.code === 1, `code=${run.code}`);
    check("refusal names the downgrade", run.output.includes("downgrade_blocked"));
  }

  // 5) wrong architecture refused
  {
    const root = makeInstallRoot("0.1.0");
    roots.push(root);
    const pkg = makePackage({ version: "0.2.0", mode: "healthy" });
    const wrongArch = process.arch === "x64" ? "arm64" : "x64";
    const fake = join(dirname(pkg.path), `search-hub-v0.2.0-${process.platform === "win32" ? "windows" : "linux"}-${wrongArch}${pkg.name.endsWith(".zip") ? ".zip" : ".tar.gz"}`);
    writeFileSync(fake, readFileSync(pkg.path));
    const bytes = readFileSync(fake);
    const run = await runUpdater(
      root,
      { path: fake, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength },
      { version: "0.2.0" },
    );
    check("wrong architecture refused", run.code === 1, `code=${run.code}`);
    check("refusal names the architecture", run.output.includes("wrong_arch") || run.output.includes("wrong_platform"));
  }
} finally {
  // Stop every service before deleting the trees: on Windows a running child
  // holds the exe/dll handles and rmdir fails with EBUSY.
  for (const root of roots) {
    try {
      killStray(root);
    } catch {
      /* best effort */
    }
  }
  await new Promise((r) => setTimeout(r, 1_500));
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // A leftover temp directory is not a test failure; the assertions already ran.
    }
  }
}

console.log(failures === 0 ? "\nAll updater checks passed." : `\n${failures} updater check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
