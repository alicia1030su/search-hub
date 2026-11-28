import { fetchWebpage, type WebpageReadResult } from "@search-hub/core";
import type { SafeFetch } from "@search-hub/shared";
import type { ResourceSlotLimiter } from "./resource-budget.js";

export interface WebpageReadBudgetOptions {
  fetch: SafeFetch;
  resourceSlots: ResourceSlotLimiter;
  signal?: AbortSignal;
  maxContentChars?: number;
  timeoutMs?: number;
}

/** Runs one webpage extraction under the process-wide concurrency budget. */
export async function readWebpageWithBudget(
  url: string,
  options: WebpageReadBudgetOptions,
): Promise<WebpageReadResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadlineAtMs = Date.now() + timeoutMs;
  const release = await options.resourceSlots.acquire(options.signal, deadlineAtMs);
  try {
    return await fetchWebpage(url, {
      fetch: options.fetch,
      signal: options.signal,
      maxContentChars: options.maxContentChars,
      timeoutMs: Math.max(1, deadlineAtMs - Date.now()),
    });
  } finally {
    release();
  }
}
