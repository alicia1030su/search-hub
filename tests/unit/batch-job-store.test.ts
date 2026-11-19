import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetBatchJob,
  readRememberedBatchJob,
  rememberBatchJob,
} from "../../apps/web/src/lib/batch-job-store.js";

/**
 * The `localStorage` pointer that lets a reload reopen the last bulk test.
 *
 * The value is a *pointer*, not a cache: a malformed or partial record must be
 * treated as "no record" rather than turned into a request for a job id nobody
 * ever created. The assertions below cover the failure modes that matter — a
 * lost pointer (silently forgetting a live run), a junk pointer (a 404 on every
 * page load) and an unreadable storage (a page that crashes in private mode).
 */

const KEY = "sh-provider-batch-job";

/** Minimal stand-in for `localStorage`; the node suite has no browser storage. */
function installStorage(options: { failWrites?: boolean } = {}): Map<string, string> {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => {
      if (options.failWrites) throw new Error("QuotaExceededError");
      store.set(name, value);
    },
    removeItem: (name: string) => {
      store.delete(name);
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = localStorage;
  return store;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("remembered batch job", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installStorage();
  });

  it("round-trips a job id, its kind and its start time", () => {
    rememberBatchJob({ jobId: "bt_1", kind: "search", startedAt: "2026-01-01T00:00:00.000Z" });
    expect(readRememberedBatchJob()).toEqual({
      jobId: "bt_1",
      kind: "search",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("reports nothing when there is no record", () => {
    expect(readRememberedBatchJob()).toBeNull();
  });

  it("treats a record it cannot trust as no record", () => {
    // Not JSON at all…
    store.set(KEY, "not-json");
    expect(readRememberedBatchJob()).toBeNull();

    // …a JSON value of the wrong shape…
    store.set(KEY, JSON.stringify({ jobId: "bt_1" }));
    expect(readRememberedBatchJob()).toBeNull();

    // …an empty id…
    store.set(KEY, JSON.stringify({ jobId: "", kind: "search" }));
    expect(readRememberedBatchJob()).toBeNull();

    // …and an unknown kind, which would otherwise decide the wrong probe mode.
    store.set(KEY, JSON.stringify({ jobId: "bt_1", kind: "everything" }));
    expect(readRememberedBatchJob()).toBeNull();
  });

  it("forgets the record", () => {
    rememberBatchJob({ jobId: "bt_1", kind: "connect", startedAt: "2026-01-01T00:00:00.000Z" });
    forgetBatchJob();
    expect(readRememberedBatchJob()).toBeNull();
  });

  it("does not throw when storage is unavailable or refuses writes", () => {
    // Private mode / blocked storage: the run itself must keep working.
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => rememberBatchJob({ jobId: "bt_1", kind: "search", startedAt: "" })).not.toThrow();
    expect(readRememberedBatchJob()).toBeNull();
    expect(() => forgetBatchJob()).not.toThrow();

    installStorage({ failWrites: true });
    expect(() => rememberBatchJob({ jobId: "bt_1", kind: "search", startedAt: "" })).not.toThrow();
    expect(readRememberedBatchJob()).toBeNull();
  });
});
