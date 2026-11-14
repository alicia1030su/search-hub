/**
 * Credential redaction shared by the live-provider script and the CI log
 * scrubber. Kept in one place so the workflow and the script can never drift.
 *
 * Covers: the literal value, a Bearer-prefixed value, URL-encoded and base64
 * variants (the common shapes a vendor error page or an upstream echo uses),
 * plus the well-known key prefixes used by these providers. Anything that is
 * not an exact/known variant cannot be detected here — see
 * docs/real-search-validation-plan.md §1.5 for the residual risk.
 */
export function redactText(text, keys) {
  let output = String(text);
  for (const key of keys) {
    if (typeof key !== "string" || key.length < 8) continue;
    const variants = new Set([
      key,
      `Bearer ${key}`,
      encodeURIComponent(key),
      Buffer.from(key).toString("base64"),
    ]);
    for (const variant of variants) {
      if (variant.length >= 8) output = output.split(variant).join("[redacted]");
    }
  }
  return output
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:tvly|sk|sh)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]");
}

/** All provider keys currently present in the environment. */
export function providerKeysFromEnv() {
  return ["TAVILY_API_KEY", "BOCHA_API_KEY", "BRAVE_API_KEY"]
    .map((name) => process.env[name])
    .filter((value) => typeof value === "string" && value.length >= 8);
}
