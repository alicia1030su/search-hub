#!/usr/bin/env node
/**
 * Search Hub desktop launcher.
 *
 * Runs as `SearchHub.exe` on Windows (Node SEA) or as `bin/search-hub` on Linux.
 * It does not contain any search logic: it owns the operational concerns a
 * double-click user needs — data directory, port conflicts, single instance,
 * health check, browser hand-off, stop/status/logs and autostart.
 *
 * Design rules:
 * - The server is a **child process** running the bundled runtime, not the SEA
 *   blob itself. `better-sqlite3` is a native addon and cannot be loaded from
 *   inside a single-executable blob, so keeping the server in a separate process
 *   is what makes the database work reliably.
 * - Everything is read from `launcher.json` next to the executable, so the same
 *   build works for a portable copy and for an installed copy.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";


const IS_WINDOWS = platform() === "win32";
/**
 * Directory of this launcher.
 *
 * Three cases:
 * - Node SEA (Windows exe): the embedded script is CommonJS, `__dirname` is the
 *   executable's directory.
 * - `node bin/search-hub.mjs` (Linux): `__dirname` does not exist in ESM, but
 *   `process.argv[1]` is the script path.
 * - Anything else: fall back to the runtime's directory.
 */
const HERE =
  typeof __dirname === "string"
    ? __dirname
    : process.argv[1]
      ? dirname(resolve(process.argv[1]))
      : dirname(process.execPath);

function findRoot() {
  // Walk upwards a few levels: the launcher lives in `bin/` on Linux and next to
  // the executable on Windows, and the manifest is always at the package root.
  let candidate = HERE;
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(candidate, "launcher.json"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return resolve(HERE, "..");
}

const ROOT = findRoot();
const MANIFEST = readJson(join(ROOT, "launcher.json"), {});
const DEFAULT_PORT = Number(MANIFEST.defaultPort ?? 8787);
const STATE_DIR = defaultDataDir();
const CONFIG_PATH = join(STATE_DIR, "launcher-config.json");
const LOCK_PATH = join(STATE_DIR, "launcher.lock");
const LOG_DIR = join(STATE_DIR, "logs");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Windows: %LOCALAPPDATA%\SearchHub (a real "user application data" location).
 * Linux: $XDG_DATA_HOME/search-hub or ~/.local/share/search-hub.
 */
function defaultDataDir() {
  if (process.env["SEARCH_HUB_DATA_DIR"]) return resolve(process.env["SEARCH_HUB_DATA_DIR"]);
  if (IS_WINDOWS) {
    return join(process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "SearchHub");
  }
  return join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "search-hub");
}

function loadConfig() {
  const saved = readJson(CONFIG_PATH, {});
  return {
    port: Number(process.env["SEARCH_HUB_PORT"] ?? saved.port ?? DEFAULT_PORT),
    listenHost: process.env["SEARCH_HUB_HOST"] ?? saved.listenHost ?? "127.0.0.1",
    openBrowser: saved.openBrowser !== false,
    service: false,
  };
}

function saveConfig(config) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function portFree(port, host) {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(false));
    probe.once("listening", () => probe.close(() => resolvePort(true)));
    probe.listen(port, host);
  });
}

function readLock() {
  const lock = readJson(LOCK_PATH, null);
  if (!lock || typeof lock.pid !== "number") return null;
  try {
    // Signal 0 only checks liveness; it does not touch the process.
    process.kill(lock.pid, 0);
    return lock;
  } catch {
    return null;
  }
}

async function healthy(port, timeoutMs = 1500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const command = IS_WINDOWS ? "cmd" : platform() === "darwin" ? "open" : "xdg-open";
  const args = IS_WINDOWS ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * A database file appearing is not enough: setup may be unfinished. The admin
 * table is the real signal, but reading SQLite here would add a native
 * dependency to the launcher, so the presence of the setup token file is used
 * instead — the server deletes it once an administrator exists.
 */
async function firstRunCompleted(dataDir) {
  return !existsSync(join(dataDir, "setup-token"));
}

async function waitHealthy(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function printStatus(lock, port) {
  if (!lock) {
    console.log("Search Hub 未在运行。");
    return;
  }
  console.log(`Search Hub 正在运行 (pid ${lock.pid})`);
  console.log(`访问地址: http://127.0.0.1:${port}`);
  console.log(`数据目录: ${STATE_DIR}`);
  console.log(`日志: ${join(LOG_DIR, "server.log")}`);
}

async function start() {
  const config = loadConfig();
  if (process.argv.includes("--port")) {
    const requested = Number(argValue("--port"));
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
      console.error("端口无效：需要 1-65535 之间的整数。");
      process.exit(2);
    }
    config.port = requested;
  }
  if (hasFlag("--lan")) config.listenHost = "0.0.0.0";
  if (hasFlag("--no-browser")) config.openBrowser = false;
  saveConfig(config);

  const existing = readLock();
  if (existing) {
    // A second double-click must never start a second instance against the same
    // SQLite file: two writers would corrupt it or fail with SQLITE_BUSY.
    console.log(`Search Hub 已在运行 (pid ${existing.pid})。`);
    console.log(`访问地址: http://127.0.0.1:${existing.port}`);
    if (config.openBrowser) openBrowser(`http://127.0.0.1:${existing.port}`);
    return;
  }

  if (!(await portFree(config.port, config.listenHost))) {
    console.error(`端口 ${config.port} 已被占用。请用 --port <新端口> 启动，或在管理后台修改端口。`);
    process.exit(3);
  }

  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, "server.log");
  const logStream = createWriteStream(logPath, { flags: "a" });

  const runtime = runtimePath();
  // The production entrypoint produced by scripts/build-server.mjs.
  const entry = join(ROOT, "app", "apps", "api", "dist", "server.mjs");
  if (!existsSync(entry)) {
    console.error(`找不到服务入口: ${entry}`);
    console.error("安装包可能不完整，请重新下载。");
    process.exit(4);
  }

  const child = spawn(runtime, [entry], {
    cwd: join(ROOT, "app"),
    env: {
      ...process.env,
      SEARCH_HUB_DATA_DIR: STATE_DIR,
      SEARCH_HUB_PORT: String(config.port),
      SEARCH_HUB_HOST: config.listenHost,
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  writeFileSync(LOCK_PATH, JSON.stringify({ pid: child.pid, port: config.port, startedAt: new Date().toISOString() }), "utf8");

  const cleanup = () => {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  };
  process.on("exit", cleanup);

  // Forward termination to the server.
  //
  // systemd sends SIGTERM to this process, and a user pressing Ctrl+C does the
  // same. Without forwarding, the launcher would exit and leave the server
  // holding the port and the SQLite file — `--stop` would then report success
  // while the instance is still running.
  const forward = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGHUP", () => forward("SIGTERM"));

  child.on("exit", (code) => {
    cleanup();
    if (code !== 0) console.error(`服务已退出，退出码 ${code}。详见 ${logPath}`);
    process.exit(code ?? 1);
  });

  const ok = await waitHealthy(config.port);
  if (!ok) {
    console.error(`服务在 60 秒内没有通过健康检查。请查看 ${logPath}`);
    console.error("进程仍在运行，可用 --stop 结束它。");
    process.exit(5);
  }

  const url = `http://127.0.0.1:${config.port}`;
  console.log("Search Hub 已启动。");
  console.log(`访问地址: ${url}`);
  console.log(`数据目录: ${STATE_DIR}`);
  console.log(`日志: ${logPath}`);
  if (!(await firstRunCompleted(STATE_DIR))) {
    // The server writes the token itself; point at the file rather than
    // duplicating the secret into our own log.
    console.log(`首次初始化: Setup Token 在 ${join(STATE_DIR, "setup-token")}`);
  }
  if (config.listenHost === "0.0.0.0") {
    console.log("警告：已监听所有网卡。局域网内任何人都能访问管理后台，请确保管理员密码足够强，且不要暴露到公网。");
  }
  if (config.openBrowser && !hasFlag("--service")) openBrowser(url);

  // A service-mode process must survive the user's desktop session ending, so it
  // does not hold the console: it keeps running until stopped explicitly.
  if (hasFlag("--service")) {
    console.log("Service 模式：后台运行，不自动打开浏览器。");
  }
}

function runtimePath() {
  const bundled = IS_WINDOWS ? join(ROOT, "runtime", "node.exe") : join(ROOT, "runtime", "bin", "node");
  return existsSync(bundled) ? bundled : process.execPath;
}

async function stop() {
  const lock = readLock();
  if (!lock) {
    console.log("Search Hub 未在运行。");
    return;
  }
  try {
    process.kill(lock.pid, "SIGTERM");
  } catch {
    /* already dead */
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!readLock()) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
  console.log("已停止。");
}

async function status() {
  const lock = readLock();
  const config = loadConfig();
  if (!lock) {
    printStatus(null, config.port);
    return;
  }
  const ok = await healthy(lock.port);
  printStatus(lock, lock.port);
  console.log(`健康检查: ${ok ? "通过" : "未通过"}`);
  if (!ok) process.exitCode = 1;
}

function showLogs() {
  const path = join(LOG_DIR, "server.log");
  if (!existsSync(path)) {
    console.log("还没有日志。");
    return;
  }
  const size = statSync(path).size;
  // Tail the last 64 KiB instead of dumping a potentially huge file.
  const start = Math.max(0, size - 65536);
  const content = readFileSync(path).subarray(start).toString("utf8");
  process.stdout.write(content);
}

function autostart(on) {
  if (!IS_WINDOWS) {
    console.log("Linux 请使用随包的 systemd 模板：systemctl --user enable search-hub");
    return;
  }
  const startup = join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const shortcut = join(startup, "SearchHub.cmd");
  if (on === false) {
    try {
      unlinkSync(shortcut);
      console.log("已关闭开机自启动。");
    } catch {
      console.log("本来就没有开启。");
    }
    return;
  }
  mkdirSync(startup, { recursive: true });
  // A .cmd in the Startup folder is user-scoped and reversible; it does not touch
  // machine-wide registry settings.
  writeFileSync(shortcut, `@echo off\r\nstart "" "${process.execPath}" --service\r\n`, "utf8");
  console.log(`已开启开机自启动：${shortcut}`);
}

function printHelp() {
  console.log(`Search Hub 启动器

用法:
  SearchHub.exe                 启动并打开浏览器
  SearchHub.exe --port 9000     指定端口（会保存）
  SearchHub.exe --lan           监听局域网（安全风险，见提示）
  SearchHub.exe --service       后台服务模式，不打开浏览器
  SearchHub.exe --status        查看运行状态
  SearchHub.exe --stop          停止服务
  SearchHub.exe --logs          查看最近日志
  SearchHub.exe --autostart     开启开机自启动
  SearchHub.exe --no-autostart  关闭开机自启动
  SearchHub.exe --help          显示本帮助

数据目录: ${STATE_DIR}
`);
}

/**
 * Entry dispatch.
 *
 * Wrapped in a function (instead of top-level await) so the same source can be
 * bundled to CommonJS for the Windows SEA executable, which is evaluated as CJS.
 */
async function run() {
  const command = process.argv[2];
  if (hasFlag("--help") || command === "help") printHelp();
  else if (hasFlag("--status") || command === "status") await status();
  else if (hasFlag("--stop") || command === "stop") await stop();
  else if (hasFlag("--logs") || command === "logs") showLogs();
  else if (hasFlag("--autostart") || command === "autostart") autostart(true);
  else if (hasFlag("--no-autostart") || command === "no-autostart") autostart(false);
  else await start();
}

run().catch((error) => {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
