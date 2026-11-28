#!/usr/bin/env node
/**
 * Captures the v0.1.18 README screenshots from a real, isolated Search Hub.
 *
 * The script starts the built API on an OS-assigned loopback port with a fresh
 * temporary data directory, creates only built-in mock providers, drives the
 * real web UI in Chromium, and captures four 1600x1000 PNGs. It never reads an
 * operator database or credential, and the browser context aborts every request
 * whose origin is not the temporary instance.
 *
 * Usage:
 *   pnpm build && node scripts/docs-screenshots.mjs
 *   node scripts/docs-screenshots.mjs --out docs/screenshots/v0118
 *   node scripts/docs-screenshots.mjs --keep
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_VERSION = "0.1.18";
const VIEWPORT = { width: 1600, height: 1000 };
const OUTPUT_FILES = [
  "onboarding.png",
  "search-lab.png",
  "dashboard.png",
  "provider-health.png",
  "manifest.json",
];

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const flagValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const OUT_DIR = resolve(REPO, flagValue("out", "docs/screenshots/v0118"));
const KEEP = hasFlag("keep");
const BROWSER_CHANNEL = flagValue("browser-channel", "auto");
const BROWSER_EXECUTABLE = flagValue("executable-path", "");

// Generated per run and never printed or persisted in the manifest. They exist
// only in the throwaway database that is removed during teardown.
const ADMIN_EMAIL = "admin@example.com";
const ADMIN_PASSWORD = randomBytes(32).toString("base64url");
const SETUP_TOKEN = randomBytes(32).toString("base64url");
const DEMO_QUERY = "distributed retrieval architecture";

const REDACTION = Object.freeze({
  policy: "throwaway mock-only instance; no operator data or vendor credentials",
  administratorEmail: "synthetic admin@example.com",
  administratorPassword: "generated per run; not recorded",
  setupToken: "generated per run; not recorded",
  sessionCookies: "not recorded",
  csrfTokens: "not recorded",
  providerCredentials: "none created; built-in mock adapters only",
  externalRequests: "blocked by browser routing; zero expected",
});

/** Writes a concise progress line to stdout. */
function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Throws an error that is surfaced by the top-level failure handler. */
function fail(message) {
  throw new Error(message);
}

/** Returns common Windows browser locations without relying on a fixed version. */
function systemBrowserCandidates() {
  const candidates = [];
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";
  for (const root of [programFiles, programFilesX86]) {
    candidates.push({
      kind: "executablePath",
      value: join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    });
    candidates.push({
      kind: "executablePath",
      value: join(root, "Google", "Chrome", "Application", "chrome.exe"),
    });
  }
  if (localAppData) {
    candidates.push({
      kind: "executablePath",
      value: join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    });
  }
  return candidates;
}

/** Finds versioned Playwright browsers already installed on this machine. */
function playwrightBrowserCandidates() {
  const roots = [];
  if (process.env["PLAYWRIGHT_BROWSERS_PATH"]) roots.push(process.env["PLAYWRIGHT_BROWSERS_PATH"]);
  if (process.env["LOCALAPPDATA"]) roots.push(join(process.env["LOCALAPPDATA"], "ms-playwright"));
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium(?:_headless_shell)?-\d+$/.test(entry.name))
      .sort((left, right) => {
        const leftVersion = Number(left.name.match(/(\d+)$/)?.[1] ?? 0);
        const rightVersion = Number(right.name.match(/(\d+)$/)?.[1] ?? 0);
        return rightVersion - leftVersion;
      });
    for (const directory of directories) {
      const base = join(root, directory.name);
      candidates.push({ kind: "executablePath", value: join(base, "chrome-win", "chrome.exe") });
      candidates.push({ kind: "executablePath", value: join(base, "chrome-win64", "chrome.exe") });
      candidates.push({
        kind: "executablePath",
        value: join(base, "chrome-headless-shell-win64", "headless_shell.exe"),
      });
      candidates.push({
        kind: "executablePath",
        value: join(base, "chrome-linux", "chrome"),
      });
    }
  }
  return candidates;
}

/**
 * Launches an installed browser without downloading one. Explicit CLI options
 * win; otherwise Edge/Chrome and existing Playwright revisions are probed.
 */
async function launchBrowser() {
  const attempts = [];
  const launch = async (options) => chromium.launch({ headless: true, ...options });
  if (BROWSER_EXECUTABLE) {
    if (!existsSync(BROWSER_EXECUTABLE)) fail(`browser executable does not exist: ${BROWSER_EXECUTABLE}`);
    try {
      const browser = await launch({ executablePath: BROWSER_EXECUTABLE });
      return { browser, description: `executable:${BROWSER_EXECUTABLE}` };
    } catch (error) {
      fail(`could not launch browser executable ${BROWSER_EXECUTABLE}: ${error?.message ?? String(error)}`);
    }
  }
  if (BROWSER_CHANNEL !== "auto") {
    try {
      const browser = await launch({ channel: BROWSER_CHANNEL });
      return { browser, description: `channel:${BROWSER_CHANNEL}` };
    } catch (error) {
      fail(`could not launch browser channel ${BROWSER_CHANNEL}: ${error?.message ?? String(error)}`);
    }
  }

  for (const channel of ["msedge", "chrome"]) {
    try {
      const browser = await launch({ channel });
      return { browser, description: `channel:${channel}` };
    } catch (error) {
      attempts.push(`channel:${channel}: ${error?.message ?? String(error)}`);
    }
  }
  for (const candidate of [...systemBrowserCandidates(), ...playwrightBrowserCandidates()]) {
    if (!existsSync(candidate.value)) continue;
    try {
      const browser = await launch({ executablePath: candidate.value });
      return { browser, description: `executable:${candidate.value}` };
    } catch (error) {
      attempts.push(`executable:${candidate.value}: ${error?.message ?? String(error)}`);
    }
  }
  fail(
    "no usable browser found; install Edge/Chrome or a Playwright browser, or pass " +
      "`--browser-channel <name>` / `--executable-path <path>`. Attempts:\n" +
      attempts.join("\n"),
  );
}

/** Returns an OS-assigned free loopback port. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("could not reserve a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

/** Waits until the temporary API answers its health endpoint. */
async function waitForHealth(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, {
        headers: { accept: "application/json" },
      });
      if (response.ok) return await response.json();
    } catch {
      // The child process is still starting.
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  fail(`instance did not become healthy at ${base}`);
}

/** Creates a small cookie-aware API client for the isolated instance. */
async function createApiClient(base) {
  let cookies = "";
  let csrfToken = "";
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookies ? { cookie: cookies } : {}),
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      cookies = setCookies.map((item) => item.split(";")[0]).join("; ");
    }
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      fail(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    return parsed;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    setCsrf: (token) => {
      csrfToken = token;
    },
  };
}

/** Starts the built API with isolated data and loopback-only configuration. */
function startInstance(port, dataDir) {
  const child = spawn(process.execPath, ["apps/api/dist/server.mjs"], {
    cwd: REPO,
    env: {
      ...process.env,
      NODE_ENV: "production",
      SEARCH_HUB_DATA_DIR: dataDir,
      SEARCH_HUB_HOST: "127.0.0.1",
      SEARCH_HUB_PORT: String(port),
      SEARCH_HUB_SETUP_TOKEN: SETUP_TOKEN,
      SEARCH_HUB_COOKIE_SECURE: "false",
      SEARCH_HUB_LOG_LEVEL: "warn",
      SEARCH_HUB_RATE_LIMIT_PER_MIN: "20000",
      SEARCH_HUB_PROXY_FROM_ENV: "false",
      SEARCH_HUB_OUTBOUND_PROXY_FROM_ENV: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null && !KEEP) {
      process.stderr.write(`instance exited with ${code}\n${output.slice(-2000)}\n`);
    }
  });
  return { child, readLog: () => output };
}

/** Creates deterministic mock providers and populates health/history data. */
async function seedMockProviders(client) {
  const providers = [
    { name: "演示源 Alpha（mock）", namespace: "alpha", resultCount: 8, latencyMs: 18 },
    { name: "演示源 Beta（mock）", namespace: "beta", resultCount: 6, latencyMs: 28 },
    { name: "演示源 Gamma（mock）", namespace: "gamma", resultCount: 4, latencyMs: 38 },
  ];
  const ids = [];
  for (const provider of providers) {
    const created = await client.post("/api/admin/providers", {
      name: provider.name,
      type: "mock",
      enabled: true,
      timeoutMs: 5000,
      maxRetries: 0,
      config: {
        namespace: provider.namespace,
        resultCount: provider.resultCount,
        latencyMs: provider.latencyMs,
        sharedUrl: false,
      },
    });
    ids.push(created.provider.id);
  }

  await client.put("/api/admin/settings", {
    cache: { enabled: true, ttlSeconds: 86_400 },
  });

  // Connectivity probes are in-process for the mock adapter. They populate the
  // real health overview without contacting a vendor or spending quota.
  for (const providerId of ids) {
    const probe = await client.post("/api/admin/health/check", {
      providerId,
      kind: "connect",
    });
    if (!Array.isArray(probe.results) || probe.results.length !== 1) {
      fail(`health probe for ${providerId} returned no result`);
    }
  }
  return ids;
}

/** Reads PNG dimensions and computes the integrity fields used by the manifest. */
function pngInfo(path) {
  const bytes = readFileSync(path);
  const isPng = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  return {
    isPng,
    width: isPng ? bytes.readUInt32BE(16) : 0,
    height: isPng ? bytes.readUInt32BE(20) : 0,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Disables animation and prevents non-local browser network traffic. */
async function hardenPage(context, base, networkState) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (request.url().startsWith("data:") || request.url().startsWith("blob:")) {
      await route.continue();
      return;
    }
    let origin = "";
    try {
      origin = new URL(request.url()).origin;
    } catch {
      networkState.blocked.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    if (origin !== base) {
      networkState.blocked.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

/** Adds deterministic-rendering CSS before the application mounts. */
async function disableAnimations(page) {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}";
    const install = () => document.head.append(style);
    if (document.head) install();
    else document.addEventListener("DOMContentLoaded", install, { once: true });
  });
}

/** Captures one viewport-sized PNG and returns its manifest entry. */
async function capture(page, file, route, options = {}) {
  const zoom = options.zoom ?? 1;
  await page.evaluate(({ value, preserveScroll }) => {
    document.documentElement.style.zoom = String(value);
    if (!preserveScroll) window.scrollTo(0, 0);
  }, { value: zoom, preserveScroll: options.preserveScroll === true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  const visibleSkeletons = await page.locator("main .animate-pulse:visible").count();
  if (visibleSkeletons > 0) fail(`${file}: ${visibleSkeletons} skeleton element(s) remain visible`);
  const errorAlerts = await page.locator('main [role="alert"]:visible').count();
  if (errorAlerts > 0) fail(`${file}: ${errorAlerts} error alert(s) are visible`);

  const path = join(OUT_DIR, file);
  await page.screenshot({
    path,
    type: "png",
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  const info = pngInfo(path);
  if (!info.isPng) fail(`${file}: not a PNG`);
  if (info.width !== VIEWPORT.width || info.height !== VIEWPORT.height) {
    fail(`${file}: ${info.width}x${info.height}, expected ${VIEWPORT.width}x${VIEWPORT.height}`);
  }
  if (info.bytes < 20_000) fail(`${file}: ${info.bytes} bytes is too small for a populated frame`);

  return {
    file,
    route,
    capturedAt: new Date().toISOString(),
    bytes: info.bytes,
    sha256: info.sha256,
    width: info.width,
    height: info.height,
    browserZoom: zoom,
    redaction: REDACTION,
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

/** Captures the setup form before POST /api/setup is ever called. */
async function captureOnboarding(page, base) {
  await page.goto(`${base}/setup`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "初始化 Search Hub", exact: true }).waitFor();
  await expect(page.locator("#setup-email")).toHaveValue("");
  await expect(page.locator("#setup-password")).toHaveValue("");
  await expect(page.getByText(`v${EXPECTED_VERSION}`, { exact: true })).toBeVisible();
  return capture(page, "onboarding.png", "/setup", {
    evidence: {
      phase: "before-setup",
      setupFormVisible: true,
      secretFieldsEmpty: true,
    },
  });
}

/** Completes the real onboarding UI with a mock-backed search. */
async function completeOnboardingUi(page, base) {
  await page.goto(`${base}/onboarding`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "首次使用引导", exact: true }).waitFor();
  await page.getByRole("heading", { name: "完成一次搜索", exact: true }).waitFor();
  await page.locator("#onboarding-query").fill(DEMO_QUERY);
  await page.getByRole("button", { name: "运行搜索", exact: true }).click();
  const result = page.getByTestId("onboarding-search-result");
  await result.waitFor({ state: "visible", timeout: 30_000 });
  await expect(result).toContainText("演示源 Alpha（mock）");
  await expect(result).toContainText("演示源 Beta（mock）");
  await page.getByRole("button", { name: "完成引导", exact: true }).click();
  await page.waitForURL(`${base}/`, { timeout: 30_000 });
  await page.getByRole("heading", { name: "仪表盘", exact: true }).waitFor();
}

/**
 * Runs a strategy search through the streaming API and captures controls,
 * diagnostics, and real mock result rows in one frame.
 */
async function captureSearchLab(page, base) {
  await page.goto(`${base}/lab`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "搜索实验室", exact: true }).waitFor();
  await expect(page.getByText("演示源 Alpha（mock）", { exact: true })).toBeVisible();
  await page.locator("#lab-mode").selectOption("strategy:balanced");
  await page.locator("#lab-limit").fill("6");
  await page.locator("#lab-query").fill(DEMO_QUERY);
  await expect(page.getByRole("button", { name: "自动选择（推荐）", exact: true })).toHaveAttribute("aria-pressed", "true");

  const streamResponsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/search/stream") && response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "运行搜索", exact: true }).click();
  const streamResponse = await streamResponsePromise;
  if (!streamResponse.ok()) fail(`search stream returned HTTP ${streamResponse.status()}`);

  const finalResults = page.getByTestId("final-results");
  await finalResults.waitFor({ state: "visible", timeout: 30_000 });
  const resultCount = await finalResults.locator("article").count();
  if (resultCount < 1) fail("search-lab: final results contain no result rows");
  await expect(finalResults).toContainText("Mock Provider");
  await expect(page.getByRole("heading", { name: "路由解释", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "候选漏斗", exact: true })).toBeVisible();
  await expect(page.getByText("调试详情", { exact: true })).toHaveCount(1);

  // Fit the strategy control and the first real result row into the viewport.
  // This changes only browser display zoom and scroll position; the PNG remains
  // exactly 1600x1000 and still comes directly from the real page.
  let zoom = 0.95;
  let fitted = false;
  for (; zoom >= 0.55; zoom = Number((zoom - 0.05).toFixed(2))) {
    await page.evaluate((value) => {
      document.documentElement.style.zoom = String(value);
      window.scrollTo(0, 0);
    }, zoom);
    await page.waitForTimeout(100);
    const control = await page.locator("#lab-mode").boundingBox();
    const result = await finalResults.locator("article").first().boundingBox();
    if (!control || !result) continue;
    const scrollTop = Math.max(0, control.y - 72);
    await page.evaluate((value) => window.scrollTo(0, value), scrollTop);
    await page.waitForTimeout(100);
    const scrolledControl = await page.locator("#lab-mode").boundingBox();
    const scrolledResult = await finalResults.locator("article").first().boundingBox();
    if (
      scrolledControl &&
      scrolledResult &&
      scrolledControl.y >= 56 &&
      scrolledResult.y + scrolledResult.height <= VIEWPORT.height - 20
    ) {
      fitted = true;
      break;
    }
  }
  if (!fitted) fail("search-lab: could not fit strategy controls and a result row");
  const resultRowsInViewport = await finalResults.locator("article").evaluateAll((rows) =>
    rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    }).length,
  );

  return capture(page, "search-lab.png", "/lab", {
    zoom,
    preserveScroll: true,
    evidence: {
      strategy: "balanced",
      streamHttpStatus: streamResponse.status(),
      resultRowsReturned: resultCount,
      resultRowsInViewport,
      diagnosticsVisible: ["路由解释", "候选漏斗", "逐源统计"],
      debugDetailsAvailable: true,
      providerType: "mock",
    },
  });
}

/** Captures the dashboard after onboarding and Lab searches have populated it. */
async function captureDashboard(page, base) {
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "仪表盘", exact: true }).waitFor();
  await expect(page.locator("main .text-2xl")).toHaveCount(4);
  await expect(page.getByText("演示源 Alpha（mock）", { exact: true }).first()).toBeVisible();
  return capture(page, "dashboard.png", "/", {
    zoom: 0.95,
    evidence: {
      onboardingCompleted: true,
      metricCards: 4,
      mockProviderActivity: true,
    },
  });
}

/** Captures the health tab after successful in-process mock connectivity probes. */
async function captureProviderHealth(page, base) {
  await page.goto(`${base}/providers`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "搜索源", exact: true }).waitFor();
  await page.getByTestId("providers-tab-health").click();
  await page.getByTestId("health-test-all").waitFor({ state: "visible" });
  const panel = page.getByRole("region", { name: "搜索源健康", exact: true });
  await panel.waitFor({ state: "visible" });
  await expect(panel.getByText("演示源 Alpha（mock）", { exact: true })).toBeVisible();
  await expect(panel.getByText("演示源 Beta（mock）", { exact: true })).toBeVisible();
  await expect(panel.getByText("演示源 Gamma（mock）", { exact: true })).toBeVisible();
  return capture(page, "provider-health.png", "/providers", {
    zoom: 0.82,
    evidence: {
      tab: "health",
      probedMockProviders: 3,
      probeKind: "connect",
      externalProviderCalls: 0,
    },
  });
}

/** Stops the child and removes its throwaway data with Windows lock retries. */
async function teardown(instance, dataDir) {
  if (instance.child.exitCode === null) instance.child.kill("SIGTERM");
  await new Promise((done) => {
    if (instance.child.exitCode !== null) {
      done();
      return;
    }
    const timer = setTimeout(done, 5000);
    instance.child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) {
        process.stderr.write(`note: could not remove ${dataDir}: ${error?.message ?? String(error)}\n`);
        return;
      }
      await new Promise((done) => setTimeout(done, 200));
    }
  }
}

/** Removes only files owned by this capture, preserving unrelated artifacts. */
function prepareOutputDirectory() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of OUTPUT_FILES) {
    const path = join(OUT_DIR, file);
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Runs the complete capture workflow. */
async function main() {
  const serverEntry = join(REPO, "apps/api/dist/server.mjs");
  const webEntry = join(REPO, "apps/web/dist/index.html");
  if (!existsSync(serverEntry)) fail("apps/api/dist/server.mjs is missing; run `pnpm build` first");
  if (!existsSync(webEntry)) fail("apps/web/dist/index.html is missing; run `pnpm build` first");

  const packageJson = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  if (packageJson.version !== EXPECTED_VERSION) {
    fail(`package.json version is ${packageJson.version}; expected ${EXPECTED_VERSION}`);
  }

  prepareOutputDirectory();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "search-hub-v0118-screenshots-"));
  const instance = startInstance(port, dataDir);
  let browser;
  let browserDescription = "not-launched";
  const networkState = { blocked: [] };

  try {
    const health = await waitForHealth(base);
    if (health.version !== EXPECTED_VERSION) {
      fail(`API version is ${health.version}; expected ${EXPECTED_VERSION}`);
    }
    log(`instance: ${base}; version=${health.version}; migrations=${health.database.migrations}`);

    const launched = await launchBrowser();
    browser = launched.browser;
    browserDescription = launched.description;
    log(`browser: ${browserDescription}`);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await hardenPage(context, base, networkState);
    const page = await context.newPage();
    await disableAnimations(page);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const captured = [];
    captured.push(await captureOnboarding(page, base));
    log("  captured onboarding.png before setup");

    // Complete first-run setup through the same real UI path as the E2E helper.
    await page.locator("#setup-token").fill(SETUP_TOKEN);
    await page.locator("#setup-email").fill(ADMIN_EMAIL);
    await page.locator("#setup-name").fill("演示管理员");
    await page.locator("#setup-password").fill(ADMIN_PASSWORD);
    await page.locator("#setup-confirm").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入", exact: true }).click();
    await page.getByRole("heading", { name: "首次使用引导", exact: true }).waitFor({ timeout: 30_000 });

    // A separate API session seeds data; actor identity remains the same admin.
    const client = await createApiClient(base);
    const session = await client.post("/api/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    client.setCsrf(session.csrfToken);
    await seedMockProviders(client);
    log("seed: 3 built-in mock providers and 3 local connectivity probes");

    await completeOnboardingUi(page, base);
    log("onboarding: completed through the real UI with mock search evidence");

    captured.push(await captureSearchLab(page, base));
    log("  captured search-lab.png with balanced strategy, stream, diagnostics, and mock results");
    captured.push(await captureDashboard(page, base));
    log("  captured dashboard.png after onboarding and Lab activity");
    captured.push(await captureProviderHealth(page, base));
    log("  captured provider-health.png after mock connectivity probes");

    if (pageErrors.length > 0) fail(`page errors during capture: ${pageErrors.slice(0, 3).join(" | ")}`);
    if (networkState.blocked.length > 0) {
      fail(`external browser requests were blocked: ${networkState.blocked.slice(0, 3).join(" | ")}`);
    }

    const hashes = new Set();
    for (const item of captured) {
      if (hashes.has(item.sha256)) fail(`${item.file}: duplicate screenshot hash`);
      hashes.add(item.sha256);
    }

    const manifest = {
      generatedBy: "scripts/docs-screenshots.mjs",
      version: EXPECTED_VERSION,
      capturedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: "zh-CN",
      browser: browserDescription,
      isolation: {
        host: "127.0.0.1",
        port: "ephemeral",
        dataDirectory: "random temporary directory; removed during teardown",
        providers: "built-in mock adapters only",
        externalRequests: 0,
      },
      redaction: REDACTION,
      files: captured,
    };
    writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    log(`\nPASS: ${captured.length} screenshots in ${OUT_DIR}`);
    for (const item of captured) {
      log(`  ${item.file}  ${item.width}x${item.height}  ${item.bytes} bytes  sha256=${item.sha256.slice(0, 16)}…`);
    }
    await context.close();
  } catch (error) {
    const logTail = instance.readLog().trim();
    if (logTail) process.stderr.write(`\ninstance log tail:\n${logTail.slice(-2000)}\n`);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    if (KEEP) {
      log(`kept instance on ${base}; data in ${dataDir}`);
    } else {
      await teardown(instance, dataDir);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
