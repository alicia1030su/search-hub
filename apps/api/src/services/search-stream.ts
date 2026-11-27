import { Readable } from "node:stream";
import {
  SearchEventSequencer,
  encodeNdjsonEvent,
  encodeNdjsonHeartbeat,
  encodeSseEvent,
  encodeSseHeartbeat,
  type SearchStreamEvent,
} from "@search-hub/core";
import {
  redactSecrets,
  type SearchExecutionEvent,
  type SearchRequest,
  type SearchResponse,
} from "@search-hub/shared";
import type { SearchService } from "./search.js";

export interface SearchStreamOptions {
  request: SearchRequest;
  actor: string;
  signal?: AbortSignal;
  format: "sse" | "ndjson";
}

export interface SearchStreamHandle {
  stream: Readable;
  cancel: () => void;
}

const MAX_QUEUED_EVENTS = 64;
const MAX_QUEUED_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;

/** Starts a search and exposes a bounded SSE/NDJSON stream with backpressure. */
export function startSearchStream(
  service: Pick<SearchService, "execute">,
  options: SearchStreamOptions,
): SearchStreamHandle {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(options.signal?.reason ?? new Error("client disconnected"));
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const sequencer = new SearchEventSequencer();
  const encode = options.format === "ndjson" ? encodeNdjsonEvent : encodeSseEvent;
  const heartbeat = options.format === "ndjson" ? encodeNdjsonHeartbeat : encodeSseHeartbeat;
  const queue: string[] = [];
  let queuedBytes = 0;
  let finished = false;
  let flushScheduled = false;
  let stream: Readable | null = null;

  const cleanup = (): void => {
    clearInterval(heartbeatTimer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  };

  const scheduleFlush = (): void => {
    if (flushScheduled || !stream || stream.destroyed) return;
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      flush();
    });
  };

  const pushFrame = (frame: string): void => {
    if (finished) return;
    queue.push(frame);
    queuedBytes += Buffer.byteLength(frame);
    if (queue.length > MAX_QUEUED_EVENTS || queuedBytes > MAX_QUEUED_BYTES) {
      controller.abort(new Error("slow stream consumer"));
      stream?.destroy();
      return;
    }
    scheduleFlush();
  };

  const emit = (event: SearchExecutionEvent): void => {
    if (finished || sequencer.closed) return;
    let encoded: SearchStreamEvent;
    switch (event.type) {
      case "meta":
        encoded = sequencer.next("meta", event.data);
        break;
      case "results_updated":
        encoded = sequencer.next("results", event.data);
        break;
      case "status":
        encoded = event.data["terminal"] === true && event.data["status"] === "cancelled"
          ? sequencer.next("cancelled", event.data)
          : sequencer.next("status", event.data);
        break;
      case "search_completed":
        encoded = sequencer.next("done", event.data);
        break;
      case "search_failed":
        encoded = sequencer.next("error", event.data);
        break;
      default:
        encoded = sequencer.next("status", { stage: event.type, ...event.data });
        break;
    }
    pushFrame(encode(encoded));
    if (encoded.final) {
      finished = true;
      scheduleFlush();
    }
  };

  const flush = (): void => {
    if (!stream) return;
    while (queue.length > 0) {
      const frame = queue.shift()!;
      queuedBytes -= Buffer.byteLength(frame);
      if (!stream.push(frame)) break;
    }
    if (finished && queue.length === 0) stream.push(null);
  };

  stream = new Readable({
    read: flush,
    destroy(error, callback) {
      finished = true;
      cleanup();
      controller.abort(error ?? new Error("stream closed"));
      callback(error);
    },
  });

  const heartbeatTimer = setInterval(() => {
    if (!finished) pushFrame(heartbeat());
  }, HEARTBEAT_MS);

  void service.execute(options.request, {
    actor: options.actor,
    signal: controller.signal,
    onEvent: emit,
  }).then((response: SearchResponse) => {
    if (!sequencer.closed) {
      const type = response.status === "cancelled" ? "cancelled" : response.status === "failed" ? "error" : "done";
      const terminal = sequencer.next(type, { ...response } as unknown as Record<string, unknown>);
      pushFrame(encode(terminal));
      finished = true;
      scheduleFlush();
    }
  }).catch((error: unknown) => {
    if (!sequencer.closed) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      const terminal = sequencer.next("error", { code: "search_failed", message });
      pushFrame(encode(terminal));
      finished = true;
      scheduleFlush();
    }
  }).finally(() => {
    finished = true;
    scheduleFlush();
    cleanup();
  });

  return {
    stream,
    cancel: () => controller.abort(new Error("client disconnected")),
  };
}
