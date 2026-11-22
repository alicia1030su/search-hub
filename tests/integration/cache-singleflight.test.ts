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

  it("counts only explicit followers and keeps the count when the leader cancels", async () => {
    const flights = new SearchFlightService();
    let release: ((value: SearchResponse) => void) | null = null;
    const factory = () => new Promise<SearchResponse>((resolve) => { release = resolve; });
    const controllers = Array.from({ length: 100 }, () => new AbortController());
    const leader = flights.run("followers", controllers[0]!.signal, factory);
    const followers = controllers.slice(1).map((controller) => flights.run("followers", controller.signal, factory));
    expect(flights.waitingCount).toBe(100);
    expect(flights.queuedFollowerCount).toBe(99);
    controllers[0]!.abort(new Error("leader cancelled"));
    await expect(leader).rejects.toThrow("leader cancelled");
    expect(flights.waitingCount).toBe(99);
    expect(flights.queuedFollowerCount).toBe(99);
    expect(flights.size).toBe(1);
    (release as ((value: SearchResponse) => void) | null)!(response());
    await Promise.all(followers);
    expect(flights.waitingCount).toBe(0);
    expect(flights.queuedFollowerCount).toBe(0);
  });

  it("decrements followers precisely on individual cancellation and shutdown", async () => {
    const flights = new SearchFlightService();
    const factory = () => new Promise<SearchResponse>(() => {});
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = [
      flights.run("cancel-followers", controllers[0]!.signal, factory),
      ...controllers.slice(1).map((controller) => flights.run("cancel-followers", controller.signal, factory)),
    ];
    expect(flights.queuedFollowerCount).toBe(3);
    controllers[1]!.abort(new Error("cancel follower one"));
    await expect(pending[1]).rejects.toThrow("cancel follower one");
    expect(flights.queuedFollowerCount).toBe(2);
    controllers[2]!.abort(new Error("cancel follower two"));
    await expect(pending[2]).rejects.toThrow("cancel follower two");
    expect(flights.queuedFollowerCount).toBe(1);
    flights.shutdown();
    await expect(pending[0]).rejects.toThrow("shut down");
    await expect(pending[3]).rejects.toThrow("shut down");
    expect(flights.waitingCount).toBe(0);
    expect(flights.queuedFollowerCount).toBe(0);
  });

  it("removes a flight immediately when its last waiter cancels even if the factory ignores abort", async () => {
    const flights = new SearchFlightService();
    let calls = 0;
    const factory = () => {
      calls += 1;
      return new Promise<SearchResponse>(() => {});
    };
    const controller = new AbortController();
    const pending = flights.run("reusable", controller.signal, factory);
    await Promise.resolve();
    controller.abort(new Error("last waiter left"));
    await expect(pending).rejects.toThrow("last waiter left");
    expect(flights.size).toBe(0);
    expect(flights.waitingCount).toBe(0);
    const replacement = await flights.run("reusable", new AbortController().signal, () => {
      calls += 1;
      return Promise.resolve(response("replacement"));
    });
    expect(replacement.taskId).toBe("replacement");
    expect(calls).toBe(2);
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
