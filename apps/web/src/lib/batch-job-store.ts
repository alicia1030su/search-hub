/**
 * The "last bulk test" pointer that survives a page reload.
 *
 * Three facts are stored — the job id, its kind and when it started — and none
 * of them is a credential or a result. The record is a **pointer, not a cache**:
 * on the next load the page asks the server what actually happened, so a stale
 * pointer can never become a stale table claiming a run succeeded.
 *
 * It is cleared only when the server says the job is gone (`404`) or belongs to
 * another account (`403`), which is the honest moment to conclude "there is
 * nothing to come back to". A new run simply overwrites it.
 *
 * Storage is addressed through `globalThis` rather than `window`: this module is
 * also exercised by the node test suite, and the browser's `window` *is*
 * `globalThis`. A blocked storage (private mode, strict policy) is treated as
 * "no storage" — the run itself must never depend on a convenience pointer.
 */
const STORAGE_KEY = "sh-provider-batch-job";

export interface RememberedBatchJob {
  jobId: string;
  kind: "connect" | "search";
  startedAt: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser's `localStorage`, or `null` where it is missing or unreachable. */
function storage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
    return typeof candidate === "object" && candidate !== null ? candidate : null;
  } catch {
    return null;
  }
}

/** Writes the pointer. Best effort: blocked storage must not break the run. */
export function rememberBatchJob(job: RememberedBatchJob): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(job));
  } catch {
    /* the run itself is unaffected; only the reload shortcut is lost */
  }
}

/**
 * Reads the pointer, or `null` when there is none.
 *
 * A malformed record is treated as no record: the value may have been written by
 * an older build (or by something else entirely), and guessing at a partial job
 * id would only produce a request that 404s.
 */
export function readRememberedBatchJob(): RememberedBatchJob | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<RememberedBatchJob>;
    if (typeof record.jobId !== "string" || record.jobId.length === 0) return null;
    if (record.kind !== "connect" && record.kind !== "search") return null;
    return {
      jobId: record.jobId,
      kind: record.kind,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
    };
  } catch {
    return null;
  }
}

/** Drops the pointer (job not found, or not ours). */
export function forgetBatchJob(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do: the next 404 clears the in-memory state anyway */
  }
}
