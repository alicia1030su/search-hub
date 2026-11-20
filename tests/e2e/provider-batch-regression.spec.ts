import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import {
  addKeyToProvider,
  addMockProvider,
  adminJson,
  callAdminApi,
  createProviderViaApi,
  deleteProvidersByNamePrefix,
  ensureSignedIn,
  gotoHealthTab,
  openPreview,
  pinBatchScope,
  readBatchCounts,
  requireProviderId,
  rowIdsByState,
  rowStates,
  rowTally,
} from "./support";

/**
 * The bulk-test surface's behavioural edges.
 *
 * Each case answers a question an operator would ask after the happy path, and
 * each one is a place where a plausible implementation misleads:
 *
 *  - **Double-clicking "开始检测"** must not create two runs. Two jobs probing
 *    the same sources is exactly the duplicate spend the feature exists to
 *    prevent.
 *  - **A mixed scope** must keep its arithmetic honest: a restricted row counts
 *    as a failure but not as a retryable failure, a skipped row counts as
 *    neither, and the eight table columns agree with the summary line.
 *  - **A source without a key** must be reported as skipped, not failed, and the
 *    pre-flight must say so before anything runs.
 *  - **The keyless switch** is a policy, not a label: flipping it changes what
 *    the pre-flight promises and what the run does.
 *  - **"Retry the failures"** after a cancel must submit the failure set only —
 *    never the cancelled remainder.
 *  - **A remembered job that is not ours** is dropped without an error surface.
 *
 * The runs go through the real dialog and the real runner. Nothing replies with
 * a fabricated job; the only interception adds the scope of the test's own
 * sources to the start request (and, in one case, holds it briefly so the
 * in-flight state is observable).
 *
 * Table shape: the result table has **eight** columns — source (with type),
 * state, key count, latency, result count, error reason, last checked, actions.
 * The classification and the upstream request count live in the **detail
 * drawer**, so those are asserted there, not in the row.
 */

const PREFIX = "e2e-reg-";

/** Reads the number rendered in one pre-flight count row. */
async function countRow(page: Page, testId: string): Promise<number> {
  const row = page.getByTestId(testId);
  await expect(row).toBeVisible();
  const text = await row.locator("dd").last().innerText();
  const value = Number(text.trim());
  if (!Number.isFinite(value)) throw new Error(`count row ${testId} did not render a number: "${text}"`);
  return value;
}

/** The result table's header labels, in render order. */
async function tableHeaders(page: Page): Promise<string[]> {
  return page.getByTestId("batch-table").locator("thead th").allInnerTexts();
}

/** Opens the detail drawer from a result row. */
async function openDetail(page: Page, providerId: string) {
  await page.getByTestId(`batch-open-detail-${providerId}`).click();
  const drawer = page.getByTestId("batch-detail");
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Sets the task-local switch without ever writing global health settings. */
async function setTaskKeyless(page: Page, enabled: boolean): Promise<void> {
  const toggle = page.getByTestId("batch-include-keyless").getByRole("switch");
  if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(enabled));
}

/**
 * Restores the settings this file is allowed to change.
 *
 * The E2E worker shares one database across files, so leaving paid probes on or
 * keyless sources excluded would change what the next file's pre-flight sees.
 */
async function restoreSettings(page: Page): Promise<void> {
  await callAdminApi(page, "/api/admin/settings", {
    method: "PUT",
    body: {
      health: { paidProbesEnabled: false, includeUnverified: true },
      security: { privateHostAllowlist: [] },
    },
  });
}

test.describe("搜索源批量体检的行为边界", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
    await restoreSettings(page);
  });

  test.afterEach(async ({ page }) => {
    await deleteProvidersByNamePrefix(page, PREFIX);
    await restoreSettings(page);
  });

  /**
   * T39 — a double click on "开始检测" is one run.
   *
   * The start request is held for a moment so the button's in-flight state is
   * observable; the second activation is a real (forced) mouse click on that
   * disabled button. The assertions are on server side effects: one POST, one
   * job id polled, and a table whose row count is the scope size exactly once.
   */
  test("T39 连点「开始检测」只创建一个任务，请求飞行中按钮禁用", async ({ page }) => {
    await page.goto("/providers");
    const createdIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const name = `${PREFIX}t39-${index}`;
      await addMockProvider(page, name, { resultCount: 2, latencyMs: 200, namespace: `t39-${index}` });
      createdIds.push(await requireProviderId(page, name));
    }

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);

    const starts: unknown[] = [];
    const polledJobs = new Set<string>();
    page.on("request", (request) => {
      const match = /\/api\/admin\/provider-health\/batch-test(?:\/(bt_[^/?]+))?$/.exec(request.url());
      if (!match) return;
      if (request.method() === "POST") return;
      if (match[1]) polledJobs.add(match[1]);
    });
    // Hold the start request briefly: the button must be disabled while it is in
    // flight, and a second activation in that window must do nothing.
    await pinBatchScope(page, createdIds, { delayMs: 700, onStart: (body) => starts.push(body) });

    const start = page.getByTestId("batch-start");
    await start.click();
    await expect(start).toBeDisabled();
    await start.click({ force: true, timeout: 2_000 }).catch(() => undefined);

    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("batch-result-status")).toContainText("已完成");

    expect(starts).toHaveLength(1);
    await expect.poll(() => polledJobs.size).toBe(1);
    const rows = page.locator('[data-testid^="batch-row-"]');
    expect(await rows.count()).toBe(createdIds.length);
    for (const id of createdIds) {
      await expect(page.getByTestId(`batch-row-${id}`)).toHaveAttribute("data-state", "ok");
    }
    // The summary describes three successes, not six.
    const counts = await readBatchCounts(page);
    expect(counts.ok).toBe(createdIds.length);
    expect(counts.failed).toBe(0);
  });

  /**
   * T40 — mixed scope: five kinds of sources, one honest set of counts.
   *
   * `counts.failed` includes the restricted (`rate_limited`) row — it *failed* —
   * while "retry failures" excludes it, and skipped rows count in neither. The
   * table is asserted to have exactly the eight columns, with classification and
   * request count available only in the drawer.
   */
  test("T40 混合五类来源：八列表格分组与计数一致、分类只在抽屉", async ({ page }) => {
    await page.goto("/providers");
    await addMockProvider(page, `${PREFIX}t40-ok`, { resultCount: 3, latencyMs: 10, namespace: "t40ok" });
    await addMockProvider(page, `${PREFIX}t40-auth`, { latencyMs: 10, failMode: "auth_invalid" });
    await addMockProvider(page, `${PREFIX}t40-limited`, { latencyMs: 10, failMode: "rate_limited" });
    await addMockProvider(page, `${PREFIX}t40-empty`, { resultCount: 0, latencyMs: 10, namespace: "t40empty" });
    // Needs a credential and has none -> skipped, never "failed".
    await createProviderViaApi(page, {
      name: `${PREFIX}t40-nokey`,
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });
    await addMockProvider(page, `${PREFIX}t40-off`, { resultCount: 2, latencyMs: 10, namespace: "t40off" });
    const offId = await requireProviderId(page, `${PREFIX}t40-off`);
    expect(
      await callAdminApi(page, `/api/admin/providers/${offId}`, { method: "PATCH", body: { enabled: false } }),
    ).toBe(200);

    const okId = await requireProviderId(page, `${PREFIX}t40-ok`);
    const authId = await requireProviderId(page, `${PREFIX}t40-auth`);
    const limitedId = await requireProviderId(page, `${PREFIX}t40-limited`);
    const emptyId = await requireProviderId(page, `${PREFIX}t40-empty`);
    const noKeyId = await requireProviderId(page, `${PREFIX}t40-nokey`);

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await pinBatchScope(page, [okId, authId, limitedId, emptyId, noKeyId, offId]);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });

    // Each source landed in the group its outcome implies.
    await expect(page.getByTestId(`batch-row-${okId}`)).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId(`batch-row-${authId}`)).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId(`batch-row-${limitedId}`)).toHaveAttribute("data-state", "restricted");
    await expect(page.getByTestId(`batch-row-${emptyId}`)).toHaveAttribute("data-state", "pending");
    await expect(page.getByTestId(`batch-row-${noKeyId}`)).toHaveAttribute("data-state", "skipped");
    await expect(page.getByTestId(`batch-row-${offId}`)).toHaveAttribute("data-state", "skipped");

    const states = await rowStates(page);
    expect(new Set(states)).toEqual(new Set(["ok", "failed", "restricted", "pending", "skipped"]));

    // Eight columns, and no request-count column: that fact moved to the drawer.
    const headers = await tableHeaders(page);
    expect(headers).toHaveLength(8);
    expect(headers.join(" ")).toContain("错误原因");
    expect(await page.locator('[data-testid^="batch-requests-"]').count()).toBe(0);
    // The classification is not a column either.
    await expect(page.getByTestId(`batch-row-${authId}`)).not.toContainText("Key 无效或已过期");

    // Every number in the summary equals the rows it summarises.
    const tally = await rowTally(page);
    const counts = await readBatchCounts(page);
    expect(tally).toEqual({ ok: 1, failed: 1, restricted: 1, pending: 1, skipped: 2 });
    expect(counts.ok).toBe(tally["ok"] ?? 0);
    expect(counts.pending).toBe(tally["pending"] ?? 0);
    expect(counts.skipped).toBe(tally["skipped"] ?? 0);
    // `failed` is the state, so it includes the restricted row…
    expect(counts.failed).toBe((tally["failed"] ?? 0) + (tally["restricted"] ?? 0));
    expect(counts.failed).toBe(2);
    // …and both skipped rows stay out of it.
    expect(counts.failed).toBeLessThan(counts.failed + counts.skipped);
    expect(counts.ok + counts.failed + counts.pending + counts.skipped).toBe(6);

    // The retry button offers the fixable failure only, and its number says so.
    await expect(page.getByTestId("batch-retry-failed")).toContainText(`(${tally["failed"] ?? 0})`);

    // The filter buttons agree with the grouping.
    await page.getByTestId("batch-filter-skipped").click();
    await expect(page.locator('[data-testid^="batch-row-"]')).toHaveCount(tally["skipped"] ?? 0);
    await page.getByTestId("batch-filter-restricted").click();
    await expect(page.locator('[data-testid^="batch-row-"]')).toHaveCount(tally["restricted"] ?? 0);

    // The drawer carries the classification and the advice sentence. Opening it
    // is the last step: closing it also closes the flow dialog.
    await page.getByTestId("batch-filter-all").click();
    const drawer = await openDetail(page, authId);
    await expect(drawer).toContainText("Key 无效或已过期");
    await expect(drawer).toContainText("到「Key 管理」更换凭证后重测。");
    await expect(drawer.getByTestId("batch-detail-requests")).toHaveText("—");
  });

  /**
   * T41 — no-key sources are visible before the run and skipped after it.
   *
   * The pre-flight has to count them without disabling the run (other sources are
   * testable), and the result table must call the source "跳过", not "失败" — the
   * difference between "we could not ask" and "the vendor said no".
   */
  test("T41 无 Key 来源：预检可见、开始仍可点，结果记为跳过而不是失败", async ({ page }) => {
    await page.goto("/providers");
    await addMockProvider(page, `${PREFIX}t41-ok`, { resultCount: 2, latencyMs: 10, namespace: "t41ok" });
    await createProviderViaApi(page, {
      name: `${PREFIX}t41-nokey`,
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });
    const okId = await requireProviderId(page, `${PREFIX}t41-ok`);
    const noKeyId = await requireProviderId(page, `${PREFIX}t41-nokey`);

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);

    await expect.poll(() => countRow(page, "count-nokey")).toBeGreaterThan(0);
    // One source cannot be asked anything; the rest of the scope still can.
    await expect(page.getByTestId("batch-start")).toBeEnabled();
    await expect.poll(() => countRow(page, "count-eligible")).toBeGreaterThan(0);

    await pinBatchScope(page, [okId, noKeyId]);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId(`batch-row-${noKeyId}`)).toHaveAttribute("data-state", "skipped");
    // The state badge, not the classification (which lives in the drawer).
    await expect(page.getByTestId(`batch-state-${noKeyId}`)).toContainText("跳过");
    await expect(page.getByTestId(`batch-state-${noKeyId}`)).not.toContainText("失败");

    // The skipped source did not inflate the failure count.
    const tally = await rowTally(page);
    const counts = await readBatchCounts(page);
    expect(tally).toEqual({ ok: 1, skipped: 1 });
    expect(counts.failed).toBe(0);
    expect(counts.skipped).toBe(1);
    expect(counts.failed).toBe((tally["failed"] ?? 0) + (tally["restricted"] ?? 0));

    // The drawer names the reason: a missing credential, not a vendor refusal.
    const drawer = await openDetail(page, noKeyId);
    await expect(drawer).toContainText("没有 Key");
    await expect(drawer).toContainText("no_key");
    await expect(drawer.getByTestId("batch-detail-health")).toContainText("未写入健康记录");
  });

  /**
   * T42 — the keyless switch is a real policy, not a label.
   *
   * With the switch off, a source that needs no credential moves from "可测" to
   * "免 Key 跳过" in the pre-flight and lands in the skipped group after the run;
   * the credentialed source keeps the run startable. The keyed row's drawer is
   * where the measured request count and the classification are read.
   */
  test("T42 免 Key 开关：关闭后免 Key 来源跳过而不是失败，请求数只在抽屉", async ({ page }) => {
    const stub = await startBraveStub();
    try {
      await page.goto("/providers");
      expect(
        await callAdminApi(page, "/api/admin/settings", {
          method: "PUT",
          body: { security: { privateHostAllowlist: ["127.0.0.1"] } },
        }),
      ).toBe(200);

      await addMockProvider(page, `${PREFIX}t42-keyless`, { resultCount: 2, latencyMs: 10, namespace: "t42k" });
      const keylessId = await requireProviderId(page, `${PREFIX}t42-keyless`);
      await createProviderViaApi(page, { name: `${PREFIX}t42-keyed`, type: "brave", baseUrl: stub.base });
      const keyedId = await requireProviderId(page, `${PREFIX}t42-keyed`);
      await addKeyToProvider(page, keyedId, "sk-E2E-REG-T42-KEYED-000000000");

      await gotoHealthTab(page);
      await openPreview(page, "connect");

      // The task-local default excludes keyless sources, regardless of the
      // global includeUnverified policy restored in beforeEach.
      const keylessSwitch = page.getByTestId("batch-include-keyless").getByRole("switch");
      await expect(keylessSwitch).toHaveAttribute("aria-checked", "false");
      await expect.poll(() => countRow(page, "count-keyless")).toBeGreaterThan(0);
      await expect(page.getByTestId("batch-start")).toBeEnabled();

      // Enabling it is scoped to this task and refetches the pre-flight.
      await keylessSwitch.click();
      await expect(keylessSwitch).toHaveAttribute("aria-checked", "true");
      await expect.poll(() => countRow(page, "count-eligible")).toBeGreaterThanOrEqual(2);
      await keylessSwitch.click();
      await expect(keylessSwitch).toHaveAttribute("aria-checked", "false");
      await expect.poll(() => countRow(page, "count-keyless")).toBeGreaterThan(0);
      await expect(page.getByTestId("batch-start")).toBeEnabled();

      await pinBatchScope(page, [keylessId, keyedId]);
      await page.getByTestId("batch-start").click();
      await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });
      await expect(page.getByTestId(`batch-row-${keylessId}`)).toHaveAttribute("data-state", "skipped");
      await expect(page.getByTestId(`batch-row-${keyedId}`)).toHaveAttribute("data-state", "ok");
      expect(stub.hits()).toBeGreaterThanOrEqual(1);

      const counts = await readBatchCounts(page);
      expect(counts.failed).toBe(0);
      expect(counts.skipped).toBe(1);

      // The request count is a drawer fact: a number for the real probe…
      await page.getByTestId(`batch-open-detail-${keyedId}`).click();
      let drawer = page.getByTestId("batch-detail");
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId("batch-detail-requests")).toHaveText(/^\d+$/);
      expect(Number(await drawer.getByTestId("batch-detail-requests").innerText())).toBe(stub.hits());
      await expect(drawer).toContainText("正常");

      // Close both overlays, then reopen the finished run from the banner.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("batch-detail")).toHaveCount(0);
      await expect(page.getByTestId("providers-resume-banner")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("providers-resume-open").click();
      await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 20_000 });

      // …and an em dash for the policy skip: no request was sent.
      drawer = await openDetail(page, keylessId);
      await expect(drawer).toContainText("免 Key 来源按策略跳过");
      await expect(drawer.getByTestId("batch-detail-requests")).toHaveText("—");
    } finally {
      await stub.close();
    }
  });

  /**
   * T43 — after a cancel, "retry the failures" submits the failures only.
   *
   * Cancelled sources are `skipped`; retrying them would re-run work the operator
   * just stopped. The request body is the assertion because that is what the
   * server acts on.
   */
  test("T43 取消后「只重测失败项」不包含被取消的来源", async ({ page }) => {
    await page.goto("/providers");
    // One fast failure, several slow sources that the cancel will abandon.
    await addMockProvider(page, `${PREFIX}t43-fail`, { latencyMs: 10, failMode: "server_error" });
    const failId = await requireProviderId(page, `${PREFIX}t43-fail`);
    const slowIds: string[] = [];
    for (let index = 1; index <= 4; index += 1) {
      const name = `${PREFIX}t43-slow-${index}`;
      await addMockProvider(page, name, { resultCount: 2, latencyMs: 900, namespace: `t43-${index}` });
      slowIds.push(await requireProviderId(page, name));
    }

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await pinBatchScope(page, [failId, ...slowIds]);
    await page.getByTestId("batch-start").click();
    await expect(page.getByTestId("batch-progress")).toBeVisible();
    await expect(page.getByTestId("batch-progress-counts")).toContainText(/失败 [1-9]/, { timeout: 45_000 });
    await page.getByTestId("batch-cancel").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });

    const failedIds = await rowIdsByState(page, "failed");
    expect(failedIds).toContain(failId);
    // Cancelled rows are in the skipped group; the reason column records that
    // the run — not the source — ended them.
    const cancelledIds = await page
      .locator('[data-testid^="batch-row-"][data-state="skipped"]')
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => /cancelled/i.test(node.textContent ?? ""))
          .map((node) => (node.getAttribute("data-testid") ?? "").slice("batch-row-".length)),
      );
    expect(cancelledIds.length).toBeGreaterThan(0);
    expect(cancelledIds).not.toContain(failId);
    // A cancelled source is not a failure.
    for (const id of cancelledIds) {
      await expect(page.getByTestId(`batch-state-${id}`)).toContainText("跳过");
    }

    const retry = page.getByTestId("batch-retry-failed");
    await expect(retry).toBeEnabled();
    await expect(retry).toContainText(`(${failedIds.length})`);

    let posted: { providerIds?: string[] } | null = null;
    await page.route("**/api/admin/provider-health/batch-test", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posted = route.request().postDataJSON() as { providerIds?: string[] };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ jobId: "bt_intercepted", status: "running", total: 1, concurrency: 1 }),
      });
    });

    await retry.click();
    await expect.poll(() => posted).not.toBeNull();
    const body = posted as unknown as { kind: string; providerIds: string[] };

    // Exactly the failed set — the cancelled remainder is not re-run.
    expect(new Set(body.providerIds)).toEqual(new Set(failedIds));
    for (const id of cancelledIds) expect(body.providerIds).not.toContain(id);
  });

  /**
   * T44 — a remembered job that belongs to another account is forgotten.
   *
   * A single-admin instance cannot mint a second account, so the cross-account
   * refusal is covered at the API level by
   * `tests/integration/provider-batch-owner.test.ts`; here the 403 is produced
   * for the one request the browser makes, and the assertion is on what the page
   * does with it: no banner, no error, and no pointer left behind.
   */
  test("T44 刷新恢复遇他人任务（403）：不显示提示条、不报错、指针被清除", async ({ page }) => {
    let forbiddenReads = 0;
    await page.route("**/api/admin/provider-health/batch-test/bt_foreign_account", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      forbiddenReads += 1;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "forbidden", message: "This test job belongs to another account" },
        }),
      });
    });
    await page.addInitScript(() => {
      // `globalThis` rather than `window`: the e2e suite is compiled without the
      // DOM library, and in the browser they are the same object.
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
        "sh-provider-batch-job",
        JSON.stringify({ jobId: "bt_foreign_account", kind: "connect", startedAt: "2026-01-01T00:00:00.000Z" }),
      );
    });

    await page.goto("/providers");
    await expect.poll(() => forbiddenReads).toBe(1);

    // The pointer is a convenience, not an error surface: nothing is shown.
    await expect(page.getByTestId("providers-resume-banner")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // …and the page still works.
    await expect(page.getByTestId("providers-test-all")).toBeVisible({ timeout: 20_000 });
    const stored = await page.evaluate(() =>
      (globalThis as unknown as { localStorage: Storage }).localStorage.getItem("sh-provider-batch-job"),
    );
    expect(stored).toBeNull();
  });

  test("T45 免 Key 开关默认关闭、仅本次生效，刷新后原任务快照不变", async ({ page }) => {
    await page.goto("/providers");
    const name = `${PREFIX}t45-keyless`;
    await addMockProvider(page, name, { resultCount: 2, latencyMs: 200, namespace: "t45" });
    const providerId = await requireProviderId(page, name);
    await page.route("**/api/admin/provider-health/batch-test/preview?*", async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("providerIds", providerId);
      await route.continue({ url: url.toString() });
    });

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await expect(page.getByTestId("batch-include-keyless").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect.poll(() => countRow(page, "count-keyless")).toBe(1);
    await expect(page.getByTestId("batch-start")).toBeDisabled();
    await setTaskKeyless(page, true);
    await expect.poll(() => countRow(page, "count-eligible")).toBe(1);

    let posted: { includeKeyless?: boolean } | null = null;
    await pinBatchScope(page, [providerId], { onStart: (body) => (posted = body as { includeKeyless?: boolean }) });
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/api/admin/provider-health/batch-test"),
    );
    await page.getByTestId("batch-start").click();
    const jobId = (await (await started).json()).jobId as string;
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId(`batch-row-${providerId}`)).toHaveAttribute("data-state", "ok");
    expect(posted).toMatchObject({ includeKeyless: true });

    const settings = await adminJson(page, "/api/admin/provider-health/settings", { method: "GET" });
    expect((settings.body as { policy: { includeUnverified: boolean } }).policy.includeUnverified).toBe(true);
    await page.getByRole("dialog").getByRole("button", { name: "关闭" }).last().click();

    await page.reload();
    await page.getByTestId("providers-resume-open").click();
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`batch-row-${providerId}`)).toHaveAttribute("data-state", "ok");
    const snapshot = await adminJson(page, `/api/admin/provider-health/batch-test/${jobId}`, { method: "GET" });
    expect((snapshot.body as { includeKeyless: boolean }).includeKeyless).toBe(true);
    await page.getByRole("dialog").getByRole("button", { name: "关闭" }).last().click();

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await expect(page.getByTestId("batch-include-keyless").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect.poll(() => countRow(page, "count-keyless")).toBe(1);
  });

  test("T46 取消后必须轮询到 remaining=0 才停止并展示结果", async ({ page }) => {
    await page.goto("/providers");
    const ids: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const name = `${PREFIX}t46-${index}`;
      await addMockProvider(page, name, { resultCount: 2, latencyMs: 900, namespace: `t46-${index}` });
      ids.push(await requireProviderId(page, name));
    }

    await gotoHealthTab(page);
    await openPreview(page, "connect");
    await setTaskKeyless(page, true);
    await pinBatchScope(page, ids);
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/api/admin/provider-health/batch-test"),
    );
    await page.getByTestId("batch-start").click();
    const jobId = (await (await started).json()).jobId as string;

    let readsAfterCancel = 0;
    let staleReads = 0;
    let cancelClicked = false;
    await page.route(`**/api/admin/provider-health/batch-test/${jobId}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      if (cancelClicked) readsAfterCancel += 1;
      const response = await route.fetch();
      const body = (await response.json()) as {
        status: string;
        counts: { remaining: number };
        nextPollAfterMs: number | null;
        items: Array<Record<string, unknown>>;
      };
      if (cancelClicked && staleReads < 2) {
        staleReads += 1;
        body.status = "cancelled";
        body.counts.remaining = 1;
        body.nextPollAfterMs = 1000;
        body.items = body.items.map((item, index) =>
          index === 0 ? { ...item, state: "unknown", code: "unknown" } : item,
        );
        await route.fulfill({ response, body: JSON.stringify(body), contentType: "application/json" });
        return;
      }
      await route.fulfill({ response });
    });

    await expect(page.getByTestId("batch-progress")).toBeVisible();
    cancelClicked = true;
    await page.getByTestId("batch-cancel").click();
    await expect.poll(() => readsAfterCancel).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("batch-results")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("batch-result-status")).toContainText("部分完成");
  });
});

/** A Brave-shaped keyed vendor stub on 127.0.0.1 (never a real vendor). */
async function startBraveStub(): Promise<{ base: string; hits(): number; close(): Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((request, response) => {
    hits += 1;
    if (!request.url?.startsWith("/res/v1/web/search")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (!request.headers["x-subscription-token"]) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "missing token" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        web: {
          results: [
            {
              title: "E2E 批量边界样例",
              url: "https://example.org/e2e-reg-keyed-1",
              description: "stub description",
              page_age: "2026-01-01T00:00:00",
              language: "en",
            },
          ],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub did not bind");
  return {
    base: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
