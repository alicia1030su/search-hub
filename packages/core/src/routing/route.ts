import { SearchHubError, type ProviderCapability } from "@search-hub/shared";
import type { ProviderRuntime } from "../engine/fanout.js";

export type QueryIntent = "news" | "code" | "academic" | "chinese" | "general";

export interface ProviderObservation {
  /** Recent observed success rate in [0,1]; absence is unknown, never zero. */
  successRate?: number | null;
  /** Recent observed latency in milliseconds; absence is unknown. */
  latencyMs?: number | null;
  /** Optional measured quality signal in [0,1]. Health is not used as quality. */
  quality?: number | null;
  /** Remaining quota ratio in [0,1]; absence is unknown. */
  remainingQuota?: number | null;
  /** Account-wide park state. It affects order, not silent removal. */
  blocked?: boolean;
}

export interface RouteProviderOptions {
  query: string;
  runtimes: ProviderRuntime[];
  capability?: ProviderCapability;
  /** Explicit ids take precedence and are returned in request order. */
  explicitProviderIds?: string[];
  maxProviders?: number;
  observations?: Record<string, ProviderObservation>;
}

export interface RouteDecision {
  providerId: string;
  score: number;
  reasons: string[];
}

export interface RouteExplanation {
  intent: QueryIntent;
  matchedRules: string[];
  selectedProviderIds: string[];
  requestedProviderCount: number;
  selectedProviderCount: number;
  decisions: RouteDecision[];
  truncatedProviderIds: string[];
}

const INTENT_PATTERNS: Array<{ intent: QueryIntent; rule: string; pattern: RegExp }> = [
  { intent: "news", rule: "news_terms", pattern: /\b(news|latest|today|breaking|headline|election|weather|release)\b|新闻|今日|今天|最新|快讯|发布会/i },
  { intent: "code", rule: "code_terms", pattern: /\b(code|coding|programming|developer|api|sdk|github|bug|typescript|python|rust|javascript|docker|kubernetes)\b|编程|代码|开发|接口|报错|教程/i },
  { intent: "academic", rule: "academic_terms", pattern: /\b(study|research|paper|arxiv|doi|pubmed|crossref|openalex|clinical|trial|theorem|dataset)\b|论文|研究|学术|期刊|实验|数据集/i },
];

const PROVIDER_INTENTS: Record<string, QueryIntent[]> = {
  brave: ["general", "news"],
  searxng: ["general", "news"],
  metaso: ["general", "news", "chinese"],
  "metaso-mcp": ["general", "news", "chinese"],
  minimax: ["general", "news", "chinese"],
  exa: ["general", "academic"],
  "qianfan-search": ["general", "news", "chinese"],
  github: ["code"],
  hackernews: ["code", "news"],
  stackoverflow: ["code"],
  arxiv: ["academic"],
  crossref: ["academic"],
  openalex: ["academic"],
  pubmed: ["academic"],
  "semantic-scholar": ["academic"],
};

function clamp01(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

/** Classifies intent with deterministic rules only; never calls a model. */
export function classifyQueryIntent(query: string): { intent: QueryIntent; matchedRules: string[] } {
  if (/[\u3400-\u9fff]/.test(query)) {
    return { intent: "chinese", matchedRules: ["cjk_script"] };
  }
  for (const candidate of INTENT_PATTERNS) {
    if (candidate.pattern.test(query)) return { intent: candidate.intent, matchedRules: [candidate.rule] };
  }
  return { intent: "general", matchedRules: ["default_general"] };
}

function capabilityOf(runtime: ProviderRuntime): ProviderCapability {
  return runtime.adapter.capability ?? "raw_search";
}

/**
 * Selects at most eight enabled, capability-compatible providers. Explicit
 * provider ids are never overridden. Observations may change ordering, but a
 * blocked/unhealthy provider is not silently removed: its failure remains
 * visible in the search response.
 */
export function routeProviders(options: RouteProviderOptions): RouteExplanation {
  const maxProviders = Math.max(1, Math.min(8, Math.floor(options.maxProviders ?? 8)));
  const explicit = [...new Set((options.explicitProviderIds ?? []).filter(Boolean))];
  const enabled = options.runtimes.filter((runtime) => runtime.enabled);
  const compatible = enabled.filter((runtime) => !options.capability || capabilityOf(runtime) === options.capability);

  if (explicit.length > 0) {
    const byId = new Map(compatible.map((runtime) => [runtime.config.id, runtime]));
    const selected = explicit.slice(0, maxProviders).map((id) => {
      const runtime = byId.get(id);
      if (!runtime) {
        throw new SearchHubError("validation_error", `Explicit provider "${id}" is unknown, disabled, or capability-incompatible`);
      }
      return runtime;
    });
    return {
      intent: classifyQueryIntent(options.query).intent,
      matchedRules: ["explicit_provider_selection"],
      selectedProviderIds: selected.map((runtime) => runtime.config.id),
      requestedProviderCount: explicit.length,
      selectedProviderCount: selected.length,
      decisions: selected.map((runtime) => ({
        providerId: runtime.config.id,
        score: 0,
        reasons: ["explicit provider selection is authoritative"],
      })),
      truncatedProviderIds: explicit.slice(maxProviders),
    };
  }

  const { intent, matchedRules } = classifyQueryIntent(options.query);
  const decisions = compatible.map((runtime) => {
    const observation = options.observations?.[runtime.config.id] ?? {};
    const intents = PROVIDER_INTENTS[runtime.config.type] ?? ["general"];
    const reasons: string[] = [];
    let score = intents.includes(intent) ? 100 : 0;
    if (intents.includes(intent)) reasons.push(`provider capability matches ${intent} intent`);

    const quality = clamp01(observation.quality);
    if (quality !== null) {
      score += quality * 20;
      reasons.push("measured quality observation");
    }
    const successRate = clamp01(observation.successRate);
    if (successRate !== null) {
      score += successRate * 8;
      reasons.push("recent reliability observation");
    }
    if (typeof observation.latencyMs === "number" && Number.isFinite(observation.latencyMs) && observation.latencyMs >= 0) {
      const penalty = Math.min(8, observation.latencyMs / 500);
      score -= penalty;
      reasons.push("recent latency observation");
    }
    const remainingQuota = clamp01(observation.remainingQuota);
    if (remainingQuota !== null) {
      score += remainingQuota * 6;
      reasons.push("remaining quota observation");
    }
    if (observation.blocked) {
      score -= 4;
      reasons.push("account-wide park lowers order but does not remove source");
    }
    if (reasons.length === 1) reasons.push("enabled and capability-compatible fallback");
    return { runtime, decision: { providerId: runtime.config.id, score, reasons } };
  });

  decisions.sort((a, b) =>
    b.decision.score - a.decision.score ||
    a.runtime.config.id.localeCompare(b.runtime.config.id),
  );
  const selected = decisions.slice(0, maxProviders);
  return {
    intent,
    matchedRules,
    selectedProviderIds: selected.map((item) => item.runtime.config.id),
    requestedProviderCount: compatible.length,
    selectedProviderCount: selected.length,
    decisions: decisions.map((item) => item.decision),
    truncatedProviderIds: decisions.slice(maxProviders).map((item) => item.runtime.config.id),
  };
}
