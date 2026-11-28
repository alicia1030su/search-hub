import type { SearchRequest, SearchStrategy } from "@search-hub/shared";

export interface StrategyRuleEvaluation {
  ruleId: string;
  matched: boolean;
  signals: string[];
}

export interface StrategyRouteDecision {
  selected: Exclude<SearchStrategy, "auto">;
  ruleId: string;
  matchedSignals: string[];
  considered: StrategyRuleEvaluation[];
}

const COMPARISON = /\b(compare|comparison|versus|vs|difference|differences|pros|cons|tradeoffs?|benchmark)\b|比较|对比|差异|优缺点|哪个好|评测/iu;
const RESEARCH = /\b(research|study|paper|analysis|analy[sz]e|investigate|survey|theorem|dataset)\b|研究|论文|数据分析|调研|综述/iu;
const MULTI_CONSTRAINT = /\b(with|without|under|between|multiple|several|constraints?|budget|performance|security|privacy)\b|并且|同时|在.{0,20}下|预算|性能|安全|隐私/iu;
const EXACT_URL = /^https?:\/\/\S+$/iu;
const SHORT_QUERY = /^[\p{L}\p{N}\s._-]{1,24}$/u;

/** Pure deterministic auto-strategy router; never calls a model or reads vectors. */
export function routeSearchStrategy(request: SearchRequest): StrategyRouteDecision {
  const query = request.query.trim();
  const considered: StrategyRuleEvaluation[] = [];
  const add = (ruleId: string, matched: boolean, signals: string[]): void => {
    considered.push({ ruleId, matched, signals });
  };

  const deepSignal = request.mode === "deep" || MULTI_CONSTRAINT.test(query);
  const qualitySignal = COMPARISON.test(query) || RESEARCH.test(query);
  const fastSignal = EXACT_URL.test(query) || (SHORT_QUERY.test(query) && query.split(/\s+/u).length <= 3);
  add("deep_intent", deepSignal, deepSignal ? [request.mode === "deep" ? "explicit_deep_mode" : "multi_constraint_query"] : []);
  add("quality_intent", qualitySignal, qualitySignal ? [COMPARISON.test(query) ? "comparison_terms" : "research_terms"] : []);
  add("fast_intent", fastSignal, fastSignal ? [EXACT_URL.test(query) ? "exact_url" : "short_query"] : []);
  add("balanced_default", !deepSignal && !qualitySignal && !fastSignal, ["default"]);

  if (deepSignal) {
    return { selected: "deep", ruleId: "deep_intent", matchedSignals: considered[0]!.signals, considered };
  }
  if (qualitySignal) {
    return { selected: "quality", ruleId: "quality_intent", matchedSignals: considered[1]!.signals, considered };
  }
  if (fastSignal) {
    return { selected: "fast", ruleId: "fast_intent", matchedSignals: considered[2]!.signals, considered };
  }
  return { selected: "balanced", ruleId: "balanced_default", matchedSignals: ["default"], considered };
}
