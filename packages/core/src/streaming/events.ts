export type SearchStreamEventType = "meta" | "results" | "status" | "done" | "error";

export interface SearchStreamEvent {
  type: SearchStreamEventType;
  sequence: number;
  final: boolean;
  [key: string]: unknown;
}

export type SearchStreamTerminal =
  | { type: "done" | "error"; final: true }
  | { type: "status"; status: "cancelled"; terminal: true; final: true };

/** Allocates gap-free sequence numbers; heartbeats deliberately do not consume one. */
export class SearchEventSequencer {
  private sequence = 0;
  private terminalEmitted = false;

  next(type: SearchStreamEventType, payload: Record<string, unknown> = {}): SearchStreamEvent {
    if (this.terminalEmitted) throw new Error("Cannot emit an event after the terminal event");
    this.sequence += 1;
    const cancelled = type === "status" && payload["status"] === "cancelled" && payload["terminal"] === true;
    const final = type === "done" || type === "error" || cancelled;
    if (final) this.terminalEmitted = true;

    // Callers cannot override the transport-owned envelope fields. Cancellation
    // is represented as a status event, with all three terminal markers fixed.
    const eventPayload = { ...payload };
    delete eventPayload["type"];
    delete eventPayload["sequence"];
    delete eventPayload["final"];
    return {
      type,
      sequence: this.sequence,
      final,
      ...eventPayload,
      ...(cancelled ? { status: "cancelled", terminal: true } : {}),
    };
  }

  get emitted(): number {
    return this.sequence;
  }

  get closed(): boolean {
    return this.terminalEmitted;
  }
}

export function encodeSseEvent(event: SearchStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function encodeNdjsonEvent(event: SearchStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeSseHeartbeat(): string {
  return ": heartbeat\n\n";
}

export function encodeNdjsonHeartbeat(): string {
  return '{"type":"heartbeat"}\n';
}

export function isTerminalEvent(
  event: Pick<SearchStreamEvent, "type" | "final"> & Partial<Pick<SearchStreamEvent, "status" | "terminal">>,
): event is SearchStreamTerminal {
  if (event.final !== true) return false;
  if (event.type === "done" || event.type === "error") return true;
  return event.type === "status" && event.status === "cancelled" && event.terminal === true;
}
