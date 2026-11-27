export type SearchStreamEventType = "meta" | "results" | "status" | "done" | "error" | "cancelled";

export interface SearchStreamEvent {
  type: SearchStreamEventType;
  sequence: number;
  final: boolean;
  [key: string]: unknown;
}

export interface SearchStreamTerminal {
  type: "done" | "error" | "cancelled";
  final: true;
}

/** Allocates gap-free sequence numbers; heartbeats deliberately do not consume one. */
export class SearchEventSequencer {
  private sequence = 0;
  private terminalEmitted = false;

  next(type: SearchStreamEventType, payload: Record<string, unknown> = {}): SearchStreamEvent {
    if (this.terminalEmitted) throw new Error("Cannot emit an event after the terminal event");
    this.sequence += 1;
    const final = type === "done" || type === "error" || type === "cancelled";
    if (final) this.terminalEmitted = true;
    return { type, sequence: this.sequence, final, ...payload };
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

export function isTerminalEvent(event: Pick<SearchStreamEvent, "type" | "final">): event is SearchStreamTerminal {
  return event.final === true && (event.type === "done" || event.type === "error" || event.type === "cancelled");
}
