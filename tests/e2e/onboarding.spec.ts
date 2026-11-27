import { expect, test, type Page } from "@playwright/test";
import { adminJson } from "./support";

const EMAIL = "admin@example.com";
const PASSWORD = "E2E-Local-Only-Password-1";

async function completeSetup(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "初始化 Search Hub" })).toBeVisible();
  await page.locator("#setup-token").fill("e2e-setup-token");
  await page.locator("#setup-email").fill(EMAIL);
  await page.locator("#setup-name").fill("管理员");
  await page.locator("#setup-password").fill(PASSWORD);
  await page.locator("#setup-confirm").fill(PASSWORD);
  await page.getByRole("button", { name: "创建管理员并进入" }).click();
  await expect(page.getByRole("heading", { name: "首次使用引导" })).toBeVisible({ timeout: 20_000 });
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(EMAIL);
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

test.describe.serial("v0.1.17 onboarding", () => {
  test("fresh setup lands on onboarding with four keyless recommendations and no automatic external requests", async ({ page }) => {
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if ((url.protocol === "http:" || url.protocol === "https:") && !["127.0.0.1", "localhost"].includes(url.hostname)) {
        externalRequests.push(request.url());
      }
    });
    await completeSetup(page);
    await expect(page.getByText("Hacker News（Algolia 官方搜索 API）", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Crossref", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("OpenAlex", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("PubMed", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/不是通用网页搜索/).first()).toBeVisible();
    await page.waitForTimeout(300);
    expect(externalRequests).toEqual([]);
  });

  test("skip persists and a later login does not reopen onboarding", async ({ page }) => {
    await login(page);
    await page.goto("/onboarding");
    await page.getByRole("button", { name: "跳过引导" }).click();
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });

    await page.context().clearCookies();
    await login(page);
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "首次使用引导" })).toHaveCount(0);
  });

  test("a ready mock can run the step-three search flow and complete onboarding", async ({ page }) => {
    await login(page);
    const reset = await adminJson(page, "/api/admin/settings", {
      method: "PUT",
      body: { onboarding: { completedAt: null, dismissedAt: null, lastSeenVersion: null } },
    });
    expect(reset.status).toBe(200);

    const created = await adminJson(page, "/api/admin/providers", {
      method: "POST",
      body: {
        name: "onboarding-e2e-mock",
        type: "mock",
        enabled: true,
        config: { resultCount: 3, latencyMs: 1, namespace: "onboarding-e2e" },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "完成一次搜索" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Mock 仅用于流程验证/)).toBeVisible();
    await page.locator("#onboarding-query").fill("onboarding e2e query");
    await page.getByRole("button", { name: "运行搜索" }).click();
    await expect(page.getByTestId("onboarding-search-result")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("onboarding-search-result")).toContainText("onboarding-e2e-mock");
    await page.getByRole("button", { name: "完成引导" }).click();
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
  });
});
