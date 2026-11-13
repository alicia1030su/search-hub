// Boots the API (serving the built web bundle) for Playwright.
// Usage: node tests/scripts/e2e-server.mjs
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    },
    stdio: "inherit",
  },
);

const shutdown = () => {
  child.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => process.exit(code ?? 0));
