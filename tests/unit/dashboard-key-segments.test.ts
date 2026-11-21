import { describe, expect, it } from "vitest";
import { dashboardKeySegments } from "../../apps/web/src/lib/dashboard-key-segments.js";
import type { DashboardStats } from "../../apps/web/src/lib/types.js";

const keys: DashboardStats["keys"] = {
  total: 8,
  healthy: 2,
  rateLimited: 1,
  cooldown: 1,
  invalid: 1,
  forbidden: 1,
  quotaExhausted: 1,
  disabled: 1,
};

describe("dashboard key segments", () => {
  it("partitions every key status, including forbidden and quota_exhausted", () => {
    const segments = dashboardKeySegments(keys, (status) => status);
    expect(segments.map((segment) => segment.status)).toEqual([
      "healthy",
      "rate_limited",
      "cooldown",
      "invalid",
      "forbidden",
      "quota_exhausted",
      "disabled",
    ]);
    expect(segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(keys.total);
    expect(segments.find((segment) => segment.status === "forbidden")).toMatchObject({
      value: 1,
      className: "bg-warning/70",
    });
    expect(segments.find((segment) => segment.status === "quota_exhausted")).toMatchObject({
      value: 1,
      className: "bg-warning/85",
    });
  });
});
