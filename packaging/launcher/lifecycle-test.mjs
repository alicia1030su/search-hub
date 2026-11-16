#!/usr/bin/env node
/**
 * Lifecycle test for the launcher, driven by controlled child processes.
 *
 * It never touches a real Search Hub: each case starts the launcher against a
 * throwaway "package root" whose `app/.../server.mjs` is a stub that either
 * answers /api/health or refuses to. That makes "did it start", "did it stop"
 * and "did it leave an orphan" deterministic.
 *
 * Cases:
 *   1. normal start → status ok → stop actually stops
 *   2. a second launcher while one runs does not create a second instance
 *   3. a stale lock (dead pid) is claimed instead of blocking startup
 *   4. a lock whose pid belongs to an unrelated live process is NOT signalled
 *   5. health never passes → the child is killed, no orphan, lock released
 *   6. stop times out (child ignores SIGTERM) → reports failure, keeps the lock
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHER = join(REPO, "packaging", "launcher", "launcher.mjs");
const NODE = process.execPath;
const BASE_PORT = Number(process.env["LAUNCHER_TEST_PORT"] ?? 8899);
let PORT = BASE_PORT;
const nextPort = () => (PORT += 1);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRoot(mode) {
  const root = mkdtempSync(join(tmpdir(), `sh-launcher-${mode}-`));
  mkdirSync(join(root, "app", "apps", "api", "dist"), { recursive: true });
  writeFileSync(
    join(root, "launcher.json"),
    JSON.stringify({ name: "Search Hub", defaultPort: PORT }),
    "utf8",
  );
  writeFileSync(join(root, "app", "apps", "api", "dist", "server.mjs"), stubServer(mode), "utf8");
  // Reuse the real launcher but keep its data dir inside the temp root.
  return root;
}

/**
 * mode "ok"     — serves /api/health, exits on SIGTERM
 * mode "silent" — never listens (health never passes)
 * mode "stubborn" — serves health but ignores SIGTERM until SIGKILL
 */
function stubServer(mode) {
  if (mode === "silent") {
    return `setTimeout(() => {}, 600000);`;
  }
  const ignoreTerm = mode === "stubborn";
  return `
import { createServer } from "node:http";
const port = Number(process.env.SEARCH_HUB_PORT);
const server = createServer((req, res) => {
  if (req.url === "/api/health") { res.writeHead(200, {"content-type":"application/json"}); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
server.listen(port, "127.0.0.1");
${ignoreTerm ? 'process.on("SIGTERM", () => { /* deliberately ignore */ });' : 'process.on("SIGTERM", () => process.exit(0));'}
`;
}

function run(args, root) {
  const env = { ...process.env, SEARCH_HUB_DATA_DIR: join(root, "data") };
  return spawnSync(NODE, [LAUNCHER, ...args], { cwd: root, env, encoding: "utf8", timeout: 90_000 });
}

async function startBg(args, root) {
  const env = { ...process.env, SEARCH_HUB_DATA_DIR: join(root, "data") };
  const child = spawn(NODE, [LAUNCHER, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return { child, output: out };
    } catch {
      /* not up */
    }
    await sleep(200);
  }
  return { child, output: out };
}

async function down() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    return !res.ok;
  } catch {
    return true;
  }
}

const roots = [];
try {
  // Each case uses its own port: a still-draining child from the previous case
  // must never make the next "is it healthy?" check ambiguous.
  await sleep(300);

  // 1. normal lifecycle
  {
    PORT = nextPort();
    const root = makeRoot("ok");
    roots.push(root);
    const bg = await startBg(["--no-browser", "--port", String(PORT), "--service"], root);
    check("start: service answers health", !(await down()));
    const status = run(["--status"], root);
    check("status: reports running", status.stdout.includes("正在运行"), status.stdout.trim().split("\n")[0]);
    const stop = run(["--stop"], root);
    check("stop: exits 0", stop.status === 0, `status=${stop.status}`);
    check("stop: service actually stopped", await down());
    check("stop: lock removed", !existsSync(join(root, "data", "launcher.lock")));
    bg.child.kill("SIGKILL");
  }

  // 2. second launcher must not spawn a second instance
  {
    PORT = nextPort();
    const root = makeRoot("ok");
    roots.push(root);
    const first = await startBg(["--no-browser", "--port", String(PORT), "--service"], root);
    const second = run(["--no-browser", "--port", String(PORT)], root);
    check("second start: reports already running", second.stdout.includes("已在运行"), second.stdout.trim().split("\n")[0]);
    check("second start: exit code 0 (no error)", second.status === 0, `status=${second.status}`);
    run(["--stop"], root);
    first.child.kill("SIGKILL");
    await sleep(500);
  }

  // 3. stale lock from a dead pid must be reclaimed
  {
    PORT = nextPort();
    const root = makeRoot("ok");
    roots.push(root);
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      join(root, "data", "launcher.lock"),
      JSON.stringify({ pid: 999_999, port: PORT, startedAt: new Date().toISOString(), role: "server" }),
      "utf8",
    );
    const bg = await startBg(["--no-browser", "--port", String(PORT), "--service"], root);
    check("stale lock: startup proceeds", !(await down()), bg.output.join("").slice(-200).replace(/\n/g, " "));
    run(["--stop"], root);
    bg.child.kill("SIGKILL");
    await sleep(500);
  }

  // 4. a lock naming an unrelated live process must never be signalled
  {
    PORT = nextPort();
    const root = makeRoot("ok");
    roots.push(root);
    mkdirSync(join(root, "data"), { recursive: true });
    // A live process that is definitely not Search Hub.
    const bystander = spawn(NODE, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    writeFileSync(
      join(root, "data", "launcher.lock"),
      JSON.stringify({ pid: bystander.pid, port: PORT, startedAt: new Date().toISOString(), role: "server" }),
      "utf8",
    );
    const stop = run(["--stop"], root);
    let alive = true;
    try {
      process.kill(bystander.pid, 0);
    } catch {
      alive = false;
    }
    check("foreign pid: unrelated process survives --stop", alive);
    check("foreign pid: stop reports not running, not success", !stop.stdout.includes("已停止。"), stop.stdout.trim().split("\n").pop());
    bystander.kill("SIGKILL");
  }

  // 5. health never passes → child must be killed, no orphan, lock released
  {
    PORT = nextPort();
    const root = makeRoot("silent");
    roots.push(root);
    const started = Date.now();
    const result = run(["--no-browser", "--port", String(PORT)], root);
    check("health timeout: exits non-zero", result.status !== 0, `status=${result.status}, ${Date.now() - started}ms`);
    check("health timeout: lock released", !existsSync(join(root, "data", "launcher.lock")));
    check("health timeout: no process left on the port", await down());
  }

  // 6. stop timeout must report failure and keep the lock
  {
    PORT = nextPort();
    const root = makeRoot("stubborn");
    roots.push(root);
    const bg = await startBg(["--no-browser", "--port", String(PORT), "--service"], root);
    const stop = run(["--stop"], root);
    if (process.platform === "win32") {
      // Windows has no ignorable SIGTERM: TerminateProcess ends the child, so the
      // honest assertion is "stop succeeded AND the process really is gone".
      check("stubborn child: stop succeeds on Windows", stop.status === 0, `status=${stop.status}`);
      check("stubborn child: actually gone", await down());
    } else {
      check("stop timeout: reports failure", stop.status !== 0, `status=${stop.status}`);
      check("stop timeout: keeps the lock", existsSync(join(root, "data", "launcher.lock")));
    }
    // Clean up the stubborn child ourselves.
    try {
      const lock = JSON.parse(readFileSync(join(root, "data", "launcher.lock"), "utf8"));
      process.kill(lock.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    bg.child.kill("SIGKILL");
    await sleep(500);
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll launcher lifecycle checks passed." : `\n${failures} launcher check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
