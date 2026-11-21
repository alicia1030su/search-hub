import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupEnvironment,
  cliEnvironment,
  health,
  json,
  providersResponse,
  runCli,
  startStub,
  type StubHandler,
} from "./support.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handler: StubHandler, token = "sh_super_secret_token_1234567890") {
  const server = await startStub(handler);
  const env = cliEnvironment(server.url, token);
  cleanups.push(() => cleanupEnvironment(env), () => server.close());
  return { server, env };
}

describe("CLI security", () => {
  it("C17 never prints the bearer token, even when a server echoes it", async () => {
    const token = "sh_super_secret_token_1234567890";
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 500, { error: { code: "internal_error", message: `upstream echoed ${token}`, details: { authorization: `Bearer ${token}` } } });
    }, token);
    const result = await runCli(["search", "Linux", "--json"], env);
    expect(result.status).toBe(6);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    expect(JSON.parse(result.stdout).error.message).toContain("[redacted]");
  });

  it("C18 config commands never persist the environment token", async () => {
    const token = "sh_super_secret_token_1234567890";
    const { env } = await fixture((_request, response) => json(response, 200, health()), token);
    const set = await runCli(["config", "set", "url", env["SEARCH_HUB_URL"]!], env);
    expect(set.status).toBe(0);
    const path = join(env["SEARCH_HUB_CLI_CONFIG_DIR"]!, "config.json");
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({ url: env["SEARCH_HUB_URL"] });
    const list = await runCli(["config", "list", "--json"], env);
    expect(list.status).toBe(0);
    expect(list.stdout).not.toContain(token);
  });

  it("C19 maps 401 to authentication failure", async () => {
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 401, { error: { code: "unauthorized", message: "Invalid token" } });
    });
    const result = await runCli(["sources", "--json"], env);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).error.code).toBe("unauthorized");
  });

  it("C20 maps 403 to permission failure", async () => {
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 403, { error: { code: "forbidden", message: "Token is missing sources:read" } });
    });
    const result = await runCli(["sources", "--json"], env);
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stdout).error.code).toBe("forbidden");
  });

  it("C21 refuses cross-origin redirects and never forwards Authorization", async () => {
    const target = await startStub((_request, response) => json(response, 200, providersResponse()));
    cleanups.push(() => target.close());
    const token = "sh_super_secret_token_1234567890";
    const source = await startStub((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      response.writeHead(302, { location: `${target.url}/api/providers` });
      response.end();
    });
    const env = cliEnvironment(source.url, token);
    cleanups.push(() => cleanupEnvironment(env), () => source.close());
    const result = await runCli(["sources", "--json"], env);
    expect(result.status).toBe(5);
    expect(target.requests).toHaveLength(0);
    expect(JSON.parse(result.stdout).error.code).toBe("cross_origin_redirect");
  });

  it("allows same-origin GET redirects without leaking credentials", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url === "/api/providers") {
        response.writeHead(302, { location: "/api/providers-final" });
        response.end();
        return;
      }
      return json(response, 200, providersResponse());
    });
    const result = await runCli(["sources", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url === "/api/providers-final")?.headers["authorization"]).toBe("Bearer sh_super_secret_token_1234567890");
  });

  it("C22 rejects remote HTTP before making a request", async () => {
    const env = cliEnvironment("http://search.example.com");
    try {
      const result = await runCli(["status", "--json"], env);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error.message).toContain("HTTPS");
    } finally {
      cleanupEnvironment(env);
    }
  });

  it("C23 does not disable TLS verification for a self-signed local server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shub-tls-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
    const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(health()));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("TLS stub did not bind");
    const env = cliEnvironment(`https://localhost:${address.port}`);
    cleanups.push(() => cleanupEnvironment(env));
    const result = await runCli(["status", "--json"], env);
    expect(result.status).toBe(5);
    expect(JSON.parse(result.stdout).error.code).toBe("network_error");
  });

  it("C24 never invokes a shell for query text", async () => {
    const marker = join(tmpdir(), `shub-shell-${process.pid}-${Date.now()}`);
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, { taskId: "task_123", query: String((request.body as { query?: unknown }).query), mode: "basic", status: "completed", results: [], stats: { rawCount: 0, dedupedCount: 0, fusedCount: 0, providers: [], timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 }, rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false }, errors: [], failedSources: [] });
    });
    const result = await runCli(["search", `$(touch ${marker})`, "--json"], env);
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("reads a token from stdin without echoing or saving it", async () => {
    const token = "sh_stdin_secret_token_1234567890";
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, providersResponse());
    }, "");
    delete env["SEARCH_HUB_TOKEN"];
    const result = await runCli(["--token-stdin", "sources", "--json"], env, `${token}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(token);
    expect(server.requests.find((request) => request.url === "/api/providers")?.headers["authorization"]).toBe(`Bearer ${token}`);
  });

  it("uses explicit --url ahead of the environment URL", async () => {
    const first = await startStub((_request, response) => json(response, 500, { error: { code: "wrong_server", message: "wrong" } }));
    const second = await startStub((_request, response) => json(response, 200, health()));
    cleanups.push(() => first.close(), () => second.close());
    const env = cliEnvironment(first.url);
    cleanups.push(() => cleanupEnvironment(env));
    const result = await runCli(["--url", second.url, "status", "--json"], env);
    expect(result.status).toBe(0);
    expect(first.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(1);
  });

  it("refuses to save a remote HTTP URL", async () => {
    const env = cliEnvironment("http://127.0.0.1:1");
    cleanups.push(() => cleanupEnvironment(env));
    const result = await runCli(["config", "set", "url", "http://search.example.com", "--json"], env);
    expect(result.status).toBe(2);
    expect(existsSync(join(env["SEARCH_HUB_CLI_CONFIG_DIR"]!, "config.json"))).toBe(false);
  });
});
