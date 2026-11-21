/**
 * 批量检测的资格判定：预检、任务创建和运行器共用同一份决策。
 *
 * 资格事实只加载一次，决策保持纯函数；跳过代表没有发出请求，只有配置错误
 * 计入失败。Key 可用性由 ProviderService 的调度器规则统一给出，这里不再解密
 * “第一个启用 Key”，也不会接触任何凭证明文。
 */
import { inArray } from "drizzle-orm";
import type { SearchHubDb } from "@search-hub/db";
import { providerInstances, providerProbeState } from "@search-hub/db";
import { getAdapter, providerRequiresKey } from "@search-hub/providers";
import type { HealthProbeKind } from "./health-classify.js";
import type { HealthService } from "./health.js";

/** 与 ProviderService.keyAvailability 的外部契约一致。 */
export interface ProviderKeyAvailability {
  total: number;
  enabled: number;
  decryptable: number;
  available: number;
  invalid: number;
  quotaExhausted: number;
  coolingUntil: string | null;
  accountQuotaExhausted: boolean;
}

export type SkipCode =
  | "SKIPPED_DISABLED"
  | "SKIPPED_NO_KEY"
  | "SKIPPED_NO_ENABLED_KEY"
  | "SKIPPED_NO_USABLE_KEY"
  | "SKIPPED_INVALID_KEY"
  | "SKIPPED_QUOTA_EXHAUSTED"
  | "SKIPPED_ACCOUNT_QUOTA"
  | "SKIPPED_KEYLESS_BY_POLICY"
  | "SKIPPED_COOLDOWN"
  | "SKIPPED_BUDGET"
  | "SKIPPED_PAID_DISABLED";

export type EligibilityCode = SkipCode | "ELIGIBLE" | "CONFIG_ERROR";

/** 七个预览桶之和始终等于 total；具体原因保留在每项 code 中。 */
export interface PreviewCounts {
  eligible: number;
  noKey: number;
  noEnabledKey: number;
  configError: number;
  disabled: number;
  keylessSkipped: number;
  /** 冷却、额度、账户配额及付费开关导致的跳过。 */
  coolingSkipped: number;
}

export interface EligibilityFacts {
  providers: Array<{
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }>;
  enabledKeyCounts: Map<string, number>;
  anyKeyCounts: Map<string, number>;
  /** 供旧调用方读取的聚合布尔值；决策本身使用 keyAvailability。 */
  decryptable: Map<string, boolean>;
  /** 调度器失败退避时间；Key 池冷却由 keyAvailability 提供。 */
  coolingUntil: Map<string, string | null>;
  keyAvailability: Map<string, ProviderKeyAvailability>;
}

export interface EligibilityOptions {
  kind: HealthProbeKind;
  /** 本次任务是否包含不需要凭据的源；与全局设置无关。 */
  includeKeyless: boolean;
  budget: ReturnType<HealthService["budget"]>;
  /** 为 true 时，付费搜索中的需凭据源在付费开关关闭时明确跳过。 */
  skipPaidWhenDisabled?: boolean;
  nowMs?: number;
}

export interface EligibilityDecision {
  providerId: string;
  providerName: string;
  code: EligibilityCode;
  enqueue: boolean;
  countable: boolean;
  /** 该源是否实际需要凭据，包含 generic-http 的配置判定。 */
  requiresKey: boolean;
  reason: string;
}

const EMPTY_AVAILABILITY: ProviderKeyAvailability = {
  total: 0,
  enabled: 0,
  decryptable: 0,
  available: 0,
  invalid: 0,
  quotaExhausted: 0,
  coolingUntil: null,
  accountQuotaExhausted: false,
};

const EMPTY_FACTS = (): EligibilityFacts => ({
  providers: [],
  enabledKeyCounts: new Map(),
  anyKeyCounts: new Map(),
  decryptable: new Map(),
  coolingUntil: new Map(),
  keyAvailability: new Map(),
});

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 两次 SQL 查询加一次批量 Key 可用性调用，与源数量无关。
 * providers.keyAvailability 返回的 Map 以 providerId 为键。
 */
export function loadEligibilityFacts(
  db: SearchHubDb,
  providers: { keyAvailability(ids: string[]): Map<string, ProviderKeyAvailability> },
  ids: string[],
): EligibilityFacts {
  if (ids.length === 0) return EMPTY_FACTS();

  const providerRows = db
    .select({
      id: providerInstances.id,
      name: providerInstances.name,
      type: providerInstances.type,
      enabled: providerInstances.enabled,
      configJson: providerInstances.configJson,
    })
    .from(providerInstances)
    .where(inArray(providerInstances.id, ids))
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
  facts.providers = providerRows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    config: parseConfig(row.configJson),
  }));
  facts.keyAvailability = providers.keyAvailability(ids);

  for (const provider of facts.providers) {
    const availability = facts.keyAvailability.get(provider.id) ?? EMPTY_AVAILABILITY;
    facts.anyKeyCounts.set(provider.id, availability.total);
    facts.enabledKeyCounts.set(provider.id, availability.enabled);
    facts.decryptable.set(provider.id, availability.decryptable > 0);
  }

  const stateByProvider = new Map(stateRows.map((row) => [row.providerId, row] as const));
  for (const provider of facts.providers) {
    const state = stateByProvider.get(provider.id);
    // nextProbeAt 在成功后也会前移，只有连续失败后的它才是冷却。
    facts.coolingUntil.set(
      provider.id,
      state?.nextProbeAt && state.consecutiveFailures > 0 ? state.nextProbeAt : null,
    );
  }

  return facts;
}

/** 单个源的纯资格决策，顺序即原因优先级。 */
export function decideEligibility(
  facts: EligibilityFacts,
  id: string,
  options: EligibilityOptions,
): { code: EligibilityCode; reason: string } {
  const provider = facts.providers.find((item) => item.id === id);
  if (!provider) {
    return { code: "CONFIG_ERROR", reason: "provider_not_found: this provider no longer exists" };
  }
  if (!provider.enabled) {
    return { code: "SKIPPED_DISABLED", reason: "disabled: the source is switched off, so probing it says nothing" };
  }
  if (!getAdapter(provider.type)) {
    return {
      code: "CONFIG_ERROR",
      reason: `adapter_missing: provider type "${provider.type}" has no implementation`,
    };
  }

  const requiresKey = providerRequiresKey(provider.type, provider.config);
  if (requiresKey && provider.type === "generic-http" && options.kind === "connect") {
    return {
      code: "CONFIG_ERROR",
      reason: "configuration_error: credentialed generic providers require a search probe; connectivity is not supported",
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const schedulerCooldown = facts.coolingUntil.get(provider.id) ?? null;
  if (schedulerCooldown && Date.parse(schedulerCooldown) > nowMs) {
    return {
      code: "SKIPPED_COOLDOWN",
      reason: `cooldown: the previous probe failed and the backoff has not elapsed (until ${schedulerCooldown})`,
    };
  }

  const availability = facts.keyAvailability.get(provider.id) ?? EMPTY_AVAILABILITY;
  if (requiresKey) {
    if (availability.total === 0) {
      return { code: "SKIPPED_NO_KEY", reason: "no_key: this source needs a credential and none is stored" };
    }
    if (availability.enabled === 0) {
      return {
        code: "SKIPPED_NO_ENABLED_KEY",
        reason: "no_enabled_key: every stored credential for this source is disabled",
      };
    }
    if (availability.decryptable === 0) {
      return {
        code: "CONFIG_ERROR",
        reason: "configuration_error: the stored credential could not be decrypted (master key changed?)",
      };
    }
    // 账户组配额是共享事实，不能靠轮换到另一把 Key 绕过。
    if (availability.accountQuotaExhausted) {
      return {
        code: "SKIPPED_ACCOUNT_QUOTA",
        reason: "account_quota_exhausted: the shared account quota is exhausted; rotating keys cannot bypass it",
      };
    }
    if (availability.available <= 0) {
      if (availability.coolingUntil && Date.parse(availability.coolingUntil) > nowMs) {
        return {
          code: "SKIPPED_COOLDOWN",
          reason: `cooldown: every credential is cooling down (until ${availability.coolingUntil})`,
        };
      }
      if (availability.quotaExhausted > 0) {
        return {
          code: "SKIPPED_QUOTA_EXHAUSTED",
          reason: "quota_exhausted: every credential has exhausted its quota",
        };
      }
      if (availability.invalid > 0) {
        return {
          code: "SKIPPED_INVALID_KEY",
          reason: "invalid_key: every credential is invalid; replace it before retrying",
        };
      }
      return {
        code: "SKIPPED_NO_USABLE_KEY",
        reason: "no_usable_key: no enabled, decryptable and available credential can serve this probe",
      };
    }
  } else if (!options.includeKeyless) {
    return {
      code: "SKIPPED_KEYLESS_BY_POLICY",
      reason: "keyless_by_policy: this source needs no key and keyless probing is switched off for this task",
    };
  }

  // 匿名 generic 连接探测实际执行一次搜索，因此与 anonymous search 共用预算；
  // 普通内建免 Key 连接探测仍走 connect，不受搜索预算限制。
  if (options.kind === "search" || (!requiresKey && provider.type === "generic-http")) {
    const budget = options.budget;
    if (requiresKey) {
      if (!budget.paidProbesEnabled && options.skipPaidWhenDisabled) {
        return {
          code: "SKIPPED_PAID_DISABLED",
          reason: "paid_disabled: this credentialed search was skipped because paid probes are disabled",
        };
      }
      if (budget.remainingToday <= 0) {
        return {
          code: "SKIPPED_BUDGET",
          reason: `budget_exhausted: daily paid-probe budget used (${budget.maxPerDay}/${budget.maxPerDay})`,
        };
      }
      if (budget.maxPerRun <= 0) {
        return { code: "SKIPPED_BUDGET", reason: "budget_exhausted: per-run paid-probe limit is zero" };
      }
    } else {
      if (options.kind === "connect" && provider.type === "generic-http") {
        if (budget.connectMaxPerProbe < 1 || budget.connectRemainingToday <= 0) {
          return {
            code: "SKIPPED_BUDGET",
            reason: "budget_exhausted:connect_http_limit",
          };
        }
      }
      if (budget.anonymousRemainingToday <= 0) {
        return {
          code: "SKIPPED_BUDGET",
          reason: `anonymous_budget_exhausted: daily anonymous-search budget used (${budget.anonymousMaxPerDay}/${budget.anonymousMaxPerDay})`,
        };
      }
      if (budget.anonymousMaxPerRun <= 0) {
        return {
          code: "SKIPPED_BUDGET",
          reason: "anonymous_budget_exhausted: per-run anonymous-search limit is zero",
        };
      }
    }
  }

  return { code: "ELIGIBLE", reason: "eligible: a probe will be sent" };
}

/** 一次范围内的全部决策及七个预览桶。 */
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
    const provider = facts.providers.find((item) => item.id === id);
    const decision = decideEligibility(facts, id, options);
    const enqueue = decision.code === "ELIGIBLE";
    decisions.push({
      providerId: id,
      providerName: provider?.name ?? "",
      code: decision.code,
      enqueue,
      countable: enqueue || decision.code === "CONFIG_ERROR",
      requiresKey: provider ? providerRequiresKey(provider.type, provider.config) : false,
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
      case "SKIPPED_PAID_DISABLED":
      case "SKIPPED_NO_USABLE_KEY":
      case "SKIPPED_INVALID_KEY":
      case "SKIPPED_QUOTA_EXHAUSTED":
      case "SKIPPED_ACCOUNT_QUOTA":
        counts.coolingSkipped += 1;
        break;
    }
  }

  return { counts, eligibleIds, total: ids.length, decisions };
}

/** 成功率分母：跳过不入分母，配置错误属于已判定失败。 */
export function testableCount(counts: PreviewCounts): number {
  return counts.eligible + counts.configError;
}
