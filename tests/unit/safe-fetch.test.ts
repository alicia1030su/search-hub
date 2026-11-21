import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetch, redactSecrets, sanitizeUrl, type SsrfPolicy } from "../../packages/shared/src/index.js";

let server: Server;
let port = 0;

const policy: SsrfPolicy = {
  allowPrivateHosts: ["127.0.0.1", "localhost"],
  allowHttp: true,
  maxRedirects: 2,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
      return;
    }
    if (req.url === "/redirect-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
      return;
    }
    if (req.url === "/huge") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(4096));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "object" && address) port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("safe-fetch connection guard", () => {
  it("reaches an allowlisted local host through the guarded lookup", async () => {
    // Regression: Node's autoSelectFamily calls lookup({all:true}) and the old
    // callback shape made every real request fail with ERR_INVALID_IP_ADDRESS.
    const safeFetch = createSafeFetch({ policy, timeoutMs: 5_000 });
    const byIp = await safeFetch<{ ok: boolean }>(`http://127.0.0.1:${port}/json`);
    expect(byIp.status).toBe(200);
    expect(byIp.data).toEqual({ ok: true, path: "/json" });
  });

  it("resolves a hostname through the guarded lookup (all:true shape)", async () => {
    // `localhost` resolves to both ::1 and 127.0.0.1 here; the guard must
    // return the array form undici expects instead of a single address.
    const safeFetch = createSafeFetch({
      policy: { allowPrivateHosts: ["localhost"], allowHttp: true, maxRedirects: 2 },
      timeoutMs: 5_000,
    });
    const response = await safeFetch<{ ok: boolean }>(`http://localhost:${port}/json`);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true, path: "/json" });
  });

  it("blocks a private destination that is not allowlisted", async () => {
    const safeFetch = createSafeFetch({
      policy: { allowPrivateHosts: [], allowHttp: true, maxRedirects: 2 },
      timeoutMs: 3_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${port}/json`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("validates every redirect hop and refuses cloud metadata", async () => {
    const safeFetch = createSafeFetch({ policy, timeoutMs: 3_000 });
    await expect(safeFetch(`http://127.0.0.1:${port}/redirect-metadata`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("enforces the response size cap", async () => {
    const safeFetch = createSafeFetch({ policy, timeoutMs: 3_000, maxBytes: 512 });
    await expect(safeFetch(`http://127.0.0.1:${port}/huge`)).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("rejects http when the policy disallows it", async () => {
    const safeFetch = createSafeFetch({
      policy: { allowPrivateHosts: ["127.0.0.1"], allowHttp: false, maxRedirects: 0 },
      timeoutMs: 3_000,
    });
    await expect(safeFetch(`http://127.0.0.1:${port}/json`)).rejects.toMatchObject({
      code: "blocked",
    });
  });
});

describe("upstream error redaction", () => {
  it("removes the exact credential used for the request", () => {
    const key = "sk-REAL-LOOKING-SECRET-1234567890";
    const text = redactSecrets(`HTTP 401: invalid key ${key}`, [`Bearer ${key}`]);
    expect(text).not.toContain(key);
    expect(text).toContain("[redacted]");
  });

  it("removes well-known credential shapes even when no header value is passed", () => {
    const text = redactSecrets(
      "echo Bearer abcdefghijklmnop sk-abcdefgh12345678 tvly-abcdefgh12345678 sh_abcdefgh12345678",
    );
    expect(text).not.toMatch(/abcdefgh/);
    expect(text).toContain("Bearer [redacted]");
    expect(text).toContain("sk-[redacted]");
    expect(text).toContain("tvly-[redacted]");
    expect(text).toContain("sh_[redacted]");
  });

  it("redacts literal, URI, query-form, lowercase-percent and double-encoded credentials", () => {
    const secret = "TEST_SECRET +/=&";
    const encoded = encodeURIComponent(secret);
    const queryForm = encoded.replace(/%20/g, "+");
    const variants = [
      secret,
      encoded,
      encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      queryForm,
      encodeURIComponent(encoded),
      encodeURIComponent(queryForm),
    ];
    for (const variant of variants) {
      const output = redactSecrets(`credential=${variant}`, [secret]);
      expect(output).not.toContain(variant);
      expect(output).toContain("[redacted]");
    }
  });

  it("redacts mixed literal/percent encoding and mixed-case double encoding", () => {
    const secret = "TEST_SECRET +/=&";
    const mixed = "TEST_SECRET%20+/%3d&";
    const doubleMixed = "TEST_SECRET%2520%2B/%253D%26";
    for (const variant of [mixed, doubleMixed]) {
      const output = redactSecrets(`credential=${variant}`, [secret]);
      expect(output).not.toContain(variant);
      expect(output).toContain("[redacted]");
    }
  });

  it("redacts non-BMP credentials in literal, encoded, query-form and double-encoded echoes", () => {
    const secret = "KEY_🔑/中 +&=";
    const encoded = encodeURIComponent(secret);
    const variants = [
      secret,
      encoded,
      encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      encoded.replace(/%20/g, "+"),
      encodeURIComponent(encoded),
    ];
    for (const variant of variants) {
      for (const text of [`credential=${variant};tail=ok`, `prefix=${variant}`, variant]) {
        const output = redactSecrets(text, [secret]);
        expect(output).not.toContain(variant);
        expect(output).toContain("[redacted]");
      }
    }
  });

  it("redacts an 8192-character mixed credential without throwing", () => {
    const secret = `A${" +/=&%".repeat(1365)}B`;
    expect(secret.length).toBe(8192);
    const mixed = [...secret]
      .map((character, index) => index % 3 === 0 ? encodeURIComponent(character) : character)
      .join("");
    for (const variant of [secret, mixed, encodeURIComponent(secret), encodeURIComponent(encodeURIComponent(secret))]) {
      let output = "";
      expect(() => { output = redactSecrets(`credential=${variant};tail=ok`, [secret]); }).not.toThrow();
      expect(output).not.toContain(variant);
      expect(output).toContain("[redacted];tail=ok");
    }
  });

  it("redacts credentials in non-2xx details.url while preserving diagnostic parameters", async () => {
    const safeFetch = createSafeFetch({ policy, timeoutMs: 5_000 });
    const secret = "TEST_DETAILS_SECRET +/=&";
    const url = `http://127.0.0.1:${port}/missing?api_key=${encodeURIComponent(secret)}&engine=google&page=2`;
    await expect(safeFetch(url, { secrets: [secret] })).rejects.toMatchObject({
      code: "bad_request",
      details: {
        upstreamStatus: 404,
        url: expect.stringContaining("api_key=%5Bredacted%5D"),
      },
    });
    try {
      await safeFetch(url, { secrets: [secret] });
      throw new Error("expected safeFetch to reject");
    } catch (error) {
      const details = (error as { details?: { url?: string } }).details;
      expect(details?.url).toContain("engine=google");
      expect(details?.url).toContain("page=2");
      expect(details?.url).not.toContain(secret);
      expect(details?.url).not.toContain(encodeURIComponent(secret));
    }
  });

  it("keeps non-sensitive query parameters in diagnostic URLs", () => {
    const output = sanitizeUrl("https://example.test/search?engine=google&q=typescript&api_key=secret-value&page=2");
    expect(output).toContain("engine=google");
    expect(output).toContain("q=typescript");
    expect(output).toContain("page=2");
    expect(output).not.toContain("secret-value");
  });

  it("does not alter a message with no credential material", () => {
    const text = "Upstream returned HTTP 429: rate limit exceeded";
    expect(redactSecrets(text, [undefined, null, "short"])).toBe(text);
  });
});

describe("caller cancellation", () => {
  it("reports a caller abort as cancelled, not as a network failure", async () => {
    // A cancelled request must not mark the provider/key as failing or be
    // retried. Before this case existed, an aborted caller signal fell through
    // to the generic network mapping (retryable: true).
    const controller = new AbortController();
    const safeFetch = createSafeFetch({ policy, timeoutMs: 5_000 });
    const pending = safeFetch(`http://127.0.0.1:${port}/json`, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });
});
