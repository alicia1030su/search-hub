import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startSearchStream } from "../../apps/api/src/services/search-stream.js";
import type { SearchService } from "../../apps/api/src/services/search.js";
import type {
  SearchExecutionEvent,
  SearchExecutionEventType,
  SearchRequest,
  SearchResponse,
} from "@search-hub/shared";
import type { SearchStreamEventType } from "../../packages/core/src/streaming/events.js";

type StreamFormat = "sse" | "ndjson";
type ExecuteOptions = Parameters<SearchService["execute"]>[1];

interface GoldenEvent {
  type: SearchStreamEventType;
  final: boolean;
  payload: Record<string, unknown>;
}

interface StreamScenario {
  name: string;
  status: SearchResponse["status"];
  events: SearchExecutionEvent[];
  golden: GoldenEvent[];
}

const request: SearchRequest = { query: "golden", mode: "basic", limit: 5 };

function executionEvent(type: SearchExecutionEventType, payload: Record<string, unknown>): SearchExecutionEvent {
  return { type, data: payload };
}

function goldenEvent(
  type: SearchStreamEventType,
  final: boolean,
  payload: Record<string, unknown>,
): GoldenEvent {
  return { type, final, payload };
}

function responseFixture(status: SearchResponse["status"]): SearchResponse {
  return {
    taskId: "task-golden",
    query: "golden",
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

function parseWire(format: StreamFormat, wire: string): Array<Record<string, unknown>> {
  if (format === "ndjson") {
    return wire.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  return wire
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectedWire(format: StreamFormat, golden: GoldenEvent[]): string {
  const events = golden.map((event, index) => ({
    type: event.type,
    sequence: index + 1,
    final: event.final,
    ...event.payload,
  }));
  if (format === "ndjson") return events.map((event) => `${JSON.stringify(event)}\n`).join("");
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const singleResult = { id: "single", url: "https://example.com/single" };
const partialResult = { id: "partial", url: "https://example.com/partial" };
const qualityResults = [
  { id: "quality-second", url: "https://example.com/quality-2" },
  { id: "quality-first", url: "https://example.com/quality-1" },
];
const mergedDeepResult = {
  id: "deep-merged",
  url: "https://example.com/shared",
  queryOrigins: ["q1", "q2"],
};

const scenarios: StreamScenario[] = [
  {
    name: "single-source success",
    status: "completed",
    events: [
      executionEvent("meta", { taskId: "task-golden" }),
      executionEvent("results_updated", { results: [singleResult] }),
      executionEvent("status", { status: "completed", terminal: false }),
      executionEvent("search_completed", { status: "completed", results: [singleResult] }),
    ],
    golden: [
      goldenEvent("meta", false, { taskId: "task-golden" }),
      goldenEvent("results", false, { results: [singleResult] }),
      goldenEvent("status", false, { status: "completed", terminal: false }),
      goldenEvent("done", true, { status: "completed", results: [singleResult] }),
    ],
  },
  {
    name: "multi-source partial success",
    status: "partial",
    events: [
      executionEvent("meta", { taskId: "task-golden" }),
      executionEvent("results_updated", { results: [partialResult] }),
      executionEvent("status", { status: "partial", terminal: false }),
      executionEvent("search_completed", {
        status: "partial",
        results: [partialResult],
        errors: [{ code: "timeout", message: "one source timed out" }],
      }),
    ],
    golden: [
      goldenEvent("meta", false, { taskId: "task-golden" }),
      goldenEvent("results", false, { results: [partialResult] }),
      goldenEvent("status", false, { status: "partial", terminal: false }),
      goldenEvent("done", true, {
        status: "partial",
        results: [partialResult],
        errors: [{ code: "timeout", message: "one source timed out" }],
      }),
    ],
  },
  {
    name: "quality rerank",
    status: "completed",
    events: [
      executionEvent("meta", { taskId: "task-golden" }),
      executionEvent("rerank_started", { taskId: "task-golden", candidateCount: 2 }),
      executionEvent("results_updated", { results: qualityResults }),
      executionEvent("status", { status: "completed", terminal: false }),
      executionEvent("search_completed", {
        status: "completed",
        results: qualityResults,
        stats: { rerankApplied: true },
      }),
    ],
    golden: [
      goldenEvent("meta", false, { taskId: "task-golden" }),
      goldenEvent("status", false, { stage: "rerank_started", taskId: "task-golden", candidateCount: 2 }),
      goldenEvent("results", false, { results: qualityResults }),
      goldenEvent("status", false, { status: "completed", terminal: false }),
      goldenEvent("done", true, {
        status: "completed",
        results: qualityResults,
        stats: { rerankApplied: true },
      }),
    ],
  },
  {
    name: "deep cross-query duplicate",
    status: "completed",
    events: [
      executionEvent("meta", { taskId: "task-golden" }),
      executionEvent("status", { status: "running", terminal: false, stage: "query_expansion" }),
      executionEvent("results_updated", { results: [mergedDeepResult] }),
      executionEvent("search_completed", {
        status: "completed",
        results: [mergedDeepResult],
        stats: { deepQueries: 2 },
      }),
    ],
    golden: [
      goldenEvent("meta", false, { taskId: "task-golden" }),
      goldenEvent("status", false, { status: "running", terminal: false, stage: "query_expansion" }),
      goldenEvent("results", false, { results: [mergedDeepResult] }),
      goldenEvent("done", true, {
        status: "completed",
        results: [mergedDeepResult],
        stats: { deepQueries: 2 },
      }),
    ],
  },
  {
    name: "cache hit",
    status: "completed",
    events: [
      executionEvent("meta", { taskId: "task-golden", cached: true }),
      executionEvent("search_completed", { status: "completed", results: [], cached: true }),
    ],
    golden: [
      goldenEvent("meta", false, { taskId: "task-golden", cached: true }),
      goldenEvent("done", true, { status: "completed", results: [], cached: true }),
    ],
  },
  {
    name: "failure",
    status: "failed",
    events: [
      executionEvent("meta", { taskId: "task-golden" }),
      executionEvent("search_failed", {
        status: "failed",
        errors: [{ code: "server_error", message: "upstream failed" }],
      }),
    ],
    golden: [
      goldenEvent("meta", false, { taskId: "task-golden" }),
      goldenEvent("error", true, {
        status: "failed",
        errors: [{ code: "server_error", message: "upstream failed" }],
      }),
    ],
  },
  {
    name: "cancellation",
    status: "cancelled",
    events: [
      executionEvent("meta", { taskId: "task-golden" }),
      executionEvent("status", { status: "cancelled", terminal: true }),
    ],
    golden: [
      goldenEvent("meta", false, { taskId: "task-golden" }),
      goldenEvent("status", true, { status: "cancelled", terminal: true }),
    ],
  },
];

const cases = scenarios.flatMap((scenario) =>
  (["sse", "ndjson"] as const).map((format) => ({ scenario, format })),
);

describe("B4 search stream scenario goldens", () => {
  it.each(cases)("$scenario.name over $format", async ({ scenario, format }) => {
    const execute = vi.fn(async (_request: SearchRequest, options: ExecuteOptions) => {
      for (const event of scenario.events) options?.onEvent?.(event);
      options?.onEvent?.(executionEvent("meta", { taskId: "after-terminal" }));
      return responseFixture(scenario.status);
    });
    const handle = startSearchStream(
      { execute } as unknown as Pick<SearchService, "execute">,
      { request, actor: "golden-test", format },
    );

    const wire = await readStream(handle.stream);
    expect(wire).toBe(expectedWire(format, scenario.golden));

    const events = parseWire(format, wire);
    expect(events.map((event) => event["sequence"])).toEqual(events.map((_, index) => index + 1));
    expect(events.filter((event) => event["final"] === true)).toHaveLength(1);
    expect(events.at(-1)?.final).toBe(true);
    expect(events.some((event) => event["type"] === "cancelled")).toBe(false);
    for (const event of events.filter((item) => item["type"] === "results")) {
      expect(event["final"]).toBe(false);
    }

    if (scenario.name === "cache hit") {
      expect(events.map((event) => event["type"])).toEqual(["meta", "done"]);
      expect(events[1]).toMatchObject({ sequence: 2, final: true, cached: true });
    }
    if (scenario.name === "cancellation") {
      expect(events.at(-1)).toMatchObject({
        type: "status",
        status: "cancelled",
        terminal: true,
        final: true,
      });
    }
  });
});
