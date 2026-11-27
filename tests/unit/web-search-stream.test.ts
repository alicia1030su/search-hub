import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, SearchStreamParser, SearchStreamUnsupportedError, setCsrfToken } from "../../apps/web/src/lib/api";
import { mergeProvisionalResults, rankingComparison, withoutRawPayloads, funnelConsistent, sourceContributions } from "../../apps/web/src/lib/search-response";
import type { SearchResponse, SearchResult } from "../../apps/web/src/lib/types";

const finalResponse: SearchResponse = {
  taskId: "t1", query: "q", mode: "rrf", status: "completed",
  results: [], errors: [], failedSources: [],
  stats: { rawCount: 0, dedupedCount: 0, fusedCount: 0, providers: [], timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 }, rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false },
};

function streamResponse(chunks: string[], contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": `${contentType}; charset=utf-8` } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken("csrf");
});

describe("search stream", () => {
  it("parses split SSE chunks, multiline data and heartbeats without fake events", () => {
    const parser = new SearchStreamParser("sse");
    const events = [
      ...parser.push(': heartbeat\n\nevent: sta'),
      ...parser.push('tus\ndata: {"status":"fanout",\ndata: "completed":1,"total":2}\n\n'),
      ...parser.push(`event: done\ndata: ${JSON.stringify(finalResponse)}\n\n`),
    ];
    expect(events).toEqual([
      { type: "status", data: { status: "fanout", completed: 1, total: 2 } },
      { type: "done", data: finalResponse },
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it("maps the server's execution event names to UI events", () => {
    const parser = new SearchStreamParser("sse");
    expect(parser.push(`event: results_updated\ndata: ${JSON.stringify({ results: [] })}\n\n`)).toEqual([{ type: "results", data: { results: [] } }]);
    expect(parser.push(`event: search_completed\ndata: ${JSON.stringify(finalResponse)}\n\n`)).toEqual([{ type: "done", data: finalResponse }]);
    expect(parser.push('event: search_failed\ndata: {"message":"failed"}\n\n')).toEqual([{ type: "error", data: { message: "failed" } }]);
  });

  it("consumes NDJSON split at arbitrary bytes and closes after done", async () => {
    const done = `{"type":"done","data":${JSON.stringify(finalResponse)}}`;
    const chunks = [JSON.stringify({ type: "meta", data: { taskId: "t1" } }) + "\n" + done.slice(0, 17), done.slice(17) + "\n"];
    const onEvent = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(chunks, "application/x-ndjson")));
    const result = await api.searchStream({ query: "q", strategy: "balanced" }, { onEvent });
    expect(result).toEqual(finalResponse);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["meta", "done"]);
    expect(fetch).toHaveBeenCalledWith("/api/search/stream", expect.objectContaining({ headers: expect.objectContaining({ "x-csrf-token": "csrf", Accept: expect.stringContaining("text/event-stream") }) }));
  });

  it("surfaces in-stream errors and does not fall back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(['event: error\ndata: {"code":"budget","message":"exhausted"}\n\n'])));
    await expect(api.searchStream({ query: "q", strategy: "deep" })).rejects.toMatchObject({ code: "budget", message: "exhausted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("only treats 404/405 as unsupported, not 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "boom", message: "no" } }), { status: 500 })));
    await expect(api.searchStream({ query: "q", strategy: "auto" })).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(api.searchStream({ query: "q", strategy: "auto" })).rejects.toBeInstanceOf(SearchStreamUnsupportedError);
  });

  it("aborts the reader through the supplied signal", async () => {
    const controller = new AbortController();
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(streamController) {
        init.signal?.addEventListener("abort", () => { cancelled = true; streamController.error(new DOMException("Aborted", "AbortError")); });
      },
    }), { headers: { "content-type": "text/event-stream" } })));
    const promise = api.searchStream({ query: "q", strategy: "auto" }, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });
});

describe("response helpers", () => {
  const result = (id: string, url: string): SearchResult => ({ id, url, title: id, snippet: "", source: "p", provider: "p", providerName: "P", providerType: "web", retrievedAt: "", score: 1, sources: [{ providerId: "p", providerName: "P", providerType: "web", rank: 1, url }] });

  it("merges provisional results by normalized URL without reordering", () => {
    const merged = mergeProvisionalResults([result("1", "https://a.test/?b=2&a=1"), result("2", "https://b.test")], [result("new", "https://a.test/?a=1&b=2#x"), result("3", "https://c.test")]);
    expect(merged.map((item) => item.id)).toEqual(["new", "2", "3"]);
  });

  it("computes contribution counts from final sources and top 10 only", () => {
    const response = structuredClone(finalResponse);
    response.results = Array.from({ length: 12 }, (_, index) => result(String(index), `https://a.test/${index}`));
    expect(sourceContributions(response)[0]).toMatchObject({ finalCount: 12, topKCount: 10 });
  });

  it("preserves final order and strips raw recursively for export", () => {
    const response = structuredClone(finalResponse);
    response.results = [result("2", "https://2.test"), result("1", "https://1.test")];
    response.results[0]!.metadata = { raw: { secret: true }, keep: 1 };
    response.debug = { rerankComparison: { before: [{ ...result("0", "https://0.test"), metadata: { raw: "secret" } }], after: response.results } };
    const exported = withoutRawPayloads(response);
    expect(exported.results.map((item) => item.id)).toEqual(["2", "1"]);
    expect(exported.results[0]!.metadata).toEqual({ keep: 1 });
    expect(exported.debug?.rerankComparison?.before?.[0]?.metadata).toBeUndefined();
    expect(response.results[0]!.metadata?.raw).toEqual({ secret: true });
  });

  it("reports ranking movements including entered/exited and em-dash friendly absent ranks", () => {
    const rows = rankingComparison([result("a", "https://a.test"), result("b", "https://b.test")], [result("b", "https://b.test"), result("c", "https://c.test")]);
    expect(rows.find((row) => row.key.includes("a.test"))).toMatchObject({ before: 1, after: undefined, movement: "exited" });
    expect(rows.find((row) => row.key.includes("c.test"))).toMatchObject({ after: 2, movement: "entered" });
  });

  it("checks B1 without silently fixing counts", () => {
    expect(funnelConsistent({ raw: 10, invalidDropped: 1, duplicatesDropped: 2, truncated: 3, final: 4 })).toBe(true);
    expect(funnelConsistent({ raw: 10, invalidDropped: 1, duplicatesDropped: 2, truncated: 3, final: 5 })).toBe(false);
    expect(funnelConsistent({ raw: 10 })).toBeNull();
  });
});
