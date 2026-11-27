import { describe, expect, it } from "vitest";
import {
  SearchEventSequencer,
  encodeNdjsonEvent,
  encodeNdjsonHeartbeat,
  encodeSseEvent,
  encodeSseHeartbeat,
  isTerminalEvent,
} from "../../packages/core/src/streaming/events.js";

describe("search stream grammar", () => {
  it("allocates gap-free sequences and closes exactly once", () => {
    const sequencer = new SearchEventSequencer();
    expect(sequencer.next("meta", { taskId: "t1" })).toEqual({ type: "meta", sequence: 1, final: false, taskId: "t1" });
    expect(sequencer.next("results", { results: [] })).toEqual({ type: "results", sequence: 2, final: false, results: [] });
    expect(sequencer.next("done", { status: "completed" })).toEqual({ type: "done", sequence: 3, final: true, status: "completed" });
    expect(sequencer.closed).toBe(true);
    expect(() => sequencer.next("status")).toThrow(/terminal/i);
  });

  it("encodes exact SSE and NDJSON frames", () => {
    const event = { type: "meta" as const, sequence: 1, final: false as const, taskId: "t1" };
    expect(encodeSseEvent(event)).toBe('event: meta\ndata: {"type":"meta","sequence":1,"final":false,"taskId":"t1"}\n\n');
    expect(encodeNdjsonEvent(event)).toBe('{"type":"meta","sequence":1,"final":false,"taskId":"t1"}\n');
    expect(encodeSseHeartbeat()).toBe(": heartbeat\n\n");
    expect(encodeNdjsonHeartbeat()).toBe('{"type":"heartbeat"}\n');
  });

  it("recognizes only explicit terminal events", () => {
    expect(isTerminalEvent({ type: "done", final: true })).toBe(true);
    expect(isTerminalEvent({ type: "error", final: true })).toBe(true);
    expect(isTerminalEvent({ type: "cancelled", final: true })).toBe(true);
    expect(isTerminalEvent({ type: "results", final: false })).toBe(false);
    expect(isTerminalEvent({ type: "status", final: true })).toBe(false);
  });
});
