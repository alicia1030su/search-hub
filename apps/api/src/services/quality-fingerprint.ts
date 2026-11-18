/**
 * Provenance fingerprints for a quality run.
 * * A score is only reproducible if the thing that produced it can be named. The
 * three fingerprints below are that name: a sha256 over a stable, credential-
 * free description of
 *
 *  - the **providers** that participated (and their ranking-relevant settings),
 *  - the **qrels** the run was measured against, and
 *  - the **models** that took part, if any.
 *
 * Two rules they all obey:
 *
 *  1. **No secret may reach the digest.** An API key must not be able to change
 *     a fingerprint — otherwise rotating a key would look like a configuration
 *     change, and a fingerprint would become a covert channel for key material.
 *     Every call site therefore passes an explicitly enumerated projection.
 *  2. **The digest is a pure function of the input.** Same rows in, same hex
 *     out, on any machine: rows are sorted before serialization, and no
 *     property order is inherited from object literal ordering.
 *
 * The digest is truncated to 32 hex characters (128 bits). It is an identity
 * label, not a security boundary: nothing is authenticated against it.
 */
import { createHash } from "node:crypto";

/** One provider's ranking-relevant settings, as they were when the run started. */
export interface ProviderFingerprintRow {
  id: string;
  type: string;
  baseUrl: string | null;
  weight: number | null;
  timeoutMs: number | null;
  maxConcurrency: number | null;
  resultsPerPage: number | null;
  rpmLimit: number | null;
  maxRetries: number | null;
  searchConfig: Record<string, unknown>;
}

/** One graded judgement, reduced to what makes the qrel set a different question. */
export interface QrelsFingerprintRow {
  queryId: string;
  documentId: string;
  relevance: number;
}

/** One model's identity, when a model took part in the run at all. */
export interface ModelFingerprintRow {
  id: string;
  kind: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
}

/** The digest length every fingerprint uses. */
const DIGEST_LENGTH = 32;

/**
 * Fields that are stripped even if a caller forgets to omit them.
 *
 * Call sites pass an enumerated projection, so this is a second line of
 * defence: a future caller that spreads a whole provider row into the
 * projection must not silently make the fingerprint depend on a credential.
 */
const SECRET_KEY_PATTERN = /key|token|secret|password|credential|authorization/i;

function digest(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, DIGEST_LENGTH);
}

/**
 * JSON serialization with sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * configurations built in a different order would produce different
 * fingerprints. Sorting at every level removes that accidental channel.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Drops any secret-looking key at any depth, so a spread cannot leak one. */
function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    output[key] = stripSecrets(record[key]);
  }
  return output;
}

/**
 * Fingerprint of the provider set.
 *
 * Includes exactly the settings that can change a ranking or a request plan:
 * weight, timeout, concurrency, page size, rate limit and retries, plus the
 * resolved search plan. `apiKey`, `credentialId` and every other secret field
 * are excluded by the projection and again by {@link stripSecrets}.
 */
export function providerFingerprint(rows: readonly ProviderFingerprintRow[]): string | null {
  if (rows.length === 0) return null;
  const projection = [...rows]
    .map((row) => ({
      id: row.id,
      type: row.type,
      baseUrl: row.baseUrl,
      weight: row.weight,
      timeoutMs: row.timeoutMs,
      maxConcurrency: row.maxConcurrency,
      resultsPerPage: row.resultsPerPage,
      rpmLimit: row.rpmLimit,
      maxRetries: row.maxRetries,
      searchConfig: stripSecrets(row.searchConfig ?? {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return digest(stableStringify(projection));
}

/**
 * Fingerprint of the qrel set.
 *
 * A judgment is `(queryId, documentId) → relevance`. Changing one grade makes
 * the set a different ground truth, so the digest must change; changing the
 * *order* rows were written in must not. `judgmentsComplete` participates
 * because it decides whether recall is a number at all — two sets with the same
 * grades but a different completeness flag answer different questions.
 */
export function qrelsFingerprint(
  rows: readonly QrelsFingerprintRow[],
  judgmentsComplete: boolean,
): string | null {
  if (rows.length === 0 && !judgmentsComplete) return null;
  const lines = [...rows]
    .map((row) => ({ queryId: row.queryId, documentId: row.documentId, relevance: row.relevance }))
    .sort((left, right) => {
      const byQuery = left.queryId.localeCompare(right.queryId);
      if (byQuery !== 0) return byQuery;
      return left.documentId.localeCompare(right.documentId);
    })
    .map((row) => `${row.queryId}|${row.documentId}|${row.relevance}`);
  return digest(`${judgmentsComplete ? "complete" : "partial"}\n${lines.join("\n")}`);
}

/**
 * Fingerprint of the models that took part.
 *
 * An empty set is `null`, not a digest of nothing: "no model was involved" is a
 * fact about the run, and conflating it with "models were involved but we
 * forgot which" would destroy the distinction that
 * `modelFingerprint === null` is meant to carry.
 */
export function modelFingerprint(rows: readonly ModelFingerprintRow[]): string | null {
  if (rows.length === 0) return null;
  const projection = [...rows]
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      providerType: row.providerType,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return digest(stableStringify(projection));
}

/** Shown in the UI: the first eight characters, with the full value on hover. */
export function shortFingerprint(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return value.slice(0, 8);
}
