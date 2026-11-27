import { expect, test, type Page } from "@playwright/test";
import { ensureSignedIn } from "./support";

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sampledAt: "2026-01-01T00:00:00.000Z",
    process: {
      platform: "test", nodeVersion: "v22", uptimeSeconds: 0,
      memory: { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, arrayBuffersBytes: 0 },
      sources: { rss: "node_process", heapUsed: "v8", heapTotal: "v8", external: "v8", arrayBuffers: "v8", uptime: "node_process" },
    },
    activity: { activeSearches: 0, activeProbes: 0, queue: { total: 0, providerKey: 0, health: 0, singleflightFollowers: 0 } },
    cache: { entries: 0, bytes: 0, totalsUpdatedAt: null, totalsSource: "search_cache_state", totalsReason: null, dbFileBytes: 0, walFileBytes: 0, dbFileSource: "fs.stat", walFileSource: "fs.stat", diskScope: "whole_sqlite_database" },
    unavailable: [],
    ...overrides,
  };
}

async function mockResources(page: Page, body: unknown): Promise<() => number> {
  let calls = 0;
  await page.route("**/api/admin/resources", async (route) => {
    calls += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return () => calls;
}

test.describe("runtime resource panel", () => {
  test("redirects an unauthenticated context to login", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/(?:login|setup)$/);
    await context.close();
  });

  test("renders zero values in Chinese and English without polling", async ({ page }) => {
    const calls = await mockResources(page, fixture());
    await ensureSignedIn(page);
    const panel = page.locator('[aria-labelledby="resources-title"]');
    await expect(panel.getByText("运行时资源", { exact: true })).toBeVisible();
    await expect(panel.getByText("0 B", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("仅手动刷新，不自动轮询。")).toBeVisible();
    expect(calls()).toBe(1);
    await page.getByTestId("locale-switcher").selectOption("en-US");
    await expect(panel.getByText("Runtime resources", { exact: true })).toBeVisible();
    await expect(panel.getByText("Manual refresh only; no automatic polling.")).toBeVisible();
    expect(calls()).toBe(1);
    const refresh = panel.getByRole("button", { name: "Refresh runtime resources" });
    await refresh.click();
    await expect.poll(calls).toBe(2);
    await expect(refresh).toBeEnabled();
  });

  test("shows partial unavailable reasons and fits a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockResources(page, fixture({
      process: { ...fixture().process, uptimeSeconds: null, memory: { ...fixture().process.memory, rssBytes: null } },
      cache: { ...fixture().cache, entries: null, bytes: null, dbFileBytes: null, walFileBytes: null, totalsReason: "totals_missing", dbFileSource: "unavailable", walFileSource: "unavailable" },
      unavailable: [
        { field: "process.uptimeSeconds", source: "node_process", reason: "uptime_unavailable" },
        { field: "process.memory.rssBytes", source: "node_process", reason: "memory_unavailable" },
        { field: "cache.totals", source: "search_cache_state", reason: "totals_missing" },
        { field: "cache.dbFileBytes", source: "fs.stat", reason: "not_found" },
        { field: "cache.walFileBytes", source: "fs.stat", reason: "not_found" },
      ],
    }));
    await ensureSignedIn(page);
    const panel = page.locator('[aria-labelledby="resources-title"]');
    await expect(panel.getByText("totals_missing", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("not_found", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("uptime_unavailable", { exact: true })).toBeVisible();
    await expect(panel.getByText("memory_unavailable", { exact: true })).toBeVisible();
    await expect(panel.getByText("—", { exact: true }).first()).toBeVisible();
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });

  test("keeps the old snapshot and marks it stale when refresh fails", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/admin/resources", async (route) => {
      calls += 1;
      if (calls === 1) await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture()) });
      else await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal_error", message: "refresh failed" } }) });
    });
    await ensureSignedIn(page);
    const panel = page.locator('[aria-labelledby="resources-title"]');
    await expect(panel.getByText("0 B", { exact: true }).first()).toBeVisible();
    await panel.getByRole("button", { name: "刷新运行时资源" }).click();
    await expect(panel.getByText("数据已过期", { exact: true })).toBeVisible();
    await expect(panel.getByText("资源刷新失败", { exact: true })).toBeVisible();
    await expect(panel.getByText("0 B", { exact: true }).first()).toBeVisible();
  });

  test("aborts an in-flight resource request when the dashboard unmounts", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/admin/resources", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture()) }).catch(() => undefined);
    });
    await ensureSignedIn(page);
    await page.goto("/providers");
    await expect(page.getByRole("heading", { name: "搜索源", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
