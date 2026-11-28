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
    expect(isTerminalEvent({ type: "status", status: "cancelled", terminal: true, final: true })).toBe(true);
    expect(isTerminalEvent({ type: "status", status: "cancelled", terminal: false, final: true })).toBe(false);
    expect(isTerminalEvent({ type: "status", status: "running", terminal: true, final: true })).toBe(false);
    expect(isTerminalEvent({ type: "results", final: false })).toBe(false);
    expect(isTerminalEvent({ type: "status", final: true })).toBe(false);
  });

  it("canonicalizes cancellation as a status terminal and ignores later events", () => {
    const sequencer = new SearchEventSequencer();
    const terminal = sequencer.next("status", {
      status: "cancelled",
      terminal: true,
      final: false,
      reason: "client disconnected",
    });

    expect(terminal).toEqual({
      type: "status",
      sequence: 1,
      final: true,
      status: "cancelled",
      terminal: true,
      reason: "client disconnected",
    });
    expect(isTerminalEvent(terminal)).toBe(true);
    expect(sequencer.closed).toBe(true);
    expect(() => sequencer.next("done")).toThrow(/terminal/i);
  });

  it("preserves ordinary status payloads without allowing envelope overrides", () => {
    const sequencer = new SearchEventSequencer();
    expect(sequencer.next("status", {
      status: "running",
      terminal: false,
      stage: "fanout",
      type: "done",
      sequence: 99,
      final: true,
    })).toEqual({
      type: "status",
      sequence: 1,
      final: false,
      status: "running",
      terminal: false,
      stage: "fanout",
    });
    expect(sequencer.closed).toBe(false);
  });

  it("keeps heartbeats out of the event sequence in exact wire goldens", () => {
    const sequencer = new SearchEventSequencer();
    const status = sequencer.next("status", { status: "running", terminal: false });
    const cancelled = sequencer.next("status", { status: "cancelled", terminal: true });

    expect(encodeSseHeartbeat() + encodeSseEvent(status) + encodeSseEvent(cancelled)).toBe(
      ': heartbeat\n\nevent: status\ndata: {"type":"status","sequence":1,"final":false,"status":"running","terminal":false}\n\n' +
      'event: status\ndata: {"type":"status","sequence":2,"final":true,"status":"cancelled","terminal":true}\n\n',
    );
    expect(encodeNdjsonHeartbeat() + encodeNdjsonEvent(status) + encodeNdjsonEvent(cancelled)).toBe(
      '{"type":"heartbeat"}\n' +
      '{"type":"status","sequence":1,"final":false,"status":"running","terminal":false}\n' +
      '{"type":"status","sequence":2,"final":true,"status":"cancelled","terminal":true}\n',
    );
    expect(sequencer.emitted).toBe(2);
  });
});
