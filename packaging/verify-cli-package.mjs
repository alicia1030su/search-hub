#!/usr/bin/env node
/** Starts a real Search Hub server and verifies a built shub package against it. */
import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.argv[2] ?? (process.platform === "win32" ? "windows-x64" : "linux-x64");
const OUT = join(REPO, "dist", "cli", TARGET);
const IS_WINDOWS = TARGET.startsWith("windows");
const command = TARGET === "node22"
  ? { command: process.execPath, args: [join(OUT, "bin", "shub.mjs")] }
  : { command: join(OUT, IS_WINDOWS ? "shub.exe" : "shub"), args: [] };
if (!existsSync(command.command)) throw new Error(`CLI executable not found: ${command.command}`);

const work = mkdtempSync(join(tmpdir(), `shub-acceptance-${TARGET}-`));
const data = join(work, "data");
mkdirSync(data, { recursive: true });
let server;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}\n`);
};

function run(args, options = {}) {
  return execFileSync(command.command, [...command.args, ...args], { encoding: "utf8", windowsHide: true, timeout: 30_000, ...options });
}

try {
  const version = run(["--version"]).trim();
  check("CLI version", version === JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version, version);
  const help = run(["--help"]);
  check("CLI help", help.includes("shub search") && help.includes("shub providers test"));

  const port = await pickPort();
  const base = `http://127.0.0.1:${port}`;
  const setupToken = `cli-acceptance-${process.pid}-${Date.now()}`;
  const adminPassword = `CLI-${randomBytes(24).toString("hex")}`;
  server = spawn(process.execPath, [join(REPO, "apps", "api", "dist", "server.mjs")], {
    cwd: REPO,
    env: {
      ...process.env,
      SEARCH_HUB_DATA_DIR: data,
      SEARCH_HUB_PORT: String(port),
      SEARCH_HUB_HOST: "127.0.0.1",
      SEARCH_HUB_SETUP_TOKEN: setupToken,
      SEARCH_HUB_COOKIE_SECURE: "false",
      SEARCH_HUB_RATE_LIMIT_PER_MIN: "9000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => { serverLog += String(chunk); });
  server.stderr.on("data", (chunk) => { serverLog += String(chunk); });
  let healthy = false;
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { healthy = true; break; }
    } catch { /* not ready */ }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
  }
  check("Search Hub server boots", healthy, healthy ? base : serverLog.slice(-300));
  if (!healthy) throw new Error("server did not become healthy");

  const setup = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cli@example.com", password: adminPassword, name: "CLI", setupToken }),
  });
  check("administrator setup", setup.ok, `HTTP ${setup.status}`);
  const cookie = setup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie } })).json();
  const headers = { "content-type": "application/json", cookie, "x-csrf-token": session.csrfToken };
  const provider = await fetch(`${base}/api/admin/providers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "CLI mock", type: "mock", enabled: true, config: { resultCount: 3 }, searchConfig: { targetResults: 3 } }),
  });
  const providerBody = provider.ok ? await provider.json() : {};
  check("mock provider created", Boolean(providerBody.provider?.id), `HTTP ${provider.status}`);
  const tokenResponse = await fetch(`${base}/api/admin/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "cli-acceptance", scopes: ["search", "sources:read", "admin", "mcp:use"], rateLimitPerMin: 600 }),
  });
  const tokenBody = tokenResponse.ok ? await tokenResponse.json() : {};
  const token = tokenBody.token;
  check("CLI token issued", Boolean(token), `HTTP ${tokenResponse.status}`);
  if (!token) throw new Error("no CLI token");

  const env = { ...process.env, SEARCH_HUB_URL: base, SEARCH_HUB_TOKEN: token, SEARCH_HUB_CLI_CONFIG_DIR: join(work, "config") };
  const status = JSON.parse(run(["status", "--json"], { env }));
  check("shub status", status.version === JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version && status.compatible === true);
  const sources = JSON.parse(run(["sources", "--json"], { env }));
  check("shub sources", sources.providers.some((item) => item.id === providerBody.provider.id));
  const doctor = JSON.parse(run(["doctor", "--json"], { env }));
  check("shub doctor", doctor.ok === true && doctor.checks.every((item) => item.ok));
  const search = JSON.parse(run(["search", "CLI acceptance", "--json"], { env }));
  check("shub real REST search", search.status === "completed" && search.results.length > 0, `status=${search.status} results=${search.results.length}`);
} catch (error) {
  check("acceptance completed without crashing", false, error instanceof Error ? error.message : String(error));
} finally {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolveStop) => setTimeout(resolveStop, 500));
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exitCode = failures === 0 ? 0 : 1;

async function pickPort() {
  for (let port = 8790; port < 8850; port += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(200) });
    } catch {
      return port;
    }
  }
  throw new Error("no free acceptance port");
}
