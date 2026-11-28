import type { WebpageReadResult } from "@search-hub/core";
import { SearchHubError, type SafeFetch } from "@search-hub/shared";
import type { ResourceSlotLimiter } from "./resource-budget.js";
import type { WebReadService } from "./web-read.js";

export interface WebpageReadBudgetOptions {
  fetch: SafeFetch;
  webReadService: Pick<WebReadService, "read">;
  resourceSlots: ResourceSlotLimiter;
  signal?: AbortSignal;
  actor?: string;
  maxContentChars?: number;
  maxHtmlBytes?: number;
  timeoutMs?: number;
  skipCache?: boolean;
  refresh?: boolean;
  render?: boolean;
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
    try {
      return await options.webReadService.read({
        url,
        maxContentChars: options.maxContentChars,
        maxHtmlBytes: options.maxHtmlBytes,
        timeoutMs: Math.max(1, deadlineAtMs - Date.now()),
        skipCache: options.skipCache,
        refresh: options.refresh,
        render: options.render,
      }, {
        fetch: options.fetch,
        signal: options.signal,
        actor: options.actor,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new SearchHubError("network", "Webpage request failed", { status: 502 });
      }
      throw error;
    }
  } finally {
    release();
  }
}
