import type { SafeFetch } from "@search-hub/shared";

/**
 * Credential scrubbing for model traffic.
 *
 * `SafeFetch` already redacts the credential headers it knows about
 * (`authorization`, `x-api-key`, `x-subscription-token`) out of upstream error
 * bodies. Two gaps remain, and this module closes both:
 *
 *  1. Vendor headers outside that list — Gemini sends the key as
 *     `x-goog-api-key`. An upstream (or an HTTP proxy in front of it) that
 *     echoes the header back would put the key into an error string.
 *  2. The scrub has to belong to the adapter that owns the key, so it keeps
 *     working regardless of which fetch implementation is injected (a unit-test
 *     stub, a future refactor, a proxy-aware client).
 *
 * The messages involved end up in three places whose shape we do not control:
 *
 *  - the `/api/admin/models/:id/test` response (shown in the admin UI),
 *  - `model_configs.last_test_error` in SQLite, and therefore in every
 *    `/api/admin/backup` snapshot,
 *  - `stats.errors[].message` in a search response, returned to any caller with
 *    a search-scoped token.
 *
 * None of them may carry a live API key, so every error that leaves a model
 * adapter is scrubbed against the exact key that adapter was given.
 */

const REDACTED = "[redacted-api-key]";

/** Known credential shapes, so a *different* key echoed by the same host cannot slip through. */
const CREDENTIAL_SHAPES: RegExp[] = [
  /bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\btvly-[A-Za-z0-9_-]{8,}/g,
  /\bsh_[A-Za-z0-9_-]{8,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
];

/** Replaces this model's key — and anything shaped like a key — in `text`. */
export function scrubSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let output = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    // Very short values would produce false positives across ordinary words.
    if (!value || value.length < 8) continue;
    const bare = value.replace(/^bearer\s+/i, "");
    for (const variant of new Set([value, bare])) {
      if (variant.length >= 8) output = output.split(variant).join(REDACTED);
    }
  }
  for (const shape of CREDENTIAL_SHAPES) output = output.replace(shape, REDACTED);
  return output;
}

/** Scrubs a thrown value while keeping its type, code and stack intact. */
export function scrubError(error: unknown, secrets: Array<string | undefined | null>): unknown {
  if (!(error instanceof Error)) return error;
  const message = scrubSecrets(error.message, secrets);
  if (message === error.message) return error;
  try {
    error.message = message;
    if (error.stack) error.stack = scrubSecrets(error.stack, secrets);
  } catch {
    // A frozen error object cannot be edited; the caller still gets the original.
  }
  return error;
}

/**
 * Wraps an injected `SafeFetch` so nothing it throws can carry the model API
 * key. Control flow is unchanged: the same error instance is re-thrown with a
 * scrubbed message.
 */
export function scrubbingFetch(fetchImpl: SafeFetch, apiKey?: string): SafeFetch {
  if (!apiKey) return fetchImpl;
  return async <T>(url: string, init?: RequestInit & { timeoutMs?: number; maxBytes?: number }) => {
    try {
      return await fetchImpl<T>(url, init);
    } catch (error) {
      throw scrubError(error, [apiKey]);
    }
  };
}
