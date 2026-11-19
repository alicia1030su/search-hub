import { t } from "./i18n";
import { codeKey, groupOf, stateKey } from "./batch-classify";
import type { BatchItem, BatchJobView, BatchState } from "./types";

/**
 * Human labels for the bulk-test surface.
 *
 * Separate from `batch-classify` (the pure structural helpers) because this
 * module needs the i18n runtime, while grouping and sorting must stay testable
 * without a DOM. Both are used by the table and the drawer, so a row's label and
 * its group can never come from two different definitions.
 */

/** Human label for a row's state; a restricted failure is labelled `restricted`. */
export function stateLabel(item: BatchItem): string {
  return t(stateKey(item, groupOf(item)));
}

/** Human label for a code, falling back to the code itself when unknown. */
export function codeLabel(code: string): string {
  const key = codeKey(code);
  const label = t(key);
  // `t()` echoes the key when it is missing; printing
  // "providers.batch.code.…" into the table would be worse than the raw code.
  return label === key ? code : label;
}

/** The actionable sentence for a classification, or `""` when there is none. */
export function codeAdvice(code: string): string {
  const key = codeKey(code, "advice");
  const advice = t(key);
  return advice === key ? "" : advice;
}

/**
 * Badge tone per state: failure is destructive, "answered but empty" is a warning.
 *
 * A tone, not a word — so it does not depend on the locale and lives here for
 * the table and the drawer to share.
 */
export const STATE_TONE: Record<BatchState, "success" | "destructive" | "warning" | "muted" | "info"> = {
  ok: "success",
  failed: "destructive",
  pending: "warning",
  skipped: "muted",
  unknown: "info",
};

/**
 * The progress label for a run.
 *
 * Three distinct labels, and "all done" is only reachable when the server says
 * `completed`: a cancelled or interrupted run must read "partially complete
 * (n/total)", because the operator would otherwise trust a half-filled table.
 */
export function runStatusLabel(job: BatchJobView): string {
  const finished = job.counts.done + job.counts.skipped;
  if (job.status === "running") return t("providers.batch.progress.running");
  if (job.status === "completed") return t("providers.batch.progress.completed");
  return t("providers.batch.progress.partial", { done: finished, total: job.counts.total });
}
