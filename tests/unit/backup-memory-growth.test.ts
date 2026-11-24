import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM acceptance harness
import { assessGrowth } from "../disaster-recovery/backup-memory-loop.mjs";

function round(afterGc: Record<string, number>) {
  return {
    afterGc: {
      heapUsedBytes: 1000,
      heapTotalBytes: 2000,
      externalBytes: 3000,
      arrayBuffersBytes: 4000,
      rssBytes: 5000,
      maxRssBytes: 6000,
      activeHandles: 2,
      ...afterGc,
    },
  };
}

const warmups = [round({}), round({})];

describe("same-process retained-memory growth classification", () => {
  it("classifies an isolated lifetime maxRSS step without retained growth as PASS", () => {
    const values = [415662080, 415662080, 415662080, 415666176, 417583104];
    const growth = assessGrowth(values.map((maxRssBytes) => round({ maxRssBytes })), warmups);
    expect(growth.result).toBe("PASS");
    expect(growth.series.maxRssBytes).toMatchObject({
      result: "PASS",
      classification: "isolated_lifetime_peak_step_without_retained_growth",
      sustainedGrowth: false,
      inconclusiveNoise: true,
      values,
      deltas: [0, 0, 4096, 1916928],
      positiveDeltas: 2,
    });
  });

  it("keeps sustained maxRSS growth as FAIL", () => {
    const growth = assessGrowth([100, 120, 140, 160, 220].map((maxRssBytes) => round({ maxRssBytes })), warmups);
    expect(growth.result).toBe("FAIL");
    expect(growth.series.maxRssBytes).toMatchObject({ result: "FAIL", sustainedGrowth: true, positiveDeltas: 4 });
  });

  it("keeps ambiguous retained heap growth BLOCKED", () => {
    const growth = assessGrowth(
      [100, 110, 120, 130, 140, 150, 160, 170, 169, 168].map((heapUsedBytes) => round({ heapUsedBytes })),
      warmups,
    );
    expect(growth.result).toBe("BLOCKED");
    expect(growth.series.heapUsedBytes).toMatchObject({ result: "BLOCKED", sustainedGrowth: false, inconclusiveNoise: true });
  });
});
