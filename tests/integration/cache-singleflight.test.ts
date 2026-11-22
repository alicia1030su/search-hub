import { describe, expect, it } from "vitest";
import type { SearchResponse } from "@search-hub/shared";
import { SearchFlightService } from "../../apps/api/src/services/singleflight.js";

function response(taskId = "shared"): SearchResponse {
  return {
    taskId, query: "fixture", mode: "basic", status: "completed", results: [],
    stats: { rawCount: 0, dedupedCount: 0, fusedCount: 0, providers: [], rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false, timing: { totalMs: 0, fanoutMs: 0, fusionMs: 0 } },
    errors: [], failedSources: [], debug: { rewrittenQueries: [] },
  };
}

describe("C10 singleflight boundaries", () => {
  it("shares only equivalent keys and returns independent response clones", async () => {
    const flights = new SearchFlightService();
    let calls = 0;
    let release: ((value: SearchResponse) => void) | null = null;
    const factory = () => {
      calls += 1;
      return new Promise<SearchResponse>((resolve) => { release = resolve; });
    };
    const first = flights.run("key-a", new AbortController().signal, factory);
    const second = flights.run("key-a", new AbortController().signal, factory);
    const other = flights.run("key-b", new AbortController().signal, async () => response("other"));
    expect((await other).taskId).toBe("other");
    (release as ((value: SearchResponse) => void) | null)!(response());
    const [one, two] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    one.taskId = "mutated";
    expect(two.taskId).toBe("shared");
    expect(flights.size).toBe(0);
    expect(flights.waitingCount).toBe(0);
  });

  it("propagates failures, removes the flight, and does not retain failed results", async () => {
    const flights = new SearchFlightService();
    await expect(flights.run("failed", new AbortController().signal, async () => { throw new Error("upstream failed"); })).rejects.toThrow("upstream failed");
    expect(flights.size).toBe(0);
    expect(flights.waitingCount).toBe(0);
    const retried = await flights.run("failed", new AbortController().signal, async () => response("retry"));
    expect(retried.taskId).toBe("retry");
  });

  it("bounds waiters and bypasses excess callers without unbounded growth", async () => {
    const flights = new SearchFlightService({ maxFlights: 1, maxWaitersPerFlight: 1, maxTotalWaiters: 1 });
    let release: ((value: SearchResponse) => void) | null = null;
    const first = flights.run("key", new AbortController().signal, () => new Promise<SearchResponse>((resolve) => { release = resolve; }));
    const bypassed = await flights.run("key", new AbortController().signal, async () => response("bypassed"));
    expect(bypassed.taskId).toBe("bypassed");
    expect(flights.waitingCount).toBe(1);
    (release as ((value: SearchResponse) => void) | null)!(response());
    await first;
    expect(flights.waitingCount).toBe(0);
  });

  it("aborts on deadline and rejects waiters even if a factory ignores cancellation", async () => {
    const flights = new SearchFlightService();
    const pending = flights.run("deadline", new AbortController().signal, () => new Promise<SearchResponse>(() => {}), { deadlineAtMs: Date.now() + 20 });
    await expect(pending).rejects.toThrow("deadline");
    expect(flights.size).toBe(0);
    expect(flights.waitingCount).toBe(0);
  });

  it("rejects new work after shutdown and leaves no listeners or timers", async () => {
    const flights = new SearchFlightService();
    const controller = new AbortController();
    const pending = flights.run("shutdown", controller.signal, () => new Promise<SearchResponse>(() => {}));
    flights.shutdown();
    await expect(pending).rejects.toThrow("shut down");
    await expect(flights.run("new", controller.signal, async () => response())).rejects.toThrow("shut down");
    expect(flights.size).toBe(0);
    expect(flights.waitingCount).toBe(0);
  });
});
