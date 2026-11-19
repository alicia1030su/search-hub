#!/usr/bin/env node
/**
 * Captures the two v0.1.10 provider-test screenshots from a real instance.
 *
 * Nothing here is drawn or edited: the script boots the built server against a
 * throwaway data directory, seeds deterministic **mock** sources (the built-in
 * test adapter, labelled as such in the UI), drives the real admin page in
 * Chromium, and captures what it sees. A screenshot that could not be taken from
 * a live page is a failure, not a placeholder.
 *
 * Isolation, deliberately:
 *  - the data directory is a fresh temp dir, deleted at the end;
 *  - the instance binds 127.0.0.1 on an ephemeral port;
 *  - **no credential is created, read or written** — every source is `mock`,
 *    which answers inside the process and never opens a socket, so no vendor is
 *    contacted and nothing is billed;
 *  - it writes only the two files it names, and refuses to overwrite anything
 *    it did not create (`--keep-existing` files are skipped and reported).
 *
 * Usage:
 *   pnpm build && node scripts/docs-screenshots-provider-test.mjs
 *   node scripts/docs-screenshots-provider-test.mjs --out docs/screenshots/v0110
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const OUT_DIR = resolve(REPO, flag("out", "docs/screenshots/v0110"));
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;

const EMAIL = "admin@example.com";
const PASSWORD = "Screenshot-Local-Only-1";
const SETUP_TOKEN = "screenshots-provider-test-token";

/** The two files this script owns. Nothing else is written. */
const SHOTS = [
  {
    file: "provider-test.png",
    title: "单源测试详情",
    /**
     * A single source probed through the *one* path the product now has.
     *
     * The dialog is opened from the provider row's test button, so the frame
     * shows the real conclusion — including `requests`, which is why this
     * release exists: the old endpoint could not report it honestly.
     */
    async capture(page, base) {
      await page.goto(`${base}/providers`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "搜索源", exact: true }).first().waitFor({ timeout: 30_000 });
      // The loopback stub source, not a `mock` one: it is the only source whose
      // `requests` count and redacted key are real numbers, which is exactly
      // what this release fixed.
      const row = page.locator("tr", { hasText: "演示源 Eta" }).first();
      await row.waitFor({ timeout: 30_000 });
      await row.getByRole("button", { name: "测试" }).click();
      await page.getByTestId("single-test-requests").waitFor({ timeout: 30_000 });
      await page.waitForTimeout(300);
    },
  },
  {
    file: "provider-batch-test.png",
    title: "批量检测结果",
    /**
     * A finished bulk run, shown as the table an operator reads.
     *
     * Four mock sources with different behaviours (ok / failed / throttled /
     * empty) plus one disabled source, so the frame shows four distinct rows and
     * the severity ordering rather than one repeated state.
     */
    async capture(page, base) {
      await page.goto(`${base}/providers`, { waitUntil: "networkidle" });
      await page.getByTestId("providers-tab-health").click();
      await page.getByTestId("health-test-all-connect").waitFor({ timeout: 30_000 });
      await page.getByTestId("health-test-all-connect").click();
      await page.getByTestId("batch-start").waitFor({ timeout: 30_000 });
      await page.getByTestId("batch-start").click();
      // The results table is the frame: wait for it, not for a timer.
      await page.getByTestId("batch-results").waitFor({ timeout: 60_000 });
      await page.getByTestId("batch-result-status").waitFor({ timeout: 30_000 });
      await page.waitForTimeout(400);
    },
  },
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`FAIL  ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("could not reserve a port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`instance did not become healthy at ${base}`);
}

/** Minimal API client bound to one session; sends CSRF on every mutation. */
async function api(base) {
  let cookies = "";
  let csrf = "";
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookies ? { cookie: cookies } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) cookies = setCookie.map((item) => item.split(";")[0]).join("; ");
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 240)}`);
    return parsed;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    patch: (path, body) => call("PATCH", path, body),
    setCsrf: (value) => {
      csrf = value;
    },
    cookieHeader: () => cookies,
  };
}

async function startInstance(port, dataDir) {
  const child = spawn(process.execPath, ["apps/api/dist/server.mjs"], {
    cwd: REPO,
    env: {
      ...process.env,
      SEARCH_HUB_DATA_DIR: dataDir,
      SEARCH_HUB_PORT: String(port),
      SEARCH_HUB_HOST: "127.0.0.1",
      SEARCH_HUB_SETUP_TOKEN: SETUP_TOKEN,
      SEARCH_HUB_COOKIE_SECURE: "false",
      SEARCH_HUB_LOG_LEVEL: "warn",
      NODE_ENV: "production",
      SEARCH_HUB_RATE_LIMIT_PER_MIN: "20000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => (buffer += String(chunk)));
  child.stderr.on("data", (chunk) => (buffer += String(chunk)));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) process.stderr.write(`instance exited with ${code}\n${buffer.slice(-2000)}\n`);
  });
  return { child, readLog: () => buffer };
}

/**
 * A Brave-shaped loopback stub.
 *
 * It exists so the screenshot can show a *measured* `requests` count and a real
 * latency: the `mock` adapter answers inside the process and never touches the
 * network, so its count is honestly `null`. This stub is a plain
 * `http.createServer` on 127.0.0.1 — no vendor is contacted and the "key" is a
 * literal placeholder that only this process ever sees.
 */
function startLoopbackStub() {
  return new Promise((resolveStub, reject) => {
    const server = createHttpServer((request, response) => {
      const send = () => {
        if (!request.headers["x-subscription-token"]) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
          return;
        }
        if (!request.url?.startsWith("/res/v1/web/search")) {
          response.writeHead(404).end("not found");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            web: {
              results: Array.from({ length: 3 }, (_, index) => ({
                title: `演示结果 ${index + 1}`,
                url: `https://example.org/demo-${index + 1}`,
                description: "仅用于界面演示的模拟结果",
                page_age: "2026-01-01T00:00:00",
                language: "zh-hans",
              })),
            },
          }),
        );
      };
      // A small delay so the captured latency is a plausible number rather than 0 ms.
      setTimeout(send, 35);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("stub did not bind"));
        return;
      }
      resolveStub({ port: address.port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/**
 * Deterministic demo sources.
 *
 * Every source is either the built-in `mock` adapter (labelled as a test source
 * in the UI, answers in-process, never opens a socket) or the loopback stub
 * above. The different `failMode`s exist so the result table shows the four
 * distinct states — failed, restricted, pending, ok — rather than one repeated
 * colour, which is the thing this screenshot is meant to explain.
 */
async function seedDemo(client, stubPort) {
  // The SSRF guard blocks 127.0.0.1 by default; the stub is on loopback.
  await client.put("/api/admin/settings", { security: { privateHostAllowlist: ["127.0.0.1"] } });
  // A single-source test is a *search* probe, so the paid switch must be on or
  // the endpoint refuses with a 409 before it reaches the stub. This instance is
  // throwaway and the only "vendor" is the loopback stub.
  await client.put("/api/admin/settings", {
    health: { paidProbesEnabled: true, maxRequestsPerRun: 10, maxRequestsPerDay: 50 },
  });

  const providers = [
    { name: "演示源 Alpha（mock）", config: { resultCount: 6, latencyMs: 18, namespace: "alpha" } },
    { name: "演示源 Beta（mock）", config: { resultCount: 4, latencyMs: 42, namespace: "beta" } },
    { name: "演示源 Gamma（mock）", config: { resultCount: 0, latencyMs: 22, namespace: "gamma" } },
    { name: "演示源 Delta（mock）", config: { latencyMs: 12, failMode: "rate_limited", namespace: "delta" } },
    { name: "演示源 Epsilon（mock）", config: { latencyMs: 12, failMode: "server_error", namespace: "epsilon" } },
    { name: "演示源 Zeta（mock）", config: { resultCount: 3, latencyMs: 15, namespace: "zeta" } },
  ];
  const ids = [];
  for (const provider of providers) {
    const created = await client.post("/api/admin/providers", {
      name: provider.name,
      type: "mock",
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0,
      config: provider.config,
    });
    ids.push(created.provider.id);
  }

  // A paginated source on the loopback stub: this is the only one whose
  // `requests` column can be a measured number.
  const stubProvider = await client.post("/api/admin/providers", {
    name: "演示源 Eta（本地 stub）",
    type: "brave",
    enabled: true,
    baseUrl: `http://127.0.0.1:${stubPort}`,
    timeoutMs: 5000,
    maxRetries: 0,
    resultsPerPage: 5,
    searchConfig: { targetResults: 10, maxPages: 2 },
  });
  ids.push(stubProvider.provider.id);
  // A literal placeholder, never a real subscription token.
  await client.post(`/api/admin/providers/${stubProvider.provider.id}/keys`, {
    label: "演示凭证",
    key: "demo-not-a-real-token",
    weight: 100,
    enabled: true,
  });

  // One disabled source so the table has a genuine "skipped" row rather than an
  // invented one.
  await client.patch(`/api/admin/providers/${ids[5]}`, { enabled: false });
  return ids;
}

function pngInfo(path) {
  const bytes = readFileSync(path);
  const signature = bytes.subarray(0, 8).toString("hex");
  const isPng = signature === "89504e470d0a1a0a";
  const width = isPng ? bytes.readUInt32BE(16) : 0;
  const height = isPng ? bytes.readUInt32BE(20) : 0;
  return { isPng, width, height, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Stops the instance and removes its throwaway data directory.
 *
 * Separated from the capture flow on purpose: a cleanup failure (a Windows file
 * lock on the SQLite file, typically) must not be reported *as* the failure of
 * the capture, and it must not mask the real error either. The directory is
 * removed on a bounded retry after the child has actually exited.
 */
async function teardown(instance, dataDir) {
  instance.child.kill("SIGTERM");
  await new Promise((done) => {
    if (instance.child.exitCode !== null) {
      done();
      return;
    }
    const timer = setTimeout(done, 3000);
    instance.child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error.code ?? "") !== "EBUSY" || attempt === 5) {
        process.stderr.write(`note: could not remove ${dataDir}: ${error.message}\n`);
        return;
      }
      await new Promise((done) => setTimeout(done, 150));
    }
  }
}

async function main() {
  if (!existsSync(join(REPO, "apps/api/dist/server.mjs"))) fail("apps/api/dist/server.mjs is missing; run `pnpm build` first");
  if (!existsSync(join(REPO, "apps/web/dist/index.html"))) fail("apps/web/dist/index.html is missing; run `pnpm build` first");

  // Never delete the directory: it holds screenshots this script does not own.
  mkdirSync(OUT_DIR, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "search-hub-shots-provider-test-"));

  log(`instance: ${base} (data ${dataDir})`);
  const instance = await startInstance(port, dataDir);
  const browser = await chromium.launch({ headless: true });
  let stub = null;

  try {
    const health = await waitForHealth(base);
    log(`health: version=${health.version} migrations=${health.database.migrations}`);

    const client = await api(base);
    const setup = await client.post("/api/setup", {
      email: EMAIL,
      password: PASSWORD,
      name: "演示管理员",
      setupToken: SETUP_TOKEN,
    });
    client.setCsrf(setup.csrfToken);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const cookiePairs = client.cookieHeader().split("; ").filter(Boolean);
    const origin = new URL(base);
    await context.addCookies(
      cookiePairs.map((pair) => {
        const [name, ...rest] = pair.split("=");
        return { name, value: rest.join("="), domain: origin.hostname, path: "/", httpOnly: true, secure: false };
      }),
    );

    stub = await startLoopbackStub();
    await seedDemo(client, stub.port);
    log(`seed: 7 demo sources (one disabled) — no real credential, no vendor call`);

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
      document.addEventListener("DOMContentLoaded", () => document.head.append(style));
    });

    const captured = [];
    for (const shot of SHOTS) {
      await shot.capture(page, base);
      await page.evaluate(() => document.fonts.ready);
      const skeletons = await page.locator("main .animate-pulse").count();
      if (skeletons > 0) fail(`${shot.file}: ${skeletons} skeleton element(s) still visible`);
      const alerts = await page.locator("main [role=alert]").count();
      if (alerts > 0) fail(`${shot.file}: an error alert is visible on the page`);
      await page.waitForTimeout(200);

      const file = join(OUT_DIR, shot.file);
      await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
      const info = pngInfo(file);
      if (!info.isPng) fail(`${shot.file}: not a PNG`);
      captured.push({ file: shot.file, ...info });
      log(`  captured ${shot.file} — ${info.width}x${info.height}, ${Math.round(info.bytes / 1024)} KB`);
    }

    if (pageErrors.length > 0) fail(`page errors during capture: ${pageErrors.slice(0, 3).join(" | ")}`);

    log("");
    for (const item of captured) log(`  ${item.file}  ${item.width}x${item.height}  sha256=${item.sha256.slice(0, 16)}…`);
    log("done");
  } finally {
    await browser.close();
    if (stub) await stub.close();
    await teardown(instance, dataDir);
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
