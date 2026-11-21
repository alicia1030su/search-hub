import { describe, expect, it } from "vitest";
import {
  codeKey,
  errorReasonOf,
  failedIds,
  groupOf,
  pendingIds,
  redactKeyId,
  requestsLabel,
  sortItems,
  stateKey,
} from "../../apps/web/src/lib/batch-classify.js";
import { en } from "../../apps/web/src/lib/i18n-en.js";
import { zh } from "../../apps/web/src/lib/i18n-zh.js";
import type { BatchItem, BatchJobView } from "../../apps/web/src/lib/types.js";

/**
 * The result table's classification, ordering and message coverage.
 *
 * These are pure functions on purpose: grouping, sorting and the "retry
 * failures" set are exactly the places where a plausible-looking implementation
 * misleads the operator — a throttled source counted as a failure makes the retry
 * button re-hit a rate limit, and a `null` latency sorted as `0` puts a source
 * that was never measured at the top of "slowest".
 *
 * The label assertions check that every message *key* exists rather than a
 * rendered string: rendering is the locale runtime (covered by `i18n-parity` and
 * the browser suite), while a missing key is the failure that would print
 * `providers.batch.code.…` into the table.
 *
 * Nothing here imports the locale runtime: `tests/` is compiled without the DOM
 * library, and a dictionary lookup does not need one.
 */

function item(patch: Partial<BatchItem>): BatchItem {
  return {
    providerId: "p1",
    providerName: "Provider 1",
    providerType: "mock",
    keyCount: 1,
    state: "ok",
    code: "ok",
    latencyMs: 100,
    resultCount: 3,
    requests: 1,
    checkId: "hc_1",
    reason: null,
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function job(items: BatchItem[]): BatchJobView {
  const done = items.filter(
    (entry) => entry.state === "ok" || entry.state === "failed" || entry.state === "pending",
  ).length;
  const skipped = items.filter((entry) => entry.state === "skipped").length;
  return {
    jobId: "bt_1",
    status: "completed",
    kind: "search",
    counts: {
      total: items.length,
      done,
      ok: items.filter((entry) => entry.state === "ok").length,
      failed: items.filter((entry) => entry.state === "failed").length,
      pending: items.filter((entry) => entry.state === "pending").length,
      skipped,
      remaining: items.filter((entry) => entry.state === "unknown").length,
    },
    items,
    includeKeyless: false,
    budget: {
      day: "2026-01-01",
      maxPerRun: 10,
      maxPerDay: 100,
      usedToday: 0,
      connectUsedToday: 0,
      anonymousSearchUsedToday: 0,
      anonymousMaxPerRun: 10,
      anonymousMaxPerDay: 100,
      anonymousRemainingToday: 100,
      remainingToday: 100,
      paidProbesEnabled: true,
      scheduledEnabled: false,
      intervalMinutes: 360,
    },
    concurrency: 2,
    startedAt: null,
    finishedAt: null,
    nextPollAfterMs: null,
  };
}

describe("batch result grouping", () => {
  it("separates a restricted source from a plain failure", () => {
    // Throttling, permissions and exhausted quota are "did not work" but not
    // "retry now": an immediate retry re-hits the same 429 and spends again.
    expect(groupOf(item({ state: "failed", code: "rate_limited" }))).toBe("restricted");
    expect(groupOf(item({ state: "failed", code: "quota_exceeded" }))).toBe("restricted");
    expect(groupOf(item({ state: "failed", code: "forbidden" }))).toBe("restricted");
    // Everything else that failed is a real failure the operator can fix.
    expect(groupOf(item({ state: "failed", code: "auth_invalid" }))).toBe("failed");
    expect(groupOf(item({ state: "failed", code: "timeout" }))).toBe("failed");
    expect(groupOf(item({ state: "failed", code: "invalid_response" }))).toBe("failed");
    expect(groupOf(item({ state: "failed", code: "configuration_error" }))).toBe("failed");
    expect(groupOf(item({ state: "failed", code: "network_error" }))).toBe("failed");
    expect(groupOf(item({ state: "failed", code: "server_error" }))).toBe("failed");
    expect(groupOf(item({ state: "pending", code: "empty_results" }))).toBe("pending");
    expect(groupOf(item({ state: "ok", code: "ok" }))).toBe("ok");
    expect(groupOf(item({ state: "skipped", code: "SKIPPED_NO_KEY" }))).toBe("skipped");
    expect(groupOf(item({ state: "unknown", code: "unknown" }))).toBe("unknown");
  });

  it("orders by severity, then slowest first, with an unmeasured latency last", () => {
    const items = [
      item({ providerId: "a", providerName: "a", state: "skipped", code: "SKIPPED_DISABLED", latencyMs: null }),
      item({ providerId: "b", providerName: "b", state: "ok", code: "ok", latencyMs: 50 }),
      item({ providerId: "c", providerName: "c", state: "failed", code: "server_error", latencyMs: 900 }),
      item({ providerId: "d", providerName: "d", state: "failed", code: "rate_limited", latencyMs: 30 }),
      item({ providerId: "e", providerName: "e", state: "pending", code: "empty_results", latencyMs: 400 }),
      item({ providerId: "f", providerName: "f", state: "ok", code: "ok", latencyMs: null }),
    ];
    const sorted = sortItems(items);
    // failed → restricted → pending → ok → skipped
    expect(sorted.map((entry) => entry.providerId)).toEqual(["c", "d", "e", "b", "f", "a"]);
    // A `null` latency is "never measured": it sorts after the measured 50 ms
    // row, not before it (which is what `0` would do).
    expect(sorted[4]!.providerId).toBe("f");
  });

  it("keeps the retry-failures set free of restricted and pending sources", () => {
    const view = job([
      item({ providerId: "failed-1", state: "failed", code: "auth_invalid" }),
      item({ providerId: "failed-2", state: "failed", code: "server_error" }),
      item({ providerId: "limited", state: "failed", code: "rate_limited" }),
      item({ providerId: "empty", state: "pending", code: "empty_results" }),
      item({ providerId: "ok", state: "ok", code: "ok" }),
    ]);
    // Retrying a rate limit immediately fails again; retrying an empty answer
    // spends money on a source that already responded.
    expect(failedIds(view)).toEqual(["failed-1", "failed-2"]);
    expect(pendingIds(view)).toEqual(["empty"]);
  });

  it("does not re-run a cancelled source when retrying the failures", () => {
    // A cancel turns the remainder into `skipped / SKIPPED_CANCELLED`. They are
    // not failures: re-submitting them would re-run exactly the work the
    // operator stopped, and "retry failures" would silently become "retry
    // everything".
    const view = job([
      item({ providerId: "failed", state: "failed", code: "server_error" }),
      item({ providerId: "cancelled-1", state: "skipped", code: "SKIPPED_CANCELLED", checkId: null }),
      item({ providerId: "cancelled-2", state: "skipped", code: "SKIPPED_CANCELLED", checkId: null }),
      item({ providerId: "disabled", state: "skipped", code: "SKIPPED_DISABLED" }),
      item({ providerId: "ok", state: "ok", code: "ok" }),
    ]);
    expect(failedIds(view)).toEqual(["failed"]);
    expect(pendingIds(view)).toEqual([]);
  });

  it("renders a missing request count as an em dash, never as zero", () => {
    expect(requestsLabel(null)).toBe("—");
    expect(requestsLabel(0)).toBe("0");
    expect(requestsLabel(3)).toBe("3");
  });

  it("truncates a key id without ever producing key material", () => {
    expect(redactKeyId(null)).toBe("—");
    expect(redactKeyId("key_abcdef1234567890")).toBe("key_ab…90");
    // Short identifiers are shown as-is rather than mangled into a fake hint.
    expect(redactKeyId("key_ab")).toBe("key_ab");
  });

  it("shows a reason only where it explains something, never as a success caption", () => {
    // A healthy probe's message is a measurement ("3 result(s) in 30ms"), and its
    // own columns already carry both numbers: printing it under "error reason"
    // would claim a working source has a problem.
    expect(errorReasonOf(item({ state: "ok", code: "ok", reason: "3 result(s) in 30ms" }))).toBeNull();
    // Every state that needs explaining keeps its message.
    const failed = item({ state: "failed", code: "timeout", reason: "timeout: no answer in 12000ms" });
    expect(errorReasonOf(failed)).toBe("timeout: no answer in 12000ms");
    expect(errorReasonOf(item({ state: "pending", code: "empty_results", reason: "empty_results: 0 rows" }))).toBe(
      "empty_results: 0 rows",
    );
    expect(errorReasonOf(item({ state: "skipped", code: "SKIPPED_NO_KEY", reason: "no_key: none stored" }))).toBe(
      "no_key: none stored",
    );
    // …and a missing or blank message is not rendered as an empty paragraph.
    expect(errorReasonOf(item({ state: "failed", reason: null }))).toBeNull();
    expect(errorReasonOf(item({ state: "failed", reason: "   " }))).toBeNull();
  });
});

describe("batch message coverage", () => {
  /**
   * The twelve canonical classifications from the PRD, plus the two
   * non-failure outcomes a single-source probe can produce.
   *
   * These need *advice*, because the operator has to act on them.
   */
  const ERROR_CODES = [
    "auth_invalid",
    "forbidden",
    "rate_limited",
    "quota_exceeded",
    "timeout",
    "dns_error",
    "tls_error",
    "network_error",
    "invalid_response",
    "empty_results",
    "configuration_error",
    "server_error",
    "cancelled",
    "no_credential",
  ];

  /**
   * Codes that only need a *label*: `ok` and `unknown` have nothing to fix, and
   * a `SKIPPED_*` row explains itself ("no key", "disabled") — the reason is the
   * next step, so a second sentence would be noise.
   */
  const STATE_ONLY_CODES = [
    "ok",
    "unknown",
    "SKIPPED_DISABLED",
    "SKIPPED_NO_KEY",
    "SKIPPED_NO_ENABLED_KEY",
    "SKIPPED_KEYLESS_BY_POLICY",
    "SKIPPED_COOLDOWN",
    "SKIPPED_BUDGET",
    "SKIPPED_CANCELLED",
    "already_running",
  ];

  const CODES = [...ERROR_CODES, ...STATE_ONLY_CODES];

  it("has a label for every classification, in both locales", () => {
    const dictionaries: Array<[string, Record<string, string>]> = [
      ["zh", zh as unknown as Record<string, string>],
      ["en", en as unknown as Record<string, string>],
    ];
    for (const [locale, dictionary] of dictionaries) {
      for (const code of CODES) {
        const label = codeKey(code);
        expect(Object.prototype.hasOwnProperty.call(dictionary, label), `${locale} is missing ${label}`).toBe(true);
        expect(dictionary[label]!.trim().length, `${locale} ${label} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("tells the operator what to do about every error classification", () => {
    const dictionaries: Array<[string, Record<string, string>]> = [
      ["zh", zh as unknown as Record<string, string>],
      ["en", en as unknown as Record<string, string>],
    ];
    for (const [locale, dictionary] of dictionaries) {
      for (const code of ERROR_CODES) {
        const advice = codeKey(code, "advice");
        // A bare label leaves the operator guessing which page to open.
        expect(Object.prototype.hasOwnProperty.call(dictionary, advice), `${locale} is missing ${advice}`).toBe(true);
        expect(dictionary[advice]!.trim().length, `${locale} ${advice} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("has a label for every row state and every filter", () => {
    for (const state of ["ok", "failed", "restricted", "pending", "skipped", "unknown"]) {
      for (const key of [`providers.batch.state.${state}`, `providers.batch.filter.${state}`]) {
        expect(Object.prototype.hasOwnProperty.call(zh, key), `zh is missing ${key}`).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(en, key), `en is missing ${key}`).toBe(true);
      }
    }
    expect(Object.prototype.hasOwnProperty.call(zh, "providers.batch.filter.all")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(en, "providers.batch.filter.all")).toBe(true);
  });

  it("maps a restricted failure to the restricted label, not the failure label", () => {
    const restricted = item({ state: "failed", code: "rate_limited" });
    expect(stateKey(restricted, groupOf(restricted))).toBe("providers.batch.state.restricted");
    const plain = item({ state: "failed", code: "server_error" });
    expect(stateKey(plain, groupOf(plain))).toBe("providers.batch.state.failed");
  });
});
