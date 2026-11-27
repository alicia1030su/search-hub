import { afterEach, describe, expect, it, vi } from "vitest";
import { runFetch } from "../../../packages/cli/src/commands/fetch.js";
import { parseCliArgs, helpText } from "../../../packages/cli/src/args.js";
import { HttpClient, HttpResponseError } from "../../../packages/cli/src/client/http.js";

const result = {
  title: "Page",
  content: "# Page\n\nBody",
  author: null,
  publishedAt: null,
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  contentLength: 12,
  readStatus: "ok",
  truncated: false,
  reasonCode: "ok",
};

function clientWith(request: ReturnType<typeof vi.fn>): HttpClient {
  return {
    health: vi.fn(async () => ({ version: "0.1.17" })),
    request,
  } as unknown as HttpClient;
}

afterEach(() => vi.restoreAllMocks());

describe("shub fetch", () => {
  it("registers the command and --max-chars option", () => {
    expect(helpText()).toContain("shub fetch <URL> [--max-chars N] [--json]");
    expect(parseCliArgs(["fetch", "https://example.com", "--max-chars", "100"]).values["max-chars"]).toBe("100");
  });

  it("prints Markdown by default and sends the requested limit", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn(async () => result);
    const code = await runFetch(parseCliArgs(["fetch", "https://example.com", "--max-chars", "100"]), clientWith(request), "table");
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith("# Page\n\nBody\n");
    expect(request).toHaveBeenCalledWith("/api/web/read", { method: "POST", body: { url: "https://example.com/", maxContentChars: 100 } });
  });

  it("prints the complete structured result in JSON mode", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runFetch(parseCliArgs(["fetch", "https://example.com", "--json"]), clientWith(vi.fn(async () => result)), "json");
    expect(code).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toEqual(result);
  });

  it("preserves readStatus and reasonCode from a 422 response", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const unavailable = { ...result, content: null, contentLength: 0, readStatus: "captcha", reasonCode: "captcha_detected" };
    const request = vi.fn(async () => { throw new HttpResponseError(422, "unprocessable", "unavailable", unavailable); });
    const code = await runFetch(parseCliArgs(["fetch", "https://example.com"]), clientWith(request), "table");
    expect(code).toBe(2);
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({ readStatus: "captcha", reasonCode: "captcha_detected", content: null });
  });

  it.each([{ positionals: [] }, { positionals: ["ftp://example.com/file"] }, { positionals: ["https://user:pass@example.com/"] }])("rejects invalid usage without sending a request: %j", async ({ positionals }) => {
    const request = vi.fn(async () => result);
    await expect(runFetch(parseCliArgs(["fetch", ...positionals]), clientWith(request), "table")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an invalid --max-chars value before sending a request", async () => {
    const request = vi.fn(async () => result);
    await expect(runFetch(parseCliArgs(["fetch", "https://example.com", "--max-chars", "0"]), clientWith(request), "table")).rejects.toThrow(/between/);
    expect(request).not.toHaveBeenCalled();
  });
});
