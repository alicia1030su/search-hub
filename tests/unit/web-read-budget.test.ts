import { describe, expect, it } from "vitest";
import type { SafeFetch } from "@search-hub/shared";
import { ResourceSemaphore } from "../../apps/api/src/services/resource-budget.js";
import { readWebpageWithBudget } from "../../apps/api/src/services/web-read-budget.js";

function htmlFetch(onStart: () => void, onEnd: () => void): SafeFetch {
  return async <T>(): Promise<{ status: number; headers: Headers; data: T; url: string }> => {
    onStart();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    onEnd();
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      data: "<html><head><title>Example</title></head><body><article>Hello world</article></body></html>" as T,
      url: "https://example.com/",
    };
  };
}

describe("webpage resource budget", () => {
  it("shares one concurrency limit across concurrent readers", async () => {
    const semaphore = new ResourceSemaphore(() => 1);
    let active = 0;
    let maxActive = 0;
    const fetch = htmlFetch(
      () => { active += 1; maxActive = Math.max(maxActive, active); },
      () => { active -= 1; },
    );

    await Promise.all([
      readWebpageWithBudget("https://example.com/a", { fetch, resourceSlots: semaphore }),
      readWebpageWithBudget("https://example.com/b", { fetch, resourceSlots: semaphore }),
    ]);

    expect(maxActive).toBe(1);
  });

  it("cancels a queued read without consuming a permit", async () => {
    const semaphore = new ResourceSemaphore(() => 1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(readWebpageWithBudget("https://example.com/", {
      fetch: htmlFetch(() => undefined, () => undefined),
      resourceSlots: semaphore,
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/i);
    release();

    const nextRelease = await semaphore.acquire();
    nextRelease();
  });
});
