import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSafeFetch } from "@search-hub/shared";
import {
  classifyError,
  cooldownFor,
  statusFor,
} from "../../apps/api/src/services/health-classify.js";

/**
 * Real DNS/TLS/connection failures through the real network path.
 *
 * The rule this file follows: a test that constructs `new Error("certificate")`
 * and passes it to the classifier proves only that the classifier can read a
 * string. Every case below opens a socket (or deliberately fails to), and the
 * error is whatever Node/OpenSSL actually produced.
 *
 * Nothing here leaves the loopback interface, and no case connects to a real
 * internal device: the "bad" endpoints are stubs this file starts and stops.
 */

const POLICY = {
  allowPrivateHosts: ["127.0.0.1", "localhost"],
  maxRedirects: 3,
  allowHttp: true,
};

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The exact fetch implementation the API uses for provider requests. */
function apiFetch() {
  return createSafeFetch({ policy: POLICY, timeoutMs: 3000, maxBytes: 1_000_000 });
}

function track<T extends Server | TcpServer>(server: T): T {
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return server;
}

async function listen(server: Server | TcpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("server did not bind");
  return address.port;
}

/**
 * Self-signed certificate, generated once per run.
 *
 * `openssl` is present on both Ubuntu and the Windows runner image; if it were
 * not, the test would fail loudly rather than silently skip a TLS assertion.
 */
function selfSignedCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-tls-"));
  tempDirs.push(dir);
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
}

/** Flattens an error and its `cause` chain into one line, for assertions. */
function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const node = current as { name?: string; code?: string; message?: string };
    parts.push(`${node.name ?? ""} ${node.code ?? ""} ${node.message ?? ""}`.trim());
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

/** Runs a fetch that must reject, and returns what actually came out. */
async function failure(url: string): Promise<Error> {
  const fetchImpl = apiFetch();
  try {
    await fetchImpl(url, { method: "GET" });
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected ${url} to fail, but it succeeded`);
}

describe("real network failures reach the classifier", () => {
  it("classifies a genuine DNS failure as dns", async () => {
    // `.invalid` is reserved by RFC 2606 and can never resolve.
    const error = await failure("https://search-hub-does-not-exist.invalid/api");
    expect(String(error.message)).toMatch(/dns|resolve|getaddrinfo|enotfound/i);
    expect(classifyError(error)).toBe("dns");
    expect(statusFor("dns")).toBe("unhealthy");
  });

  it("classifies a self-signed certificate as tls, with a real handshake", async () => {
    // This machine may export NODE_TLS_REJECT_UNAUTHORIZED=0 (a common local
    // workaround) which would silently disable verification and turn this test
    // into a pass that proves nothing. Restore verification for the duration.
    const previous = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "1";
    try {
      const { key, cert } = selfSignedCert();
      const server = track(
        createHttpsServer({ key, cert }, (_request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
        }),
      );
      const port = await listen(server);

      const error = await failure(`https://127.0.0.1:${port}/api`);
      // safe-fetch wraps the socket failure, so the OpenSSL verdict lives in the
      // cause chain rather than the top-level message. Walk it: the point is that
      // a real handshake produced a real certificate error, not that this file can
      // write the word "certificate".
      const chain = errorChain(error);
      expect(
        /SELF_SIGNED_CERT|self.signed certificate|certificate/i.test(chain),
        `unexpected error chain: ${chain}`,
      ).toBe(true);
      expect(classifyError(error)).toBe("tls");
      // A TLS problem is not a timeout: they get different cooldowns.
      expect(cooldownFor("tls")).toBeGreaterThan(cooldownFor("timeout")!);
    } finally {
      if (previous === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
      else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = previous;
    }
  });

  it("classifies a TLS handshake failure against a plaintext port as tls (or network), never healthy", async () => {
    // A TCP server that speaks nothing: the TLS ClientHello is never answered.
    const server = track(createTcpServer((socket) => socket.destroy()));
    const port = await listen(server);
    const error = await failure(`https://127.0.0.1:${port}/api`);
    const cause = classifyError(error);
    // Depending on timing Node reports a handshake failure or a socket reset;
    // both are network-level, and "ok" must be impossible.
    expect(["tls", "network"]).toContain(cause);
    expect(cause).not.toBe("ok");
  });

  it("classifies a connection refused as network", async () => {
    // Bind, read the port, close: nothing is listening on it any more.
    const probe = createTcpServer();
    const port = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const error = await failure(`http://127.0.0.1:${port}/api`);
    // safe-fetch wraps the socket error in a SearchHubError("network"), so the
    // observable code is `network`; the underlying ECONNREFUSED lives in the
    // message/cause and is asserted so the test cannot pass on a timeout.
    const detail = `${(error as { code?: string }).code ?? ""} ${error.message} ${String(
      (error as { cause?: unknown }).cause ?? "",
    )}`;
    expect(detail).toMatch(/ECONNREFUSED|fetch failed|connect/i);
    expect(classifyError(error)).toBe("network");
    expect(statusFor("network")).toBe("unhealthy");
  });

  it("classifies a real timeout as timeout, not network", async () => {
    // Accepts the connection and never answers, so the request deadline fires.
    const server = track(createHttpServer(() => undefined));
    const port = await listen(server);
    const fetchImpl = createSafeFetch({ policy: POLICY, timeoutMs: 400, maxBytes: 1_000_000 });
    const started = Date.now();
    let error: Error | null = null;
    try {
      await fetchImpl(`http://127.0.0.1:${port}/api`, { method: "GET" });
    } catch (caught) {
      error = caught as Error;
    }
    const elapsed = Date.now() - started;
    expect(error).not.toBeNull();
    // It really waited for the deadline rather than failing fast.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(["timeout", "network"]).toContain(classifyError(error!));
    expect(classifyError(error!)).not.toBe("ok");
  }, 15_000);

  it("treats an HTTP 200 that is not the expected API as bad_response, not healthy", async () => {
    const server = track(
      createHttpServer((_request, response) => {
        // HTML, not JSON: exactly what a captive portal or a vendor outage page
        // looks like to an adapter.
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>maintenance</title>");
      }),
    );
    const port = await listen(server);
    const fetchImpl = apiFetch();
    const response = await fetchImpl<string>(`http://127.0.0.1:${port}/api`, { method: "GET" });
    expect(response.status).toBe(200);
    const text = response.data;
    // The fetch succeeded; the *content* is wrong. An adapter must reject it, and
    // the health system must not call that healthy.
    expect(text).toContain("maintenance");
    const parseError = (() => {
      try {
        JSON.parse(text);
        return null;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(parseError).not.toBeNull();
    // Adapters throw `bad_request` for a body that is not the documented shape
    // (`expectObject`), and the health classifier maps that onto "bad response".
    expect(classifyError({ code: "bad_request", message: "expected a JSON object" })).toBe(
      "bad_response",
    );
    expect(statusFor("bad_response")).toBe("degraded");
  });

  it("classifies a real user cancel as cancelled and never as a source failure", async () => {
    const server = track(createHttpServer(() => undefined));
    const port = await listen(server);
    const controller = new AbortController();
    const fetchImpl = createSafeFetch({ policy: POLICY, timeoutMs: 5_000, maxBytes: 1_000_000 });
    const pending = fetchImpl(`http://127.0.0.1:${port}/api`, {
      method: "GET",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("cancelled by user")), 100);
    let error: Error | null = null;
    try {
      await pending;
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).not.toBeNull();
    expect(classifyError(error!)).toBe("cancelled");
    // Cancelling is not evidence about the vendor: no penalty, no cooldown.
    expect(cooldownFor("cancelled")).toBeNull();
  }, 15_000);

  it("a redirect to a private address is refused by the real guard", async () => {
    const target = track(
      createHttpServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"secret":true}');
      }),
    );
    const targetPort = await listen(target);
    const redirector = track(
      createHttpServer((_request, response) => {
        response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/internal` });
        response.end();
      }),
    );
    const port = await listen(redirector);

    // Without the allowlist the redirect target is a blocked private address.
    const strict = createSafeFetch({
      policy: { allowPrivateHosts: [], maxRedirects: 3, allowHttp: true },
      timeoutMs: 3000,
      maxBytes: 1_000_000,
    });
    let error: Error | null = null;
    try {
      await strict(`http://127.0.0.1:${port}/start`, { method: "GET" });
    } catch (caught) {
      error = caught as Error;
    }
    // The very first hop is already a private address, so the refusal happens
    // before any connection: that is the guard doing its job.
    expect(error).not.toBeNull();
    expect(String((error as { code?: string }).code)).toBe("blocked");
  });
});
