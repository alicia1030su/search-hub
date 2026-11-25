import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@search-hub/db";
import { restrictWindowsAcl } from "@search-hub/backup";
import {
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

  it("backup verify never leaks a stdin token on a successful legacy verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "shub-backup-canary-"));
    directories.push(root);
    const dataDir = join(root, "data");
    await mkdir(dataDir);
    const dbPath = join(dataDir, "search-hub.db");
    const keyPath = join(dataDir, "master.key");
    const db = createDb({ file: dbPath });
    try { runMigrations(db.sqlite, join(process.cwd(), "packages", "db", "migrations")); } finally { db.close(); }
    await writeFile(keyPath, `${"5a".repeat(32)}\n`, { mode: 0o600 });
    await chmod(dbPath, 0o600);
    await chmod(keyPath, 0o600);
    if (process.platform === "win32") {
      await restrictWindowsAcl(dataDir, true);
      await restrictWindowsAcl(dbPath, false);
      await restrictWindowsAcl(keyPath, false);
    }
    const env = cliEnvironment("http://127.0.0.1:1");
    delete env.SEARCH_HUB_TOKEN;
    cleanups.push(() => cleanupEnvironment(env));
    const token = "sh_stdin_backup_canary_1234567890";
    const result = await runCli(["--token-stdin", "backup", "verify", dbPath, "--legacy", "--data-dir", dataDir, "--json"], env, `${token}\n`);
    expect(result.status).toBe(0);
    expectNoToken(result, token);
  });

  it("backup verify never leaks a stdin token when the package path contains it", async () => {
    const root = await mkdtemp(join(tmpdir(), "shub-backup-canary-failure-"));
    directories.push(root);
    const env = cliEnvironment("http://127.0.0.1:1");
    delete env.SEARCH_HUB_TOKEN;
    cleanups.push(() => cleanupEnvironment(env));
    const token = "sh_stdin_backup_failure_canary_1234567890";
    const missing = join(root, `${token}.shbackup`);
    const result = await runCli(["--token-stdin", "backup", "verify", missing, "--data-dir", root, "--json"], env, `${token}\n`);
    expect(result.status).not.toBe(0);
    expectNoToken(result, token);
  });
});
