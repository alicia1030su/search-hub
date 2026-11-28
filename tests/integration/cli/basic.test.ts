import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_ENTRY,
  batchJob,
  cleanupEnvironment,
  cliEnvironment,
  health,
  json,
  providersResponse,
  runCli,
  searchResponse,
  startStub,
  type StubHandler,
} from "./support.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handler: StubHandler, token = "sh_test_token_1234567890") {
  const server = await startStub(handler);
  const env = cliEnvironment(server.url, token);
  cleanups.push(() => cleanupEnvironment(env), () => server.close());
  return { server, env };
}

function streamEvent(type: string, sequence: number, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sequence, final: type === "done", ...data });
}

function sseFrame(value: string): string {
  return `event: search\ndata: ${value}\n\n`;
}

function standardHandler(overrides: { search?: unknown; searchStatus?: number; version?: string } = {}): StubHandler {
  return (request, response) => {
    if (request.url === "/api/health") return json(response, 200, health(overrides.version));
    if (request.url === "/api/search" || request.url === "/api/search/deep") {
      return json(response, overrides.searchStatus ?? 200, overrides.search ?? searchResponse());
    }
    if (request.url === "/api/providers") return json(response, 200, providersResponse());
    return json(response, 404, { error: { code: "not_found", message: "not found" } });
  };
}

describe("CLI basic and search commands", () => {
  it("C01 shows help", async () => {
    const result = await runCli(["--help"], cliEnvironment("http://127.0.0.1:1"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("shub search");
  });

  it("C03 performs a normal search and preserves provider attribution", async () => {
    const { server, env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--json"], env);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.taskId).toBe("task_123");
    expect(body.results[0].providerName).toBe("Mock");
    const search = server.requests.find((request) => request.url === "/api/search");
    expect(search?.body).toMatchObject({ query: "Linux", limit: 20, mode: "basic" });
    expect(search?.headers["authorization"]).toBe("Bearer sh_test_token_1234567890");
  });

  it("C04 passes Chinese queries as UTF-8", async () => {
    const { server, env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux 内核最新变化", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url === "/api/search")?.body).toMatchObject({ query: "Linux 内核最新变化" });
  });

  it("C05 passes Unicode and shell metacharacters literally", async () => {
    const { server, env } = await fixture(standardHandler());
    const query = "AI 搜索 🚀 $(touch should-not-exist) && echo unsafe";
    const result = await runCli(["search", query, "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url === "/api/search")?.body).toMatchObject({ query });
  });

  it("C06 maps --provider to the providers array", async () => {
    const { server, env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--provider", "prv_1,prv_2", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url === "/api/search")?.body).toMatchObject({ providers: ["prv_1", "prv_2"] });
  });

  it("C07 maps --group, --mode, --language, --freshness and --timeout", async () => {
    const { server, env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--group", "news", "--mode", "rrf", "--language", "zh-CN", "--freshness", "week", "--timeout", "15000", "--limit", "7", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url === "/api/search")?.body).toMatchObject({
      group: "news",
      mode: "rrf",
      language: "zh-CN",
      freshness: "week",
      timeoutMs: 15000,
      limit: 7,
    });
  });

  it("C08 routes deep mode to the deep-search endpoint", async () => {
    const { server, env } = await fixture(standardHandler());
    const result = await runCli(["search", "AI 搜索技术", "--mode", "deep", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.some((request) => request.url === "/api/search/deep")).toBe(true);
    expect(server.requests.some((request) => request.url === "/api/search")).toBe(false);
  });

  it("streams live SSE events by default and prints one authoritative final result", async () => {
    const completed = searchResponse();
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health("0.1.18"));
      if (request.url !== "/api/search/stream") return json(response, 404, { error: { code: "not_found", message: "not found" } });
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(sseFrame(streamEvent("meta", 1, { taskId: completed.taskId, mode: "basic" })));
      response.write(sseFrame(streamEvent("status", 2, { stage: "provider_started", providerId: "prv_1" })));
      response.write(sseFrame(streamEvent("results", 3, { results: [{ title: "Temporary result", url: "https://example.com/tmp", providerName: "Mock" }] })));
      response.end(sseFrame(streamEvent("done", 4, completed)));
    });
    const result = await runCli(["search", "Linux", "--stream", "--limit", "5"], env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[provider] stage=provider_started providerId=prv_1");
    expect(result.stdout).toContain("[results_updated] [temporary]");
    expect(result.stdout.match(/\[final\]/g)).toHaveLength(1);
    expect(result.stdout).toContain("Linux result");
    const stream = server.requests.find((request) => request.url === "/api/search/stream");
    expect(stream?.headers["authorization"]).toBe("Bearer sh_test_token_1234567890");
    expect(stream?.body).toMatchObject({ query: "Linux", limit: 5, stream: "sse" });
  });

  it("streams NDJSON when --stream-format ndjson is selected", async () => {
    const completed = searchResponse();
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health("0.1.18"));
      if (request.url !== "/api/search/stream") return json(response, 404, { error: { code: "not_found", message: "not found" } });
      response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      response.end([
        streamEvent("meta", 1, { taskId: completed.taskId }),
        streamEvent("results", 2, { results: [] }),
        streamEvent("done", 3, completed),
      ].join("\n") + "\n");
    });
    const result = await runCli(["search", "Linux", "--stream", "--stream-format", "ndjson", "--format", "ndjson"], env);
    expect(result.status, result.stderr).toBe(0);
    const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual(["meta", "results", "done"]);
    expect(events[1].resultSet).toBe("temporary");
    expect(events[2]).toMatchObject({ resultSet: "final", results: completed.results });
    expect(server.requests.find((request) => request.url === "/api/search/stream")?.body).toMatchObject({ stream: "ndjson" });
  });

  it("rejects --stream-format without --stream before opening a stream", async () => {
    const { server, env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--stream-format", "ndjson"], env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--stream-format requires --stream");
    expect(server.requests.some((request) => request.url === "/api/search/stream")).toBe(false);
  });

  it("returns 130 for a status-based cancelled terminal event", async () => {
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health("0.1.18"));
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(JSON.stringify({ type: "status", sequence: 1, final: true, status: "cancelled", terminal: true, message: "Search cancelled" }) + "\n");
    });
    const result = await runCli(["search", "Linux", "--stream", "--stream-format", "ndjson", "--format", "ndjson"], env);
    expect(result.status).toBe(130);
    const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "status", status: "cancelled", terminal: true, final: true, resultSet: "final" });
    expect(result.stderr).toContain("Search cancelled");
  });

  it("C09 keeps partial results and returns zero by default", async () => {
    const partial = searchResponse({
      status: "partial",
      stats: { ...searchResponse().stats, partial: true },
      errors: [{ providerId: "prv_2", providerName: "Broken", code: "timeout", message: "timed out" }],
      failedSources: [{ id: "prv_2", code: "timeout" }],
    });
    const { env } = await fixture(standardHandler({ search: partial }));
    const result = await runCli(["search", "Linux", "--json"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).results).toHaveLength(1);
    expect(result.stderr).toContain("partially");
  });

  it("C10 preserves a failed search response and returns non-zero", async () => {
    const failed = searchResponse({ status: "failed", results: [], errors: [{ providerId: "prv_1", providerName: "Mock", code: "server_error", message: "failed" }], failedSources: [{ id: "prv_1", code: "server_error" }] });
    const { env } = await fixture(standardHandler({ search: failed, searchStatus: 503 }));
    const result = await runCli(["search", "Linux", "--json"], env);
    expect(result.status).toBe(6);
    expect(JSON.parse(result.stdout).status).toBe("failed");
    expect(result.stderr).toContain("Search failed");
  });

  it("C11/C12 emits only valid JSON on stdout", async () => {
    const { env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--format", "json"], env);
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toBe("");
  });

  it("keeps argument errors machine-readable in JSON mode", async () => {
    const env = cliEnvironment("http://127.0.0.1:1");
    cleanups.push(() => cleanupEnvironment(env));
    const result = await runCli(["search", "Linux", "--not-a-real-option", "--json"], env);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("invalid_arguments");
  });

  it("C13 pipes JSON through jq on Linux", async () => {
    if (process.platform !== "linux") return;
    const { env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--json"], env);
    const parsed = spawnSync("jq", ["-e", ".taskId == \"task_123\""], { input: result.stdout, encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("C14 parses JSON with PowerShell ConvertFrom-Json on Windows", async () => {
    if (process.platform !== "win32") return;
    const { env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--json"], env);
    const parsed = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$input | ConvertFrom-Json | Out-Null"], { input: result.stdout, encoding: "utf8" });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it("C15 preserves errors and failedSources in JSON", async () => {
    const partial = searchResponse({ status: "partial", errors: [{ providerId: "prv_2", providerName: "Broken", code: "timeout", message: "timed out" }], failedSources: [{ id: "prv_2", code: "timeout" }] });
    const { env } = await fixture(standardHandler({ search: partial }));
    const body = JSON.parse((await runCli(["search", "Linux", "--json"], env)).stdout);
    expect(body.errors).toHaveLength(1);
    expect(body.failedSources).toEqual([{ id: "prv_2", code: "timeout" }]);
  });

  it("C16 --strict turns partial success into a non-zero exit", async () => {
    const partial = searchResponse({ status: "partial", stats: { ...searchResponse().stats, partial: true } });
    const { env } = await fixture(standardHandler({ search: partial }));
    const result = await runCli(["search", "Linux", "--strict", "--json"], env);
    expect(result.status).toBe(6);
    expect(JSON.parse(result.stdout).results).toHaveLength(1);
  });

  it("emits honest non-streaming NDJSON with metadata, results and completion", async () => {
    const { env } = await fixture(standardHandler());
    const result = await runCli(["search", "Linux", "--format", "ndjson"], env);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(["metadata", "result", "complete"]);
    expect(lines[0].streaming).toBe(false);
    expect(lines[2].stats.rawCount).toBe(1);
  });

  it("C48 works against a server reporting v0.1.12", async () => {
    const { env } = await fixture(standardHandler({ version: "0.1.12" }));
    const result = await runCli(["search", "compatibility", "--json"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).taskId).toBe("task_123");
  });

  it("rejects an incompatible server before searching", async () => {
    const { server, env } = await fixture(standardHandler({ version: "0.1.11" }));
    const result = await runCli(["search", "Linux", "--json"], env);
    expect(result.status).toBe(8);
    expect(server.requests.some((request) => request.url === "/api/search")).toBe(false);
  });
});

describe("CLI network behavior", () => {
  it("C36 reports an unreachable server", async () => {
    const env = cliEnvironment("https://127.0.0.1:1");
    try {
      const result = await runCli(["status", "--json"], env);
      expect(result.status).toBe(5);
      expect(JSON.parse(result.stdout).error.code).toBe("network_error");
    } finally {
      cleanupEnvironment(env);
    }
  });

  it("C37 reports DNS failure", async () => {
    const env = cliEnvironment("https://does-not-exist.invalid");
    try {
      const result = await runCli(["status", "--json"], env);
      expect(result.status).toBe(5);
      expect(result.stderr).toBe("");
    } finally {
      cleanupEnvironment(env);
    }
  });

  it("C39 surfaces Retry-After without retrying a paid POST", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 429, { error: { code: "rate_limited", message: "Slow down" } }, { "retry-after": "2" });
    });
    const result = await runCli(["search", "Linux", "--json"], env);
    expect(result.status).toBe(6);
    expect(JSON.parse(result.stdout).error.retryAfterMs).toBe(2000);
    expect(server.requests.filter((request) => request.url === "/api/search")).toHaveLength(1);
  });

  it("C40 maps a 503 error envelope to server failure", async () => {
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 503, { error: { code: "server_error", message: "Upstream unavailable" } });
    });
    const result = await runCli(["search", "Linux", "--json"], env);
    expect(result.status).toBe(6);
    expect(JSON.parse(result.stdout).error.message).toContain("Upstream unavailable");
  });

  it("C41/C43 times out without retrying the billable POST", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      setTimeout(() => json(response, 200, searchResponse()), 1_500);
    });
    const result = await runCli(["search", "Linux", "--timeout", "1000", "--json"], env);
    expect(result.status).toBe(7);
    expect(server.requests.filter((request) => request.url === "/api/search")).toHaveLength(1);
  });

  it("C42 Ctrl+C aborts local waiting with exit code 130", async () => {
    if (process.platform !== "linux") return;
    let started!: () => void;
    const requestStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      started();
      setTimeout(() => json(response, 200, searchResponse()), 5_000);
    });
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "search", "Linux", "--json"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    await requestStarted;
    child.kill("SIGINT");
    const status = await new Promise<number | null>((resolveStatus) => child.on("close", resolveStatus));
    expect(status).toBe(130);
    expect(JSON.parse(stdout).error.code).toBe("interrupted");
  });
});

describe("CLI sources, status and batch output", () => {
  it("lists sources with sources:read and supports --enabled", async () => {
    const { server, env } = await fixture(standardHandler());
    const result = await runCli(["sources", "--enabled", "--json"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).providers).toHaveLength(1);
    expect(server.requests.find((request) => request.url === "/api/providers")?.headers["authorization"]).toBeTruthy();
  });

  it("status reports server and CLI versions without management topology", async () => {
    const { env } = await fixture(standardHandler());
    const result = await runCli(["status", "--json"], env);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.version).toBe("0.1.12");
    expect(body.cliVersion).toBe(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version);
    expect(body.compatible).toBe(true);
    expect(body.proxy).toBeUndefined();
  });

  it("doctor accepts search plus sources:read without requiring admin", async () => {
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url === "/api/search/tasks/shub-doctor-permission-check") return json(response, 404, { error: { code: "not_found", message: "not found" } });
      if (request.url === "/api/providers") return json(response, 200, providersResponse());
      return json(response, 403, { error: { code: "forbidden", message: "admin scope required" } });
    });
    const result = await runCli(["doctor", "--json"], env);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(true);
    expect(body.checks.find((check: { name: string }) => check.name === "admin_scope").ok).toBe(false);
  });

  it("C32 polls a batch job until its real terminal state", async () => {
    let polls = 0;
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url?.startsWith("/api/admin/provider-health/batch-test/preview")) return json(response, 200, { kind: "search", total: 1, counts: { eligible: 1, noKey: 0, noEnabledKey: 0, configError: 0, disabled: 0, keylessSkipped: 0, coolingSkipped: 0 }, budget: { remainingRun: 3 }, paidRisk: false, estimatedPaidProbes: 0, estimatedAnonymousProbes: 0 });
      if (request.url === "/api/admin/provider-health/batch-test" && request.method === "POST") return json(response, 201, { jobId: "job_123", status: "running", total: 1, concurrency: 1 });
      if (request.url === "/api/admin/provider-health/batch-test/job_123") {
        polls += 1;
        return json(response, 200, batchJob(polls === 1 ? { status: "running", counts: { total: 1, done: 0, ok: 0, failed: 0, pending: 0, skipped: 0, remaining: 1 }, nextPollAfterMs: 100 } : {}));
      }
      return json(response, 404, { error: { code: "not_found", message: "not found" } });
    });
    const result = await runCli(["providers", "test", "--all", "--json", "--poll-interval", "100"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("completed");
    expect(polls).toBe(2);
    expect(server.requests.filter((request) => request.url === "/api/admin/provider-health/batch-test" && request.method === "POST")).toHaveLength(1);
  });
});
