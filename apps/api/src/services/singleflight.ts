import type { SearchResponse } from "@search-hub/shared";

interface Waiter {
  resolve: (response: SearchResponse) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Flight {
  key: string;
  controller: AbortController;
  promise: Promise<SearchResponse>;
  waiters: Set<Waiter>;
  timer: NodeJS.Timeout | null;
  settled: boolean;
}

export interface SearchFlightOptions {
  /** Absolute request deadline in epoch milliseconds. */
  deadlineAtMs?: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** Bounded singleflight for equivalent cold cache misses. */
export class SearchFlightService {
  readonly maxFlights: number;
  readonly maxWaitersPerFlight: number;
  readonly maxTotalWaiters: number;
  private readonly flights = new Map<string, Flight>();
  private totalWaiters = 0;
  private shutDown = false;

  constructor(options: { maxFlights?: number; maxWaitersPerFlight?: number; maxTotalWaiters?: number } = {}) {
    this.maxFlights = options.maxFlights ?? 256;
    this.maxWaitersPerFlight = options.maxWaitersPerFlight ?? 1024;
    this.maxTotalWaiters = options.maxTotalWaiters ?? 2048;
  }

  get size(): number {
    return this.flights.size;
  }

  /** O(1) count used by runtime monitoring. */
  get waitingCount(): number {
    return this.totalWaiters;
  }

  run(
    key: string,
    signal: AbortSignal,
    factory: (sharedSignal: AbortSignal) => Promise<SearchResponse>,
    options: SearchFlightOptions = {},
  ): Promise<SearchResponse> {
    if (this.shutDown) return Promise.reject(new Error("search flights are shut down"));
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const existing = this.flights.get(key);
    if (existing && !existing.settled &&
        existing.waiters.size < this.maxWaitersPerFlight &&
        this.totalWaiters < this.maxTotalWaiters) {
      return this.addWaiter(existing, signal);
    }
    if (existing || this.flights.size >= this.maxFlights || this.totalWaiters >= this.maxTotalWaiters) {
      return this.runUnshared(signal, factory);
    }

    const controller = new AbortController();
    const flight: Flight = {
      key,
      controller,
      promise: Promise.resolve(null as unknown as SearchResponse),
      waiters: new Set(),
      timer: null,
      settled: false,
    };
    flight.promise = Promise.resolve().then(() => factory(controller.signal));
    this.flights.set(key, flight);
    const deadline = Math.min(options.deadlineAtMs ?? Number.POSITIVE_INFINITY, Date.now() + 5 * 60_000);
    if (Number.isFinite(deadline)) {
      flight.timer = setTimeout(() => {
        const error = new Error("search flight deadline exceeded");
        controller.abort(error);
        this.settle(flight, { error });
      }, Math.max(1, deadline - Date.now()));
      flight.timer.unref();
    }
    void flight.promise.then(
      (response) => this.settle(flight, { response }),
      (error: unknown) => this.settle(flight, { error }),
    );
    return this.addWaiter(flight, signal);
  }

  /** Abort all upstream work and remove every listener/timer before DB close. */
  shutdown(): void {
    this.shutdownFlights();
  }

  shutdownFlights(): void {
    this.shutDown = true;
    for (const flight of this.flights.values()) {
      this.settle(flight, { error: new Error("search flights are shut down") }, true);
    }
    this.flights.clear();
    this.totalWaiters = 0;
  }

  private runUnshared(
    signal: AbortSignal,
    factory: (sharedSignal: AbortSignal) => Promise<SearchResponse>,
  ): Promise<SearchResponse> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortReason(signal));
    if (signal.aborted) return Promise.reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    return Promise.resolve()
      .then(() => factory(controller.signal))
      .finally(() => signal.removeEventListener("abort", onAbort));
  }

  private addWaiter(flight: Flight, signal: AbortSignal): Promise<SearchResponse> {
    return new Promise<SearchResponse>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = (): void => {
        if (flight.settled || !flight.waiters.delete(waiter)) return;
        this.totalWaiters = Math.max(0, this.totalWaiters - 1);
        signal.removeEventListener("abort", waiter.onAbort);
        reject(abortReason(signal));
        if (flight.waiters.size === 0) flight.controller.abort(abortReason(signal));
      };
      flight.waiters.add(waiter);
      this.totalWaiters += 1;
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
  }

  private settle(
    flight: Flight,
    outcome: { response: SearchResponse } | { error: unknown },
    aborted = false,
  ): void {
    if (flight.settled) return;
    flight.settled = true;
    if (flight.timer) clearTimeout(flight.timer);
    flight.timer = null;
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
    if (aborted) flight.controller.abort(new Error("search flights are shut down"));
    for (const waiter of flight.waiters) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.totalWaiters = Math.max(0, this.totalWaiters - 1);
      if ("response" in outcome) {
        try {
          waiter.resolve(structuredClone(outcome.response));
        } catch (error) {
          waiter.reject(error);
        }
      } else {
        waiter.reject(outcome.error);
      }
    }
    flight.waiters.clear();
  }
}
