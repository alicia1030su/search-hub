import { expect, test, type Page } from "@playwright/test";
import { ensureSignedIn } from "./support";

const CANARY = "V0118-RAW-CANARY";
interface LabControl {
  requests: Array<Record<string, unknown>>;
  cancellations: number;
  release?: () => void;
  reads: string[];
}
const result = (id: string) => ({
  id, title: `Result ${id}`, url: `https://example.test/${id}`, snippet: "snippet",
  source: "p", provider: "p", providerName: "Local mock", providerType: "mock",
  retrievedAt: "2026-01-01T00:00:00.000Z", score: 1, sources: [{ providerId: "p", providerName: "Local mock", providerType: "mock", rank: 1, url: `https://example.test/${id}` }],
  metadata: { raw: CANARY },
});
const finalResponse = {
  taskId: "task-v0118", query: "stream query", strategy: "balanced", status: "completed",
  results: [result("1")], errors: [], failedSources: [], stats: {
    rawCount: 1, dedupedCount: 1, fusedCount: 1, providers: [], cached: true,
    timing: { totalMs: 8, fanoutMs: 2, fusionMs: 1 }, rerankApplied: false, embeddingApplied: false, summaryApplied: false, partial: false,
    funnel: { raw: 1, invalidDropped: 0, duplicatesDropped: 0, truncated: 0, final: 1 },
  }, debug: { rerankComparison: { before: [], after: [result("1")] } },
};

async function stubLabBase(page: Page) {
  await page.route("**/api/admin/providers", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    providers: [{ id: "p", name: "Local mock", type: "mock", enabled: true, ready: true }], status: [],
  }) }));
  await page.route("**/api/admin/models", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/search/route-preview", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
}

async function installStreamMock(page: Page, options: { cancel?: boolean; response?: { results: Array<ReturnType<typeof result>>; [key: string]: unknown } } = {}) {
  await page.addInitScript(({ cancel, response }) => {
    const browser = globalThis as unknown as { fetch: typeof fetch; __labControl: LabControl };
    const originalFetch = browser.fetch.bind(globalThis);
    const control: LabControl = { requests: [], cancellations: 0, release: undefined, reads: [] };
    Object.assign(globalThis, { __labControl: control });
    browser.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/search/stream")) {
        control.requests.push(JSON.parse(String(init?.body ?? "{}")));
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify({ taskId: "task-v0118", selectedProviderIds: ["p"] })}\n\n`));
            controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ status: "fanout" })}\n\n: heartbeat\n\n`));
            controller.enqueue(encoder.encode(`event: results\ndata: ${JSON.stringify({ results: [response.results[0]], sequence: 7 })}\n\n`));
            if (cancel) return;
            control.release = () => {
              controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(response)}\n\n`));
              controller.close();
            };
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.includes("/api/search/tasks/task-v0118/cancel")) {
        control.cancellations += 1;
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/web/read")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { url: string };
        control.reads.push(request.url);
        const failed = request.url.endsWith("/2");
        return new Response(JSON.stringify({ url: request.url, readStatus: failed ? "login_required" : "ok", ok: !failed, text: failed ? undefined : "Extracted safe text", truncated: false, extractor: "article", fetchMs: 3 }), { headers: { "content-type": "application/json" } });
      }
      return originalFetch(input, init);
    };
  }, { cancel: options.cancel ?? false, response: options.response ?? finalResponse });
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.describe("v0.1.18 search laboratory", () => {
  test("keeps legacy rrf default and all ten legacy options", async ({ page }) => {
    await stubLabBase(page);
    let request: Record<string, unknown> | undefined;
    await page.route("**/api/search", async (route) => {
      request = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...finalResponse, strategy: undefined, mode: "rrf" }) });
    });
    await ensureSignedIn(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    await expect(page.locator("#lab-mode")).toHaveValue("mode:rrf");
    await expect(page.locator('#lab-mode optgroup[label="旧模式兼容"] option')).toHaveCount(10);
    await page.locator("#lab-query").fill("legacy query");
    await page.getByRole("button", { name: "运行搜索", exact: true }).click();
    await expect(page.getByTestId("final-results")).toBeVisible();
    expect(request?.mode).toBe("rrf");
    expect(request?.strategy).toBeUndefined();
    expect(request?.skipCache).toBe(true);
  });

  test("streams provisional results, preserves them on cancel, then atomically finishes on done", async ({ page }) => {
    await stubLabBase(page);
    await installStreamMock(page);
    await ensureSignedIn(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    await page.locator("#lab-mode").selectOption("strategy:balanced");
    await page.getByText("高级参数", { exact: true }).click();
    await page.locator("#lab-cache").selectOption("allow");
    await page.locator("#lab-query").fill("stream query");
    await page.getByRole("button", { name: "运行搜索", exact: true }).click();
    const provisional = page.getByTestId("provisional-results");
    await expect(provisional).toBeVisible();
    await expect(provisional.getByText("临时结果", { exact: true }).first()).toBeVisible();
    expect(await provisional.evaluate((node) => (globalThis as unknown as { getComputedStyle(value: unknown): { borderTopStyle: string } }).getComputedStyle(node).borderTopStyle)).toBe("dashed");
    await expect(page.getByRole("button", { name: "复制 JSON" })).toHaveCount(0);
    await expect(page.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    await page.evaluate(() => (globalThis as unknown as { __labControl: LabControl }).__labControl.release?.());
    await expect(page.getByTestId("final-results")).toBeVisible();
    await expect(page.getByTestId("provisional-results")).toHaveCount(0);
    await expect(page.getByTestId("final-results").getByRole("link", { name: "Result 1" })).toHaveCount(1);
    await expect(page.getByText("缓存命中", { exact: false })).toBeVisible();
    const requests = await page.evaluate(() => (globalThis as unknown as { __labControl: LabControl }).__labControl.requests);
    expect(requests[0]?.strategy).toBe("balanced");
    expect(requests[0]?.mode).toBeUndefined();
    expect(requests[0]?.providers).toBeUndefined();
    expect(requests[0]?.queryExpansion).toBe(false);
    expect(requests[0]?.stream).toBe("sse");
    await page.getByRole("button", { name: "复制 JSON" }).click();
    const clipboard = await page.evaluate(() => (globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }).navigator.clipboard.readText());
    expect(clipboard).not.toContain(CANARY);
    expect(clipboard).not.toContain("sequence");
  });

  test("cancel calls the known task endpoint and keeps a non-final provisional list", async ({ page }) => {
    await stubLabBase(page);
    await installStreamMock(page, { cancel: true });
    await ensureSignedIn(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    await page.locator("#lab-mode").selectOption("strategy:fast");
    await page.locator("#lab-query").fill("cancel query");
    await page.getByRole("button", { name: "运行搜索", exact: true }).click();
    await expect(page.getByTestId("provisional-results")).toBeVisible();
    await page.getByRole("button", { name: "中断请求", exact: true }).first().click();
    await expect(page.getByRole("status").getByText("已取消，非最终结果；以下内容不会被导出为最终响应。")).toBeVisible();
    await expect(page.getByTestId("provisional-results")).toBeVisible();
    await expect(page.getByRole("button", { name: "复制 JSON" })).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as unknown as { __labControl: LabControl }).__labControl.cancellations)).toBe(1);
  });

  test("reads正文 only on demand, reuses session cache, handles login state and returns focus on Escape", async ({ page }) => {
    await stubLabBase(page);
    await installStreamMock(page);
    await page.route("**/api/search", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...finalResponse, strategy: undefined, mode: "rrf", results: [result("1"), result("2")] }) }));
    await ensureSignedIn(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    await page.locator("#lab-query").fill("reader query");
    await page.getByRole("button", { name: "运行搜索", exact: true }).click();
    await expect(page.getByTestId("final-results")).toBeVisible();
    expect(await page.evaluate(() => (globalThis as unknown as { __labControl: LabControl }).__labControl.reads.length)).toBe(0);
    const firstRead = page.getByRole("button", { name: "查看正文" }).first();
    await firstRead.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Extracted safe text", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(firstRead).toBeFocused();
    await firstRead.click();
    await expect(page.getByText("Extracted safe text", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (globalThis as unknown as { __labControl: LabControl }).__labControl.reads.length)).toBe(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "查看正文" }).nth(1).click();
    await expect(page.getByRole("status").getByText("需要登录后查看，请打开原网页完成登录。")).toBeVisible();
  });

  test("shows Deep budgets, applied stages, route, degradations and ranking facts", async ({ page }) => {
    await stubLabBase(page);
    const first = result("1");
    const second = result("2");
    const deepResponse = {
      ...finalResponse,
      strategy: "deep" as const,
      query: "deep query",
      results: [second, first],
      route: { selected: "deep" as const, ruleId: "rule-deep", matchedSignals: ["multi_hop"], considered: ["deep", "quality"] },
      appliedStages: ["fanout", "rerank"],
      degradations: [{ stage: "summary", reason: "model_not_configured", fallback: "skip" }],
      queryExpansion: { queries: [
        { query: "deep query", kind: "original", round: 1, weight: 1 },
        { query: "deep query", kind: "rewrite", round: 1, weight: 0.5 },
        { query: "expanded query", kind: "expanded", round: 2, weight: 0.5 },
      ] },
      deepBudget: { subqueries: 3, rounds: 2, providerQueries: 32, httpRequests: 64, exhausted: true },
      stats: { ...finalResponse.stats, rerankApplied: true },
      debug: { rerankComparison: { before: [first, second], after: [second, first] } },
    };
    await installStreamMock(page, { response: deepResponse });
    await ensureSignedIn(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    await page.locator("#lab-mode").selectOption("strategy:deep");
    await page.locator("#lab-query").fill("deep query");
    await page.getByRole("button", { name: "运行搜索", exact: true }).click();
    await expect(page.getByTestId("provisional-results")).toBeVisible();
    await page.evaluate(() => (globalThis as unknown as { __labControl: LabControl }).__labControl.release?.());
    await expect(page.getByTestId("final-results")).toBeVisible();
    await expect(page.getByRole("heading", { name: "查询扩展与预算" })).toBeVisible();
    await expect(page.getByText("已去重", { exact: true })).toBeVisible();
    await expect(page.getByText("rule-deep", { exact: true })).toBeVisible();
    await expect(page.getByText("rerank", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("summary: model_not_configured → skip", { exact: true })).toBeVisible();
    await expect(page.getByText("预算耗尽，返回已有结果", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "重排前后对比" })).toBeVisible();
    await expect(page.getByText("↑1", { exact: true })).toBeVisible();
    await expect(page.getByText("↓1", { exact: true })).toBeVisible();
    const finalText = await page.getByTestId("final-results").innerText();
    expect(finalText.indexOf("Result 2")).toBeLessThan(finalText.indexOf("Result 1"));
  });

  test("has no page overflow at 360px and 768px and does not add routes", async ({ page }) => {
    await stubLabBase(page);
    await installStreamMock(page);
    await ensureSignedIn(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    expect(await page.locator('a[href^="/"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")))).not.toContain("/reader");
    for (const width of [360, 768]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => {
        const browser = globalThis as unknown as { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
        return browser.document.documentElement.scrollWidth <= browser.innerWidth;
      })).toBe(true);
      await expect(page.getByRole("button", { name: "运行搜索", exact: true })).toBeVisible();
    }
  });
});
