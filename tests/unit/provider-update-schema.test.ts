import { describe, expect, it } from "vitest";
import { providerUpdateSchema } from "@search-hub/shared";

describe("provider update schema", () => {
  it("does not inject create defaults into a partial PATCH", () => {
    expect(providerUpdateSchema.parse({ maxConcurrency: 1, rpmLimit: 2 })).toEqual({
      maxConcurrency: 1,
      rpmLimit: 2,
    });
  });

  it("preserves explicitly supplied config and searchConfig without resetting omitted fields", () => {
    const config = { keyInjection: { in: "header", name: "x-api-key" } };
    const searchConfig = { targetResults: 4, maxPages: 2 };
    expect(providerUpdateSchema.parse({ config, searchConfig, enabled: false })).toEqual({
      config,
      searchConfig,
      enabled: false,
    });
  });

  it("still validates provided values", () => {
    expect(providerUpdateSchema.safeParse({ rpmLimit: 0 }).success).toBe(false);
    expect(providerUpdateSchema.safeParse({ timeoutMs: 100 }).success).toBe(false);
  });
});
