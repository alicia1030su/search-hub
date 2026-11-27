import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SEED,
  mulberry32,
  pairedStratifiedBootstrap,
  type BootstrapMetric,
  type PairedQuerySample,
} from "../../packages/core/src/evaluation/bootstrap.js";

function samples(count = 32, delta = 0.1): PairedQuerySample[] {
  const cells: Array<[string, string, number]> = [
    ["en", "factual", 4], ["en", "news", 8], ["zh", "factual", 8], ["zh", "news", 12],
  ];
  const result: PairedQuerySample[] = [];
  for (const [language, category, baseCount] of cells) {
    const cellCount = baseCount + (language === "zh" && category === "news" ? Math.max(0, count - 32) : 0);
    for (let index = 0; index < cellCount && result.length < count; index += 1) {
      result.push({
        queryId: `${language}-${category}-${String(index).padStart(2, "0")}`,
        language,
        category,
        judgmentSource: "human",
        baseline: { ndcgAtK: 0.5, mrrAtK: 0.5, precisionAtK: 0.5, recallAtK: 0.5, returnedCount: 10, judgmentsComplete: true },
        candidate: { ndcgAtK: 0.5 + delta, mrrAtK: 0.5 + delta, precisionAtK: 0.5 + delta, recallAtK: 0.5 + delta, returnedCount: 10, judgmentsComplete: true },
      });
    }
  }
  return result;
}

function run(pairs: PairedQuerySample[], metric: BootstrapMetric = "ndcgAtK") {
  return pairedStratifiedBootstrap({ pairs, metric });
}

describe("mulberry32", () => {
  it("matches the seed=118 golden sequence", () => {
    const random = mulberry32();
    expect(Array.from({ length: 8 }, () => random())).toEqual([
      0.06173252291046083, 0.3429913413710892, 0.0005066492594778538, 0.8818586224224418,
      0.15544429095461965, 0.14508019969798625, 0.7168995307292789, 0.2240166561678052,
    ]);
    expect(BOOTSTRAP_SEED).toBe(118);
  });
});

describe("pairedStratifiedBootstrap", () => {
  it("is reproducible regardless of input order and uses no BCa", () => {
    const input = samples();
    const first = run(input);
    const second = run([...input].reverse());
    expect(second).toEqual(first);
    expect(first.protocol).toEqual({ seed: 118, iterations: 10_000, ci: 0.95, method: "paired_stratified_percentile", bca: false });
    expect(first.status).toBe("SUPPORTED");
    expect(first.observed!.pairedN).toBe(32);
    expect(first.observed!.delta).toBeCloseTo(0.1, 10);
    expect(first.observed!.deltaCi.lower).toBeCloseTo(0.1, 10);
    expect(first.observed!.deltaCi.upper).toBeCloseTo(0.1, 10);
  });

  it("reports 2.5/97.5 percentile bounds and refuses a negative improvement", () => {
    const input = samples(32, -0.1);
    input.forEach((sample, index) => {
      sample.baseline.ndcgAtK = 0.2 + (index % 8) / 20;
      sample.candidate.ndcgAtK = sample.baseline.ndcgAtK - 0.05 - (index % 3) / 50;
    });
    const result = run(input);
    const interval = result.observed!.deltaCi;
    expect(interval.lower).not.toBeNull();
    expect(interval.upper).not.toBeNull();
    expect(interval.lower!).toBeLessThanOrEqual(interval.upper!);
    expect(interval.lower!).toBeGreaterThanOrEqual(-0.141);
    expect(interval.upper!).toBeLessThanOrEqual(-0.04);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasons).toContain("improvement_not_confirmed_in_both_lenses");
  });

  it("weights stratum means by frozen query counts, not equal strata", () => {
    const input = samples();
    for (const sample of input) {
      const base = sample.language === "en" && sample.category === "factual" ? 0.2 : 0.8;
      sample.baseline.ndcgAtK = base;
      sample.candidate.ndcgAtK = base;
    }
    const result = run(input);
    // Frozen cell weights: 4/32, 8/32, 8/32, 12/32.
    expect(result.observed!.baselineMean).toBeCloseTo(0.725, 10);
  });

  it("excludes failed, budget-exhausted, provisional and non-human pairs with reasons", () => {
    const input = samples();
    input[0]!.status = "failed";
    input[1]!.status = "timeout";
    input[2]!.status = "budget_exhausted";
    input[3]!.candidate.provisional = true;
    input[4]!.judgmentSource = "machine_generated";
    const result = run(input);
    expect(result.expectedPairs).toBe(32);
    expect(result.pairedN).toBe(27);
    expect(result.excludedN).toBe(5);
    expect(result.attrition).toBe(5 / 32);
    expect(result.exclusions.map((entry) => entry.reasons[0])).toEqual([
      "failed", "timeout", "budget_exhausted", "provisional", "no_human_judgments",
    ]);
  });

  it("accepts native QueryMetrics from the existing metric engine", () => {
    const input = samples();
    const sample = input[4]!;
    const metric = { value: 0.5, status: "ok" as const, sampleSize: 1, provisionalCount: 0, lowSample: false };
    sample.baseline = {
      queryId: sample.queryId, judgedCount: 1, unjudgedCount: 0, returnedCount: 1, provisional: false,
      ndcgAtK: metric, mrrAtK: metric, precisionAtK: metric, recallAtK: metric,
    };
    const result = run(input);
    expect(result.pairedN).toBe(32);
    expect(result.exclusions).toEqual([]);
  });

  it("does not pad missing judgments with zero", () => {
    const input = samples();
    input[4]!.baseline.ndcgAtK = null;
    const result = run(input);
    expect(result.exclusions[0]).toEqual({ queryId: input[4]!.queryId, reasons: ["missing_metric:ndcgAtK"] });
    expect(result.observed!.pairedN).toBe(31);
    expect(result.pairedN).toBe(31);
  });

  it("keeps empty results N/A in observed but zeroes nDCG/MRR/P in releaseScore", () => {
    const input = samples();
    input[4]!.candidate = { ndcgAtK: null, mrrAtK: null, precisionAtK: null, recallAtK: null, returnedCount: 0 };
    const result = run(input);
    expect(result.observed!.pairedN).toBe(31);
    expect(result.releaseScore!.pairedN).toBe(32);
    expect(result.releaseScore!.candidateMean).toBeCloseTo((31 * 0.6) / 32, 10);
    expect(run(input, "mrrAtK").releaseScore!.candidateMean).toBeCloseTo((31 * 0.6) / 32, 10);
    expect(run(input, "precisionAtK").releaseScore!.candidateMean).toBeCloseTo((31 * 0.6) / 32, 10);
  });

  it("computes Recall only for complete qrels", () => {
    const input = samples();
    input[4]!.judgmentsComplete = false;
    const result = run(input, "recallAtK");
    expect(result.observed!.pairedN).toBe(31);
    expect(result.releaseScore!.pairedN).toBe(31);
    expect(result.exclusions).toEqual([]);
  });

  it("returns INSUFFICIENT_EVIDENCE when a stratum has fewer than four pairs", () => {
    const input = samples(23);
    const result = run(input);
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.observed).toMatchObject({ pairedN: 23, deltaCi: { lower: null, upper: null }, sufficient: false });
    expect(result.reasons.some((reason) => reason.includes("stratum"))).toBe(true);
  });

  it("returns INSUFFICIENT_EVIDENCE when a category has fewer than eight pairs", () => {
    const input = samples();
    const result = run(input.filter((sample) =>
      !(sample.language === "en" && sample.category === "factual") && sample.queryId !== "zh-factual-00",
    ));
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.reasons.some((reason) => reason.includes("category:factual<8"))).toBe(true);
  });

  it("returns INSUFFICIENT_EVIDENCE above 20% attrition and accepts exactly 20%", () => {
    const atBoundary = samples(40);
    for (const sample of atBoundary.slice(32)) sample.status = "failed";
    const accepted = run(atBoundary);
    expect(accepted.attrition).toBe(0.2);
    expect(accepted.status).toBe("SUPPORTED");
    atBoundary[31]!.status = "failed";
    const rejected = run(atBoundary);
    expect(rejected.attrition).toBe(0.225);
    expect(rejected.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(rejected.reasons).toContain("attrition>20%");
  });

  it("does not claim improvement without enough pairs", () => {
    const result = run(samples(8));
    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.observed).toMatchObject({ pairedN: 8, deltaCi: { lower: null, upper: null }, sufficient: false });
  });

  it("rejects protocol changes and duplicate query IDs", () => {
    expect(() => pairedStratifiedBootstrap({ pairs: samples(), metric: "ndcgAtK", iterations: 100 })).toThrow("10,000");
    expect(() => pairedStratifiedBootstrap({ pairs: samples(), metric: "ndcgAtK", seed: 1 })).toThrow("118");
    const input = samples();
    input[1]!.queryId = input[0]!.queryId;
    expect(() => run(input)).toThrow("unique queryIds");
  });
});
