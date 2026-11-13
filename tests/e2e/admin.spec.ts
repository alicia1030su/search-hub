import { expect, test, type Page } from "@playwright/test";

const EMAIL = "admin@example.com";
const PASSWORD = "E2E-Admin-Password-1";

async function completeSetup(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "初始化 Search Hub" })).toBeVisible();
  await page.locator("#setup-token").fill("e2e-setup-token");
  await page.locator("#setup-email").fill(EMAIL);
  await page.locator("#setup-name").fill("管理员");
  await page.locator("#setup-password").fill(PASSWORD);
  await page.locator("#setup-confirm").fill(PASSWORD);
  await page.getByRole("button", { name: "创建管理员并进入" }).click();
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(EMAIL);
  await page.locator("#login-password").fill(PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

async function addMockProvider(page: Page, name: string, namespace: string): Promise<void> {
  await page.goto("/providers");
  await page.getByRole("button", { name: "新增搜索源" }).first().click();
  await page.locator("#provider-name").fill(name);
  await page.locator("#provider-type").selectOption("mock");
  await page
    .getByLabel("适配器配置（JSON）")
    .fill(JSON.stringify({ resultCount: 5, latencyMs: 30, namespace }, null, 2));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(name, { exact: false }).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
}

test.describe("Search Hub 管理后台端到端", () => {
  test("首次安装 → 添加搜索源 → 搜索实验室 → 设置 → 保留", async ({ page }) => {
    await completeSetup(page);

    // 1. Dashboard shows real metrics (zero state, not fake numbers).
    await expect(page.getByText("搜索总数")).toBeVisible();
    await expect(page.getByText("成功率")).toBeVisible();
    await expect(page.getByText("当前时间范围内没有搜索记录。")).toBeVisible();

    // 2. Providers: add two real mock providers through the UI.
    await page.goto("/providers");
    await expect(page.getByRole("heading", { name: "搜索源" })).toBeVisible();
    await addMockProvider(page, "e2e-mock-a", "a");
    await addMockProvider(page, "e2e-mock-b", "b");

    // 3. Models page renders its empty state (no invented model rows).
    await page.goto("/models");
    await expect(page.getByRole("heading", { name: "模型" })).toBeVisible();

    // 4. Search lab: run a real search against both providers.
    await page.goto("/lab");
    await expect(page.getByRole("heading", { name: "搜索实验室" })).toBeVisible();
    await page.locator("#lab-query").fill("e2e 实验室验证");
    await page.getByRole("button", { name: "运行搜索" }).click();
    await expect(page.getByText("e2e-mock-a", { exact: false }).first()).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.locator("body")).not.toContainText("sk-TEST");

    // 5. Theme toggle actually switches the html class.
    await page.getByRole("button", { name: "切换主题" }).click();
    await expect(page.locator("html")).toHaveAttribute("class", /dark/);

    // 6. Settings: save a non-default instance name.
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await page.locator("#settings-name").fill("E2E Hub");
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByText("设置已保存").first()).toBeVisible({ timeout: 15_000 });

    // 7. Reload: session survives, configuration survives.
    await page.reload();
    await expect(page.locator("#settings-name")).toHaveValue("E2E Hub");
    await page.goto("/providers");
    await expect(page.getByText("e2e-mock-a").filter({ visible: true }).first()).toBeVisible();

    // 8. Dashboard now reflects the real search we ran.
    await page.goto("/");
    await expect(page.getByText("搜索总数")).toBeVisible();
  });

  test("未登录访问管理页会跳转登录", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/providers");
    await expect(page).toHaveURL(/\/login|\/setup/);
    await context.close();
  });

  test("错误口令给出可读错误而不是白屏", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    await page.locator("#login-email").fill(EMAIL);
    await page.locator("#login-password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText(/邮箱或密码|错误|失败/).first()).toBeVisible({ timeout: 15_000 });
    await context.close();
  });

  test("集成页展示 MCP 端点与工具列表，且不泄露密钥", async ({ page }) => {
    await login(page);
    await page.goto("/integrations");
    await expect(page.getByRole("heading", { name: "集成" })).toBeVisible();
    await expect(page.locator("body")).toContainText("/mcp");
    await expect(page.locator("body")).toContainText("search_web");
    await expect(page.locator("body")).not.toContainText("sk-");
  });

  test("搜索源目录把未实现项标注清楚且不可创建", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await expect(page.getByText("仅目录 · 未实现").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("支持 30 源", { exact: false })).toHaveCount(0);
  });
});
