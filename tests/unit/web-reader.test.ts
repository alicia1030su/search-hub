import { describe, expect, it, vi } from "vitest";
import { fetchWebpage } from "@search-hub/core";
import { SearchHubError, type SafeFetch, type SafeFetchResponse } from "@search-hub/shared";

const ARTICLE = Array.from({ length: 45 }, (_, index) => `Paragraph ${index} explains reliable web reading with useful detail and evidence for every reader.`).join(" ");

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

function article(title = "A useful article", body = `<article><h1>${title}</h1><p>${ARTICLE}</p></article>`): string {
  return page(title, body);
}

function response(html: string, overrides: Partial<SafeFetchResponse<string>> = {}): SafeFetchResponse<string> {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
    data: html,
    url: "https://example.com/final",
    ...overrides,
  };
}

function fakeFetch(result: SafeFetchResponse<string> | Error): SafeFetch {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as SafeFetch;
}

describe("fetchWebpage B5 classification", () => {
  it("extracts title, Markdown, author, date and URLs from a normal article", async () => {
    const html = page(
      "Readable story",
      `<article><h1>Readable story</h1><p>${ARTICLE}</p><p><strong>Important</strong> and <a href="/source">source</a>.</p></article>`,
      `<meta name="author" content="Ada"><meta property="article:published_time" content="2026-11-01T10:00:00Z"><script>secret()</script>`,
    );
    const result = await fetchWebpage("https://example.com/start", {
      fetch: fakeFetch(response(html, { url: "https://example.com/final" })),
    });
    expect(result).toMatchObject({
      title: "Readable story",
      readStatus: "ok",
      reasonCode: "ok",
      truncated: false,
      author: "Ada",
      publishedAt: "2026-11-01T10:00:00Z",
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/final",
    });
    expect(result.content).toContain("# Readable story");
    expect(result.content).toContain("**Important** and [source](/source)");
    expect(result.content).not.toContain("<script>");
    expect(result.contentLength).toBe(result.content!.length);
  });

  it("identifies exact HTTP 200 soft 404 title and body marker", async () => {
    const result = await fetchWebpage("https://example.com/missing", {
      fetch: fakeFetch(response(page("404 Not Found", "<h1>404 Not Found</h1><p>The page you requested could not be found.</p>"))),
    });
    expect(result.readStatus).toBe("not_found");
    expect(result.reasonCode).toBe("not_found");
    expect(result.content).toBeNull();
    expect(JSON.stringify(result)).not.toContain("<html");
  });

  it("identifies HTTP 200 soft 404 from Page Not Found h1 and title", async () => {
    const result = await fetchWebpage("https://example.com/missing", {
      fetch: fakeFetch(response(page("Example | Page Not Found", "<h1>Page Not Found</h1><p>The requested page could not be found.</p>"))),
    });
    expect(result.readStatus).toBe("not_found");
  });

  it("does not misclassify an article discussing soft 404 errors", async () => {
    const result = await fetchWebpage("https://example.com/article", {
      fetch: fakeFetch(response(article("Fixing soft 404 errors"))),
    });
    expect(result.readStatus).toBe("ok");
  });

  it("identifies a short password login form", async () => {
    const result = await fetchWebpage("https://example.com/private", {
      fetch: fakeFetch(response(page("Members", "<h1>Members</h1><form action='/login'><input type='password'><button>Login</button></form>"))),
    });
    expect(result.readStatus).toBe("login_required");
    expect(result.content).toBeNull();
  });

  it("identifies an exact short login title", async () => {
    const result = await fetchWebpage("https://example.com/login", {
      fetch: fakeFetch(response(page("Login", "<p>Please sign in to continue.</p>"))),
    });
    expect(result.readStatus).toBe("login_required");
  });

  it("does not misclassify a long article with login links and password discussion", async () => {
    const result = await fetchWebpage("https://example.com/security", {
      fetch: fakeFetch(response(article("Designing secure login and password reset", `<article><h1>Designing secure login and password reset</h1><p>${ARTICLE}</p><a href="/login">Login</a></article>`))),
    });
    expect(result.readStatus).toBe("ok");
  });

  it.each([
    "<div class='cf-chl'>Checking browser</div>",
    "<div class='g-recaptcha' data-sitekey='test'></div>",
    "<script src='https://example.com/hcaptcha.js'></script>",
  ])("identifies captcha challenge element %s", async (challenge) => {
    const result = await fetchWebpage("https://example.com/challenge", {
      fetch: fakeFetch(response(page("Just a moment", `<h1>Just a moment</h1>${challenge}`))),
    });
    expect(result.readStatus).toBe("captcha");
    expect(result.content).toBeNull();
  });

  it("identifies exact human verification title with challenge form", async () => {
    const result = await fetchWebpage("https://example.com/challenge", {
      fetch: fakeFetch(response(page("Verify you are human", "<form><input name='response'></form>"))),
    });
    expect(result.readStatus).toBe("captcha");
  });

  it("does not misclassify a captcha security article", async () => {
    const result = await fetchWebpage("https://example.com/security", {
      fetch: fakeFetch(response(article("Understanding captcha tradeoffs"))),
    });
    expect(result.readStatus).toBe("ok");
  });

  it("identifies HTTP 503 from SafeFetch errors without exposing upstream body", async () => {
    const error = new SearchHubError("bad_request", "Upstream returned HTTP 503: <html>secret details</html>", {
      status: 503,
      details: { upstreamStatus: 503, url: "https://example.com/final" },
    });
    const result = await fetchWebpage("https://example.com/start", { fetch: fakeFetch(error) });
    expect(result).toMatchObject({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/final",
      readStatus: "maintenance",
      content: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret details");
  });

  it("identifies a maintenance title with maintenance copy", async () => {
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(page("Site Maintenance", "<h1>Site Maintenance</h1><p>We will be back shortly.</p>"))),
    });
    expect(result.readStatus).toBe("maintenance");
  });

  it("identifies a maintenance title with Retry-After", async () => {
    const headers = new Headers({ "content-type": "text/html", "retry-after": "120" });
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(page("Maintenance", "<p>Temporarily unavailable.</p>"), { headers })),
    });
    expect(result.readStatus).toBe("maintenance");
  });

  it("does not misclassify a long article about maintenance", async () => {
    const result = await fetchWebpage("https://example.com/article", {
      fetch: fakeFetch(response(article("A practical guide to scheduled maintenance"))),
    });
    expect(result.readStatus).toBe("ok");
  });

  it("applies captcha before login, maintenance, not_found and unsupported", async () => {
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(page("404 Not Found", "<h1>404 Not Found</h1><form action='/login'><input type='password'></form><div class='h-captcha'></div><p>The page could not be found.</p>"))),
    });
    expect(result.readStatus).toBe("captcha");
  });

  it("applies login before not_found", async () => {
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(page("Login", "<form action='/login'><input type='password'></form><p>The page could not be found.</p>"))),
    });
    expect(result.readStatus).toBe("login_required");
  });

  it("returns unsupported for non-HTML without leaking the body", async () => {
    const result = await fetchWebpage("https://example.com/data", {
      fetch: fakeFetch(response("private response", { headers: new Headers({ "content-type": "application/json" }) })),
    });
    expect(result).toMatchObject({ readStatus: "unsupported", reasonCode: "unsupported_content", content: null, contentLength: 0 });
    expect(JSON.stringify(result)).not.toContain("private response");
  });

  it("returns unsupported for HTML with insufficient article text", async () => {
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(page("Empty", "<main><p>Hello.</p></main>"))),
    });
    expect(result.readStatus).toBe("unsupported");
    expect(result.content).toBeNull();
  });

  it.each([404, 410, 503])("classifies HTTP %i before parsing error-page markers", async (status) => {
    const expected = status === 503 ? "maintenance" : "not_found";
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(page("Private upstream error", "<div class='cf-chl'></div><form action='/login'><input type='password'></form>"), { status })),
    });
    expect(result).toMatchObject({ readStatus: expected, reasonCode: expected, content: null, contentLength: 0, title: null });
    expect(JSON.stringify(result)).not.toContain("Private upstream error");
  });

  it.each([404, 410, 503])("classifies SafeFetch HTTP %i errors without parsing the body", async (status) => {
    const expected = status === 503 ? "maintenance" : "not_found";
    const error = new SearchHubError("bad_request", `Upstream returned HTTP ${status}: <html>secret details</html>`, {
      status,
      details: { upstreamStatus: status, url: "https://example.com/final" },
    });
    const result = await fetchWebpage("https://example.com/start", { fetch: fakeFetch(error) });
    expect(result).toMatchObject({ finalUrl: "https://example.com/final", readStatus: expected, content: null });
    expect(JSON.stringify(result)).not.toContain("secret details");
  });

  it.each([
    { status: 429, code: "network" },
    { status: 500, code: "server_error" },
    { status: 502, code: "server_error" },
    { status: 504, code: "timeout" },
  ] as const)("maps non-throwing HTTP $status to a stable $code error", async ({ status, code }) => {
    const error = await fetchWebpage("https://example.com/start", {
      fetch: fakeFetch(response(page("Secret upstream failure", ARTICLE), {
        status,
        url: "https://user:pass@example.com/final?token=final-secret#access_token=fragment-secret",
        headers: new Headers({ "content-type": "text/html", "retry-after": "120" }),
      })),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchHubError);
    expect(error).toMatchObject({
      code,
      status,
      retryable: true,
      retryAfterMs: 120_000,
      message: `Webpage request failed with HTTP ${status}`,
      details: { upstreamStatus: status, url: "https://example.com/final?token=%5Bredacted%5D" },
    });
    expect(String(error)).not.toContain("Secret upstream failure");
    expect(JSON.stringify(error)).not.toContain("final-secret");
    expect(JSON.stringify(error)).not.toContain("fragment-secret");
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([
    { status: 429, code: "network" },
    { status: 500, code: "server_error" },
    { status: 502, code: "server_error" },
    { status: 504, code: "timeout" },
  ] as const)("normalizes SafeFetch HTTP $status errors to a stable $code error", async ({ status, code }) => {
    const upstream = new SearchHubError("bad_request", "Upstream returned a body that must not escape", {
      status,
      retryAfterMs: 250,
      details: { upstreamStatus: status, url: "https://user:pass@example.com/final?token=final-secret#access_token=fragment-secret" },
    });
    const error = await fetchWebpage("https://example.com/start", { fetch: fakeFetch(upstream) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchHubError);
    expect(error).toMatchObject({
      code,
      status,
      retryable: true,
      retryAfterMs: 250,
      message: `Webpage request failed with HTTP ${status}`,
      details: { upstreamStatus: status, url: "https://example.com/final?token=%5Bredacted%5D" },
    });
    expect(error).not.toBe(upstream);
    expect(String(error)).not.toContain("body that must not escape");
    expect((error as Error).cause).toBeUndefined();
  });

  it("handles real 404 responses from fake transports that do not throw", async () => {
    const result = await fetchWebpage("https://example.com/missing", {
      fetch: fakeFetch(response("Not found", { status: 404 })),
    });
    expect(result.readStatus).toBe("not_found");
  });
});

describe("fetchWebpage limits, cancellation and validation", () => {
  it("passes timeout, signal and byte cap to SafeFetch", async () => {
    const fetch = vi.fn(async () => response(article())) as unknown as SafeFetch;
    const controller = new AbortController();
    await fetchWebpage("https://example.com/", { fetch, signal: controller.signal, timeoutMs: 1234, maxHtmlBytes: 99_999 });
    expect(fetch).toHaveBeenCalledWith("https://example.com/", expect.objectContaining({
      timeoutMs: 1234,
      maxBytes: 99_999,
      signal: controller.signal,
    }));
  });

  it("truncates Markdown and reports independent truncated flag", async () => {
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(article())),
      maxContentChars: 80,
    });
    expect(result.readStatus).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(80);
    expect(result.contentLength).toBe(80);
  });

  it("returns unsupported when a transport ignores the HTML byte cap", async () => {
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(article())),
      maxHtmlBytes: 10,
    });
    expect(result.readStatus).toBe("unsupported");
    expect(result.content).toBeNull();
  });

  it("measures the HTML cap in UTF-8 bytes rather than string characters", async () => {
    const html = article("中文正文", `<article><h1>中文正文</h1><p>${ARTICLE}</p></article>`);
    const result = await fetchWebpage("https://example.com/", {
      fetch: fakeFetch(response(html)),
      maxHtmlBytes: Buffer.byteLength(html, "utf8") - 1,
    });
    expect(result).toMatchObject({ readStatus: "unsupported", content: null });
    expect(JSON.stringify(result)).not.toContain("中文正文");
  });

  it("returns unsupported when SafeFetch blocks an oversized response", async () => {
    const error = new SearchHubError("blocked", "Response exceeded 10 bytes", {
      details: { url: "https://user:pass@example.com/final?token=final-secret#access_token=fragment-secret" },
    });
    const result = await fetchWebpage("https://example.com/start", { fetch: fakeFetch(error) });
    expect(result).toMatchObject({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/final?token=%5Bredacted%5D",
      readStatus: "unsupported",
      reasonCode: "unsupported_content",
      content: null,
    });
    expect(JSON.stringify(result)).not.toContain("final-secret");
    expect(JSON.stringify(result)).not.toContain("fragment-secret");
  });

  it("preserves non-size SafeFetch blocked errors such as SSRF rejection", async () => {
    const error = new SearchHubError("blocked", "URL resolves to a private address", { status: 403 });
    await expect(fetchWebpage("https://example.com/start", { fetch: fakeFetch(error) })).rejects.toBe(error);
  });

  it.each(["cancelled", "timeout"] as const)("does not swallow %s errors with decoding causes", async (code) => {
    const cause = Object.assign(new Error("gzip decoding failed"), { code: "Z_DATA_ERROR" });
    const error = new SearchHubError(code, `${code} upstream request`, { cause });
    await expect(fetchWebpage("https://example.com/start", { fetch: fakeFetch(error) })).rejects.toBe(error);
  });

  it.each([
    { encoding: "gzip", code: "Z_DATA_ERROR", message: "incorrect header check" },
    { encoding: "deflate", code: "Z_DATA_ERROR", message: "invalid block type" },
    { encoding: "br", code: "ERR_BROTLI_DECODING_FAILED", message: "Brotli decompression failed" },
  ])("returns unsupported when remote $encoding decoding fails", async ({ code, message }) => {
    const cause = Object.assign(new Error(message), { code });
    const error = new SearchHubError("network", "Network error requesting https://example.com/", { cause });
    const result = await fetchWebpage("https://example.com/start", { fetch: fakeFetch(error) });
    expect(result).toMatchObject({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/start",
      readStatus: "unsupported",
      reasonCode: "unsupported_content",
      content: null,
    });
    expect(JSON.stringify(result)).not.toContain(message);
  });

  it("does not send a request for a pre-cancelled signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop now"));
    const fetch = vi.fn(async () => response(article())) as unknown as SafeFetch;
    await expect(fetchWebpage("https://example.com/", { fetch, signal: controller.signal })).rejects.toThrow("stop now");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards cancellation during the request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort(new Error("cancelled mid-read"));
      return response(article());
    }) as unknown as SafeFetch;
    await expect(fetchWebpage("https://example.com/", { fetch, signal: controller.signal })).rejects.toThrow("cancelled mid-read");
  });

  it.each(["not a url", "ftp://example.com/file", "file:///etc/passwd", "https://user:pass@example.com/"])("rejects invalid URL %s before fetching", async (url) => {
    const fetch = vi.fn(async () => response(article())) as unknown as SafeFetch;
    await expect(fetchWebpage(url, { fetch })).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid limits before fetching", async () => {
    const fetch = vi.fn(async () => response(article())) as unknown as SafeFetch;
    await expect(fetchWebpage("https://example.com/", { fetch, maxContentChars: 0 })).rejects.toThrow(TypeError);
    await expect(fetchWebpage("https://example.com/", { fetch, maxHtmlBytes: 1.5 })).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes URL credentials and fragments while redacting credential query values", async () => {
    const result = await fetchWebpage("https://example.com/start?token=requested-secret&q=article#access_token=fragment-secret", {
      fetch: fakeFetch(response(article(), { url: "https://user:final-password@example.com/final?api_key=final-secret&q=article#token=fragment-secret" })),
    });
    expect(result.requestedUrl).toBe("https://example.com/start?token=%5Bredacted%5D&q=article");
    expect(result.finalUrl).toBe("https://example.com/final?api_key=%5Bredacted%5D&q=article");
    expect(JSON.stringify(result)).not.toContain("requested-secret");
    expect(JSON.stringify(result)).not.toContain("final-secret");
    expect(JSON.stringify(result)).not.toContain("final-password");
    expect(JSON.stringify(result)).not.toContain("fragment-secret");
  });

  it("rethrows network errors for REST 502 mapping", async () => {
    const networkError = new SearchHubError("network", "network unavailable", { status: 502 });
    await expect(fetchWebpage("https://example.com/", { fetch: fakeFetch(networkError) })).rejects.toBe(networkError);
  });

  it("rethrows timeout errors for REST 504 mapping", async () => {
    const timeoutError = new SearchHubError("timeout", "timed out", { status: 504 });
    await expect(fetchWebpage("https://example.com/", { fetch: fakeFetch(timeoutError) })).rejects.toBe(timeoutError);
  });
});
