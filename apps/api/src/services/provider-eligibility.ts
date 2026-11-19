/**
 * Who can actually be tested, and why not.
 *
 * A bulk provider test has to answer "can this source be probed at all" *before*
 * it spends a request. That question has one definition in this codebase, and
 * it lives here: the preview endpoint, the job creator and the runner all read
 * this module instead of writing their own `if` chain. Two implementations of
 * "is this source testable" would drift apart on the first edge case, and the
 * user-visible symptom would be a run that promises 12 sources and probes 8.
 *
 * Design rules encoded below:
 *
 * 1. **Decision order is a priority, not a checklist.** Disabled outranks
 *    "no adapter" outranks "cooling" outranks "key state" outranks "policy
 *    preference". The most absolute, cheapest and least negotiable fact wins, so
 *    a transient cooldown can never be reported as a missing credential.
 * 2. **No N+1.** Facts are loaded with exactly three queries regardless of how
 *    many providers were selected.
 * 3. **A skip is not a failure.** `SKIPPED_*` means "no request was sent"; only
 *    `CONFIG_ERROR` is a real failure that must appear in the failure list.
 * 4. **Nothing here reads or returns key material.** The decrypt probe answers a
 *    boolean; the reason string never contains a fragment of a key, ciphertext
 *    or IV, because those strings travel to the browser and into logs.
 */
import { inArray } from "drizzle-orm";
import type { SearchHubDb } from "@search-hub/db";
import { apiKeys, providerInstances, providerProbeState } from "@search-hub/db";
import { getAdapter } from "@search-hub/providers";
import type { HealthProbeKind } from "./health-classify.js";
import type { HealthService } from "./health.js";

/**
 * Skip reasons that mean "no request was sent".
 *
 * They are deliberately distinct codes rather than one `SKIPPED`: the operator
 * acts differently on each (enable it / add a key / re-enable a key / turn on
 * keyless probing / wait).
 */
export type SkipCode =
  | "SKIPPED_DISABLED"
  | "SKIPPED_NO_KEY"
  | "SKIPPED_NO_ENABLED_KEY"
  | "SKIPPED_KEYLESS_BY_POLICY"
  | "SKIPPED_COOLDOWN"
  | "SKIPPED_BUDGET";

export type EligibilityCode = SkipCode | "ELIGIBLE" | "CONFIG_ERROR";

/** The seven buckets the preview reports. Their sum is exactly `total` (§7). */
export interface PreviewCounts {
  eligible: number;
  noKey: number;
  noEnabledKey: number;
  configError: number;
  disabled: number;
  keylessSkipped: number;
  /**
   * Cooling *and* budget exhaustion.
   *
   * They share a bucket on purpose: the preview's contract is that the seven
   * numbers add up to `total`, and a separate `budgetSkipped` column would make
   * that identity false. The per-item `code` still distinguishes the two, which
   * is where the operator reads the actual reason.
   */
  coolingSkipped: number;
}

/**
 * Everything the decision needs, loaded once.
 *
 * Maps instead of arrays so `decideEligibility` stays O(1) per provider and the
 * preview of 500 sources cannot turn into 500 scans.
 */
export interface EligibilityFacts {
  providers: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  /** Keys with `enabled = true`. */
  enabledKeyCounts: Map<string, number>;
  /** All keys, enabled or not. */
  anyKeyCounts: Map<string, number>;
  /**
   * Whether the provider's first enabled key decrypts.
   *
   * `true` when there is nothing to decrypt (no enabled key), so this map never
   * invents a configuration error out of an empty credential pool.
   */
  decryptable: Map<string, boolean>;
  /**
   * Timestamp before which the source must not be probed, or `null`.
   *
   * Two sources of truth, both real cooldowns: a key that the vendor parked
   * (`api_keys.cooldown_until`) when *every* enabled key is parked, and the
   * scheduler's own backoff after a failed probe (`provider_probe_state`).
   */
  coolingUntil: Map<string, string | null>;
}

/** Options shared by the preview and the runner. */
export interface EligibilityOptions {
  kind: HealthProbeKind;
  /** The `includeUnverified` policy: probe sources that need no credential. */
  includeKeyless: boolean;
  /** Snapshot from `HealthService.budget()`, read once per batch job. */
  budget: ReturnType<HealthService["budget"]>;
  /** Injectable clock; the caller passes one so a test can freeze time. */
  nowMs?: number;
}

export interface EligibilityDecision {
  providerId: string;
  providerName: string;
  code: EligibilityCode;
  /** True only for `ELIGIBLE`: the runner sends a request for these. */
  enqueue: boolean;
  /** True when the source counts toward the success-rate denominator. */
  countable: boolean;
  reason: string;
}

const EMPTY_FACTS = (): EligibilityFacts => ({
  providers: [],
  enabledKeyCounts: new Map(),
  anyKeyCounts: new Map(),
  decryptable: new Map(),
  coolingUntil: new Map(),
});

/**
 * Loads the facts for a selection with **three** queries.
 *
 * `providers.resolveKey` is called at most once per provider, for its first
 * enabled key only: that is a decryption, not a query, and doing it here means
 * the runner never has to guess whether a stored credential is usable. The
 * return value is reduced to a boolean immediately so no key material is kept.
 */
export function loadEligibilityFacts(
  db: SearchHubDb,
  providers: { resolveKey(keyId: string): string | undefined },
  ids: string[],
): EligibilityFacts {
  if (ids.length === 0) return EMPTY_FACTS();

  const providerRows = db
    .select({
      id: providerInstances.id,
      name: providerInstances.name,
      type: providerInstances.type,
      enabled: providerInstances.enabled,
    })
    .from(providerInstances)
    .where(inArray(providerInstances.id, ids))
    .all();

  const keyRows = db
    .select({
      id: apiKeys.id,
      providerId: apiKeys.providerId,
      enabled: apiKeys.enabled,
      cooldownUntil: apiKeys.cooldownUntil,
    })
    .from(apiKeys)
    .where(inArray(apiKeys.providerId, ids))
    .all();

  const stateRows = db
    .select({
      providerId: providerProbeState.providerId,
      nextProbeAt: providerProbeState.nextProbeAt,
      consecutiveFailures: providerProbeState.consecutiveFailures,
    })
    .from(providerProbeState)
    .where(inArray(providerProbeState.providerId, ids))
    .all();

  const facts = EMPTY_FACTS();
  facts.providers = providerRows;

  const firstEnabledKey = new Map<string, string>();
  const enabledCooling = new Map<string, string[]>();
  const enabledTotals = new Map<string, number>();

  for (const key of keyRows) {
    facts.anyKeyCounts.set(key.providerId, (facts.anyKeyCounts.get(key.providerId) ?? 0) + 1);
    if (!key.enabled) continue;
    facts.enabledKeyCounts.set(key.providerId, (facts.enabledKeyCounts.get(key.providerId) ?? 0) + 1);
    enabledTotals.set(key.providerId, (enabledTotals.get(key.providerId) ?? 0) + 1);
    if (!firstEnabledKey.has(key.providerId)) firstEnabledKey.set(key.providerId, key.id);
    if (key.cooldownUntil) {
      const list = enabledCooling.get(key.providerId) ?? [];
      list.push(key.cooldownUntil);
      enabledCooling.set(key.providerId, list);
    }
  }

  for (const provider of providerRows) {
    const keyId = firstEnabledKey.get(provider.id);
    // No enabled key means there is nothing that could fail to decrypt; saying
    // otherwise would report a missing credential as a broken one.
    facts.decryptable.set(provider.id, keyId === undefined ? true : providers.resolveKey(keyId) !== undefined);
  }

  const stateByProvider = new Map(stateRows.map((row) => [row.providerId, row] as const));
  for (const provider of providerRows) {
    const state = stateByProvider.get(provider.id);
    const candidates: string[] = [];

    // A scheduler backoff is a cooldown only after a *failure*: `nextProbeAt`
    // also advances on success (it is the schedule), and treating that as a
    // cooldown would make "re-test the failures" impossible for six hours.
    if (state?.nextProbeAt && state.consecutiveFailures > 0) candidates.push(state.nextProbeAt);

    // A key pool is cooling only when *no* key could serve the probe: one
    // usable key is enough, and the probe picks exactly one.
    const cooldowns = enabledCooling.get(provider.id) ?? [];
    const total = enabledTotals.get(provider.id) ?? 0;
    if (total > 0 && cooldowns.length === total) candidates.push(...cooldowns);

    facts.coolingUntil.set(provider.id, latestTimestamp(candidates));
  }

  return facts;
}

/** Newest parseable timestamp in the list, or `null`. */
function latestTimestamp(values: string[]): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

/**
 * The decision for one provider. Pure: same facts and options, same answer.
 *
 * Order (first match wins):
 *  disabled → no adapter → cooldown → exhausted budget (only if the probe could
 *  actually spend) → undecryptable key → no key → no enabled key → keyless
 *  policy → eligible.
 *
 * Two deliberate refinements to the plain reading of §5's table:
 *
 *  - **The paid *switch* is not an eligibility rule.** It is a settings-level
 *    decision that refuses the whole paid run (`startBatch` throws a 409 with
 *    "paid probes are disabled") rather than silently converting twelve testable
 *    sources into twelve "budget" skips, which would look like an exhausted
 *    account. §5 row 3 lists only the *counters* (`remainingToday <= 0`), and
 *    that is what this function implements.
 *  - **The budget only gates a source with a usable credential.** A source with
 *    no key at all cannot spend anything, so blaming the budget for it would send
 *    the operator to the wrong settings page and hide the real reason.
 */
export function decideEligibility(
  facts: EligibilityFacts,
  id: string,
  options: EligibilityOptions,
): { code: EligibilityCode; reason: string } {
  const provider = facts.providers.find((item) => item.id === id);
  if (!provider) {
    // Not a skip: a provider id the caller invented is a request defect, and
    // reporting it as "disabled" would hide the mistake.
    return { code: "CONFIG_ERROR", reason: "provider_not_found: this provider no longer exists" };
  }

  if (!provider.enabled) {
    return { code: "SKIPPED_DISABLED", reason: "disabled: the source is switched off, so probing it says nothing" };
  }

  const adapter = getAdapter(provider.type);
  if (!adapter) {
    return {
      code: "CONFIG_ERROR",
      reason: `adapter_missing: provider type "${provider.type}" has no implementation`,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const coolingUntil = facts.coolingUntil.get(provider.id) ?? null;
  if (coolingUntil && Date.parse(coolingUntil) > nowMs) {
    return {
      code: "SKIPPED_COOLDOWN",
      reason: `cooldown: the previous probe failed and the backoff has not elapsed (until ${coolingUntil})`,
    };
  }

  const enabledCount = facts.enabledKeyCounts.get(provider.id) ?? 0;
  const anyCount = facts.anyKeyCounts.get(provider.id) ?? 0;
  const hasUsableKey = adapter.requiresKey && enabledCount > 0 && facts.decryptable.get(provider.id) === true;

  // A paid probe consumes the operator's account quota. A connectivity probe and
  // an anonymous search do not, so neither may be blocked by the paid cap — and
  // neither may a credentialed probe that has no credential to spend with.
  const consumesPaidSlot = options.kind === "search" && hasUsableKey;
  if (consumesPaidSlot) {
    const budget = options.budget;
    if (budget.remainingToday <= 0) {
      return {
        code: "SKIPPED_BUDGET",
        reason: `budget_exhausted: daily paid-probe budget used (${budget.maxPerDay}/${budget.maxPerDay})`,
      };
    }
    if (budget.maxPerRun <= 0) {
      return { code: "SKIPPED_BUDGET", reason: "budget_exhausted: per-run paid-probe limit is zero" };
    }
  }

  if (adapter.requiresKey) {
    if (enabledCount > 0 && facts.decryptable.get(provider.id) === false) {
      // Never include the ciphertext, its length or a prefix: this string is
      // rendered in the browser and written to the probe log.
      return {
        code: "CONFIG_ERROR",
        reason: "configuration_error: the stored credential could not be decrypted (master key changed?)",
      };
    }
    if (anyCount === 0) {
      return { code: "SKIPPED_NO_KEY", reason: "no_key: this source needs a credential and none is stored" };
    }
    if (enabledCount === 0) {
      return {
        code: "SKIPPED_NO_ENABLED_KEY",
        reason: "no_enabled_key: every stored credential for this source is disabled",
      };
    }
  } else if (!options.includeKeyless) {
    return {
      code: "SKIPPED_KEYLESS_BY_POLICY",
      reason: "keyless_by_policy: this source needs no key and keyless probing is switched off",
    };
  }

  return { code: "ELIGIBLE", reason: "eligible: a probe will be sent" };
}

/**
 * All decisions for a selection, with the seven preview buckets.
 *
 * The counts are derived from the same decisions the runner uses, so "the
 * preview said 12" and "the run probed 12" cannot disagree.
 */
export function previewBatch(
  facts: EligibilityFacts,
  ids: string[],
  options: EligibilityOptions,
): {
  counts: PreviewCounts;
  eligibleIds: string[];
  total: number;
  decisions: EligibilityDecision[];
} {
  const counts: PreviewCounts = {
    eligible: 0,
    noKey: 0,
    noEnabledKey: 0,
    configError: 0,
    disabled: 0,
    keylessSkipped: 0,
    coolingSkipped: 0,
  };
  const decisions: EligibilityDecision[] = [];
  const eligibleIds: string[] = [];

  for (const id of ids) {
    const decision = decideEligibility(facts, id, options);
    const providerName = facts.providers.find((item) => item.id === id)?.name ?? "";
    const enqueue = decision.code === "ELIGIBLE";
    decisions.push({
      providerId: id,
      providerName,
      code: decision.code,
      enqueue,
      // A configuration error is a real, fixable failure that must appear in the
      // failure list; every `SKIPPED_*` never entered the run at all.
      countable: enqueue || decision.code === "CONFIG_ERROR",
      reason: decision.reason,
    });
    if (enqueue) eligibleIds.push(id);

    switch (decision.code) {
      case "ELIGIBLE":
        counts.eligible += 1;
        break;
      case "SKIPPED_NO_KEY":
        counts.noKey += 1;
        break;
      case "SKIPPED_NO_ENABLED_KEY":
        counts.noEnabledKey += 1;
        break;
      case "CONFIG_ERROR":
        counts.configError += 1;
        break;
      case "SKIPPED_DISABLED":
        counts.disabled += 1;
        break;
      case "SKIPPED_KEYLESS_BY_POLICY":
        counts.keylessSkipped += 1;
        break;
      case "SKIPPED_COOLDOWN":
      case "SKIPPED_BUDGET":
        counts.coolingSkipped += 1;
        break;
    }
  }

  return { counts, eligibleIds, total: ids.length, decisions };
}

/**
 * The success-rate denominator: `total - skipped`.
 *
 * A configuration error counts (it was detected and failed); a skipped source
 * does not, because dividing by sources that never got a request would report a
 * success rate the operator cannot act on.
 */
export function testableCount(counts: PreviewCounts): number {
  return counts.eligible + counts.configError;
}
