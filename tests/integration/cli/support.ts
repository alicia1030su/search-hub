import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CLI_ENTRY = join(root, "packages", "cli", "src", "index.ts");

export interface CliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface StubRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export type StubHandler = (request: StubRequest, response: ServerResponse) => void | Promise<void>;

export interface StubServer {
  url: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}

export async function startStub(handler: StubHandler): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const record = { method: request.method ?? "GET", url: request.url ?? "/", headers: request.headers, body };
    requests.push(record);
    await handler(record, response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

export function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

export function cliEnvironment(url: string, token = "sh_test_token_1234567890"): NodeJS.ProcessEnv {
  const configDir = mkdtempSync(join(tmpdir(), "shub-config-"));
  return {
    ...process.env,
    SEARCH_HUB_URL: url,
    SEARCH_HUB_TOKEN: token,
    SEARCH_HUB_CLI_CONFIG_DIR: configDir,
  };
}

export function cleanupEnvironment(env: NodeJS.ProcessEnv): void {
  if (env["SEARCH_HUB_CLI_CONFIG_DIR"]) rmSync(env["SEARCH_HUB_CLI_CONFIG_DIR"], { recursive: true, force: true });
}

export function runCliSync(args: string[], env: NodeJS.ProcessEnv = cliEnvironment("http://127.0.0.1:1")): CliResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, ...args], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: ${args.join(" ")}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

export function health(version = "0.1.12") {
  return {
    status: "ok",
    version,
    uptimeSeconds: 42,
    setupRequired: false,
    providers: { total: 2, enabled: 1, healthy: 1, circuitOpen: 0 },
    database: { driver: "sqlite", migrations: 11 },
  };
}

export function searchResponse(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task_123",
    query: "Linux",
    mode: "basic",
    status: "completed",
    results: [
      {
        id: "res_1",
        title: "Linux result",
        url: "https://example.com/linux",
        snippet: "A result",
        source: "example",
        provider: "prv_1",
        providerType: "mock",
        providerName: "Mock",
        retrievedAt: "2026-11-21T00:00:00.000Z",
        score: 1,
        sources: [{ providerId: "prv_1", providerName: "Mock", providerType: "mock", rank: 1, url: "https://example.com/linux" }],
      },
    ],
    stats: {
      rawCount: 1,
      dedupedCount: 1,
      fusedCount: 1,
      providers: [{ providerId: "prv_1", providerName: "Mock", providerType: "mock", ok: true, latencyMs: 5, resultCount: 1, attempts: 1, httpRequests: 1 }],
      timing: { totalMs: 5, fanoutMs: 3, fusionMs: 1 },
      rerankApplied: false,
      embeddingApplied: false,
      summaryApplied: false,
      partial: false,
    },
    errors: [],
    failedSources: [],
    ...overrides,
  };
}

export function providersResponse() {
  return {
    providers: [
      {
        id: "prv_1",
        name: "Mock",
        type: "mock",
        enabled: true,
        keyCount: 0,
        healthyKeyCount: 0,
        availableKeyCount: 0,
        ready: true,
        notReadyReason: null,
        circuitOpen: false,
      },
    ],
    status: [{ providerId: "prv_1", providerName: "Mock", providerType: "mock", enabled: true, healthy: true, circuitOpen: false, circuitOpenUntil: null, keys: [] }],
    catalog: [],
    adapters: ["mock"],
    manifests: [],
  };
}

export function batchPreview(overrides: Record<string, unknown> = {}) {
  return {
    kind: "search",
    total: 1,
    counts: { eligible: 1, noKey: 0, noEnabledKey: 0, configError: 0, disabled: 0, keylessSkipped: 0, coolingSkipped: 0 },
    budget: { remainingRun: 3 },
    paidRisk: false,
    estimatedPaidProbes: 0,
    estimatedAnonymousProbes: 0,
    ...overrides,
  };
}

export function batchJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job_123",
    status: "completed",
    kind: "search",
    counts: { total: 1, done: 1, ok: 1, failed: 0, pending: 0, skipped: 0, remaining: 0 },
    items: [{ providerId: "prv_1", providerName: "Mock", providerType: "mock", keyCount: 0, state: "ok", code: "ok", latencyMs: 5, resultCount: 1, requests: 1, checkId: "chk_1", reason: null, checkedAt: "2026-11-21T00:00:00.000Z" }],
    budget: {},
    includeKeyless: false,
    concurrency: 1,
    startedAt: "2026-11-21T00:00:00.000Z",
    finishedAt: "2026-11-21T00:00:01.000Z",
    nextPollAfterMs: null,
    ...overrides,
  };
}
