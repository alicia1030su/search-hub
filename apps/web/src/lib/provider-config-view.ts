import type {
  ProviderCatalogEntry,
  ProviderCatalogField,
  ProviderHealthRow,
  ProviderSummary,
} from "./types";

export type ProviderConfigField = Pick<ProviderCatalogField, "key" | "label" | "required"> & {
  target: "config" | "baseUrl" | "credential" | "model";
};

export type ProviderFixHint =
  | "no_key"
  | "invalid_config"
  | "auth_failed"
  | "rate_limited"
  | "quota"
  | "network"
  | "empty_results"
  | "permission"
  | "timeout"
  | "server_error"
  | "disabled";

/** General web-search coverage, excluding community/API/test substitutes. */
export function isGeneralWebEntry(entry: Pick<ProviderCatalogEntry, "category" | "type">): boolean {
  return entry.category === "general" && !["hackernews", "duckduckgo", "mock"].includes(entry.type);
}

/** Declarative fields an operator must understand before configuring a source. */
export function providerConfigFields(
  entry: Pick<ProviderCatalogEntry, "fields">,
): ProviderConfigField[] {
  return (entry.fields ?? [])
    .filter((field): field is ProviderCatalogField & { target: "config" | "baseUrl" | "credential" | "model" } =>
      field.target === "config" || field.target === "baseUrl" || field.target === "credential" ||
      (field.target === "model" && field.required === true),
    )
    .map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required === true,
      target: field.target,
    }));
}

/** Actionable remediation derived from readiness and runtime facts, never verification. */
export function providerFixHint(
  provider: Pick<ProviderSummary, "notReadyReason" | "keyCount">,
  healthRow: Pick<ProviderHealthRow, "runtime" | "lastErrorCode" | "keyTotal"> | null | undefined,
): ProviderFixHint | null {
  const reason = (provider.notReadyReason ?? "").toLowerCase();
  if (reason.includes("disabled")) return "disabled";
  if (reason.includes("no credential") || reason.includes("no key")) return "no_key";
  if (reason.includes("decrypt") || reason.includes("invalid") || reason.includes("config")) return "invalid_config";

  const runtime = healthRow?.runtime;
  const errorCode = healthRow?.lastErrorCode ?? "";
  if (runtime === "invalid_credentials" || errorCode === "auth_invalid") return "auth_failed";
  if (runtime === "rate_limited" || errorCode === "rate_limited") return "rate_limited";
  if (runtime === "quota_exceeded" || errorCode === "quota_exceeded") return "quota";
  if (runtime === "permission_denied" || errorCode === "blocked" || errorCode === "forbidden") return "permission";
  if (errorCode === "no_available_key" || errorCode === "empty_results") return "empty_results";
  if (errorCode === "timeout") return "timeout";
  if (errorCode === "server_error" || errorCode === "bad_response") return "server_error";
  if (runtime === "unhealthy" || ["network", "dns", "tls", "network_error"].includes(errorCode)) return "network";
  if (runtime === "unverified") {
    return provider.keyCount === 0 || healthRow?.keyTotal === 0 ? "no_key" : "invalid_config";
  }
  return null;
}
