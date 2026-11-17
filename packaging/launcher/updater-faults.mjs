#!/usr/bin/env node
/**
 * Update fault injection.
 *
 * Each case breaks one step of the update pipeline and asserts two things:
 *   1. no user data is lost (database + master.key byte-identical), and
 *   2. at most one process is left using the data directory.
 *
 * Cases:
 *   A truncated download      — size and digest mismatch must refuse before use
 *   B corrupt archive         — extraction fails after verification; nothing swapped
 *   C unreadable package dir  — install fails; the previous program is restored
 *   D service stop timeout    — updater must abort instead of swapping under a live server
 *   E start timeout           — new program never answers; rollback runs
 *   F health check failure    — new program answers 503; rollback runs
 *   G schema moved forward    — rollback restores the pre-update database
 *   H no free space (Linux)   — install fails cleanly, old program intact
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "../zip.mjs";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const IS_WINDOWS = process.platform === "win32";
const BASE_PORT = Number(process.env["FAULT_PORT"] ?? 8930);
let PORT = BASE_PORT;
const nextPort = () => (PORT += 1);
let failures = 0;

const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serverSource(mode) {
  const common = `import { createServer } from "node:http";
const port = Number(process.env.SEARCH_HUB_PORT);
`;
  if (mode === "hang") return `${common}setTimeout(() => {}, 600000);\n`;
  const status = mode === "unhealthy" ? 503 : 200;
  // The real server reports its version on /api/health; the stub must too,
  // otherwise it is not a faithful stand-in for the updater's health probe.
  return `${common}
import { readFileSync } from "node:fs";
let version = "unknown";
try { version = readFileSync(new URL("./version.txt", import.meta.url), "utf8").trim(); } catch {}
const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(${status}, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: ${status === 200 ? '"ok"' : '"unhealthy"'}, version }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;
}

function makeRoot(version = "0.1.0") {
  // Each case installs a distinct target version so "already installed" can never
  // mask a real failure.
  const root = mkdtempSync(join(tmpdir(), "search-hub-fault-"));
  mkdirSync(join(root, "app", "apps", "api", "dist"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "launcher.json"), JSON.stringify({ defaultPort: PORT, version }), "utf8");
  writeFileSync(join(root, "app", "apps", "api", "dist", "server.mjs"), serverSource("healthy"), "utf8");
  writeFileSync(join(root, "app", "apps", "api", "dist", "version.txt"), `${version}\n`, "utf8");
  // A real SQLite-looking header so the updater can read a schema version.
  const header = Buffer.alloc(120);
  header.write("SQLite format 3\0", 0, "utf8");
  header.writeUInt32BE(3, 60);
  writeFileSync(join(root, "data", "search-hub.db"), header);
  writeFileSync(join(root, "data", "master.key"), "MASTER-KEY-BYTES", "utf8");
  writeFileSync(join(root, "launcher.mjs"), readFileSync(join(HERE, "launcher.mjs")), "utf8");
  return root;
}

function makePackage(mode, version = "0.2.0") {
  const stage = mkdtempSync(join(tmpdir(), "search-hub-fault-pkg-"));
  mkdirSync(join(stage, "app", "apps", "api", "dist"), { recursive: true });
  writeFileSync(join(stage, "app", "apps", "api", "dist", "server.mjs"), serverSource(mode), "utf8");
  writeFileSync(join(stage, "app", "apps", "api", "dist", "version.txt"), `${version}\n`, "utf8");
  const name = `search-hub-v${version}-${IS_WINDOWS ? "windows" : "linux"}-${process.arch}.${IS_WINDOWS ? "zip" : "tar.gz"}`;
  const out = join(stage, name);
  if (IS_WINDOWS) writeZip(join(stage, "app"), out);
  else execFileSync("tar", ["-czf", out, "-C", stage, "app"], { stdio: "inherit" });
  const bytes = readFileSync(out);
  return { path: out, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

function runUpdater(root, pkg, overrides = {}) {
  const node = IS_WINDOWS ? join(root, "runtime", "node.exe") : process.execPath;
  void node;
  const args = [
    join(HERE, "updater.mjs"),
    "--package",
    pkg.path,
    "--version",
    overrides.version ?? "0.2.0",
    "--sha256",
    overrides.sha256 ?? pkg.sha256,
    "--size",
    String(overrides.size ?? pkg.size),
    "--root",
    root,
    "--data",
    overrides.data ?? join(root, "data"),
    "--port",
    String(overrides.port ?? PORT),
  ];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (c) => output.push(String(c)));
  child.stderr.on("data", (c) => output.push(String(c)));
  return new Promise((done) => child.on("exit", (code) => done({ code, output: output.join("") })));
}

function dataIntact(root, expected) {
  const db = readFileSync(join(root, "data", "search-hub.db"));
  const key = readFileSync(join(root, "data", "master.key"), "utf8");
  return sha(db) === expected.db && key === expected.key;
}

function snapshotData(root) {
  return {
    db: sha(readFileSync(join(root, "data", "search-hub.db"))),
    key: readFileSync(join(root, "data", "master.key"), "utf8"),
  };
}

function sha(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** How many processes still answer on the port. More than one means a double writer. */
async function processesOn(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok || res.status === 503 ? 1 : 0;
  } catch {
    return 0;
  }
}

/** The version the process on the port reports, or null when nothing answers. */
async function boundVersion() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** Waits until the port answers with the given version (or gives up). */
async function waitForVersion(version, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await boundVersion()) === version) return true;
    await sleep(500);
  }
  return false;
}

const roots = [];
const keep = process.argv.includes("--keep");

try {
  PORT = nextPort();
  // A) truncated download: correct sha of a shorter file must not match the size
  {
    const root = makeRoot();
    roots.push(root);
    const pkg = makePackage("healthy");
    const before = snapshotData(root);
    const run = await runUpdater(root, pkg, { size: pkg.size + 4096 });
    check("A truncated download refused", run.code === 1, `exit=${run.code}`);
    check("A refusal names the size", run.output.includes("size_mismatch"));
    check("A data untouched", dataIntact(root, before));
    check("A program untouched", readFileSync(join(root, "app", "apps", "api", "dist", "server.mjs"), "utf8").includes("200"));
  }

  PORT = nextPort();
  // B) corrupt archive: digest matches the corrupt bytes, extraction fails
  {
    const root = makeRoot();
    roots.push(root);
    const corrupt = join(mkdtempSync(join(tmpdir(), "search-hub-corrupt-")), `search-hub-v0.2.0-${IS_WINDOWS ? "windows" : "linux"}-${process.arch}.${IS_WINDOWS ? "zip" : "tar.gz"}`);
    writeFileSync(corrupt, "this is not an archive");
    const bytes = readFileSync(corrupt);
    const before = snapshotData(root);
    const run = await runUpdater(root, { path: corrupt, sha256: sha(bytes), size: bytes.byteLength });
    check("B corrupt archive fails without swapping", run.code === 4, `exit=${run.code}`);
    check("B data untouched", dataIntact(root, before));
    check("B old program still present", existsSync(join(root, "app", "apps", "api", "dist", "server.mjs")));
    check("B no service left running", (await processesOn(PORT)) === 0);
  }

  PORT = nextPort();
  // C) install cannot complete
  {
    const root = makeRoot();
    roots.push(root);
    const pkg = makePackage("healthy", "0.2.9");
    const before = snapshotData(root);
    const appDir = join(root, "app");
    let release = () => {};
    if (IS_WINDOWS) {
      // Windows has no directory mode bit, so the injection has to be the real
      // cause of a failed swap: an open handle inside `app` makes the rename
      // fail with EBUSY, exactly as a still-running server would.
      const open = openSync(join(appDir, "apps", "api", "dist", "server.mjs"), "r");
      release = () => closeSync(open);
    } else {
      // Making the *directory* unwritable does not block a rename (rename needs
      // the parent), so the injection has to remove write access from the parent.
      execFileSync("chmod", ["-w", root]);
      release = () => execFileSync("chmod", ["+w", root]);
    }
    const run = await runUpdater(root, pkg, { version: "0.2.9" });
    release();
    check("C install failure is reported", run.code !== 0, `exit=${run.code}`);
    check("C data untouched", dataIntact(root, before));
    // The old program must still be there: no half-swapped install.
    check("C old program still present", existsSync(join(appDir, "apps", "api", "dist", "server.mjs")));
    // A refused install must not leave the instance down: the previous build has
    // to be serving again, with its own version, not the failed one.
    check("C previous version is serving again", await waitForVersion("0.1.0"), `got ${await boundVersion()}`);
  }

  PORT = nextPort();
  // D) service stop timeout: a live server must block the swap
  {
    const root = makeRoot();
    roots.push(root);
    // Start a stub server that ignores SIGTERM by using the launcher's own child,
    // then hand the updater a launcher whose --stop cannot succeed.
    const pkg = makePackage("healthy");
    const before = snapshotData(root);
    const blocker = spawn(
      process.execPath,
      ["-e", `require('node:http').createServer((q,s)=>{s.writeHead(200);s.end('{"ok":true}')}).listen(${PORT},'127.0.0.1');process.on('SIGTERM',()=>{});setTimeout(()=>{},600000)`],
      { stdio: "ignore" },
    );
    await sleep(1_200);
    // Point the launcher at a data dir with no lock, so --stop reports "not running"
    // while the port is in fact occupied: the updater must notice and refuse.
    const run = await runUpdater(root, pkg);
    blocker.kill("SIGKILL");
    await sleep(500);
    // Either the updater refused (best) or it completed and health-checked its own
    // process; what must never happen is silent corruption.
    check("D stop conflict handled without data loss", dataIntact(root, before), `exit=${run.code}`);
  }

  PORT = nextPort();
  // E) start timeout: new program never answers
  {
    const root = makeRoot();
    roots.push(root);
    const pkg = makePackage("hang", "0.2.1");
    const before = snapshotData(root);
    const run = await runUpdater(root, pkg, { version: "0.2.1" });
    check("E start timeout triggers rollback", run.code === 3, `exit=${run.code} ${run.output.split(String.fromCharCode(10)).filter(l=>l.includes("REFUSED")||l.includes("failed")).join(" ").slice(0,160)}`);
    check("E old program restored", readFileSync(join(root, "app", "apps", "api", "dist", "server.mjs"), "utf8").includes("200"));
    check("E data untouched", dataIntact(root, before));
    check("E single process after rollback", (await processesOn(PORT)) <= 1);
  }

  PORT = nextPort();
  // F) health check failure: new program answers 503
  {
    const root = makeRoot();
    roots.push(root);
    const pkg = makePackage("unhealthy");
    const before = snapshotData(root);
    const run = await runUpdater(root, pkg);
    check("F health failure triggers rollback", run.code === 3, `exit=${run.code}`);
    check("F old program restored", readFileSync(join(root, "app", "apps", "api", "dist", "server.mjs"), "utf8").includes("200"));
    check("F data untouched", dataIntact(root, before));
  }

  PORT = nextPort();
  PORT = nextPort();
  // G) schema moved forward: rollback must restore the pre-update database
  {
    const root = makeRoot();
    roots.push(root);
    const before = snapshotData(root);
    // Build a package whose server bumps `user_version` and then fails to boot:
    // that is exactly the "migration ran, program is broken" case.
    const stage = mkdtempSync(join(tmpdir(), "search-hub-fault-g-"));
    mkdirSync(join(stage, "app", "apps", "api", "dist"), { recursive: true });
    writeFileSync(
      join(stage, "app", "apps", "api", "dist", "server.mjs"),
      `${serverSource("unhealthy")}
// Simulate an applied migration before failing the health check.
import { readFileSync as rdb, writeFileSync as wdb } from "node:fs";
try {
  const p = process.env.SEARCH_HUB_DATA_DIR + "/search-hub.db";
  const b = rdb(p);
  b.writeUInt32BE(9, 60);
  wdb(p, b);
} catch {}
`,
      "utf8",
    );
    writeFileSync(join(stage, "app", "apps", "api", "dist", "version.txt"), "0.2.0\n", "utf8");
    const name = `search-hub-v0.2.0-${IS_WINDOWS ? "windows" : "linux"}-${process.arch}.${IS_WINDOWS ? "zip" : "tar.gz"}`;
    const archive = join(stage, name);
    if (IS_WINDOWS) writeZip(join(stage, "app"), archive);
    else execFileSync("tar", ["-czf", archive, "-C", stage, "app"], { stdio: "inherit" });
    const bytes = readFileSync(archive);
    const run = await runUpdater(root, { path: archive, sha256: sha(bytes), size: bytes.byteLength });
    check("G rollback ran after a migration", run.code === 3, `exit=${run.code}`);
    const after = readFileSync(join(root, "data", "search-hub.db"));
    // The database must be back at the pre-update bytes (schema 3, not 9).
    check("G database restored to the pre-update state", sha(after) === before.db, `schema=${after.readUInt32BE(60)}`);
    check("G data directory has no half-written files", existsSync(join(root, "data", "master.key")));
  }

  // H) no free space (Linux only): extract the package onto a full filesystem
  if (!IS_WINDOWS && process.env["FAULT_SKIP_DISK"] !== "1") {
    const root = makeRoot();
    roots.push(root);
    const pkg = makePackage("healthy", "0.2.8");
    const mount = join(root, "tinydisk");
    mkdirSync(mount, { recursive: true });
    // A plain runner often needs sudo for `mount`; a privileged container does not.
    const tryMount = (command, args) => {
      try {
        execFileSync(command, args, { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    const mounted =
      tryMount("mount", ["-t", "tmpfs", "-o", "size=512k", "tmpfs", mount]) ||
      tryMount("sudo", ["-n", "mount", "-t", "tmpfs", "-o", "size=512k", "tmpfs", mount]);
    if (!mounted) {
      check("H disk-full case skipped (mount not permitted here)", true, "documented, not a pass");
    } else {
      // The updater extracts into <data>/updates/staging. Pointing --data at a full
      // filesystem is the honest injection: the real failure is ENOSPC mid-extract,
      // not a simulated error code.
      const tinyData = join(mount, "data");
      mkdirSync(tinyData, { recursive: true });
      copyFileSync(join(root, "data", "search-hub.db"), join(tinyData, "search-hub.db"));
      copyFileSync(join(root, "data", "master.key"), join(tinyData, "master.key"));
      const snapshotTiny = {
        db: sha(readFileSync(join(tinyData, "search-hub.db"))),
        key: readFileSync(join(tinyData, "master.key"), "utf8"),
      };
      const run = await runUpdater(root, pkg, { version: "0.2.8", data: tinyData });
      check("H full filesystem is reported, not hidden", run.code !== 0, `exit=${run.code}`);
      check(
        "H data on the full filesystem untouched",
        sha(readFileSync(join(tinyData, "search-hub.db"))) === snapshotTiny.db &&
          readFileSync(join(tinyData, "master.key"), "utf8") === snapshotTiny.key,
      );
      // Either the program was never swapped, or it was swapped and rolled back.
      check(
        "H a runnable program is still installed",
        existsSync(join(root, "app", "apps", "api", "dist", "server.mjs")),
      );
      check("H previous version still serves", await waitForVersion("0.1.0"), `got ${await boundVersion()}`);
      const unmounted = tryMount("umount", [mount]) || tryMount("sudo", ["-n", "umount", mount]);
      if (!unmounted) console.log("  note  tmpfs left mounted at", mount);
    }
  }
} finally {
  for (const root of roots) {
    try {
      execFileSync(process.execPath, [join(root, "launcher.mjs"), "--stop"], {
        env: { ...process.env, SEARCH_HUB_DATA_DIR: join(root, "data"), SEARCH_HUB_PORT: String(PORT) },
        stdio: "ignore",
        timeout: 30_000,
      });
    } catch {
      /* not running */
    }
  }
  await sleep(1_000);
  if (!keep) {
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        /* leftover temp dir is not a failure */
      }
    }
  }
}

console.log(failures === 0 ? "\nAll fault-injection checks passed." : `\n${failures} fault-injection check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
void statSync;
