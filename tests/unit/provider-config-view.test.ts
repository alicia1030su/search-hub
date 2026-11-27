import { describe, expect, it } from "vitest";
import {
  isGeneralWebEntry,
  providerConfigFields,
  providerFixHint,
} from "../../apps/web/src/lib/provider-config-view.js";
import type {
  ProviderCatalogEntry,
  ProviderHealthRow,
  ProviderSummary,
} from "../../apps/web/src/lib/types.js";

const entry = (type: string, category: ProviderCatalogEntry["category"]): ProviderCatalogEntry =>
  ({ type, category }) as ProviderCatalogEntry;

const provider = (notReadyReason: string | null, keyCount = 1): ProviderSummary =>
  ({ notReadyReason, keyCount }) as ProviderSummary;

const health = (
  runtime: ProviderHealthRow["runtime"],
  lastErrorCode: string | null = null,
  keyTotal = 1,
): ProviderHealthRow => ({ runtime, lastErrorCode, keyTotal }) as ProviderHealthRow;

describe("provider config view", () => {
  it("recognises general web search without counting community or test sources", () => {
    expect(isGeneralWebEntry(entry("brave", "general"))).toBe(true);
    expect(isGeneralWebEntry(entry("tavily", "general"))).toBe(true);
    expect(isGeneralWebEntry(entry("hackernews", "vertical"))).toBe(false);
    expect(isGeneralWebEntry(entry("duckduckgo", "vertical"))).toBe(false);
    expect(isGeneralWebEntry(entry("mock", "custom"))).toBe(false);
    expect(isGeneralWebEntry(entry("crossref", "vertical"))).toBe(false);
  });

  it("returns only config, base URL and credential fields with required flags", () => {
    const fields = providerConfigFields({
      fields: [
        { key: "apiKey", label: "API Key", type: "password", required: true, target: "credential" },
        { key: "baseUrl", label: "Base URL", type: "text", target: "baseUrl" },
        { key: "region", label: "Region", type: "text", required: true, target: "config" },
        { key: "model", label: "Model", type: "text", required: true, target: "model" },
        { key: "optionalModel", label: "Optional model", type: "text", target: "model" },
      ],
    });
    expect(fields).toEqual([
      { key: "apiKey", label: "API Key", required: true, target: "credential" },
      { key: "baseUrl", label: "Base URL", required: false, target: "baseUrl" },
      { key: "region", label: "Region", required: true, target: "config" },
      { key: "model", label: "Model", required: true, target: "model" },
    ]);
  });

  it("maps readiness and runtime failures to actionable hints", () => {
    expect(providerFixHint(provider("no credential configured", 0), null)).toBe("no_key");
    expect(providerFixHint(provider("credential could not be decrypted", 1), null)).toBe("invalid_config");
    expect(providerFixHint(provider(null), health("invalid_credentials", "auth_invalid"))).toBe("auth_failed");
    expect(providerFixHint(provider(null), health("rate_limited", "rate_limited"))).toBe("rate_limited");
    expect(providerFixHint(provider(null), health("quota_exceeded", "quota_exceeded"))).toBe("quota");
    expect(providerFixHint(provider(null), health("unhealthy", "network"))).toBe("network");
    expect(providerFixHint(provider(null), health("degraded", "no_available_key"))).toBe("empty_results");
    expect(providerFixHint(provider(null), health("degraded", "timeout"))).toBe("timeout");
    expect(providerFixHint(provider(null), health("permission_denied", "blocked"))).toBe("permission");
    expect(providerFixHint(provider(null), health("cooldown", "rate_limited"))).toBe("rate_limited");
    expect(providerFixHint(provider(null), health("cooldown", null))).toBeNull();
    expect(providerFixHint(provider(null), health("unverified", null, 0))).toBe("no_key");
    expect(providerFixHint(provider(null), health("healthy"))).toBeNull();
  });

  it("never reports HTTP 200 empty results as an authentication failure", () => {
    expect(providerFixHint(provider(null), health("degraded", "no_available_key"))).toBe("empty_results");
  });
});
