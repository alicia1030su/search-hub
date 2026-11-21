import { expect, test, type Page } from "@playwright/test";
import { deleteProvidersByNamePrefix, pinBatchScope } from "./support";

const EMAIL = "admin@example.com";
/** Test-only password for the throwaway database created by `e2e-server.mjs`. */
const PASSWORD = "E2E-Local-Only-Password-1";

/**
 * Bulk provider test — T25–T30.
 *
 * The suite drives the **real** page against a **real** API. There is no vendor
 * traffic: every source it creates is the `mock` adapter, which answers inside
 * the process and never opens a socket. That is what makes it safe to leave the
 * paid switch on for the `paidRisk` case.
 *
 * The assertions are about what an operator would conclude from the screen —
 * "which sources can be tested", "is this run really finished", "does retrying
 * the failures include the throttled one" — because each of those is a place
 * where a plausible-looking implementation tells a lie.
 */

/**
 * Signs in, running first-time setup when this file is the first to run.
 *
 * `admin.spec.ts` normally creates the administrator, but a targeted run
 * (`pnpm test:e2e -- provider-batch`) starts from an empty database, so this
 * helper has to handle both states instead of assuming an order between files.
 */
async function ensureSignedIn(page: Page): Promise<void> {
  await page.goto("/");
  // The SPA decides client-side whether to render the login form, the setup form
  // or the dashboard. Waiting for one of the forms first removes the race
  // between the URL check below and the first paint — a fresh browser context
  // has no session yet, so `/` legitimately renders as `/login` a moment later.
  await page
    .locator("#login-email, #setup-token")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  if (page.url().includes("/setup") || (await page.locator("#setup-token").isVisible().catch(() => false))) {
    await page.locator("#setup-token").fill("e2e-setup-token");
    await page.locator("#setup-email").fill(EMAIL);
    await page.locator("#setup-name").fill("管理员");
    await page.locator("#setup-password").fill(PASSWORD);
    await page.locator("#setup-confirm").fill(PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
    return;
  }

  if (page.url().endsWith("/login") || (await page.locator("#login-email").isVisible().catch(() => false))) {
    await page.locator("#login-email").fill(EMAIL);
    await page.locator("#login-password").fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
    return;
  }

  // Already authenticated (setup ran earlier in this worker).
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

/** Calls an admin API from inside the page, carrying the session and CSRF token. */
async function callAdminApi(
  page: Page,
  path: string,
  init: { method: string; body?: unknown },
): Promise<number> {
  return page.evaluate(
    async (args) => {
      const session = await fetch("/api/auth/session", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const csrf = session.ok ? ((await session.json()) as { csrfToken?: string }).csrfToken : undefined;
      const response = await fetch(args.path, {
        method: args.method,
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      });
      return response.status;
    },
    { path, method: init.method, body: init.body },
  );
}

/**
 * Creates a `mock` provider through the UI.
 *
 * The UI path is used rather than the API so the test also proves the form still
 * accepts the adapter config — a broken form would otherwise be invisible to
 * this suite.
 */
async function addMockProvider(
  page: Page,
  name: string,
  config: Record<string, unknown>,
): Promise<void> {
  await page.getByRole("button", { name: "新增搜索源" }).first().click();
  await page.locator("#provider-name").fill(name);
  await page.locator("#provider-type").selectOption("mock");
  await page.getByLabel("适配器配置（JSON）").fill(JSON.stringify(config, null, 2));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(name, { exact: false }).filter({ visible: true }).first()).toBeVisible({
    timeout: 20_000,
  });
}

async function gotoHealthTab(page: Page): Promise<void> {
  await page.goto("/providers");
  // The tab's accessible name carries a healthy/total suffix ("健康监控 0/53"),
  // so it is addressed by a stable test id rather than by an exact label.
  await page.getByTestId("providers-tab-health").click();
  await expect(page.getByTestId("health-test-all")).toBeVisible({ timeout: 20_000 });
}

/** Opens the pre-flight dialog through the primary entry point. */
async function openPreview(page: Page, kind: "connect" | "search"): Promise<void> {
  await page
    .getByTestId(kind === "search" ? "health-test-all" : "health-test-all-connect")
    .click();
  await expect(page.getByTestId("batch-preview")).toBeVisible();
}

async function setTaskKeyless(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.getByTestId("batch-include-keyless").getByRole("switch");
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
}

/** Reads the rows of the result table, in render order. */
async function rowStates(page: Page): Promise<string[]> {
  const rows = page.locator('[data-testid^="batch-row-"]');
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-state") ?? ""),
  );
}

test.describe("搜索源批量体检", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test.afterEach(async ({ page }) => {
    await deleteProvidersByNamePrefix(page, "e2e-batch-");
  });

  /**
   * T25 — the confirmation dialog states the scope, the six counts, the budget
   * and whether money is at stake.
   *
   * Both halves of `paidRisk` are asserted: a connectivity run must never warn
   * about a cost it cannot incur, and a paid run with the switch on must warn.
   */
  test("T25 预检框显示 6 行计数与预算，付费提示按 kind 出现", async ({ page }) => {
    // A keyed source and a disabled one, so at least two buckets are non-zero.
    await page.goto("/providers");
    await addMockProvider(page, "e2e-batch-t25-a", { resultCount: 3, latencyMs: 20, namespace: "t25a" });
    await addMockProvider(page, "e2e-batch-t25-b", { resultCount: 2, latencyMs: 20, namespace: "t25b" });

    await gotoHealthTab(page);
    await openPreview(page, "connect");

    // Six count rows, each present by name and readable as a number.
    for (const id of ["count-eligible", "count-nokey", "count-config-error", "count-disabled", "count-keyless", "count-cooling"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    // The scope is stated explicitly so the counts have a denominator.
    await expect(page.getByTestId("batch-scope-total")).toContainText("范围内共");
    await expect(page.getByTestId("batch-budget")).toBeVisible();
    await expect(page.getByTestId("batch-budget-remaining")).toContainText("今日剩余");

    // Connectivity: no paid risk, ever.
    await expect(page.getByTestId("batch-paid-risk-off")).toBeVisible();
    await expect(page.getByTestId("batch-paid-risk")).toHaveCount(0);

    // Close before reopening: the second preview is a different `kind`, and a
    // dialog left open would swallow the entry-button click.
    await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
    await expect(page.getByTestId("batch-preview")).toHaveCount(0);

    // Now a paid run with the switch on: the warning must appear, with a count.
    const enabled = await callAdminApi(page, "/api/admin/settings", {
      method: "PUT",
      body: { health: { paidProbesEnabled: true, maxRequestsPerRun: 10, maxRequestsPerDay: 50 } },
    });
    expect(enabled).toBe(200);
    // 付费风险只属于真正需要凭据的源；mock 始终是匿名的。
    expect(
      await callAdminApi(page, "/api/admin/providers", {
        method: "POST",
        body: { name: "e2e-batch-t25-keyed", type: "brave", baseUrl: "http://127.0.0.1:9", enabled: true },
      }),
    ).toBe(200);
    const keyedId = await page.evaluate(async () => {
      const response = await fetch("/api/admin/providers", { credentials: "include" });
      const body = (await response.json()) as { providers: Array<{ id: string; name: string }> };
      return body.providers.find((item) => item.name === "e2e-batch-t25-keyed")?.id ?? null;
    });
    expect(keyedId).not.toBeNull();
    expect(
      await callAdminApi(page, `/api/admin/providers/${keyedId}/keys`, {
        method: "POST",
        body: { label: "e2e", key: "sk-E2E-BATCH-T25-0000000000", weight: 100, enabled: true },
      }),
    ).toBe(200);

    await openPreview(page, "search");
    await expect(page.getByTestId("batch-paid-risk")).toBeVisible();
    await expect(page.getByTestId("batch-paid-risk")).toContainText("预计");
    // With the switch on and eligible sources present, the start button is live.
    await expect(page.getByTestId("batch-start")).toBeEnabled();
    await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
    const removed = await page.evaluate(async (id) => {
      const session = await fetch("/api/auth/session", { credentials: "include" });
      const csrf = session.ok ? ((await session.json()) as { csrfToken?: string }).csrfToken : undefined;
      const response = await fetch(`/api/admin/providers/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers: csrf ? { "x-csrf-token": csrf } : {},
      });
      return { status: response.status, body: await response.text() };
    }, keyedId);
    expect(removed.status, removed.body).toBe(200);
    expect(
      await callAdminApi(page, "/api/admin/settings", {
        method: "PUT",
        body: { health: { paidProbesEnabled: false } },
      }),
    ).toBe(200);
  });

  /**
   * T26 — a cancelled run keeps what it already learned.
   *
   * The point of interest is not "did it cancel" but "did the table keep the
   * finished rows": a cancel that wipes the table makes the operator rerun
   * everything, which is exactly the cost the feature exists to avoid.
   */
  test("T26 确认→进度可见→取消→结果表仍保留已完成行", async ({ page }) => {
    await page.goto("/providers");
    // Slow enough that one row finishes before the cancel lands.
    for (let index = 1; index <= 4; index += 1) {
      await addMockProvider(page, `e2e-batch-t26-${index}`, {
        resultCount: 2,
        latencyMs: 400,
        namespace: `t26-${index}`,
      });
    }

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await page.getByTestId("batch-start").click();

    // Progress is visible, and it is labelled as running rather than finished.
    await expect(page.getByTestId("batch-progress")).toBeVisible();
    await expect(page.getByTestId("batch-progress-status")).toContainText("进行中");
    await expect(page.getByTestId("batch-progress-bar")).toBeVisible();

    // Wait for at least one finished item before cancelling, otherwise the
    // assertion below would be vacuous.
    await expect(page.getByTestId("batch-progress-counts")).toContainText(/成功 [1-9]/, { timeout: 30_000 });
    await page.getByTestId("batch-cancel").click();

    // A cancelled run lands on the results table with a "partially complete"
    // label — never "all done", even though every row it shows is a conclusion.
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 30_000 });
    const status = await page.getByTestId("batch-result-status").innerText();
    expect(status).toMatch(/部分完成|已完成/);
    expect(status).not.toBe("全部完成");
    const finished = page.locator('[data-testid^="batch-row-"][data-state="ok"]');
    await expect(finished.first()).toBeVisible();
    expect(await finished.count()).toBeGreaterThanOrEqual(1);

    // The cancelled remainder is shown as skipped, not as a failure.
    const rowCount = await page.locator('[data-testid^="batch-row-"]').count();
    expect(rowCount).toBeGreaterThanOrEqual(4);
    const counts = await page.getByTestId("batch-result-counts").innerText();
    expect(counts).toContain("跳过");
  });

  /**
   * T27 — severity order: failed → restricted → pending → ok → skipped.
   *
   * Four different failure kinds plus a disabled source, because a sort that
   * only knows "ok vs not ok" passes a two-state test and fails this one.
   */
  test("T27 结果表按失败→受限→待确认→成功→跳过排序", async ({ page }) => {
    await page.goto("/providers");
    await addMockProvider(page, "e2e-batch-t27-ok", { resultCount: 4, latencyMs: 10, namespace: "t27ok" });
    await addMockProvider(page, "e2e-batch-t27-failed", { latencyMs: 10, failMode: "server_error" });
    await addMockProvider(page, "e2e-batch-t27-limited", { latencyMs: 10, failMode: "rate_limited" });
    await addMockProvider(page, "e2e-batch-t27-pending", { resultCount: 0, latencyMs: 10, namespace: "t27p" });
    await addMockProvider(page, "e2e-batch-t27-off", { resultCount: 2, latencyMs: 10, namespace: "t27off" });

    // Disable the last one so it is skipped rather than probed.
    const disabled = await callAdminApi(page, "/api/admin/providers", { method: "GET" });
    expect(disabled).toBe(200);
    const target = await page.evaluate(async () => {
      const response = await fetch("/api/admin/providers", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const body = (await response.json()) as { providers: Array<{ id: string; name: string }> };
      return body.providers.find((item) => item.name === "e2e-batch-t27-off")?.id ?? null;
    });
    expect(target).not.toBeNull();
    expect(await callAdminApi(page, `/api/admin/providers/${target}`, { method: "PATCH", body: { enabled: false } })).toBe(200);

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });

    const states = await rowStates(page);
    expect(states.length).toBeGreaterThanOrEqual(5);
    // Strictly non-decreasing severity: the exact multiset is asserted by the
    // group boundaries below, so an implementation that only sorts "ok last"
    // cannot pass this.
    const rank: Record<string, number> = {
      failed: 0,
      restricted: 1,
      pending: 2,
      ok: 3,
      skipped: 4,
      unknown: 5,
    };
    const ranks = states.map((state) => rank[state] ?? 9);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(states)).toEqual(new Set(["failed", "restricted", "pending", "ok", "skipped"]));
  });

  /**
   * T28 — "retry the failures" submits exactly the failure set.
   *
   * The throttled source is deliberately *not* in that set: retrying a rate
   * limit immediately fails again and spends another request. The assertion is
   * on the request body, not on the UI, because the body is what the server acts
   * on — a button that "looks right" and posts the whole scope would still cost
   * money.
   */
  test("T28 只重测失败项时请求体恰好是失败集合", async ({ page }) => {
    await page.goto("/providers");
    await addMockProvider(page, "e2e-batch-t28-ok", { resultCount: 3, latencyMs: 10, namespace: "t28ok" });
    await addMockProvider(page, "e2e-batch-t28-fail", { latencyMs: 10, failMode: "server_error" });
    await addMockProvider(page, "e2e-batch-t28-limited", { latencyMs: 10, failMode: "rate_limited" });

    const ids = await page.evaluate(async () => {
      const response = await fetch("/api/admin/providers", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const body = (await response.json()) as { providers: Array<{ id: string; name: string }> };
      const find = (name: string) => body.providers.find((item) => item.name === name)?.id ?? null;
      return {
        failed: find("e2e-batch-t28-fail"),
        limited: find("e2e-batch-t28-limited"),
        ok: find("e2e-batch-t28-ok"),
      };
    });
    expect(ids.failed).not.toBeNull();
    expect(ids.limited).not.toBeNull();
    if (ids.failed === null || ids.limited === null || ids.ok === null) {
      throw new Error("T28 fixtures were not created");
    }

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await pinBatchScope(page, [ids.failed, ids.limited, ids.ok]);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });

    // Capture the retry request instead of letting it run: the body is the
    // subject under test, and a second real run would only add noise.
    let posted: { kind?: string; providerIds?: string[] } | null = null;
    await page.route("**/api/admin/provider-health/batch-test", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posted = route.request().postDataJSON() as { kind?: string; providerIds?: string[] };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "bt_intercepted", status: "running", total: 1, concurrency: 1 }),
      });
    });

    await page.getByTestId("batch-retry-failed").click();
    await expect.poll(() => posted).not.toBeNull();

    const body = posted as unknown as { kind: string; providerIds: string[] };
    expect(body.providerIds).toEqual([ids.failed]);
    // The throttled source is restricted, not failed: it must not be in the set.
    expect(body.providerIds).not.toContain(ids.limited);
    expect(body.providerIds).not.toContain(ids.ok);
    expect(body.providerIds).toHaveLength(1);
  });

  /**
   * T29 — the detail drawer.
   *
   * 非必需 Key 的源按匿名路径探测，即使池里存了 Key 也不能泄露或假装使用；
   * 样例仍最多三条，未发请求时 requests 必须显示 em dash 而不是 0。
   */
  test("T29 可选 Key 不被匿名探测使用，样例最多 3 条且 requests 缺失显示 —", async ({ page }) => {
    await page.goto("/providers");
    await addMockProvider(page, "e2e-batch-t29", { resultCount: 6, latencyMs: 10, namespace: "t29" });

    // mock 不需要凭据；可选 Key 池存在也不能让匿名探测自动使用它。
    const providerId = await page.evaluate(async () => {
      const list = await fetch("/api/admin/providers", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const body = (await list.json()) as { providers: Array<{ id: string; name: string }> };
      return body.providers.find((item) => item.name === "e2e-batch-t29")?.id ?? null;
    });
    expect(providerId).not.toBeNull();
    expect(
      await callAdminApi(page, `/api/admin/providers/${providerId}/keys`, {
        method: "POST",
        body: { label: "e2e", key: "sk-E2E-BATCH-T29-PLAINTEXT-000000", weight: 100, enabled: true },
      }),
    ).toBe(200);

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });

    await page.getByTestId(`batch-detail-${providerId}`).click();
    const drawer = page.getByTestId("batch-detail");
    await expect(drawer).toBeVisible();

    // 匿名探测没有 keyId，抽屉必须明确说“未使用凭证”。
    const keyLabel = page.getByTestId("batch-detail-key");
    await expect(keyLabel).toBeVisible();
    await expect(keyLabel).toHaveText("—");
    // No credential material anywhere in the drawer.
    await expect(drawer).not.toContainText("sk-E2E-BATCH-T29-PLAINTEXT-000000");
    await expect(page.locator("body")).not.toContainText("sk-E2E-BATCH-T29-PLAINTEXT-000000");

    // At most three samples, and they are the probe's own rows.
    const samples = page.getByTestId("batch-detail-samples").locator("li");
    await expect(samples.first()).toBeVisible();
    expect(await samples.count()).toBeLessThanOrEqual(3);

    // The mock adapter never opens a socket, so the probe issued no request and
    // the drawer must say so with an em dash instead of inventing a number.
    await expect(page.getByTestId("batch-detail-requests")).toHaveText("—");

    await page.keyboard.press("Escape");
  });

  /**
   * T30 — the new surface is fully translated.
   *
   * A dictionary test cannot catch a hardcoded Chinese string inside a
   * component, so this checks the rendered dialog in English: any CJK in its
   * chrome is a missing `t()` call.
   */
  test("T30 英文界面下批量体检文案无硬编码中文", async ({ page }) => {
    await page.goto("/providers");
    await page.getByTestId("locale-switcher").selectOption("en-US");

    await gotoHealthTabEnglish(page);
    await page.getByTestId("health-test-all").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The dialog's own chrome reads as English…
    await expect(dialog).toContainText("Testable");
    await expect(dialog).toContainText("Budget");
    await expect(page.getByTestId("batch-start")).toBeVisible();

    // …and contains no Chinese at all. Scoped to the dialog because the page
    // behind it legitimately holds provider names an operator chose.
    const text = await dialog.innerText();
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);

    await dialog.getByRole("button", { name: "Cancel" }).last().click();
    await page.getByTestId("locale-switcher").selectOption("zh-CN");
  });

  /**
   * T31 — the top-of-page entry.
   *
   * `providers` is the page an administrator lands on, so "test everything" has
   * to be reachable from there without first switching to the health tab. The
   * assertion is on the *same* pre-flight dialog, not on a second flow: a second
   * implementation would drift from the one the health tab opens.
   */
  test("T31 页面顶部「全部测试」打开同一个预检框", async ({ page }) => {
    await page.goto("/providers");
    await expect(page.getByTestId("providers-test-all")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("providers-test-all").click();

    await expect(page.getByTestId("batch-preview")).toBeVisible();
    // The button opens the live-search kind, and the dialog shows it selected.
    await expect(page.getByTestId("batch-kind-search")).toBeVisible();
    // Same scope counters as the health-tab entry: one flow, one implementation.
    await expect(page.getByTestId("count-eligible")).toBeVisible();
    await expect(page.getByTestId("batch-scope-total")).toContainText("范围内共");

    await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
    await expect(page.getByTestId("batch-preview")).toHaveCount(0);
  });

  /**
   * T32 — a reload can come back to the last run.
   *
   * The job lives on the server and the page keeps only a pointer to it. The test
   * therefore (a) starts a real run, (b) reloads, (c) checks the banner describes
   * what the server says happened, and (d) opens the results from it. A page that
   * merely remembered "a job existed" would pass nothing here.
   */
  test("T32 刷新后提示条出现并能打开上次检测结果", async ({ page }) => {
    await page.goto("/providers");
    await addMockProvider(page, "e2e-batch-t32", { resultCount: 2, latencyMs: 10, namespace: "t32" });

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });
    // Rows reached the table before the reload: otherwise the reopened view
    // below would be indistinguishable from an empty one.
    await expect(page.locator('[data-testid^="batch-row-"]').first()).toBeVisible();
    // `.last()`: the dialog has both the header X and the footer button, and both
    // carry the same accessible name.
    await page.getByRole("dialog").getByRole("button", { name: "关闭" }).last().click();

    await page.reload();
    const banner = page.getByTestId("providers-resume-banner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("providers-resume-text")).toContainText("上次检测已结束");
    // No dialog on load: the notice is a line on the page, not a pop-up.
    await expect(page.getByTestId("batch-results")).toHaveCount(0);

    await page.getByTestId("providers-resume-open").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid^="batch-row-"]').first()).toBeVisible();
    await expect(page.getByTestId("batch-result-status")).toContainText("已完成");

    // Closing the dialog drops the notice: it has been acted on.
    await page.getByRole("dialog").getByRole("button", { name: "关闭" }).last().click();
    await expect(page.getByTestId("providers-resume-banner")).toHaveCount(0);
  });

  /**
   * T33 — a pointer to a job that no longer exists is forgotten quietly.
   *
   * This is the reload after the database was reset (or after signing in as a
   * different account). The page must not error, and must not show a banner about
   * a run it can never open.
   */
  test("T33 任务不存在时静默清除，不显示提示条也不报错", async ({ page }) => {
    await page.goto("/providers");
    await page.evaluate(() => {
      // `globalThis` rather than `window`: the e2e suite is compiled without the
      // DOM library, and inside the browser they are the same object.
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
        "sh-provider-batch-job",
        JSON.stringify({ jobId: "bt_does_not_exist", kind: "connect", startedAt: "2026-01-01T00:00:00.000Z" }),
      );
    });
    await page.reload();

    await expect(page.getByTestId("providers-resume-banner")).toHaveCount(0);
    // No error alert either: a missing job is not something the operator did wrong.
    await expect(page.getByRole("alert")).toHaveCount(0);
    // …and the pointer is gone, so the next reload does not ask again.
    const stored = await page.evaluate(() =>
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem("sh-provider-batch-job"),
    );
    expect(stored).toBeNull();
  });

  /**
   * T34 — the result table fits the dialog, and its last column is usable.
   *
   * The failure this guards against is not cosmetic: a table whose action column
   * is pushed outside the dialog's visible width hides the only per-row buttons an
   * operator can press. §7 lists eight columns, and the two that do not belong
   * there — the error classification and the upstream request count — stay in the
   * drawer, which the last assertions check still shows them.
   */
  test("T34 结果表 8 列，1600×1000 下操作列完整可见且无横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/providers");
    await addMockProvider(page, "e2e-batch-t34", { resultCount: 3, latencyMs: 10, namespace: "t34" });

    const providerId = await page.evaluate(async () => {
      const response = await fetch("/api/admin/providers", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const body = (await response.json()) as { providers: Array<{ id: string; name: string }> };
      return body.providers.find((item) => item.name === "e2e-batch-t34")?.id ?? null;
    });
    expect(providerId).not.toBeNull();

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });

    // Exactly the eight columns of §7: source (+type), state, keys, latency,
    // results, reason, last checked, actions.
    await expect(page.getByTestId("batch-table").locator("thead th")).toHaveCount(8);
    // The two facts that belong to the drawer are not columns any more.
    await expect(page.locator('[data-testid^="batch-requests-"]')).toHaveCount(0);

    // No horizontal scrolling is needed at the dialog's own width…
    const overflow = await page.getByTestId("batch-table").evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    // …and both action buttons of a row sit inside the dialog, horizontally.
    // Vertical scrolling inside the dialog is allowed (a long list); a column
    // pushed off the right edge is not.
    for (const testId of [`batch-open-detail-${providerId}`, `batch-retry-one-${providerId}`]) {
      const edges = await page.getByTestId(testId).evaluate((node) => {
        const dialog = node.closest('[role="dialog"]');
        const button = node.getBoundingClientRect();
        const panel = dialog?.getBoundingClientRect();
        return { left: button.left, right: button.right, panelLeft: panel?.left ?? 0, panelRight: panel?.right ?? 0 };
      });
      expect(edges.left).toBeGreaterThanOrEqual(edges.panelLeft - 1);
      expect(edges.right).toBeLessThanOrEqual(edges.panelRight + 1);
    }

    // The retry button is not merely visible: pressing it probes that one source
    // and shows the probe's **own** conclusion. The batch row is left alone — it
    // is the record of what the run saw, and a later probe must not rewrite it.
    const retryRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().includes(`/api/admin/providers/${providerId}/test`),
    );
    await page.getByTestId(`batch-retry-one-${providerId}`).click();
    expect(await retryRequest).toBeTruthy();

    // The single-source result dialog opens on its own (no drawer needed), with
    // the facts the batch row does not carry: request count and test time.
    const singleResult = page.getByRole("dialog").filter({ hasText: "搜索测试" });
    await expect(singleResult).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("single-test-requests")).toBeVisible();
    await expect(page.getByTestId("single-test-checked-at")).toBeVisible();
    await singleResult.getByRole("button", { name: "关闭" }).last().click();
    await expect(singleResult).toHaveCount(0);

    // …and the row still says what the run said (a retest is a new probe, not a
    // patch on the ledger).
    await expect(page.getByTestId(`batch-state-${providerId}`)).toHaveText("成功");

    // The drawer still carries what the table no longer shows.
    await page.getByTestId(`batch-open-detail-${providerId}`).click();
    const drawer = page.getByTestId("batch-detail");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("batch-detail-requests")).toBeVisible();
    await expect(drawer).toContainText("错误分类");

    await page.keyboard.press("Escape");
  });
});

/** English variant of the health tab helper: the tab label is translated too. */
async function gotoHealthTabEnglish(page: Page): Promise<void> {
  await page.goto("/providers");
  await page.getByTestId("providers-tab-health").click();
  await expect(page.getByTestId("health-test-all")).toBeVisible({ timeout: 20_000 });
}
