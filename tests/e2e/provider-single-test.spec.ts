import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import {
  addKeyToProvider,
  adminJson,
  addMockProvider,
  callAdminApi,
  deleteProvidersByNamePrefix,
  ensureSignedIn,
  gotoHealthTab,
  healthCard,
  readHealthRuntime,
  requireProviderId,
} from "./support";

/**
 * The single-source test (the "测试连通性" button on a source's row).
 *
 * The point of these cases is that the dialog's conclusion is the *probe's*
 * conclusion, not a second implementation's opinion: the same `checkOne` path
 * the scheduler and the bulk runner use answers here (PRD D1 / US6). The suite
 * therefore asserts facts a decorative dialog could not produce:
 *
 *  - the upstream request count is a number when a request really was sent,
 *    and an em dash when the adapter provably never opened a socket;
 *  - the failure dialog names the classification (`auth_invalid` → "Key 无效或
 *    已过期") instead of a generic "failed";
 *  - the health overview reflects the probe after a reload, so the conclusion
 *    survives the dialog.
 *
 * Nothing here mocks the app's API. The only stand-in is a `127.0.0.1` HTTP
 * server shaped like the vendor wire format, started by this file, and reached
 * through the real SSRF allowlist setting.
 */

const SECRET = "sk-E2E-SINGLE-PLAINTEXT-A1B2C3D4";

interface VendorStub {
  base: string;
  hits(): number;
  close(): Promise<void>;
}

/**
 * A minimal vendor-shaped HTTP server.
 *
 * `hn` answers the Hacker News wire format (keyless), `unauthorized` answers
 * 401 to every request so a real upstream status produces the classification.
 */
async function startVendorStub(mode: "hn" | "unauthorized"): Promise<VendorStub> {
  let hits = 0;
  const server: Server = createServer((request, response) => {
    hits += 1;
    if (mode === "unauthorized") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "invalid token" } }));
      return;
    }
    if (!request.url?.startsWith("/api/v1/search")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        hits: Array.from({ length: 3 }, (_, index) => ({
          objectID: String(index + 1),
          title: `E2E 单源测试样例 ${index + 1}`,
          url: `https://example.org/e2e-single-${index + 1}`,
          created_at: "2026-01-01T00:00:00.000Z",
          points: 5,
          author: "e2e",
          num_comments: 0,
        })),
        nbHits: 3,
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

/** Allows the loopback stub through the SSRF guard (nothing else is relaxed). */
async function allowLoopback(page: Page): Promise<void> {
  expect(
    await callAdminApi(page, "/api/admin/settings", {
      method: "PUT",
      body: { security: { privateHostAllowlist: ["127.0.0.1"] } },
    }),
  ).toBe(200);
}

/** Creates a provider through the UI (the form is part of what is under test). */
async function addHttpProvider(page: Page, name: string, type: string, baseUrl: string): Promise<void> {
  await page.getByRole("button", { name: "新增搜索源" }).first().click();
  await page.locator("#provider-name").fill(name);
  await page.locator("#provider-type").selectOption(type);
  await page.locator("#provider-base").fill(baseUrl);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(name, { exact: false }).filter({ visible: true }).first()).toBeVisible({
    timeout: 20_000,
  });
}

/** The value next to a labelled metric inside the test-result dialog. */
function metricValue(dialog: Locator, label: string) {
  return dialog.locator(`p:text-is("${label}")`).first().locator("xpath=following-sibling::p[1]");
}

/** Runs the row's own test button and returns the dialog locator. */
async function runRowTest(page: Page, providerId: string) {
  await page.locator(`#provider-${providerId}`).getByRole("button", { name: "测试连通性" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return dialog;
}

async function closeDialog(page: Page): Promise<void> {
  // Two buttons share the accessible name "关闭": the header X and the footer.
  await page.getByRole("dialog").getByRole("button", { name: "关闭" }).last().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.describe("搜索源单源测试", () => {
  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
  });

  test.afterEach(async ({ page }) => {
    await deleteProvidersByNamePrefix(page, "e2e-single-");
  });

  /**
   * T34 — the pass path through the row button.
   *
   * The mock adapter answers in-process, so the dialog must report an em dash
   * for upstream requests (D7: `null` means "no request was sent", and an
   * invented number is worse than an honest dash). The credential attached to
   * the source exists only to make the redaction assertion meaningful: key
   * material must never reach the page, and the key *identifier* is truncated.
   */
  test("T35 单源测试通过：结论、结果数、测试时间与脱敏 Key，页面无 Key 明文", async ({ page }) => {
    await page.goto("/providers");
    const name = "e2e-single-t34";
    await addMockProvider(page, name, { resultCount: 3, latencyMs: 10, namespace: "t34" });
    const providerId = await requireProviderId(page, name);
    await addKeyToProvider(page, providerId, SECRET);
    const keys = await adminJson(page, `/api/admin/providers/${providerId}/keys`, { method: "GET" });
    const keyId = (keys.body as Array<{ id: string }> | null)?.[0]?.id ?? null;
    expect(keyId).not.toBeNull();

    // Before the probe: the health overview has no conclusion for this source.
    await gotoHealthTab(page);
    await expect(healthCard(page, name)).toContainText("尚未检测");
    expect(await readHealthRuntime(page, providerId)).toBe("unknown");

    await page.getByTestId("providers-tab-installed").click();
    const dialog = await runRowTest(page, providerId);

    // The title names the source, so the dialog cannot be mistaken for another.
    await expect(dialog).toContainText("搜索测试：");
    await expect(dialog).toContainText(name);
    await expect(dialog).toContainText("测试通过");
    await expect(metricValue(dialog, "返回结果")).toHaveText("3");
    // A mock adapter never opens a socket: `null` is the honest answer.
    await expect(page.getByTestId("single-test-requests")).toHaveText("—");
    await expect(page.getByTestId("single-test-checked-at")).toHaveText(/\d{4}[-/]\d{2}[-/]\d{2}/);
    // The key id is truncated for display; neither the secret nor the full
    // identifier reaches the page.
    await expect(dialog).toContainText("…");
    const dialogText = await dialog.innerText();
    expect(dialogText).not.toContain(SECRET);
    expect(dialogText).not.toContain(keyId as string);
    expect(await page.locator("body").innerText()).not.toContain(SECRET);

    await closeDialog(page);

    // The conclusion is a server fact: a fresh health overview shows it.
    await page.reload();
    await gotoHealthTab(page);
    await expect(healthCard(page, name)).toContainText("健康");
    await expect(healthCard(page, name)).toContainText("上次检测");
    expect(await readHealthRuntime(page, providerId)).toBe("healthy");
  });

  /**
   * T35 — the request count is a measurement.
   *
   * A keyless source backed by a loopback HTTP stub really sends one request,
   * so the dialog must show `1` (not `—`), the result count must match what the
   * stub returned, and the health list must flip from 未检测 to 健康. This is
   * the assertion a dialog that "computes" its numbers cannot pass.
   */
  test("T36 单源测试的上游请求数是真实测量，并写回健康概览", async ({ page }) => {
    const stub = await startVendorStub("hn");
    try {
      await page.goto("/providers");
      await allowLoopback(page);
      const name = "e2e-single-t35";
      await addHttpProvider(page, name, "hackernews", stub.base);
      const providerId = await requireProviderId(page, name);

      await gotoHealthTab(page);
      await expect(healthCard(page, name)).toContainText("尚未检测");

      await page.getByTestId("providers-tab-installed").click();
      const dialog = await runRowTest(page, providerId);

      await expect(dialog).toContainText("测试通过");
      await expect(metricValue(dialog, "返回结果")).toHaveText("3");
      await expect(page.getByTestId("single-test-requests")).toHaveText(/^\d+$/);
      const requests = Number(await page.getByTestId("single-test-requests").innerText());
      expect(requests).toBeGreaterThanOrEqual(1);
      // The number the dialog shows is the number the socket saw.
      expect(requests).toBe(stub.hits());
      await expect(page.getByTestId("single-test-checked-at")).toHaveText(/\d{4}[-/]\d{2}[-/]\d{2}/);
      // This source needs no credential: the key label says so instead of
      // inventing an identifier. The requests cell above is the measured number.
      await expect(metricValue(dialog, "脱敏 Key")).toHaveText("未使用凭证");

      await closeDialog(page);

      await page.reload();
      await gotoHealthTab(page);
      await expect(healthCard(page, name)).toContainText("健康");
      expect(await readHealthRuntime(page, providerId)).toBe("healthy");
    } finally {
      await stub.close();
    }
  });

  /**
   * T36 — a failed single test names the classification.
   *
   * "测试失败" alone tells the operator nothing; the dialog has to say *why*.
   * A real 401 from a loopback stub must render the auth label and its advice,
   * and the health list must show 凭证无效 afterwards — the same mapping the
   * scheduled probe uses.
   */
  test("T37 单源测试失败：显示鉴权分类与建议，而不是笼统失败", async ({ page }) => {
    await page.goto("/providers");
    // Prove the classification is driven by the vendor's answer: a real 401
    // from a loopback stub, not a mock that throws a hand-written code.
    const stub = await startVendorStub("unauthorized");
    try {
      await allowLoopback(page);
      const name = "e2e-single-t36";
      await addHttpProvider(page, name, "hackernews", stub.base);
      const providerId = await requireProviderId(page, name);
      expect(stub.hits()).toBe(0);

      await page.getByTestId("providers-tab-installed").click();
      const dialog = await runRowTest(page, providerId);

      await expect(dialog).toContainText("测试失败");
      await expect(dialog).not.toContainText("测试通过");
      // The auth classification, not a generic failure caption.
      await expect(dialog).toContainText("Key 无效或已过期");
      await expect(dialog).toContainText("到「Key 管理」更换凭证后重测。");
      // The probe did reach the vendor, so the count is a number.
      await expect(page.getByTestId("single-test-requests")).toHaveText(/^\d+$/);
      expect(Number(await page.getByTestId("single-test-requests").innerText())).toBe(stub.hits());

      await closeDialog(page);

      await page.reload();
      await gotoHealthTab(page);
      await expect(healthCard(page, name)).toContainText("凭证无效");
      expect(await readHealthRuntime(page, providerId)).toBe("invalid_credentials");
    } finally {
      await stub.close();
    }
  });
});
