import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, helpText } from "../../../packages/cli/src/args.js";
import { HttpClient, HttpResponseError } from "../../../packages/cli/src/client/http.js";
import { runSearch, SearchStreamDecoder } from "../../../packages/cli/src/commands/search.js";
import { EXIT_CODES } from "../../../packages/cli/src/errors/index.js";

const finalResponse = {
  taskId: "task-1",
  query: "stream test",
  mode: "basic",
  status: "completed",
  results: [{ id: "r1", title: "Final result", url: "https://example.com/final", provider: "mock", providerName: "Mock" }],
  errors: [],
  failedSources: [],
  stats: { rawCount: 1, dedupedCount: 1, fusedCount: 1, providers: [] },
};

function event(type: string, sequence: number, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sequence, final: ["done", "error", "cancelled"].includes(type), ...data });
}

function sse(...events: string[]): string {
  return events.map((value) => `event: search\ndata: ${value}\n\n`).join("");
}

function response(payload: string, type = "text/event-stream"): Response {
  return new Response(payload, { headers: { "content-type": type } });
}

function captureOutput(): { stdout: ReturnType<typeof vi.spyOn>; stderr: ReturnType<typeof vi.spyOn> } {
  return {
    stdout: vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    stderr: vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  };
}

function outputLines(stdout: ReturnType<typeof vi.spyOn>): string[] {
  return stdout.mock.calls.map((call: unknown[]) => String(call[0]));
}

function mockFetch(stream: Response | (() => Promise<Response>), token = "test-token"): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (String(_url).endsWith("/api/health")) {
      return Response.json({ status: "ok", version: "0.1.18", uptimeSeconds: 1, setupRequired: false, providers: { total: 1, enabled: 1, healthy: 1, circuitOpen: 0 } });
    }
    expect(init?.method).toBe("POST");
    expect(((init?.headers ?? {}) as Record<string, string>)["authorization"]).toBe(`Bearer ${token}`);
    return typeof stream === "function" ? await stream() : stream;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function streamClient(signal?: AbortSignal): HttpClient {
  return new HttpClient("http://127.0.0.1:8787", "test-token", 30_000, signal);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shub search --stream", () => {
  it("registers --stream and --stream-format in help and argument parsing", () => {
    expect(helpText()).toContain("--stream-format <sse|ndjson>");
    const args = parseCliArgs(["search", "hello", "--stream", "--stream-format", "ndjson"]);
    expect(args.values["stream"]).toBe(true);
    expect(args.values["stream-format"]).toBe("ndjson");
  });

  it.each([
    ["--stream-format", "ndjson"],
    ["--stream", "--stream-format", "xml"],
  ])("rejects invalid stream flags before fetching: %j", async (...flags) => {
    const fetchMock = mockFetch(response(""));
    await expect(runSearch(parseCliArgs(["search", "hello", ...flags]), streamClient(), "table")).rejects.toThrow(/requires|one of/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints SSE provider/progress/temporary events before the final chunk arrives", async () => {
    const { stdout } = captureOutput();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode(sse(event("meta", 1, { taskId: "task-1", mode: "basic" }))));
      },
    });
    const fetchMock = mockFetch(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const pending = runSearch(
      parseCliArgs(["search", "stream test", "--stream", "--provider", "mock", "--limit", "3", "--mode", "deep", "--timeout", "5000"]),
      streamClient(),
      "table",
    );
    await vi.waitFor(() => expect(outputLines(stdout).join("")).toContain("[meta]"));
    const live = outputLines(stdout).join("");
    expect(live).not.toContain("[final]");
    controller.enqueue(new TextEncoder().encode(sse(
      event("status", 2, { stage: "provider_started", providerId: "mock" }),
      event("status", 3, { stage: "rerank_started" }),
      event("results", 4, { results: [{ title: "Temporary", url: "https://example.com/tmp", providerName: "Mock" }] }),
    )));
    await vi.waitFor(() => expect(outputLines(stdout).join("")).toContain("[results_updated] [temporary]"));
    controller.enqueue(new TextEncoder().encode(sse(event("done", 5, finalResponse))));
    controller.close();
    await expect(pending).resolves.toBe(EXIT_CODES.ok);
    const text = outputLines(stdout).join("");
    expect(text).toContain("[provider] stage=provider_started providerId=mock");
    expect(text).toContain("[progress] stage=rerank_started");
    expect(text.match(/\[final\]/g)).toHaveLength(1);
    expect(text).toContain("Final result");
    const streamCall = fetchMock.mock.calls[1]!;
    expect(String(streamCall[0])).toBe("http://127.0.0.1:8787/api/search/stream");
    expect(JSON.parse(String((streamCall[1] as RequestInit).body))).toMatchObject({
      query: "stream test", providers: ["mock"], limit: 3, mode: "deep", timeoutMs: 5000, stream: "sse",
    });
  });

  it("supports NDJSON wire format and emits one authoritative final event in JSON mode", async () => {
    const { stdout } = captureOutput();
    const cancel = vi.fn();
    const payload = [
      event("meta", 1, { taskId: "task-1" }),
      event("results", 2, { results: [] }),
      event("done", 3, finalResponse),
      event("done", 4, finalResponse),
    ].join("\n") + "\n";
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel,
    });
    mockFetch(new Response(body, { headers: { "content-type": "application/x-ndjson" } }));
    const code = await runSearch(parseCliArgs(["search", "stream test", "--stream", "--stream-format", "ndjson", "--json"]), streamClient(), "json");
    expect(code).toBe(EXIT_CODES.ok);
    const events = outputLines(stdout).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ type: "results", resultSet: "temporary", streaming: true });
    expect(events[2]).toMatchObject({ type: "done", resultSet: "final", streaming: true, results: finalResponse.results });
    expect(events.filter((value) => value["final"] === true)).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { type: "error", code: 6, message: "provider unavailable" },
    { type: "cancelled", code: 130, message: "Search cancelled" },
  ])("returns a nonzero exit and concise stderr for $type", async ({ type, code, message }) => {
    const { stdout, stderr } = captureOutput();
    mockFetch(response(sse(event(type, 1, { message }))));
    await expect(runSearch(parseCliArgs(["search", "hello", "--stream"]), streamClient(), "table")).resolves.toBe(code);
    expect(outputLines(stdout).join("")).toContain(`[${type}] [final]`);
    expect(outputLines(stderr).join("")).toContain(message);
  });

  it("accepts the status-based cancelled terminal contract", async () => {
    const { stdout, stderr } = captureOutput();
    mockFetch(response(sse(event("status", 1, { status: "cancelled", terminal: true, final: true, message: "Search cancelled" }))));
    await expect(runSearch(parseCliArgs(["search", "hello", "--stream", "--json"]), streamClient(), "json")).resolves.toBe(EXIT_CODES.interrupted);
    expect(JSON.parse(outputLines(stdout)[0]!)).toMatchObject({ type: "status", status: "cancelled", terminal: true, final: true, resultSet: "final" });
    expect(outputLines(stderr).join("")).toContain("Search cancelled");
  });

  it("aborts fetch and releases the reader when the client is interrupted", async () => {
    captureOutput();
    const interrupt = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(event("meta", 1, { taskId: "task-1" }))));
        interrupt.signal.addEventListener("abort", () => controller.error(interrupt.signal.reason), { once: true });
      },
      cancel,
    });
    mockFetch(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const pending = runSearch(parseCliArgs(["search", "hello", "--stream"]), streamClient(interrupt.signal), "table");
    await vi.waitFor(() => expect(body.locked).toBe(true));
    interrupt.abort();
    await expect(pending).rejects.toMatchObject({ code: "interrupted", exitCode: EXIT_CODES.interrupted });
    expect(body.locked).toBe(false);
    const fetchMock = vi.mocked(fetch);
    expect((fetchMock.mock.calls[1]![1] as RequestInit).signal?.aborted).toBe(true);
  });

  it("rejects a stream that closes without a terminal event", async () => {
    captureOutput();
    mockFetch(response(sse(event("meta", 1, { taskId: "task-1" }))));
    await expect(runSearch(parseCliArgs(["search", "hello", "--stream"]), streamClient(), "table")).rejects.toMatchObject({ code: "incomplete_stream" });
  });

  it("redacts the configured token from temporary and final output", async () => {
    const { stdout } = captureOutput();
    mockFetch(response(sse(
      event("results", 1, { results: [{ title: "test-token", url: "https://example.com" }] }),
      event("done", 2, { ...finalResponse, query: "test-token" }),
    )));
    await runSearch(parseCliArgs(["search", "hello", "--stream", "--json"]), streamClient(), "json");
    expect(outputLines(stdout).join("")).not.toContain("test-token");
    expect(outputLines(stdout).join("")).toContain("[redacted]");
  });

  it("keeps ordinary JSON search on the non-streaming endpoint and output contract", async () => {
    const { stdout } = captureOutput();
    const fetchMock = mockFetch(Response.json({ ...finalResponse, token: "test-token" }));
    const code = await runSearch(parseCliArgs(["search", "stream test", "--json"]), streamClient(), "json");
    expect(code).toBe(EXIT_CODES.ok);
    expect(fetchMock.mock.calls[1]![0]).toBe("http://127.0.0.1:8787/api/search");
    const output = JSON.parse(outputLines(stdout)[0]!) as Record<string, unknown>;
    expect(output).toMatchObject({ taskId: "task-1", results: finalResponse.results });
    expect(output["token"]).toBe("[redacted]");
    expect(output).not.toHaveProperty("streaming");
  });

  it("preserves ordinary failed search responses and their nonzero exit", async () => {
    captureOutput();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ version: "0.1.18" }))
      .mockResolvedValueOnce(Response.json({ ...finalResponse, status: "failed" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runSearch(parseCliArgs(["search", "hello"]), streamClient(), "table")).resolves.toBe(EXIT_CODES.server);
    expect(fetchMock.mock.calls[1]![0]).toBe("http://127.0.0.1:8787/api/search");
  });
});

describe("SearchStreamDecoder", () => {
  it("handles split UTF-8-independent chunks, CRLF, multiline data and heartbeats", () => {
    const decoder = new SearchStreamDecoder("sse");
    const wire = `: heartbeat\r\n\r\nevent: meta\r\ndata: ${event("meta", 1)}\r\n\r\ndata: {"type":"results",\r\ndata: "sequence":2,"final":false,"results":[]}\r\n\r\ndata: ${event("done", 3, finalResponse)}\r\n\r\n`;
    const events: unknown[] = [];
    for (const char of wire) events.push(...decoder.push(char));
    decoder.finish();
    expect(events).toHaveLength(3);
  });

  it.each([
    [event("results", 2) + "\n", /out-of-order/],
    [event("done", 1, { final: false }) + "\n", /out-of-order/],
    ["not-json\n", /malformed/],
  ])("rejects invalid NDJSON grammar", (wire, message) => {
    const decoder = new SearchStreamDecoder("ndjson");
    expect(() => decoder.push(wire)).toThrow(message);
  });

  it("ignores trailing data in the same chunk after a terminal event", () => {
    const decoder = new SearchStreamDecoder("ndjson");
    expect(decoder.push(event("done", 1, finalResponse) + "\n" + event("meta", 2) + "\n")).toHaveLength(1);
    expect(() => decoder.push(event("meta", 2) + "\n")).toThrow(/after the terminal/);
  });

  it("propagates streaming HTTP errors without invoking the consumer", async () => {
    const consume = vi.fn();
    mockFetch(Response.json({ error: { code: "unauthorized", message: "bad token" } }, { status: 401 }));
    await expect(streamClient().consumeStream("/api/search/stream", { method: "POST", body: {} }, consume)).rejects.toBeInstanceOf(HttpResponseError);
    expect(consume).not.toHaveBeenCalled();
  });
});
