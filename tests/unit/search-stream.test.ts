import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startSearchStream } from "../../apps/api/src/services/search-stream.js";
import type { SearchService } from "../../apps/api/src/services/search.js";
import type { SearchExecutionEvent, SearchRequest, SearchResponse } from "@search-hub/shared";

const request: SearchRequest = { query: "stream", mode: "basic", limit: 5 };
type ExecuteOptions = Parameters<SearchService["execute"]>[1];

function responseFixture(status: SearchResponse["status"] = "completed"): SearchResponse {
  return {
    taskId: "task-stream",
    query: "stream",
    mode: "basic",
    status,
    results: [],
    stats: {
      rawCount: 0,
      dedupedCount: 0,
      fusedCount: 0,
      providers: [],
      timing: { totalMs: 0, fanoutMs: 0, fusionMs: 0 },
      rerankApplied: false,
      embeddingApplied: false,
      summaryApplied: false,
      partial: status === "partial",
    },
    errors: [],
    failedSources: [],
  };
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseNdjson(payload: string): Array<Record<string, unknown>> {
  return payload.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("search event stream", () => {
  it("aborts the search when a slow consumer exceeds the bounded queue", async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (_request: SearchRequest, options: { signal?: AbortSignal; onEvent?: (event: { type: "results_updated"; data: Record<string, unknown> }) => void }) => {
      signal = options.signal;
      for (let index = 0; index < 100; index += 1) {
        options.onEvent?.({ type: "results_updated", data: { index } });
      }
      return responseFixture();
    });
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "sse" },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(handle.stream.destroyed).toBe(true);
  });

  it("propagates explicit cancellation to the in-flight search", () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn((_request: SearchRequest, options: { signal?: AbortSignal }) => {
      signal = options.signal;
      return new Promise<SearchResponse>(() => undefined);
    });
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "ndjson" },
    );

    handle.cancel();
    expect(signal?.aborted).toBe(true);
    handle.stream.destroy();
  });

  it("emits one canonical SSE cancellation terminal when onEvent reports cancellation", async () => {
    const execute = vi.fn(async (_request: SearchRequest, options: ExecuteOptions) => {
      options?.onEvent?.({ type: "meta", data: { taskId: "task-stream" } });
      options?.onEvent?.({
        type: "status",
        data: { status: "cancelled", terminal: true, reason: "client disconnected" },
      });
      options?.onEvent?.({ type: "results_updated", data: { results: [] } });
      return responseFixture("cancelled");
    });
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "sse" },
    );

    expect(await readStream(handle.stream)).toBe(
      'event: meta\ndata: {"type":"meta","sequence":1,"final":false,"taskId":"task-stream"}\n\n' +
      'event: status\ndata: {"type":"status","sequence":2,"final":true,"status":"cancelled","terminal":true,"reason":"client disconnected"}\n\n',
    );
  });

  it("emits one canonical NDJSON cancellation terminal when execute returns cancellation", async () => {
    const execute = vi.fn(async () => responseFixture("cancelled"));
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "ndjson" },
    );

    const events = parseNdjson(await readStream(handle.stream));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "status",
      sequence: 1,
      final: true,
      status: "cancelled",
      terminal: true,
      taskId: "task-stream",
      results: [],
    });
    expect(events.some((event) => event["type"] === "cancelled")).toBe(false);
  });

  it.each([
    ["partial", "done"],
    ["failed", "error"],
  ] as const)("maps %s responses to a single %s terminal", async (status, type) => {
    const execute = vi.fn(async () => responseFixture(status));
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "ndjson" },
    );

    const events = parseNdjson(await readStream(handle.stream));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type, sequence: 1, final: true, status });
  });

  it("ignores observer events after an execution terminal", async () => {
    const execute = vi.fn(async (_request: SearchRequest, options: ExecuteOptions) => {
      const terminal: SearchExecutionEvent = { type: "search_failed", data: { status: "failed" } };
      options?.onEvent?.(terminal);
      options?.onEvent?.({ type: "meta", data: { taskId: "too-late" } });
      return responseFixture("failed");
    });
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "test", format: "ndjson" },
    );

    const events = parseNdjson(await readStream(handle.stream));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", sequence: 1, final: true, status: "failed" });
  });
});
