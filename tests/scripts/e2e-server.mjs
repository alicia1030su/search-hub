// Boots the API (serving the built web bundle) for Playwright.
// Usage: node tests/scripts/e2e-server.mjs
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnedProcessTree, adapter } from "../../scripts/lib/resource/process-tree.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = process.env["E2E_PORT"] ?? "8901";
const dataDir = join(repoRoot, ".data", "e2e");

if (process.env["E2E_KEEP_DATA"] !== "1" && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
}

const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/api/src/index.ts"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      SEARCH_HUB_DATA_DIR: dataDir,
      SEARCH_HUB_PORT: port,
      NODE_ENV: "production",
      SEARCH_HUB_LOG_LEVEL: "warn",
      SEARCH_HUB_COOKIE_SECURE: "false",
      // Fixed first-run token so the Playwright flow is deterministic.
      SEARCH_HUB_SETUP_TOKEN: "e2e-setup-token",
      // The suite drives many navigations per minute; the production default
      // (300/min) is a real gate for deployments, not for the test harness.
      SEARCH_HUB_RATE_LIMIT_PER_MIN: "20000",
    },
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform === "win32",
  },
);

const io = adapter(process.platform);
let tree = null;
let shutdownPromise = null;
let shutdownRequested = false;

async function register() {
  if (!child.pid || child.exitCode !== null) return;
  const root = await io.readProcess(child.pid);
  if (root) tree = new OwnedProcessTree(child.pid, root.identity.startTime, { io, consoleCtrlOwned: process.platform === "win32" });
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownRequested = true;
  shutdownPromise = (async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (tree) {
      const cleanup = await tree.cleanup();
      if (!cleanup.ok) {
        console.error(`e2e-server cleanup failed residuals=${cleanup.residuals.length}`);
        process.exitCode = 1;
      }
    }
  })();
  return shutdownPromise;
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
child.once("error", (error) => {
  console.error(`e2e-server child failed: ${error.message}`);
  process.exitCode = 5;
});
child.once("close", async (code) => {
  await shutdown();
  if (!shutdownRequested) process.exitCode = code ?? 0;
  else if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code ?? 0;
});

try {
  await register();
} catch (error) {
  console.error(`e2e-server identity registration failed: ${error.message}`);
  child.kill("SIGTERM");
  process.exitCode = 5;
}
