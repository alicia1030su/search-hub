import { expect, test, type Page } from "@playwright/test";

const EMAIL = "admin@example.com";
/**
 * Fixed, test-only password for the throwaway database created by
 * `tests/scripts/e2e-server.mjs`. It must be stable across the whole run:
 * Playwright restarts the worker after a failure, which re-evaluates the module,
 * and a freshly randomised password would then no longer match the admin that
 * the first test created. This credential only exists in `.data/e2e`, which is
 * deleted at the start of every run.
 */
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
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

/**
 * The suite logs in once per test. The default login throttle is 10/min and
 * applies per IP, so a longer run would start failing on the throttle rather
 * than on the behaviour under test. Raise it for this test database only.
 */
async function raiseLoginThrottle(page: Page): Promise<void> {
  const csrf = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { csrfToken?: string };
    return data.csrfToken ?? null;
  });
  if (!csrf) throw new Error("no CSRF token after setup");
  const status = await page.evaluate(
    async (token) => {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": token },
        body: JSON.stringify({ security: { loginRateLimitPerMin: 100 } }),
      });
      return response.status;
    },
    csrf,
  );
  if (status !== 200) throw new Error(`raising login throttle failed with HTTP ${status}`);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.waitForTimeout(150);
  if (!page.url().endsWith("/login")) {
    throw new Error(`login redirected to ${page.url()}`);
  }
  try {
    await page.locator("#login-email").waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    const body = await page.locator("body").innerText().catch(() => "");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    throw new Error(`login form missing; url=${page.url()} body=${body.slice(0, 160)}`);
  }
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
    await raiseLoginThrottle(page);

    // 1. Dashboard shows real metrics (zero state, not fake numbers).
    await expect(page.getByText("搜索总数")).toBeVisible();
    await expect(page.getByText("成功率", { exact: true })).toBeVisible();
    await expect(page.getByText("当前时间范围内没有搜索记录。")).toBeVisible();

    // 2. Providers: add two real mock providers through the UI.
    await page.goto("/providers");
    await expect(page.getByRole("heading", { name: "搜索源", exact: true })).toBeVisible();
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

  test("搜索源市场把没有适配器的条目标注清楚", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    // The catalog now lives behind the marketplace tab.
    await page.getByRole("button", { name: "搜索源市场", exact: true }).click();
    // Every provider that ships an adapter has one; the entries that do not are
    // labelled instead of pretending to be usable. After MiniMax and 秘塔 gained
    // adapters, `baidu` is the remaining "no official API" entry.
    await expect(page.getByText("无官方接口").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("支持 30 源", { exact: false })).toHaveCount(0);
  });
  test("v0.1.4 按服务商渲染字段，创建时保存凭证并在编辑时显式轮换", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "新增搜索源" }).first().click();

    await page.locator("#provider-name").fill("e2e-v014");
    await page.locator("#provider-type").selectOption("deepseek-search");
    await expect(page.getByText("该服务商需要额外参数")).toBeVisible();
    await expect(page.locator("#provider-base")).toHaveValue("https://api.deepseek.com");

    await page.locator("input[type=password]").first().fill("sk-e2e-secret-value-123456");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("e2e-v014", { exact: false }).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });

    // The credential was saved with the provider, and is masked.
    const row = page.locator("tr", { hasText: "e2e-v014" }).first();
    await row.getByRole("button", { name: "Key" }).click();
    await expect(page.getByText("主凭证")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("sk-e2e-secret-value-123456");
    await page.keyboard.press("Escape");

    // Edit without action keeps exactly one key.
    await row.getByRole("button", { name: "编辑" }).click();
    await expect(page.getByText("凭证操作")).toBeVisible();
    await expect(page.getByLabel("保持不变（不新增 Key）")).toBeChecked();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("e2e-v014", { exact: false }).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });

    // Explicit rotation adds a second key.
    await page.locator("tr", { hasText: "e2e-v014" }).first().getByRole("button", { name: "编辑" }).click();
    await page.getByLabel("新增一个 Key（可用于轮换）").check();
    await page.locator("input[type=password]").first().fill("sk-e2e-rotated-value-654321");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("e2e-v014", { exact: false }).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });

    await page.locator("tr", { hasText: "e2e-v014" }).first().getByRole("button", { name: "Key" }).click();
    await expect(page.getByText("轮换凭证")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("sk-e2e-rotated-value-654321");
  });

  test("v0.1.4 切换服务商重置 Base URL 与已填凭证", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "新增搜索源" }).first().click();

    await page.locator("#provider-name").fill("e2e-switch");
    await page.locator("#provider-type").selectOption("deepseek-search");
    await page.locator("input[type=password]").first().fill("sk-e2e-switch-value-0002");
    await page.locator("#provider-type").selectOption("doubao");
    await expect(page.getByText("切换服务商会重置配置")).toBeVisible();
    await page.getByRole("button", { name: "切换到新服务商" }).click();

    await expect(page.locator("#provider-base")).toHaveValue("https://open.feedcoopapi.com");
    await expect(page.locator("input[type=password]").first()).toHaveValue("");
  });

  test("v0.1.4 腾讯元宝必须成对凭证", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "新增搜索源" }).first().click();

    await page.locator("#provider-name").fill("e2e-tencent");
    await page.locator("#provider-type").selectOption("tencent-yuanbao");
    await expect(page.locator("#provider-base")).toHaveValue("https://wsa.tencentcloudapi.com");

    // SecretId only: the pair is incomplete and must not save.
    await page.locator("#field-secretId").fill("test-secret-id-only");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("请填写该服务商要求的凭证字段。")).toBeVisible();

    await page.locator("#field-secretKey").fill("test-secret-key-only");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByText("e2e-tencent", { exact: false }).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  });
  test("v0.1.4 账户级额度配置可保存并回显", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "新增搜索源" }).first().click();

    await page.locator("#provider-name").fill("e2e-account-group");
    await page.locator("#provider-type").selectOption("bailian");
    await page.locator("#provider-base").fill("https://workspace.cn-beijing.maas.aliyuncs.com");
    await page.locator("#field-model").fill("qwen-plus");
    await page.locator("input[type=password]").first().fill("sk-e2e-account-value-0003");
    // Account-level budget lives under the collapsible advanced section.
    await page.getByRole("switch", { name: "高级设置（请求调度、账户额度、适配器配置）" }).click();
    await page.locator("#provider-account-group").fill("bailian-main");
    await page.locator("#provider-account-rpm").fill("30");
    await page.getByRole("button", { name: "保存", exact: true }).click();

    await expect(page.getByText("e2e-account-group", { exact: false }).filter({ visible: true }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Re-open and confirm the values round-tripped through the API.
    await page.locator("tr", { hasText: "e2e-account-group" }).first().getByRole("button", { name: "编辑" }).click();
    await expect(page.locator("#provider-account-group")).toHaveValue("bailian-main");
    await expect(page.locator("#provider-account-rpm")).toHaveValue("30");
  });

  test("v0.1.4 实验台分别展示检索结果与联网状态", async ({ page }) => {
    await login(page);
    // A mock provider proves the "raw result" half; a grounded provider with no
    // key proves the warning half. The answer card must never render as a page.
    await page.goto("/lab");
    await expect(page.getByRole("heading", { name: "搜索实验室" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("已触发联网");
    await expect(page.locator("body")).not.toContainText("无可验证来源");
  });


  test("v0.1.4 市场批量添加多个源", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "搜索源市场", exact: true }).click();

    await page.getByLabel("arXiv 选择").check();
    await page.getByLabel("GitHub 搜索 选择").check();
    await expect(page.getByText("已选 2 个")).toBeVisible();
    await page.getByRole("button", { name: "添加所选" }).click();

    await expect(page.getByText("arxiv", { exact: false }).filter({ visible: true }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("github", { exact: false }).filter({ visible: true }).first()).toBeVisible();
  });

  test("v0.1.4 批量启用跳过未配置凭证的源并说明原因", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "搜索源市场", exact: true }).click();
    await page.getByLabel("Exa 选择").check();
    await page.getByRole("button", { name: "添加所选" }).click();
    await expect(page.getByText("exa", { exact: false }).filter({ visible: true }).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByLabel("全选搜索源").check();
    await page.getByRole("button", { name: "批量启用" }).click();
    // The refusal states why instead of silently doing nothing.
    await expect(page.getByText("no credential configured", { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("v0.1.4 搜索参数由 Manifest 驱动", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "搜索源市场", exact: true }).click();
    await page.getByRole("button", { name: "添加此搜索源" }).first().click();

    await page.locator("#provider-type").selectOption("brave");
    await expect(page.getByText("搜索参数（按厂商能力）")).toBeVisible();
    await expect(page.locator("#provider-max-pages")).toBeVisible();

    // Exa has no pagination, so the page controls must disappear. Switching may
    // ask for confirmation because the previous type had defaults filled in.
    await page.locator("#provider-type").selectOption("exa");
    if (await page.getByText("切换服务商会重置配置").count()) {
      await page.getByRole("button", { name: "切换到新服务商" }).click();
    }
    await expect(page.locator("#provider-max-pages")).toHaveCount(0);
    await expect(page.getByText("该厂商不支持分页", { exact: false })).toBeVisible();
  });
  test("v0.1.4 一键添加全部不会额外启用任何实例", async ({ page }) => {
    await login(page);
    await page.goto("/providers");

    // Earlier cases deliberately enable a few instances, so the assertion is
    // relative: a bulk install must not change the enabled count at all.
    // Wait for the table first, otherwise the "before" count is read while the
    // list is still loading and is always zero.
    await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 20_000 });
    const enabledSwitches = page.locator('tr [role="switch"][aria-checked="true"]');
    const enabledBefore = await enabledSwitches.count();

    await page.getByRole("button", { name: "搜索源市场", exact: true }).click();
    await page.getByRole("button", { name: "一键添加全部已实现" }).click();
    await expect(page.getByText("已添加", { exact: false }).first()).toBeVisible({ timeout: 25_000 });

    await expect(enabledSwitches).toHaveCount(enabledBefore, { timeout: 20_000 });
  });

  test("v0.1.4 一键禁用全部搜索源", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "搜索源市场", exact: true }).click();
    await page.getByRole("button", { name: "全部禁用" }).click();
    await expect(page.getByText("已禁用", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  });

  test("v0.1.4 删除一个实例不影响其他实例", async ({ page }) => {
    await login(page);
    await page.goto("/providers");

    // Count instances of one provider type by name prefix; the providers table
    // is the only one that lists them under "我的搜索源".
    const providerRows = page.locator("tbody tr");
    const arxivRows = providerRows.filter({ hasText: "arXiv" });

    // Baseline must be read *after* the list has loaded: sampling it straight
    // after goto raced the fetch and produced a wrong baseline (the source of the
    // CI flake). Wait for either rows or the empty state, then count.
    await expect
      .poll(async () => (await arxivRows.count()) + (await page.getByText("还没有配置搜索源").count()), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const before = await arxivRows.count();

    await page.getByRole("button", { name: "搜索源市场", exact: true }).click();
    await page.getByLabel("arXiv 选择").check();
    await page.getByRole("button", { name: "添加所选" }).click();
    await expect(page.getByText("已添加 1 个搜索源", { exact: false }).first()).toBeVisible({ timeout: 20_000 });

    await expect(arxivRows).toHaveCount(before + 1, { timeout: 20_000 });

    // Delete exactly the instance just added: the newest one sits last.
    await arxivRows.last().getByRole("button", { name: /删除/ }).click();
    // Scope the confirmation to the dialog: the table also has per-row delete
    // buttons with the same label.
    const dialog = page.getByRole("dialog").filter({ hasText: "删除" }).last();
    await dialog.getByRole("button", { name: "删除", exact: true }).click();

    await expect(arxivRows).toHaveCount(before, { timeout: 20_000 });
    // Any instance that existed before the add must still be there: the delete
    // was scoped to the one row, not to the provider type.
    if (before > 0) {
      await expect(arxivRows.first()).toBeVisible();
    }
  });

  test("v0.1.7 语言切换覆盖全站并在刷新后保持", async ({ page }) => {
    // The shared E2E database is set up once by the first test in this file, so
    // this one signs in rather than trying to run setup again.
    await login(page);

    // Default is Chinese: assert copy that only exists in the zh dictionary.
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible();
    const switcher = page.getByTestId("locale-switcher");
    await expect(switcher).toHaveValue("zh-CN");

    // Switch to English and verify several *different* pages, not just the nav:
    // a dictionary that only covers the sidebar would pass a nav-only check.
    await switcher.selectOption("en-US");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sources" })).toBeVisible();

    await page.goto("/providers");
    await expect(page.getByRole("heading", { name: "Search sources", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add source" })).toBeVisible();

    await page.goto("/lab");
    await expect(page.getByRole("heading", { name: "Search lab" })).toBeVisible();
    await expect(page.getByLabel("Query")).toBeVisible();

    await page.goto("/integrations");
    await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: true }).first()).toBeVisible();
    await expect(page.getByText("Search cache")).toBeVisible();

    // No Chinese left in the page content. Scoped to <main> on purpose: the
    // header legitimately contains the locale's own name ("简体中文") and the
    // administrator's display name, neither of which is UI copy. Everything a
    // user reads to operate this page lives in <main>.
    const cjk = /[\u4e00-\u9fff]/;
    expect(mainText, `Chinese text still visible in /settings: ${mainText.slice(0, 300)}`).not.toMatch(cjk);

    // Persistence: a real reload keeps English.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings", exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("locale-switcher")).toHaveValue("en-US");

    // And switching back restores Chinese, including after another reload.
    await page.getByTestId("locale-switcher").selectOption("zh-CN");
    await expect(page.getByRole("heading", { name: "设置", exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "设置", exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("locale-switcher")).toHaveValue("zh-CN");
  });

  test("v0.1.8 搜索质量实验室可用，并诚实标注合成基准", async ({ page }) => {
    await login(page);

    await page.goto("/quality");
    await expect(page.getByRole("heading", { name: "搜索质量评测实验室" })).toBeVisible();

    // The seeded fixture is selectable and its synthetic origin is stated on the
    // page, not just in the docs: a score from it must never be read as a
    // measurement of a real vendor.
    await expect(page.getByText("合成基准").first()).toBeVisible();
    await expect(page.getByText(/不能当作任何真实厂商的搜索准确率/)).toBeVisible();

    // Freeze state and counts come from the API, so their presence proves the
    // dataset endpoint answered rather than the page rendering placeholders.
    await expect(page.getByText(/v1/).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "实验" })).toBeVisible();

    await page.getByRole("tab", { name: "实验" }).click();
    // Offline is the default and the only mode that cannot spend money.
    await expect(page.getByTestId("quality-run-mode")).toHaveValue("offline");
    await expect(page.getByRole("button", { name: "开始实验" })).toBeVisible();

    // English mode must not leave Chinese copy behind on this page either.
    await page.getByTestId("locale-switcher").selectOption("en-US");
    await page.goto("/quality");
    await expect(page.getByRole("heading", { name: "Search quality evaluation lab" })).toBeVisible();
    // Dataset content is not UI copy: a fixture may legitimately hold a Chinese
    // query while the interface is in English. Scope the check to the chrome a
    // user operates — headings, buttons, tabs and labels.
    const chrome = await page
      .locator("main h1, main h2, main h3, main button, main [role=tab], main label")
      .allInnerTexts();
    expect(chrome.join(" | ")).not.toMatch(/[\u4e00-\u9fff]/);
    await page.getByTestId("locale-switcher").selectOption("zh-CN");
  });

  test("v0.1.4 深色主题下搜索源页仍可读", async ({ page }) => {
    await login(page);
    await page.goto("/providers");
    await page.getByRole("button", { name: "切换主题" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("heading", { name: "搜索源", exact: true }).first()).toBeVisible();
    // Text must not be invisible: dark mode has its own foreground colour.
    const classList = await page.locator("html").getAttribute("class");
    expect(classList).toContain("dark");
    const color = await page
      .getByRole("heading", { name: "搜索源", exact: true })
      .first()
      .evaluate((node) => {
        const element = node as unknown as {
          ownerDocument?: { defaultView?: { getComputedStyle: (target: unknown) => { color: string } } };
        };
        const view = element.ownerDocument?.defaultView;
        return view ? view.getComputedStyle(node).color : "";
      });
    expect(color).toBeTruthy();
  });
});
