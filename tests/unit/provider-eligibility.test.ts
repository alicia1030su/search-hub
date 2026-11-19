/**
 * Eligibility decisions for a bulk provider test.
 *
 * The scenario is the one the brief writes down explicitly — 20 sources:
 * 12 testable, 5 without a usable key (3 with no key at all, 2 with every key
 * disabled) and 3 disabled — because that is what the UI has to be able to
 * explain and what T09's "the parts sum to the whole" identity is about.
 *
 * Everything here reads real rows: an eligibility rule that is only exercised
 * against hand-made objects proves the arithmetic, not the SQL.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, resolveMigrationsDir, type DbHandle } from "@search-hub/db";
import { apiKeys, providerInstances, providerProbeState, type SearchHubDb } from "@search-hub/db";
import {
  decideEligibility,
  loadEligibilityFacts,
  previewBatch,
  testableCount,
  type EligibilityOptions,
} from "../../apps/api/src/services/provider-eligibility.js";
import type { HealthService } from "../../apps/api/src/services/health.js";

interface Fixture {
  handle: DbHandle;
  db: SearchHubDb;
  dir: string;
  /** Provider ids in creation order. */
  ids: string[];
  keys: Map<string, string>;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.handle.close();
    } catch {
      /* already closed */
    }
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

/** A budget snapshot shaped exactly like `HealthService.budget()`. */
function budget(patch: Partial<ReturnType<HealthService["budget"]>> = {}): ReturnType<HealthService["budget"]> {
  return {
    day: "2026-01-01",
    maxPerRun: 10,
    maxPerDay: 100,
    usedToday: 0,
    connectUsedToday: 0,
    anonymousSearchUsedToday: 0,
    remainingToday: 100,
    paidProbesEnabled: true,
    scheduledEnabled: false,
    intervalMinutes: 360,
    ...patch,
  };
}

function options(patch: Partial<EligibilityOptions> = {}): EligibilityOptions {
  return {
    kind: "search",
    includeKeyless: true,
    budget: budget(),
    nowMs: Date.parse("2026-01-01T00:00:00.000Z"),
    ...patch,
  };
}

/**
 * Builds the 20-source scenario.
 *
 * `mock` needs no key, so the keyless cases use `hackernews` (also keyless) and
 * the credentialed cases use `brave` (requires a key): the distinction the code
 * branches on is `adapter.requiresKey`, not a flag passed in by the test.
 */
function buildFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "search-hub-eligibility-"));
  const handle = createDb({ file: join(dir, "elig.db") });
  runMigrations(handle.sqlite, resolveMigrationsDir());
  const db = handle.db;
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const ids: string[] = [];
  const keys = new Map<string, string>();

  const addProvider = (id: string, type: string, enabled: boolean) => {
    db.insert(providerInstances)
      .values({
        id,
        name: id,
        type,
        enabled,
        baseUrl: "http://127.0.0.1:9",
        timeoutMs: 1000,
        maxConcurrency: 1,
        priority: 100,
        weight: 100,
        maxRetries: 0,
        resultsPerPage: 10,
        rpmLimit: 6000,
        keyStrategy: "round_robin",
        cooldownMs: 30_000,
        breakerThreshold: 5,
        breakerCooldownMs: 60_000,
        configJson: "{}",
        searchConfigJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    ids.push(id);
    return id;
  };

  const addKey = (id: string, providerId: string, enabled: boolean) => {
    db.insert(apiKeys)
      .values({
        id,
        providerId,
        label: id,
        keyCiphertext: `cipher-${id}`,
        keyIv: "iv",
        keyTag: "tag",
        keyVersion: 1,
        keyHint: `key_${id.slice(-4)}`,
        weight: 100,
        enabled,
        status: "unknown",
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        quotaUsedToday: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    keys.set(id, providerId);
  };

  // 12 testable: 12 credentialed sources with one enabled, decryptable key.
  for (let index = 1; index <= 12; index += 1) {
    const id = addProvider(`ok-${index}`, "brave", true);
    addKey(`key-ok-${index}`, id, true);
  }
  // 3 with no key at all.
  for (let index = 1; index <= 3; index += 1) addProvider(`nokey-${index}`, "brave", true);
  // 2 whose keys all exist but are disabled.
  for (let index = 1; index <= 2; index += 1) {
    const id = addProvider(`disabledkey-${index}`, "brave", true);
    addKey(`key-disabled-${index}`, id, false);
  }
  // 3 disabled sources (some with keys: the disable wins).
  for (let index = 1; index <= 3; index += 1) {
    const id = addProvider(`off-${index}`, "brave", false);
    addKey(`key-off-${index}`, id, true);
  }

  return { handle, db, dir, ids, keys };
}

/**
 * A `resolveKey` stand-in: every ciphertext in this fixture is decryptable
 * except those a test explicitly corrupts (see the decrypt-failure case).
 */
function resolver(broken: Set<string> = new Set()) {
  return {
    resolveKey(keyId: string): string | undefined {
      if (broken.has(keyId)) return undefined;
      return `plaintext-${keyId}`;
    },
  };
}

describe("eligibility decisions", () => {
  it("decides 20 providers into 12 testable / 5 without key / 3 disabled", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const ids = [...fixture.ids];
    const facts = loadEligibilityFacts(fixture.db, resolver(), ids);
    const preview = previewBatch(facts, ids, options());

    expect(preview.total).toBe(20);
    expect(preview.counts.eligible).toBe(12);
    expect(preview.counts.noKey + preview.counts.noEnabledKey).toBe(5);
    expect(preview.counts.noKey).toBe(3);
    expect(preview.counts.noEnabledKey).toBe(2);
    expect(preview.counts.disabled).toBe(3);
    expect(preview.counts.configError).toBe(0);
    expect(preview.counts.keylessSkipped).toBe(0);
    expect(preview.counts.coolingSkipped).toBe(0);
    expect(preview.eligibleIds).toHaveLength(12);
  });

  it("counts sum to total, whatever the mix of reasons", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    // Add the two harder buckets: a cooling source and a keyless source that
    // policy excludes. The cooling one is an otherwise-eligible source, so the
    // bucket boundary is observable in the eligible count too.
    const cooling = fixture.ids[11]!; // `ok-12`, a fully testable credentialed source
    fixture.db
      .insert(providerProbeState)
      .values({
        providerId: cooling,
        autoProbeEnabled: true,
        consecutiveFailures: 3,
        backoffLevel: 2,
        nextProbeAt: "2026-01-01T00:05:00.000Z",
        resetAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    const keyless = "keyless-1";
    const now = "2026-01-01T00:00:00.000Z";
    fixture.db
      .insert(providerInstances)
      .values({
        id: keyless,
        name: keyless,
        type: "hackernews",
        enabled: true,
        baseUrl: "http://127.0.0.1:9",
        timeoutMs: 1000,
        maxConcurrency: 1,
        priority: 100,
        weight: 100,
        maxRetries: 0,
        resultsPerPage: 10,
        rpmLimit: 6000,
        keyStrategy: "round_robin",
        cooldownMs: 30_000,
        breakerThreshold: 5,
        breakerCooldownMs: 60_000,
        configJson: "{}",
        searchConfigJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const ids = [...fixture.ids, keyless];

    const facts = loadEligibilityFacts(fixture.db, resolver(), ids);
    const preview = previewBatch(facts, ids, options({ includeKeyless: false }));

    const sum =
      preview.counts.eligible +
      preview.counts.noKey +
      preview.counts.noEnabledKey +
      preview.counts.configError +
      preview.counts.disabled +
      preview.counts.keylessSkipped +
      preview.counts.coolingSkipped;
    expect(sum).toBe(preview.total);
    expect(preview.total).toBe(21);
    // A cooling source lands in `coolingSkipped`, together with budget skips:
    // the seven columns have to add up to `total`, so they cannot be separate.
    expect(preview.counts.coolingSkipped).toBe(1);
    expect(preview.counts.keylessSkipped).toBe(1);
    expect(preview.counts.eligible).toBe(11);
  });

  it("keeps a cooling source out even when `kind=connect` ignores the paid budget", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const id = fixture.ids[0]!;
    fixture.db
      .insert(providerProbeState)
      .values({
        providerId: id,
        autoProbeEnabled: true,
        consecutiveFailures: 1,
        backoffLevel: 1,
        nextProbeAt: "2026-01-01T00:01:00.000Z",
        resetAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    const facts = loadEligibilityFacts(fixture.db, resolver(), [id]);
    // Paid probing off + zero budget must not matter for a connectivity probe.
    const connect = decideEligibility(
      facts,
      id,
      options({ kind: "connect", budget: budget({ paidProbesEnabled: false, remainingToday: 0 }) }),
    );
    expect(connect.code).toBe("SKIPPED_COOLDOWN");
    // …but it does matter for a paid search probe of the same source.
    const search = decideEligibility(
      facts,
      id,
      options({ kind: "search", budget: budget({ paidProbesEnabled: false, remainingToday: 0 }) }),
    );
    expect(search.code).toBe("SKIPPED_COOLDOWN");
  });

  it("reports an undecryptable key as a configuration error that counts, without leaking material", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const id = fixture.ids[0]!;
    const keyId = "key-ok-1";
    const facts = loadEligibilityFacts(fixture.db, resolver(new Set([keyId])), [id]);
    const decision = decideEligibility(facts, id, options());

    expect(decision.code).toBe("CONFIG_ERROR");
    // A configuration error is countable: it is a real failure the operator must
    // be able to see and fix, unlike a skip.
    const preview = previewBatch(facts, [id], options());
    expect(preview.counts.configError).toBe(1);
    expect(preview.decisions[0]!.countable).toBe(true);
    // Neither the plaintext, the ciphertext, nor the key id may appear.
    expect(decision.reason).not.toContain("plaintext-");
    expect(decision.reason).not.toContain("cipher-");
    expect(decision.reason).not.toContain(keyId);
  });

  it("leaves the paid *switch* to the run, and only skips on exhausted counters", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const id = fixture.ids[0]!;
    const facts = loadEligibilityFacts(fixture.db, resolver(), [id]);

    // `paidProbesEnabled=false` refuses the whole paid run (the route returns a
    // 409 naming the setting). It must not be reported as "this source is out of
    // budget": that would tell the operator to look at the wrong setting and
    // would hide that the source itself is perfectly testable.
    const switchOff = decideEligibility(facts, id, options({ budget: budget({ paidProbesEnabled: false }) }));
    expect(switchOff.code).toBe("ELIGIBLE");

    // The counters, on the other hand, *are* a per-source skip (§5 row 3).
    const exhausted = decideEligibility(facts, id, options({ budget: budget({ remainingToday: 0 }) }));
    expect(exhausted.code).toBe("SKIPPED_BUDGET");
    expect(exhausted.reason).toContain("budget_exhausted");
  });

  it("treats an exhausted daily budget as a skip, not as a failure", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const id = fixture.ids[0]!;
    const facts = loadEligibilityFacts(fixture.db, resolver(), [id]);
    const decision = decideEligibility(facts, id, options({ budget: budget({ remainingToday: 0 }) }));
    expect(decision.code).toBe("SKIPPED_BUDGET");
    expect(decision.reason).toContain("budget_exhausted");
  });

  it("does not apply the paid budget to a keyless source", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const now = "2026-01-01T00:00:00.000Z";
    const id = "keyless-budget";
    fixture.db
      .insert(providerInstances)
      .values({
        id,
        name: id,
        type: "hackernews",
        enabled: true,
        baseUrl: "http://127.0.0.1:9",
        timeoutMs: 1000,
        maxConcurrency: 1,
        priority: 100,
        weight: 100,
        maxRetries: 0,
        resultsPerPage: 10,
        rpmLimit: 6000,
        keyStrategy: "round_robin",
        cooldownMs: 30_000,
        breakerThreshold: 5,
        breakerCooldownMs: 60_000,
        configJson: "{}",
        searchConfigJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const facts = loadEligibilityFacts(fixture.db, resolver(), [id]);
    const decision = decideEligibility(
      facts,
      id,
      options({ budget: budget({ paidProbesEnabled: false, remainingToday: 0 }) }),
    );
    // An anonymous search cannot consume account quota, so the paid switch must
    // not make every public source permanently untestable.
    expect(decision.code).toBe("ELIGIBLE");
  });

  it("reports a missing adapter as a configuration error rather than a skip", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const now = "2026-01-01T00:00:00.000Z";
    const id = "no-adapter";
    fixture.db
      .insert(providerInstances)
      .values({
        id,
        name: id,
        type: "type-that-does-not-exist",
        enabled: true,
        baseUrl: "http://127.0.0.1:9",
        timeoutMs: 1000,
        maxConcurrency: 1,
        priority: 100,
        weight: 100,
        maxRetries: 0,
        resultsPerPage: 10,
        rpmLimit: 6000,
        keyStrategy: "round_robin",
        cooldownMs: 30_000,
        breakerThreshold: 5,
        breakerCooldownMs: 60_000,
        configJson: "{}",
        searchConfigJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const facts = loadEligibilityFacts(fixture.db, resolver(), [id]);
    const decision = decideEligibility(facts, id, options());
    expect(decision.code).toBe("CONFIG_ERROR");
    expect(decision.reason).toContain("adapter_missing");
  });

  it("reports an unknown provider id as a configuration error", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const facts = loadEligibilityFacts(fixture.db, resolver(), [fixture.ids[0]!]);
    const decision = decideEligibility(facts, "does-not-exist", options());
    expect(decision.code).toBe("CONFIG_ERROR");
    expect(decision.reason).toContain("provider_not_found");
  });

  it("orders the decision: disabled outranks a missing adapter", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const now = "2026-01-01T00:00:00.000Z";
    const id = "disabled-and-unimplemented";
    fixture.db
      .insert(providerInstances)
      .values({
        id,
        name: id,
        type: "type-that-does-not-exist",
        enabled: false,
        baseUrl: "http://127.0.0.1:9",
        timeoutMs: 1000,
        maxConcurrency: 1,
        priority: 100,
        weight: 100,
        maxRetries: 0,
        resultsPerPage: 10,
        rpmLimit: 6000,
        keyStrategy: "round_robin",
        cooldownMs: 30_000,
        breakerThreshold: 5,
        breakerCooldownMs: 60_000,
        configJson: "{}",
        searchConfigJson: "{}",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const facts = loadEligibilityFacts(fixture.db, resolver(), [id]);
    // Disabling a source is an administrative decision; the missing adapter is a
    // maintenance detail that must not be blamed for it.
    expect(decideEligibility(facts, id, options()).code).toBe("SKIPPED_DISABLED");
  });
});

describe("success-rate denominator", () => {
  it("is `testable`: skips are excluded, configuration errors are not", () => {
    const fixture = buildFixture();
    fixtures.push(fixture);
    const facts = loadEligibilityFacts(fixture.db, resolver(new Set(["key-ok-2"])), [...fixture.ids]);
    const preview = previewBatch(facts, [...fixture.ids], options());

    // 20 sources: 8 skipped (3 disabled + 3 no key + 2 all-keys-disabled).
    const skipped =
      preview.counts.disabled +
      preview.counts.noKey +
      preview.counts.noEnabledKey +
      preview.counts.keylessSkipped +
      preview.counts.coolingSkipped;
    expect(skipped).toBe(8);
    // 12 testable = 11 eligible + 1 configuration error.
    expect(testableCount(preview.counts)).toBe(12);
    expect(preview.counts.configError).toBe(1);
    expect(preview.counts.eligible).toBe(11);
    // A success rate over the skipped sources would be `11/20`; over the
    // testable ones it is `11/12`. The difference is the whole point.
    expect(skipped + testableCount(preview.counts)).toBe(preview.total);
  });
});
