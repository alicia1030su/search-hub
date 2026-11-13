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
  ];
  for (const address of blocked) {
    it(`blocks ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"];
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
