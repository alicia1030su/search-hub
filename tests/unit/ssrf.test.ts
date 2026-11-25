import { describe, expect, it } from "vitest";
import {
  createSafeFetch,
  hostIsAllowlisted,
  isBlockedAddress,
  validateOutboundUrl,
  type SsrfPolicy,
} from "@search-hub/shared";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const POLICY: SsrfPolicy = { allowPrivateHosts: [], maxRedirects: 3, allowHttp: true };

describe("SSRF address classification", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.4.2",
    "192.168.1.10",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fd12::3",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "::127.0.0.1",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::7f00:1",
    "2002:7f00:1::1",
    "2001:0000:4136:e378:8000:63bf:80fe:fffe",
    "fe80::1%eth0",
  ];
  for (const address of blocked) {
    it(`blocks ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "0:0:0:0:0:ffff:8.8.8.8",
    "::ffff:0808:0808",
    "64:ff9b::0808:0808",
    "2002:0808:0808::1",
    "2001:0000:4136:e378:8000:63bf:f7f7:f7f7",
  ];
  for (const address of allowed) {
    it(`allows public address ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }
});

describe("hostname allowlist", () => {
  it("matches exact hosts and suffix patterns", () => {
    expect(hostIsAllowlisted("searxng", [".internal", "searxng"])).toBe(true);
    expect(hostIsAllowlisted("api.internal", [".internal"])).toBe(true);
    expect(hostIsAllowlisted("api.internal.example.com", [".internal"])).toBe(false);
    expect(hostIsAllowlisted("attacker.internal.example.com", ["internal"])).toBe(false);
    expect(hostIsAllowlisted("searxng.internal.evil.com", [".internal"])).toBe(false);
  });
});

describe("validateOutboundUrl", () => {
  it("rejects non-http protocols", async () => {
    await expect(validateOutboundUrl("file:///etc/passwd", POLICY)).rejects.toThrow(/protocol/i);
    await expect(validateOutboundUrl("gopher://example.com", POLICY)).rejects.toThrow(/protocol/i);
  });

  it("rejects embedded credentials", async () => {
    await expect(validateOutboundUrl("https://user:pass@example.com", POLICY)).rejects.toThrow(
      /credentials/i,
    );
  });

  it("rejects loopback and cloud metadata literals", async () => {
    await expect(validateOutboundUrl("http://127.0.0.1:8080/", POLICY)).rejects.toThrow(/private|reserved/i);
    await expect(validateOutboundUrl("http://169.254.169.254/latest/meta-data/", POLICY)).rejects.toThrow(
      /private|reserved|metadata/i,
    );
    await expect(validateOutboundUrl("http://[::1]:8080/", POLICY)).rejects.toThrow(/private|reserved/i);
    await expect(validateOutboundUrl("http://localhost/", POLICY)).rejects.toThrow(/internal hostname/i);
  });

  it("never allows the metadata IP even when the host is allowlisted", async () => {
    await expect(
      validateOutboundUrl("http://169.254.169.254/", {
        ...POLICY,
        allowPrivateHosts: ["169.254.169.254", "*"],
      }),
    ).rejects.toThrow(/metadata/i);
  });

  it("allows a private host only when explicitly allowlisted", async () => {
    const blockedResult = await validateOutboundUrl("http://127.0.0.1:8080/", POLICY).catch((error) => error);
    expect(blockedResult).toBeInstanceOf(Error);

    const allowed = await validateOutboundUrl("http://127.0.0.1:8080/", {
      ...POLICY,
      allowPrivateHosts: ["127.0.0.1"],
    });
    expect(allowed.allowlisted).toBe(true);
  });

  it.each([
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
  ])("never allows embedded metadata %s through a hostname allowlist", async (address) => {
    await expect(validateOutboundUrl("http://metadata.test/", {
      ...POLICY,
      allowPrivateHosts: ["metadata.test"],
    }, {
      resolveHost: async () => [{ address, family: 6 }],
    })).rejects.toMatchObject({ code: "blocked" });
  });

  it("rejects a zone-scoped public IPv6 DNS answer even for an allowlisted hostname", async () => {
    await expect(validateOutboundUrl("http://zoned.allowed.test/", {
      ...POLICY,
      allowPrivateHosts: ["zoned.allowed.test"],
    }, {
      resolveHost: async () => [{ address: "2606:4700:4700::1111%eth0", family: 6 }],
    })).rejects.toMatchObject({ code: "blocked" });
  });

  it("allows a public IPv4 address embedded in well-known NAT64", async () => {
    const target = await validateOutboundUrl("http://public-nat64.test/", POLICY, {
      resolveHost: async () => [{ address: "64:ff9b::0808:0808", family: 6 }],
    });
    expect(target.addresses).toEqual(["64:ff9b::0808:0808"]);
  });

  it("blocks plain HTTP when the policy forbids it", async () => {
    await expect(
      validateOutboundUrl("http://example.com/", { ...POLICY, allowHttp: false }),
    ).rejects.toThrow(/Plain HTTP/i);
  });
});

async function startTestServer(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

describe("safeFetch runtime behaviour", () => {
  it("BUG-0116-01 blocks an expanded mapped loopback before socket or budget charge", async () => {
    let hits = 0;
    let charged = 0;
    const { server, port } = await startTestServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    try {
      const safeFetch = createSafeFetch({
        policy: POLICY,
        timeoutMs: 2_000,
        resolveHost: async () => [{ address: "0:0:0:0:0:ffff:127.0.0.1", family: 6 }],
      });
      const error = await safeFetch(`http://expanded-mapped.test:${port}/`, {
        onRequest: () => {
          charged += 1;
        },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toMatch(/blocked|ERR_SSRF_BLOCKED/);
      expect(hits).toBe(0);
      expect(charged).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("blocks a loopback request before opening a socket", async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"secret":true}');
    });
    try {
      const safeFetch = createSafeFetch({ policy: POLICY });
      await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it("follows a redirect but re-validates each hop", async () => {
    const target = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const redirector = await startTestServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/internal` });
      res.end();
    });
    try {
      const allowlistedFetch = createSafeFetch({
        policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      });
      // Both hops are allowlisted, so the redirect resolves.
      const response = await allowlistedFetch(`http://127.0.0.1:${redirector.port}/go`);
      expect(response.data).toEqual({ ok: true });
      expect(response.url).toContain("/internal");
    } finally {
      redirector.server.close();
      target.server.close();
    }
  });

  it("blocks a redirect that lands on a non-allowlisted private address", async () => {
    const redirector = await startTestServer((_req, res) => {
      res.writeHead(302, { location: "http://10.0.0.1/admin" });
      res.end();
    });
    try {
      const safeFetch = createSafeFetch({
        policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      });
      await expect(safeFetch(`http://127.0.0.1:${redirector.port}/go`)).rejects.toThrow(
        /private|reserved|allowlist/i,
      );
    } finally {
      redirector.server.close();
    }
  });

  it("caps response size", async () => {
    const { server, port } = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(2048));
    });
    try {
      const safeFetch = createSafeFetch({
        policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
        maxBytes: 256,
      });
      await expect(safeFetch(`http://127.0.0.1:${port}/big`)).rejects.toThrow(/exceeded/i);
    } finally {
      server.close();
    }
  });

  it("times out a slow upstream", async () => {
    const { server, port } = await startTestServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 500);
    });
    try {
      const safeFetch = createSafeFetch({
        policy: { ...POLICY, allowPrivateHosts: ["127.0.0.1"] },
      });
      await expect(safeFetch(`http://127.0.0.1:${port}/slow`, { timeoutMs: 100 })).rejects.toThrow(
        /timed out/i,
      );
    } finally {
      server.close();
    }
  });
});
