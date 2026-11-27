import { expect, type Page } from "@playwright/test";

/**
 * Helpers shared by the v0.1.10 provider-test browser suites.
 *
 * Everything here drives the real page against the real API. The only network
 * peer a test may introduce is a `127.0.0.1` HTTP stub it starts itself (see
 * `provider-single-test.spec.ts`): that keeps "how many upstream requests did
 * the probe send" a measurement instead of a claim, without ever contacting a
 * vendor.
 */

export const EMAIL = "admin@example.com";
/** Test-only password for the throwaway database created by `e2e-server.mjs`. */
export const PASSWORD = "E2E-Local-Only-Password-1";

/**
 * The first-run guide is intentionally outside the dashboard shell. Suites that
 * exercise older surfaces dismiss it through the real UI so their assertions
 * stay focused on the surface under test.
 */
export async function dismissOnboardingIfVisible(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "首次使用引导" });
  if (!(await heading.isVisible().catch(() => false))) return;
  await page.getByRole("button", { name: "跳过引导" }).click();
  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

/**
 * Signs in, running first-time setup when this file is the first to run.
 *
 * A targeted run (`pnpm test:e2e -- <file>`) starts from an empty database, so
 * this has to handle both states instead of assuming an order between files.
 */
export async function ensureSignedIn(page: Page): Promise<void> {
  await page.goto("/");
  // The SPA decides client-side whether to render the login form, the setup form
  // or the dashboard. Waiting for one of the forms removes the race between the
  // URL check below and the first paint (a fresh context has no session yet).
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
    await expect(page.getByRole("heading", { name: "首次使用引导" })).toBeVisible({ timeout: 20_000 });
    await dismissOnboardingIfVisible(page);
    return;
  }

  if (page.url().endsWith("/login") || (await page.locator("#login-email").isVisible().catch(() => false))) {
    await page.locator("#login-email").fill(EMAIL);
    await page.locator("#login-password").fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
    await dismissOnboardingIfVisible(page);
    return;
  }

  await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible({ timeout: 20_000 });
}

/**
 * Calls an admin API from inside the page, carrying the session and CSRF token.
 *
 * Returning the parsed body as well as the status lets a test seed a provider
 * and immediately know its id without a second round trip.
 */
export async function adminJson(
  page: Page,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<{ status: number; body: unknown }> {
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
          accept: "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        ...(args.hasBody ? { body: JSON.stringify(args.body) } : {}),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    },
    { path, method: init.method, body: init.body ?? null, hasBody: init.body !== undefined },
  );
}

/** Status-only variant, for seeding calls whose body is not interesting. */
export async function callAdminApi(
  page: Page,
  path: string,
  init: { method: string; body?: unknown },
): Promise<number> {
  return (await adminJson(page, path, init)).status;
}

/** The id of the provider with this exact name, or `null`. */
export async function findProviderId(page: Page, name: string): Promise<string | null> {
  const result = await adminJson(page, "/api/admin/providers", { method: "GET" });
  const body = result.body as { providers?: Array<{ id: string; name: string }> } | null;
  return body?.providers?.find((item) => item.name === name)?.id ?? null;
}

/** Same, but fails the test instead of returning `null`. */
export async function requireProviderId(page: Page, name: string): Promise<string> {
  const id = await findProviderId(page, name);
  if (id === null) throw new Error(`provider "${name}" was not created`);
  return id;
}

/**
 * Creates a `mock` provider through the UI.
 *
 * The UI path is used rather than the API so the suite also proves the form
 * still accepts the adapter config — a broken form would otherwise be invisible.
 */
export async function addMockProvider(
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

/**
 * Creates a provider through the admin API.
 *
 * Used when the *shape* of the form is not the subject (e.g. a keyed source
 * with no credential), so a UI detour would only add flakiness.
 */
export async function createProviderViaApi(
  page: Page,
  input: { name: string; type: string; baseUrl?: string; config?: Record<string, unknown> },
): Promise<string> {
  const result = await adminJson(page, "/api/admin/providers", {
    method: "POST",
    body: { enabled: true, ...input },
  });
  if (result.status !== 200) {
    throw new Error(`provider create failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return requireProviderId(page, input.name);
}

/** Attaches a credential to a provider (the plaintext is encrypted server-side). */
export async function addKeyToProvider(page: Page, providerId: string, key: string): Promise<void> {
  const status = await callAdminApi(page, `/api/admin/providers/${providerId}/keys`, {
    method: "POST",
    body: { label: "e2e", key, weight: 100, enabled: true },
  });
  expect(status, "key create").toBe(200);
}

/**
 * Deletes every provider whose name starts with `prefix`.
 *
 * The Playwright worker shares one database across files, so a suite that seeds
 * providers has to take them away again: a failing source left enabled would
 * otherwise change the scope (and the failure counts) of every later run.
 */
export async function deleteProvidersByNamePrefix(page: Page, prefix: string): Promise<void> {
  const result = await adminJson(page, "/api/admin/providers", { method: "GET" });
  const body = result.body as { providers?: Array<{ id: string; name: string }> } | null;
  for (const provider of body?.providers ?? []) {
    if (!provider.name.startsWith(prefix)) continue;
    await callAdminApi(page, `/api/admin/providers/${provider.id}`, { method: "DELETE" }).catch(() => 0);
  }
}

/** Opens the providers page and switches to the health tab. */
export async function gotoHealthTab(page: Page): Promise<void> {
  await page.goto("/providers");
  // The tab's accessible name carries a healthy/total suffix ("健康监控 0/53"),
  // so it is addressed by a stable test id rather than by an exact label.
  await page.getByTestId("providers-tab-health").click();
  await expect(page.getByTestId("health-test-all")).toBeVisible({ timeout: 20_000 });
}

/** Opens the pre-flight dialog through the primary entry point. */
export async function openPreview(page: Page, kind: "connect" | "search"): Promise<void> {
  await page
    .getByTestId(kind === "search" ? "health-test-all" : "health-test-all-connect")
    .click();
  await expect(page.getByTestId("batch-preview")).toBeVisible();
}

/** Reads the rows of the result table, in render order. */
export async function rowStates(page: Page): Promise<string[]> {
  const rows = page.locator('[data-testid^="batch-row-"]');
  await expect(rows.first()).toBeVisible();
  return rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-state") ?? ""));
}

/** Provider ids of the result rows whose `data-state` is `state`. */
export async function rowIdsByState(page: Page, state: string): Promise<string[]> {
  return page
    .locator(`[data-testid^="batch-row-"][data-state="${state}"]`)
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute("data-testid") ?? "")
        .filter((id) => id.startsWith("batch-row-"))
        .map((id) => id.slice("batch-row-".length)),
    );
}

/** Tally of the result table's rows by `data-state`. */
export async function rowTally(page: Page): Promise<Record<string, number>> {
  const states = await rowStates(page);
  const tally: Record<string, number> = {};
  for (const state of states) tally[state] = (tally[state] ?? 0) + 1;
  return tally;
}

export interface BatchCountsText {
  ok: number;
  failed: number;
  pending: number;
  skipped: number;
}

/** Parses `batch-result-counts` ("成功 1 · 失败 2 · 待确认 0 · 跳过 3"). */
export async function readBatchCounts(page: Page): Promise<BatchCountsText> {
  const text = await page.getByTestId("batch-result-counts").innerText();
  const match = /成功\s*(\d+)\s*·\s*失败\s*(\d+)\s*·\s*待确认\s*(\d+)\s*·\s*跳过\s*(\d+)/.exec(text);
  if (!match) throw new Error(`unexpected batch counts text: ${text}`);
  return {
    ok: Number(match[1]),
    failed: Number(match[2]),
    pending: Number(match[3]),
    skipped: Number(match[4]),
  };
}

/**
 * Pins a batch run to an explicit provider set.
 *
 * The page's entry point always runs over *every* configured source. A test that
 * wants exact counts (and must not probe an unrelated, possibly real-vendor
 * source that another spec left behind) scopes the one POST to its own sources.
 * The request still goes to the real server, which executes a real run; only the
 * scope parameter is added. A retry that already carries its own `providerIds`
 * is passed through untouched, so the request body stays the subject under test.
 */
export async function pinBatchScope(
  page: Page,
  providerIds: string[],
  options: { delayMs?: number; onStart?: (body: unknown) => void } = {},
): Promise<void> {
  await page.route("**/api/admin/provider-health/batch-test", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    options.onStart?.(body);
    if (Array.isArray(body["providerIds"])) {
      await route.continue();
      return;
    }
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    await route.continue({ postData: JSON.stringify({ ...body, providerIds }) });
  });
}

/** The health tab's row card for one provider, scoped to the health section. */
export function healthCard(page: Page, providerName: string) {
  return page
    .locator('section[aria-label="搜索源健康"] div.rounded-xl')
    .filter({ hasText: providerName })
    .first();
}

/** Server-side runtime state for a provider, read from the health overview. */
export async function readHealthRuntime(page: Page, providerId: string): Promise<string | null> {
  const result = await adminJson(page, "/api/admin/health", { method: "GET" });
  const body = result.body as {
    providers?: Array<{ providerId: string; runtime: string }>;
  } | null;
  return body?.providers?.find((row) => row.providerId === providerId)?.runtime ?? null;
}
