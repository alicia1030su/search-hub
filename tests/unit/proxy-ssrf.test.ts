import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGuardedLookup,
  createSafeFetch,
  describeOutboundPolicy,
  noProxyMatches,
  proxyForUrl,
  redactProxyUrl,
  resetProxyDispatchers,
  resolveOutboundProxy,
  validateOutboundUrl,
  type HostResolver,
  type SsrfPolicy,
} from "@search-hub/shared";

const POLICY: SsrfPolicy = { allowPrivateHosts: [], maxRedirects: 3, allowHttp: true };

/**
 * A synthetic public address. Tests never dial it: it only exists so the
 * validator sees a routable, non-private answer.
 */
const PUBLIC_ADDRESS = "93.184.216.34";

function makeResolver(overrides: Record<string, string[]> = {}): HostResolver {
  return async (hostname) => {
    const addresses = overrides[hostname.toLowerCase()] ?? [PUBLIC_ADDRESS];
    return addresses.map((address) =>
      address.includes(":") ? { address, family: 6 } : { address, family: 4 },
    );
  };
}

/** Local stand-in for "the public internet": real HTTP on 127.0.0.1. */
async function startOrigin(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

interface ConnectRecord {
  host: string;
  port: number;
  headers: Record<string, string>;
}

interface MockProxy {
  port: number;
  connects: ConnectRecord[];
  forwardRequests: Array<{ method: string; url: string; headers: Record<string, string> }>;
  close: () => Promise<void>;
}

/**
 * Minimal HTTP forward proxy: records every CONNECT and every absolute-form
 * request, and never dials anything outside 127.0.0.1.
 *
 * `tunnelTo` lets a test point the tunnel at a local origin while still
 * asserting which host:port the application *asked* the proxy to reach.
 */
async function startMockProxy(
  options: {
    onConnect?: (req: IncomingMessage, clientSocket: Socket) => void;
    onForward?: (req: IncomingMessage, res: ServerResponse) => void;
    tunnelTo?: { host: string; port: number };
  } = {},
): Promise<MockProxy> {
  const connects: ConnectRecord[] = [];
  const forwardRequests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];

  const server = createServer((req, res) => {
    forwardRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
    });
    if (options.onForward) {
      options.onForward(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("forwarded");
  });

  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const target = req.url ?? "";
    const separator = target.lastIndexOf(":");
    connects.push({
      host: target.slice(0, separator),
      port: Number(target.slice(separator + 1)),
      headers: req.headers as Record<string, string>,
    });
    if (options.onConnect) {
      options.onConnect(req, clientSocket);
      return;
    }
    const upstreamHost = options.tunnelTo?.host ?? target.slice(0, separator);
    const upstreamPort = options.tunnelTo?.port ?? Number(target.slice(separator + 1));
    const upstream = netConnect(upstreamPort, upstreamHost, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) clientSocket.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    port,
    connects,
    forwardRequests,
    close: () =>
      new Promise<void>((resolve) => {
        // Tunnel and keep-alive sockets must be dropped explicitly, otherwise
        // an undici Pool can hold the proxy open for seconds after the test.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
  // Cached proxy dispatchers hold keep-alive sockets; drop them so a suite
  // cannot hang on an undici pool that is still connected to a mock proxy.
  resetProxyDispatchers();
});

function track(close: () => Promise<void>): void {
  cleanup.push(close);
}

describe("direct mode: destination validation", () => {
  const blockedLiterals = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.4.2",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254",
    "169.254.1.1",
    "100.64.0.10",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
  ];

  for (const literal of blockedLiterals) {
    it(`rejects ${literal}`, async () => {
      await expect(validateOutboundUrl(`http://${literal}/`, POLICY)).rejects.toMatchObject({
        code: "blocked",
      });
    });
  }

  const blockedV6 = ["::1", "::ffff:127.0.0.1", "fc00::1", "fd12::3", "fe80::1", "ff02::1"];
  for (const literal of blockedV6) {
    it(`rejects [${literal}]`, async () => {
      await expect(validateOutboundUrl(`http://[${literal}]/`, POLICY)).rejects.toMatchObject({
        code: "blocked",
      });
    });
  }

  const blockedHostnames = [
    "localhost",
    "localhost.",
    "foo.localhost",
    "app.local",
    "printer.local",
    "metadata.google.internal",
  ];
  for (const hostname of blockedHostnames) {
    it(`rejects internal hostname ${hostname}`, async () => {
      await expect(validateOutboundUrl(`http://${hostname}/`, POLICY)).rejects.toMatchObject({
        code: "blocked",
      });
    });
  }

  it("rejects URLs with embedded credentials", async () => {
    await expect(validateOutboundUrl("https://user:pass@example.com/", POLICY)).rejects.toMatchObject(
      { code: "blocked" },
    );
  });

  it("rejects non-http(s) protocols", async () => {
    for (const url of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "ws://example.com/",
      "data:text/plain,hi",
    ]) {
      await expect(validateOutboundUrl(url, POLICY)).rejects.toMatchObject({ code: "blocked" });
    }
  });

  it("rejects plain http when allowHttp is false", async () => {
    await expect(
      validateOutboundUrl("http://example.com/", { ...POLICY, allowHttp: false }),
    ).rejects.toMatchObject({ code: "blocked" });
  });

  it("allows a validated public target and reports the resolved address", async () => {
    const target = await validateOutboundUrl("https://example.public.test/", POLICY, {
      resolveHost: makeResolver({ "example.public.test": [PUBLIC_ADDRESS] }),
    });
    expect(target.allowlisted).toBe(false);
    expect(target.addresses).toEqual([PUBLIC_ADDRESS]);
  });

  it("never allows a metadata address, even when the host is allowlisted", async () => {
    await expect(
      validateOutboundUrl("http://169.254.169.254/", {
        ...POLICY,
        allowPrivateHosts: ["169.254.169.254"],
      }),
    ).rejects.toMatchObject({ code: "blocked" });
  });

  it("fetches an allowlisted local origin in direct mode", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    track(origin.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
    });
    const response = await safeFetch<{ ok: boolean }>(`http://127.0.0.1:${origin.port}/`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
  });
});

describe("DNS rebinding", () => {
  it("connect-time lookup refuses (ERR_SSRF_BLOCKED) a private answer", async () => {
    const lookup = createGuardedLookup(POLICY, {
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      lookup("rebind.test", { family: 4 }, (err: NodeJS.ErrnoException | null) => {
        resolve(err ?? (new Error("lookup unexpectedly succeeded") as NodeJS.ErrnoException));
      });
    });
    expect(error.code).toBe("ERR_SSRF_BLOCKED");
  });

  it.each([
    "169.254.169.254",
    "fd00:ec2::254",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
  ])(
    "BUG-0116-08 never allows metadata %s at connect time even for an allowlisted hostname",
    async (address) => {
      const lookup = createGuardedLookup(
        { ...POLICY, allowPrivateHosts: ["metadata.allowed.test"] },
        { resolveHost: async () => [{ address, family: address.includes(":") ? 6 : 4 }] },
      );
      const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        lookup("metadata.allowed.test", { family: 0 }, (cause) => resolve(cause));
      });
      expect(error?.code).toBe("ERR_SSRF_BLOCKED");
    },
  );

  it("connect-time lookup resolves a public answer normally", async () => {
    const lookup = createGuardedLookup(POLICY, {
      resolveHost: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    });
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("ok.test", { family: 4 }, (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }, family?: number) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          typeof address === "string"
            ? { address, family: Number(family) }
            : (address as { address: string; family: number }),
        );
      });
    });
    expect(result.address).toBe(PUBLIC_ADDRESS);
    expect(result.family).toBe(4);
  });

  it("blocks the request when DNS rebinds between validation and connection", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("internal-secret");
    });
    track(origin.close);

    // validate -> public, connect -> loopback: the classic rebinding attack.
    let call = 0;
    const resolveHost: HostResolver = async () => {
      call += 1;
      return call === 1
        ? [{ address: PUBLIC_ADDRESS, family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };

    const safeFetch = createSafeFetch({ policy: POLICY, timeoutMs: 5_000, resolveHost });
    const error = await safeFetch(`http://rebind.test:${origin.port}/`).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("network");
    // No payload from the loopback origin may leak into the response.
    expect(JSON.stringify(error.message)).not.toContain("internal-secret");
  });
});

describe("redirect chains are re-validated per hop", () => {
  it("blocks a redirect to cloud metadata", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    track(origin.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${origin.port}/go`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("blocks a redirect to a private address that is not allowlisted", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(302, { location: "http://10.0.0.1/admin" });
      res.end();
    });
    track(origin.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${origin.port}/go`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("blocks a redirect from an allowlisted host to plain 127.0.0.1", async () => {
    // `localhost` is allowlisted for the first hop; the redirect target
    // 127.0.0.1 is not, so the second hop must be rejected.
    const origin = await startOrigin((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1/" });
      res.end();
    });
    track(origin.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["localhost"] },
      timeoutMs: 5_000,
    });
    await expect(safeFetch(`http://localhost:${origin.port}/go`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("blocks a redirect to a file:// URL", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    });
    track(origin.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${origin.port}/go`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("stops after maxRedirects", async () => {
    const origin = await startOrigin((req, res) => {
      const host = req.headers.host ?? `127.0.0.1`;
      res.writeHead(302, { location: `http://${host}${req.url}` });
      res.end();
    });
    track(origin.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"], maxRedirects: 2 },
      timeoutMs: 5_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${origin.port}/loop`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("follows a redirect whose destination passes validation", async () => {
    const target = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    track(target.close);
    const hop = await startOrigin((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/final` });
      res.end();
    });
    track(hop.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
    });
    const response = await safeFetch<{ ok: boolean }>(`http://127.0.0.1:${hop.port}/start`);
    expect(response.data).toEqual({ ok: true });
    expect(response.url).toContain("/final");
  });
});

describe("proxy mode", () => {
  it("routes a validated public target through the proxy (CONNECT observed)", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"via":"proxy"}');
    });
    track(origin.close);
    // The proxy is told to tunnel to the loopback origin, so the test asserts
    // the requested host:port without ever dialling the synthetic public IP.
    const proxy = await startMockProxy({ tunnelTo: { host: "127.0.0.1", port: origin.port } });
    track(proxy.close);

    const safeFetch = createSafeFetch({
      policy: POLICY,
      timeoutMs: 5_000,
      resolveHost: makeResolver({ "origin.public.test": [PUBLIC_ADDRESS] }),
      proxy: { proxy: `http://127.0.0.1:${proxy.port}` },
    });

    const response = await safeFetch<{ via: string }>(
      `http://origin.public.test:${origin.port}/through`,
    );
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ via: "proxy" });
    expect(proxy.connects.length).toBe(1);
    expect(proxy.connects[0]!.host).toBe("origin.public.test");
    expect(proxy.connects[0]!.port).toBe(origin.port);
  });

  it("never issues a CONNECT for metadata, loopback, RFC1918, CGNAT or .local targets", async () => {
    const proxy = await startMockProxy();
    track(proxy.close);

    const targets = [
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://localhost/",
      "http://printer.local/",
      "http://metadata.google.internal/",
    ];

    for (const trust of ["untrusted", "trusted-networks"] as const) {
      const safeFetch = createSafeFetch({
        policy: POLICY,
        timeoutMs: 2_000,
        proxy: { proxy: `http://127.0.0.1:${proxy.port}`, proxyTrust: trust },
      });
      for (const target of targets) {
        await expect(safeFetch(target)).rejects.toMatchObject({ code: "blocked" });
      }
      // Validation happens before dispatch: the proxy must see nothing at all.
      expect(proxy.connects.length).toBe(0);
      expect(proxy.forwardRequests.length).toBe(0);
    }
  });

  it("blocks a public-looking hostname that resolves privately before any CONNECT", async () => {
    // The proxy resolves the destination itself, so a hostname that looks
    // public is the interesting case: the application must still resolve it,
    // reject the private answer, and never hand it to the proxy.
    const proxy = await startMockProxy();
    track(proxy.close);

    const safeFetch = createSafeFetch({
      policy: POLICY,
      timeoutMs: 2_000,
      resolveHost: makeResolver({
        "rebind.public.test": ["127.0.0.1"],
        "rfc1918.public.test": ["10.0.0.7"],
        "metadata.public.test": ["169.254.169.254"],
        "expanded-mapped.public.test": ["0:0:0:0:0:ffff:127.0.0.1"],
      }),
      proxy: { proxy: `http://127.0.0.1:${proxy.port}` },
    });

    for (const host of [
      "rebind.public.test",
      "rfc1918.public.test",
      "metadata.public.test",
      "expanded-mapped.public.test",
    ]) {
      await expect(safeFetch(`http://${host}/`)).rejects.toMatchObject({ code: "blocked" });
    }
    expect(proxy.connects.length).toBe(0);
    expect(proxy.forwardRequests.length).toBe(0);
  });

  it("still blocks cloud metadata in proxy mode even when it is allowlisted", async () => {    const proxy = await startMockProxy();
    track(proxy.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["169.254.169.254", "100.100.100.200"] },
      timeoutMs: 2_000,
      proxy: { proxy: `http://127.0.0.1:${proxy.port}`, proxyTrust: "trusted-networks" },
    });
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      code: "blocked",
    });
    await expect(safeFetch("http://100.100.100.200/")).rejects.toMatchObject({ code: "blocked" });
    expect(proxy.connects.length).toBe(0);
  });

  it("ignores the private host allowlist while the proxy is untrusted", async () => {
    const proxy = await startMockProxy();
    track(proxy.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 2_000,
      proxy: { proxy: `http://127.0.0.1:${proxy.port}` },
    });
    await expect(safeFetch(`http://127.0.0.1:${proxy.port}/`)).rejects.toMatchObject({
      code: "blocked",
    });
    expect(proxy.connects.length).toBe(0);
  });

  it("honours the allowlist when the operator declares trusted-networks", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    track(origin.close);
    const proxy = await startMockProxy({ tunnelTo: { host: "127.0.0.1", port: origin.port } });
    track(proxy.close);
    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
      proxy: { proxy: `http://127.0.0.1:${proxy.port}`, proxyTrust: "trusted-networks" },
    });
    const response = await safeFetch<{ ok: boolean }>(`http://127.0.0.1:${origin.port}/`);
    expect(response.data.ok).toBe(true);
    expect(proxy.connects.length).toBe(1);
  });

  it("bypasses the proxy when NO_PROXY matches", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"direct":true}');
    });
    track(origin.close);
    const proxy = await startMockProxy();
    track(proxy.close);

    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
      proxy: {
        proxy: `http://127.0.0.1:${proxy.port}`,
        proxyTrust: "trusted-networks",
        noProxy: "127.0.0.1",
      },
    });
    const response = await safeFetch<{ direct: boolean }>(`http://127.0.0.1:${origin.port}/`);
    expect(response.data.direct).toBe(true);
    expect(proxy.connects.length).toBe(0);
    expect(proxy.forwardRequests.length).toBe(0);
  });

  it("keeps the allowlist for a NO_PROXY direct hop even when the proxy is untrusted", async () => {
    // A NO_PROXY bypass is a direct connection, so the connect-time lookup
    // guard still protects it and the operator's allowlist still applies.
    // Dropping it here would break every self-hosted SearXNG behind a proxy.
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"direct":true}');
    });
    track(origin.close);
    const proxy = await startMockProxy();
    track(proxy.close);

    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
      proxy: {
        proxy: `http://127.0.0.1:${proxy.port}`,
        // Trust level deliberately left unset (untrusted).
        noProxy: "127.0.0.1",
      },
    });
    const response = await safeFetch<{ direct: boolean }>(`http://127.0.0.1:${origin.port}/`);
    expect(response.data.direct).toBe(true);
    expect(proxy.connects.length).toBe(0);
  });

  it("does not trust the CONNECT target alone: a tunnel that answers from a private host is still a blind spot", async () => {
    // The proxy is what resolves the destination, so a cooperating proxy can
    // legally connect to a private address while the CONNECT record still
    // carries a public hostname. Asserting "no CONNECT happened" therefore
    // cannot prove safety on its own. This test documents the residual risk
    // that remains in `untrusted` mode and pins the two things the application
    // *can* still guarantee: the CONNECT target is the validated hostname, and
    // the tunnel destination is decided by the proxy, not by the client.
    const privateOrigin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"from":"private-origin"}');
    });
    track(privateOrigin.close);
    // The proxy tunnels to 127.0.0.1 while the client asked for a validated
    // public name — exactly what a DNS-rebinding or misconfigured proxy does.
    const proxy = await startMockProxy({
      tunnelTo: { host: "127.0.0.1", port: privateOrigin.port },
    });
    track(proxy.close);

    const safeFetch = createSafeFetch({
      policy: POLICY,
      timeoutMs: 5_000,
      resolveHost: makeResolver({ "rebind.public.test": [PUBLIC_ADDRESS] }),
      proxy: { proxy: `http://127.0.0.1:${proxy.port}`, proxyTrust: "untrusted" },
    });

    const response = await safeFetch<{ from: string }>("http://rebind.public.test/");
    // Documented, not desired: with an untrusted proxy the application cannot
    // see the private destination. Preserving the assertion makes the blind
    // spot explicit instead of letting a "0 CONNECTs" test imply safety.
    expect(response.data.from).toBe("private-origin");
    expect(proxy.connects).toHaveLength(1);
    expect(proxy.connects[0]!.host).toBe("rebind.public.test");
    // What the app does guarantee: it validated the name it handed to the
    // proxy, and it never dialled the target itself.
    expect(response.url).toBe("http://rebind.public.test/");
  });

  it("re-validates redirect hops in proxy mode and never tunnels to metadata", async () => {
    const origin = await startOrigin((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    track(origin.close);
    const proxy = await startMockProxy({ tunnelTo: { host: "127.0.0.1", port: origin.port } });
    track(proxy.close);

    const safeFetch = createSafeFetch({
      policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      timeoutMs: 5_000,
      proxy: { proxy: `http://127.0.0.1:${proxy.port}`, proxyTrust: "trusted-networks" },
    });

    await expect(safeFetch(`http://127.0.0.1:${origin.port}/go`)).rejects.toMatchObject({
      code: "blocked",
    });
    // The first hop was proxied; the metadata hop must never reach the proxy.
    expect(proxy.connects.length).toBe(1);
    expect(proxy.connects[0]!.port).toBe(origin.port);
  });

  it("refuses to build a fetch with an invalid proxy instead of going direct", () => {
    expect(() =>
      createSafeFetch({ policy: POLICY, proxy: { proxy: "socks5://127.0.0.1:1080" } }),
    ).toThrowError(/Unsupported outbound proxy scheme/i);
  });

  it("maps a 407 from the proxy to a clear error without leaking credentials", async () => {
    const proxy = await startMockProxy({
      onConnect: (_req, clientSocket) => {
        clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      },
    });
    track(proxy.close);

    const secret = "s3cr3t-p4ssword";
    const safeFetch = createSafeFetch({
      policy: POLICY,
      timeoutMs: 3_000,
      resolveHost: makeResolver({ "denied.public.test": [PUBLIC_ADDRESS] }),
      proxy: {
        proxy: `http://proxyuser:${secret}@127.0.0.1:${proxy.port}`,
        proxyTrust: "trusted-networks",
      },
    });

    const error = await safeFetch("http://denied.public.test/").catch((e) => e);
    expect(error.code).toBe("blocked");
    expect(error.status).toBe(502);
    const serialized = JSON.stringify({
      message: error.message,
      details: error.details,
      json: error.toJSON(),
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("proxyuser");
    expect(serialized).toContain("407");
  });

  it("maps a 502 from the proxy to a network error naming the proxy only", async () => {
    const proxy = await startMockProxy({
      onConnect: (_req, clientSocket) => {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      },
    });
    track(proxy.close);

    const safeFetch = createSafeFetch({
      policy: POLICY,
      timeoutMs: 3_000,
      resolveHost: makeResolver({ "unreachable.public.test": [PUBLIC_ADDRESS] }),
      proxy: { proxy: `http://127.0.0.1:${proxy.port}`, proxyTrust: "trusted-networks" },
    });
    const error = await safeFetch("http://unreachable.public.test/").catch((e) => e);
    expect(error.code).toBe("network");
    expect(String(error.message)).toContain("proxy");
    expect((error.details as { proxyStatus?: number }).proxyStatus).toBe(502);
  });

  it("always tunnels plain HTTP with CONNECT instead of forwarding absolute-form", async () => {
    // Rationale: the proxy must always see an explicit host:port, so the
    // application-level check and what the proxy dials cannot disagree.
    const origin = await startOrigin((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("tunnelled");
    });
    track(origin.close);
    const proxy = await startMockProxy({ tunnelTo: { host: "127.0.0.1", port: origin.port } });
    track(proxy.close);
    const safeFetch = createSafeFetch({
      policy: POLICY,
      timeoutMs: 5_000,
      resolveHost: makeResolver({ "plain.public.test": [PUBLIC_ADDRESS] }),
      proxy: { proxy: `http://127.0.0.1:${proxy.port}`, proxyTrust: "trusted-networks" },
    });
    const response = await safeFetch<string>(`http://plain.public.test:${origin.port}/x`);
    expect(response.status).toBe(200);
    expect(proxy.connects.length).toBe(1);
    expect(proxy.forwardRequests.length).toBe(0);
  });
});

describe("proxy configuration validation", () => {
  it("rejects non-http(s) proxy schemes", () => {
    for (const proxy of [
      "socks5://127.0.0.1:1080",
      "socks://127.0.0.1:1080",
      "file:///etc/proxy.conf",
      "pac+http://127.0.0.1/proxy.pac",
      "ftp://127.0.0.1:21",
      "data:text/plain,proxy",
    ]) {
      expect(() => resolveOutboundProxy({ proxy })).toThrowError(/Unsupported outbound proxy scheme/i);
    }
  });

  it("rejects an unknown trust level instead of defaulting to trust", () => {
    expect(() =>
      resolveOutboundProxy({ proxy: "http://127.0.0.1:3128", proxyTrust: "yes-i-trust-it" }),
    ).toThrowError(/Invalid outbound proxy trust level/i);
  });

  it("accepts the documented trust-level aliases", () => {
    expect(
      resolveOutboundProxy({ proxy: "http://127.0.0.1:3128", proxyTrust: "application-only" }),
    ).toMatchObject({ trust: "untrusted", trustDeclared: true });
    expect(
      resolveOutboundProxy({ proxy: "http://127.0.0.1:3128", proxyTrust: "egress-enforced" }),
    ).toMatchObject({ trust: "trusted-networks", trustDeclared: true });
    // Case/whitespace tolerant, because it comes from a hand-edited env file.
    expect(
      resolveOutboundProxy({ proxy: "http://127.0.0.1:3128", proxyTrust: "  EGRESS-ENFORCED " }),
    ).toMatchObject({ trust: "trusted-networks" });
  });

  it("states a residualRisk for every proxy mode and none for direct", () => {
    const direct = describeOutboundPolicy(POLICY, resolveOutboundProxy({}));
    expect(direct.residualRisk).toBeNull();

    const undeclared = describeOutboundPolicy(
      POLICY,
      resolveOutboundProxy({ proxy: "http://127.0.0.1:3128" }),
    );
    expect(undeclared.residualRisk).toMatch(/not declared/i);
    expect(undeclared.residualRisk).toMatch(/DNS rebinding/i);

    const untrusted = describeOutboundPolicy(
      POLICY,
      resolveOutboundProxy({ proxy: "http://127.0.0.1:3128", proxyTrust: "untrusted" }),
    );
    expect(untrusted.residualRisk).toMatch(/untrusted/i);

    const delegated = describeOutboundPolicy(
      POLICY,
      resolveOutboundProxy({ proxy: "http://127.0.0.1:3128", proxyTrust: "egress-enforced" }),
    );
    expect(delegated.residualRisk).toMatch(/delegated to the proxy/i);
  });

  it("rejects a malformed proxy URL", () => {
    expect(() => resolveOutboundProxy({ proxy: "not a url" })).toThrowError(
      /Invalid outbound proxy URL/i,
    );
  });

  it("defaults to untrusted and reports it as undeclared", () => {
    const resolved = resolveOutboundProxy({ proxy: "http://127.0.0.1:3128" });
    expect(resolved.trust).toBe("untrusted");
    expect(resolved.trustDeclared).toBe(false);
  });

  it("redacts credentials from the proxy display value", () => {
    const resolved = resolveOutboundProxy({ proxy: "http://user:hunter2@proxy.int:3128" });
    expect(resolved.proxy!.display).toBe("http://proxy.int:3128");
    expect(JSON.stringify(resolved)).not.toContain("hunter2");
    expect(resolved.proxy!.hasCredentials).toBe(true);
    expect(redactProxyUrl("http://user:hunter2@proxy.int:3128")).not.toContain("hunter2");
    expect(redactProxyUrl("::not-a-url::")).toBe("[invalid-proxy-url]");
  });

  it("keeps Proxy-Authorization out of any serialisation of the resolved proxy", () => {
    const resolved = resolveOutboundProxy({ proxy: "http://user:hunter2@proxy.int:3128" });
    const basic = Buffer.from("user:hunter2").toString("base64");
    // The value is readable for the dispatcher...
    expect(resolved.proxy!.authorization).toBe(`Basic ${basic}`);
    // ...but never enumerable, so a log line or JSON response cannot leak it.
    expect(JSON.stringify(resolved.proxy)).not.toContain(basic);
    expect(JSON.stringify({ ...resolved.proxy })).not.toContain(basic);
    expect(Object.keys(resolved.proxy!)).not.toContain("authorization");
  });

  it("describeOutboundPolicy never leaks credentials", () => {
    const resolved = resolveOutboundProxy({
      proxy: "https://u:p@proxy.int:8443/",
      proxyTrust: "trusted-networks",
      noProxy: "a.test, b.test",
    });
    const description = describeOutboundPolicy(
      { ...POLICY, allowPrivateHosts: ["internal.test"] },
      resolved,
    );
    expect(JSON.stringify(description)).not.toContain(":p@");
    expect(description.mode).toBe("proxy");
    expect(description.proxyHost).toBe("https://proxy.int:8443");
    expect(description.noProxyEntries).toBe(2);
    expect(description.privateHostAllowlistHonored).toBe(true);
  });

  it("warns when a proxy is configured without a declared trust level", () => {
    const resolved = resolveOutboundProxy({
      proxy: "http://127.0.0.1:3128",
      noProxy: null,
      proxyTrust: null,
    });
    const description = describeOutboundPolicy({ ...POLICY, allowPrivateHosts: ["x.test"] }, resolved);
    expect(description.privateHostAllowlistHonored).toBe(false);
    expect(description.warnings.join(" ")).toMatch(/untrusted|trust level/i);
    expect(description.warnings.join(" ")).toMatch(/ignored/i);
  });
});

describe("NO_PROXY semantics", () => {
  it("matches exact hosts and label-boundary subdomains", () => {
    expect(noProxyMatches("example.com", 80, ["example.com"])).toBe(true);
    expect(noProxyMatches("api.example.com", 80, ["example.com"])).toBe(true);
    expect(noProxyMatches("notexample.com", 80, ["example.com"])).toBe(false);
    expect(noProxyMatches("example.com.evil.test", 80, ["example.com"])).toBe(false);
  });

  it("supports leading-dot and wildcard suffixes", () => {
    expect(noProxyMatches("example.com", 443, [".example.com"])).toBe(true);
    expect(noProxyMatches("a.example.com", 443, [".example.com"])).toBe(true);
    expect(noProxyMatches("a.example.com", 443, ["*.example.com"])).toBe(true);
    expect(noProxyMatches("b.other.com", 443, ["*.example.com"])).toBe(false);
  });

  it("honours ports, including IPv6 literals", () => {
    expect(noProxyMatches("proxy.test", 8080, ["proxy.test:8080"])).toBe(true);
    expect(noProxyMatches("proxy.test", 9090, ["proxy.test:8080"])).toBe(false);
    expect(noProxyMatches("::1", 8080, ["[::1]:8080"])).toBe(true);
    expect(noProxyMatches("::1", 9090, ["[::1]:8080"])).toBe(false);
  });

  it("supports '*' and CIDR entries", () => {
    expect(noProxyMatches("anything.test", 80, ["*"])).toBe(true);
    expect(noProxyMatches("10.1.2.3", 80, ["10.0.0.0/8"])).toBe(true);
    expect(noProxyMatches("11.1.2.3", 80, ["10.0.0.0/8"])).toBe(false);
  });

  it("proxyForUrl returns null for bypassed targets and the proxy otherwise", () => {
    const config = resolveOutboundProxy({
      proxy: "http://127.0.0.1:3128",
      noProxy: "internal.test, 127.0.0.1",
    });
    expect(proxyForUrl(config, "http://internal.test/")).toBeNull();
    expect(proxyForUrl(config, "https://example.com/")).not.toBeNull();
  });
});

describe("direct mode is the unchanged default", () => {
  it("keeps working with no proxy configuration", () => {
    const config = resolveOutboundProxy({});
    expect(config.enabled).toBe(false);
    const description = describeOutboundPolicy(POLICY, config);
    expect(description.mode).toBe("direct");
    expect(description.proxyHost).toBeNull();
    expect(description.warnings).toHaveLength(0);
  });
});
