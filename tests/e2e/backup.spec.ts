import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "E2E-Local-Only-Password-1";

async function completeSetup(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForURL(/\/(?:login|setup)$/);
  if (new URL(page.url()).pathname === "/login") {
    await page.locator("#login-email").fill("admin@example.com");
    await page.locator("#login-password").fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
  } else {
    await page.locator("#setup-token").fill("e2e-setup-token");
    await page.locator("#setup-email").fill("admin@example.com");
    await page.locator("#setup-name").fill("管理员");
    await page.locator("#setup-password").fill(PASSWORD);
    await page.locator("#setup-confirm").fill(PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
  }
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

test.describe("backup center", () => {
  test("requires authentication", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/backup");
    await expect(page).toHaveURL(/\/(?:login|setup)$/);
    await context.close();
  });

  test("renders encrypted backup and safe restore guidance without an in-place button", async ({ page }) => {
    await page.route("**/api/admin/backups/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          dbBytes: 1024,
          schema: "0012_api_key_credential_revision.sql",
          keySource: "file",
          walBytes: 0,
          latestBackup: null,
          backupDirWritable: true,
          restoreReadiness: false,
          keyReadiness: "missing",
        }),
      });
    });
    await completeSetup(page);
    await page.getByRole("link", { name: "备份中心", exact: true }).click();
    await expect(page).toHaveURL(/\/backup$/);
    await expect(page.getByRole("heading", { name: "备份与灾备" })).toBeVisible();
    await expect(page.getByLabel("恢复包口令")).toBeVisible();
    await expect(page.getByRole("button", { name: "创建并下载 .shbackup" })).toBeDisabled();
    await expect(page.getByText("shub backup restore search-hub.shbackup --data-dir /srv/search-hub/restored --passphrase-stdin", { exact: true })).toBeVisible();
    await expect(page.getByText("选择不存在或为空的目标目录；命令默认执行 dry-run，不写入目标。")).toBeVisible();
    await expect(page.getByText("网页不提供原址覆盖恢复；非空目标会被拒绝。")).toBeVisible();
    await expect(page.getByRole("button", { name: "恢复", exact: true })).toHaveCount(0);
    await page.getByTestId("locale-switcher").selectOption("en-US");
    await expect(page.getByRole("heading", { name: "Backup and disaster recovery" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Backup center", exact: true })).toBeVisible();
  });
});
