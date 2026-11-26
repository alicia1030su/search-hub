import { expect, test, type Download, type Page } from "@playwright/test";

const PASSWORD = "E2E-Local-Only-Password-1";
const CANARY = "V0116-UPSTREAM-RAW-CANARY-7f3c9d";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

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
    await page.getByRole("button", { name: "创建管理员并进入", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "仪表盘", exact: true })).toBeVisible({ timeout: 20_000 });
}

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("download stream was unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test.describe("v0.1.16 Lab raw-data privacy", () => {
  function rawCanaryResult() {
    return {
      id: "result-local",
      title: "Local safe result",
      url: "https://example.test/result",
      snippet: "local stub",
      provider: "prv_mock",
      providerType: "mock",
      providerName: "Local mock",
      sources: [],
      retrievedAt: "2026-01-01T00:00:00.000Z",
      score: 1,
      metadata: { raw: CANARY },
    };
  }

  function rawCanaryResponse(taskId: string) {
    const result = rawCanaryResult();
    return {
      taskId,
      query: "lab privacy",
      mode: "rrf",
      status: "completed",
      results: [result],
      errors: [],
      stats: {
        rawCount: 1,
        dedupedCount: 1,
        fusedCount: 1,
        providers: [],
        rerankApplied: false,
        embeddingApplied: false,
        summaryApplied: false,
        partial: false,
        degraded: false,
        timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 },
      },
      debug: {
        perProviderResults: [{
          providerId: "prv_mock",
          providerName: "Local mock",
          results: [{ ...result, metadata: { raw: CANARY } }],
        }],
      },
    };
  }

  async function stubLabBase(page: Page): Promise<void> {
    await page.route("**/api/admin/providers", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          providers: [{ id: "prv_mock", name: "Local mock", type: "mock", enabled: true }],
          status: [],
        }),
      });
    });
    await page.route("**/api/admin/models", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
  }

  test("does not request or export upstream raw canaries by default", async ({ page }) => {
    let searchRequest: Record<string, unknown> | undefined;
    await stubLabBase(page);
    await page.route("**/api/search", async (route) => {
      searchRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rawCanaryResponse("task-lab-privacy")),
      });
    });

    await completeSetup(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    await expect(page.getByText("Local mock", { exact: true })).toBeVisible();
    await page.locator("#lab-query").fill("lab privacy");
    await page.getByRole("button", { name: "运行搜索", exact: true }).click();
    await expect(page.getByRole("link", { name: "Local safe result", exact: true }).first()).toBeVisible();

    expect.soft(searchRequest?.includeRaw, "Lab must default includeRaw to false").toBe(false);
    await expect.soft(page.getByText(CANARY, { exact: false })).toHaveCount(0);

    await page.getByRole("button", { name: "复制 JSON", exact: true }).click();
    const clipboard = await page.evaluate(() =>
      (navigator as Navigator & { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
    );
    expect.soft(clipboard, "clipboard JSON must not contain the raw canary").not.toContain(CANARY);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 JSON", exact: true }).click();
    const exported = await downloadText(await downloadPromise);
    expect.soft(exported, "downloaded JSON must not contain the raw canary").not.toContain(CANARY);
  });

  test("strips raw canaries from UI and exports when includeRaw is explicitly enabled", async ({ page }) => {
    let searchRequest: Record<string, unknown> | undefined;
    await stubLabBase(page);
    await page.route("**/api/search", async (route) => {
      searchRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rawCanaryResponse("task-lab-explicit-raw")),
      });
    });
    await page.route("**/api/search/tasks/task-lab-history", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "task-lab-history",
          status: "completed",
          response: rawCanaryResponse("task-lab-history"),
        }),
      });
    });

    await completeSetup(page);
    await page.getByRole("link", { name: "搜索实验室", exact: true }).click();
    await expect(page.getByText("Local mock", { exact: true })).toBeVisible();
    await page.getByText("高级参数", { exact: true }).click();
    await page.getByLabel(/includeRaw/).check();
    await page.locator("#lab-query").fill("lab privacy");
    await page.getByRole("button", { name: "运行搜索", exact: true }).click();
    await expect(page.getByRole("link", { name: "Local safe result", exact: true }).first()).toBeVisible();

    expect.soft(searchRequest?.includeRaw, "explicit opt-in must send includeRaw=true").toBe(true);
    await expect.soft(page.getByText(CANARY, { exact: false })).toHaveCount(0);

    await page.getByRole("button", { name: "复制 JSON", exact: true }).click();
    const clipboard = await page.evaluate(() =>
      (navigator as Navigator & { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
    );
    expect.soft(clipboard, "clipboard JSON must strip raw metadata even after opt-in").not.toContain(CANARY);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 JSON", exact: true }).click();
    const exported = await downloadText(await downloadPromise);
    expect.soft(exported, "downloaded JSON must strip raw metadata even after opt-in").not.toContain(CANARY);

    await page.getByLabel("任务 ID").fill("task-lab-history");
    await page.getByRole("button", { name: "查询任务", exact: true }).click();
    await expect(page.getByText("task-lab-history", { exact: true }).first()).toBeVisible();
    const previewTexts = await page.locator("details pre").allTextContents();
    expect.soft(
      previewTexts.join("\n"),
      "loaded task JsonPreview must strip raw metadata",
    ).not.toContain(CANARY);
  });
});

test.describe("v0.1.16 backup loading semantics", () => {
  test("shows unknown rather than zero while backup status is loading", async ({ page }) => {
    let releaseStatus: (() => void) | undefined;
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    await page.route("**/api/admin/backups/status", async (route) => {
      await statusGate;
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

    const databaseValue = page.getByText("数据库", { exact: true }).locator("..").locator("p").nth(1);
    const walValue = page.getByText("WAL", { exact: true }).locator("..").locator("p").nth(1);
    try {
      await completeSetup(page);
      await page.getByRole("link", { name: "备份中心", exact: true }).click();
      await expect(page.getByRole("heading", { name: "备份与灾备", exact: true })).toBeVisible();
      await expect(databaseValue).toBeVisible();
      await expect(walValue).toBeVisible();

      expect.soft(await databaseValue.textContent(), "unknown database size must not be displayed as zero").toBe("—");
      expect.soft(await walValue.textContent(), "unknown WAL size must not be displayed as zero").toBe("—");
    } finally {
      releaseStatus?.();
    }

    await expect(databaseValue).toHaveText("1.0 KiB");
    await expect(walValue).toHaveText("0 B");
  });
});
