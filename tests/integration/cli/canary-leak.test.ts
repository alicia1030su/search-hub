import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, afterEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@search-hub/db";
import { restrictWindowsAcl } from "@search-hub/backup";
import { HttpClient } from "../../../packages/cli/src/client/http.js";
import {
  CLI_ENTRY,
  batchPreview,
  cleanupEnvironment,
  cliEnvironment,
  health,
  json,
  providersResponse,
  runCli,
  searchResponse,
  startStub,
  type CliResult,
  type StubHandler,
} from "./support.js";

const cleanups: Array<() => Promise<void> | void> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(handler: StubHandler, token = "") {
  const server = await startStub(handler);
  const env = cliEnvironment(server.url, token);
  delete env.SEARCH_HUB_TOKEN;
  cleanups.push(() => cleanupEnvironment(env), () => server.close());
  return { server, env };
}

function expectNoToken(result: CliResult, token: string): void {
  expect(result.stdout).not.toContain(token);
  expect(result.stderr).not.toContain(token);
}

function containsToken(value: unknown, token: string): boolean {
  if (typeof value === "string") return value.includes(token);
  if (value instanceof Error) return value.message.includes(token) || containsToken(value.cause, token);
  if (Array.isArray(value)) return value.some((item) => containsToken(item, token));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsToken(item, token));
  }
  return false;
}

interface OpenStdinCliResult extends CliResult {
  timedOut: boolean;
}

function runCliWithOpenStdin(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string,
  timeoutMs = 5_000,
): Promise<OpenStdinCliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr, timedOut });
    };
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(input);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", finish);
  });
}

function echoFailure(response: Parameters<typeof json>[0], token: string): void {
  json(response, 500, {
    error: {
      code: "internal_error",
      message: `upstream echoed ${token}`,
      details: { authorization: `Bearer ${token}` },
    },
  });
}

function probeResponse(token: string) {
  return {
    result: {
      ok: true,
      latencyMs: 12,
      resultCount: 1,
      message: token,
      status: "healthy",
      cause: "ok",
      errorCode: null,
      requests: 1,
      billingUnit: "unknown",
      spent: false,
      kind: "search",
      keyId: null,
      checkedAt: "2026-11-21T00:00:00.000Z",
    },
    budget: { remainingRun: 2 },
  };
}

const commandCases: Array<{
  name: string;
  args: string[];
  success: StubHandler;
  failure: StubHandler;
}> = [
  {
    name: "search",
    args: ["search", "canary", "--json"],
    success: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      const token = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const base = searchResponse();
      return json(response, 200, searchResponse({
        query: token,
        results: [{ ...base.results[0], title: token, snippet: token }],
      }));
    },
    failure: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      echoFailure(response, String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    },
  },
  {
    name: "sources",
    args: ["sources", "--json"],
    success: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      const body = providersResponse();
      body.providers[0]!.name = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      return json(response, 200, body);
    },
    failure: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      echoFailure(response, String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    },
  },
  {
    name: "doctor",
    args: ["doctor", "--json"],
    success: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url === "/api/search/tasks/shub-doctor-permission-check") return json(response, 404, { error: { code: "not_found", message: "not found" } });
      if (request.url === "/api/providers") return json(response, 200, providersResponse());
      return json(response, 403, { error: { code: "forbidden", message: `admin denied ${String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "")}` } });
    },
    failure: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url === "/api/search/tasks/shub-doctor-permission-check") return json(response, 404, { error: { code: "not_found", message: "not found" } });
      echoFailure(response, String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    },
  },
  {
    name: "providers test",
    args: ["providers", "test", "prv_1", "--json"],
    success: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url?.startsWith("/api/admin/provider-health/batch-test/preview")) return json(response, 200, batchPreview());
      return json(response, 200, probeResponse(String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "")));
    },
    failure: (request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      echoFailure(response, String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    },
  },
];

describe("CLI canary leakage", () => {
  it("HttpClient redacts the token from network errors", async () => {
    const token = "sh_http_client_network_canary_1234567890";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`socket failed for ${token}`)));
    try {
      const client = new HttpClient("http://127.0.0.1:1", token, 1000);
      const error = await client.request("/api/health").catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "network_error" });
      expect((error as Error).message).not.toContain(token);
      expect(containsToken((error as { cause?: unknown }).cause, token)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    "https://user:URL_CANARY_123@",
    "https://user:URL_CANARY_123@example.com",
    "https://example.com/?token=URL_CANARY_123",
  ])("does not echo a URL canary for %s", async (rawUrl) => {
    const env = cliEnvironment("http://127.0.0.1:1");
    cleanups.push(() => cleanupEnvironment(env));
    const result = await runCli(["--url", rawUrl, "status", "--json"], env);
    expect(result.status).toBe(2);
    expectNoToken(result, "URL_CANARY_123");
  });

  it("never leaks a stdin-supplied token when URL validation fails", async () => {
    const token = "sh_stdin_top_level_canary_1234567890";
    const env = cliEnvironment(`https://user:${token}@`);
    delete env.SEARCH_HUB_TOKEN;
    cleanups.push(() => cleanupEnvironment(env));

    const result = await runCli(["--token-stdin", "status", "--json"], env, `${token}\n`);

    expect(result.status).toBe(2);
    expectNoToken(result, token);
  });

  it("fails fast without reading stdin when URL validation fails", async () => {
    const token = "sh_stdin_fail_fast_canary_1234567890";
    const env = cliEnvironment(`https://user:${token}@`);
    delete env.SEARCH_HUB_TOKEN;
    cleanups.push(() => cleanupEnvironment(env));

    const result = await runCliWithOpenStdin(
      ["--token-stdin", "status", "--json"],
      env,
      `${token}\n`,
    );

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(2);
    expectNoToken(result, token);
  });

  it("rejects --token-stdin for local backup commands without reading stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "shub-backup-token-reject-"));
    directories.push(root);
    const token = "sh_stdin_local_backup_canary_1234567890";
    const env = cliEnvironment("http://127.0.0.1:1");
    delete env.SEARCH_HUB_TOKEN;
    cleanups.push(() => cleanupEnvironment(env));

    const result = await runCliWithOpenStdin(
      ["--token-stdin", "backup", "verify", join(root, "missing.shbackup"), "--data-dir", root, "--json"],
      env,
      `${token}\n`,
    );

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain("only supported for remote commands");
    expectNoToken(result, token);
  });

  it("rejects combined --token-stdin and --passphrase-stdin without stdin contention", async () => {
    const root = await mkdtemp(join(tmpdir(), "shub-backup-stdin-conflict-"));
    directories.push(root);
    const token = "sh_stdin_conflict_canary_1234567890";
    const passphrase = "sh_passphrase_conflict_canary_1234567890";
    const env = cliEnvironment("http://127.0.0.1:1");
    delete env.SEARCH_HUB_TOKEN;
    cleanups.push(() => cleanupEnvironment(env));

    const result = await runCliWithOpenStdin(
      ["--token-stdin", "--passphrase-stdin", "backup", "verify", join(root, "missing.shbackup"), "--data-dir", root, "--json"],
      env,
      `${token}\n${passphrase}\n`,
    );

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(2);
    expect(output).toMatch(/token-stdin/i);
    expect(output).toMatch(/passphrase-stdin/i);
    expectNoToken(result, token);
    expectNoToken(result, passphrase);
  });

  it.each(commandCases)("$name never leaks a stdin token on success or failure", async ({ args, success, failure }) => {
    const token = "sh_stdin_canary_1234567890";
    const successFixture = await fixture(success);
    const successResult = await runCli(["--token-stdin", ...args], successFixture.env, `${token}\n`);
    expect(successResult.status).toBe(0);
    expectNoToken(successResult, token);

    const failureFixture = await fixture(failure);
    const failureResult = await runCli(["--token-stdin", ...args], failureFixture.env, `${token}\n`);
    expect(failureResult.status).not.toBe(0);
    expectNoToken(failureResult, token);
  });

  it("backup verify never leaks an environment token on a successful legacy verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "shub-backup-canary-"));
    directories.push(root);
    const dataDir = join(root, "data");
    await mkdir(dataDir);
    const dbPath = join(dataDir, "search-hub.db");
    const keyPath = join(dataDir, "master.key");
    const db = createDb({ file: dbPath });
    try {
      runMigrations(db.sqlite, join(process.cwd(), "packages", "db", "migrations"));
      db.sqlite.pragma("journal_mode = DELETE");
      expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      db.close();
    }
    await writeFile(keyPath, `${"5a".repeat(32)}\n`, { mode: 0o600 });
    await chmod(dbPath, 0o600);
    await chmod(keyPath, 0o600);
    if (process.platform === "win32") {
      await restrictWindowsAcl(dataDir, true);
      await restrictWindowsAcl(dbPath, false);
      await restrictWindowsAcl(keyPath, false);
    }
    const token = "sh_env_backup_canary_1234567890";
    const env = cliEnvironment("http://127.0.0.1:1", token);
    cleanups.push(() => cleanupEnvironment(env));
    const result = await runCli(["backup", "verify", dbPath, "--legacy", "--data-dir", dataDir, "--json"], env);
    expect(result.status).toBe(0);
    expectNoToken(result, token);
  });

  it("backup verify never leaks an environment token when the package path contains it", async () => {
    const root = await mkdtemp(join(tmpdir(), "shub-backup-canary-failure-"));
    directories.push(root);
    const token = "sh_env_backup_failure_canary_1234567890";
    const env = cliEnvironment("http://127.0.0.1:1", token);
    cleanups.push(() => cleanupEnvironment(env));
    const missing = join(root, `${token}.shbackup`);
    const result = await runCli(["backup", "verify", missing, "--data-dir", root, "--json"], env);
    expect(result.status).not.toBe(0);
    expectNoToken(result, token);
  });
});
