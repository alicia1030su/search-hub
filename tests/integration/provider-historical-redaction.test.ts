import { afterEach, describe, expect, it } from "vitest";
import type { SearchResponse } from "@search-hub/shared";
import { addKey, createProvider } from "../helpers/vendor-stubs.js";
import { startBatchHarness, type BatchHarness } from "../helpers/batch-harness.js";

const harnesses: BatchHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function variants(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  return [
    secret,
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
    encoded.replace(/%20/g, "+"),
    encodeURIComponent(encoded),
  ];
}

function assertNoSecret(text: string, secret: string): void {
  const folded = text.toLowerCase();
  for (const variant of variants(secret)) {
    expect(folded.includes(variant.toLowerCase()), "historical diagnostic leaked a credential variant").toBe(false);
  }
}

function parseMcp(body: string): Record<string, unknown> {
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.at(-1) ?? body) as Record<string, unknown>;
}

describe("pre-v0.1.12 diagnostic redaction on read", () => {
  it("protects health history/overview, key summaries, task details, logs and MCP without rewriting audit rows", async () => {
    const harness = await startBatchHarness();
    harnesses.push(harness);
    const secret = "TEST_HISTORICAL_SECRET_1234567890 +/=&";
    const providerId = await createProvider(harness.app, harness.write(), {
      name: "historical-leak",
      type: "brave",
      baseUrl: "http://127.0.0.1:9",
    });
    await addKey(harness.app, harness.write(), providerId, secret);
    const keyId = harness.ctx.sqlite
      .prepare("SELECT id FROM api_keys WHERE provider_id = ?")
      .get(providerId) as { id: string };
    const now = new Date().toISOString();
    const leaked = `upstream echoed ${secret} uri=${encodeURIComponent(secret)}`;

    harness.ctx.sqlite
      .prepare(
        "INSERT INTO provider_health_checks (id, provider_id, key_id, kind, status, error_code, latency_ms, result_count, health_score, detail_json, trigger, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run("hc_legacy_leak", providerId, keyId.id, "connect", "unhealthy", "auth_invalid", 12, null, 0, JSON.stringify({ cause: "auth_invalid", message: leaked, requests: 1 }), "manual", now);
    harness.ctx.sqlite
      .prepare("UPDATE api_keys SET last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ?")
      .run("auth_invalid", leaked, now, keyId.id);

    const response: SearchResponse = {
      taskId: "task_legacy_leak",
      query: "legacy",
      mode: "basic",
      status: "failed",
      results: [],
      stats: {
        rawCount: 0,
        dedupedCount: 0,
        fusedCount: 0,
        providers: [{
          providerId,
          providerName: "historical-leak",
          providerType: "brave",
          ok: false,
          latencyMs: 12,
          resultCount: 0,
          keyId: keyId.id,
          errorCode: "auth_invalid",
          errorMessage: leaked,
          attempts: 1,
          httpRequests: 1,
        }],
        timing: { totalMs: 12, fanoutMs: 10, fusionMs: 2 },
        rerankApplied: false,
        embeddingApplied: false,
        summaryApplied: false,
        partial: true,
      },
      errors: [{ providerId, providerName: "historical-leak", code: "auth_invalid", message: leaked }],
      failedSources: [{ id: providerId, code: "auth_invalid" }],
      debug: { rewrittenQueries: [] },
    };
    harness.ctx.sqlite
      .prepare(
        "INSERT INTO search_tasks (id, query, mode, status, providers_json, errors_json, response_json, actor, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(response.taskId, "legacy", "basic", "failed", JSON.stringify([providerId]), JSON.stringify(response.errors), JSON.stringify(response), null, now, now);
    harness.ctx.sqlite
      .prepare(
        "INSERT INTO search_events (task_id, provider_id, provider_name, provider_type, key_id, ok, status_code, latency_ms, result_count, error_code, error_message, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(response.taskId, providerId, "historical-leak", "brave", keyId.id, 0, 401, 12, 0, "auth_invalid", leaked, now);

    const tokenResponse = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tokens",
      ...harness.write(),
      payload: { name: "historical-health", scopes: ["mcp:use"], rateLimitPerMin: 600 },
    });
    expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
    const token = tokenResponse.json().token as string;

    const watched = ["api_keys", "provider_health_checks", "search_tasks", "search_events"];
    const before = Object.fromEntries(
      watched.map((table) => [table, harness.ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );

    const urls = [
      `/api/admin/provider-health/history?providerId=${providerId}`,
      "/api/admin/provider-health",
      `/api/admin/providers/${providerId}/keys`,
      `/api/search/tasks/${response.taskId}`,
      "/api/admin/logs",
    ];
    for (const url of urls) {
      const result = await harness.app.inject({ method: "GET", url, ...harness.read() });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.body).toContain("[redacted: legacy diagnostic]");
      assertNoSecret(result.body, secret);
    }

    const mcp = await harness.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_provider_health", arguments: {} },
      },
    });
    expect(mcp.statusCode, mcp.body).toBe(200);
    const rpc = parseMcp(mcp.body) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    expect(rpc.result?.isError).toBeFalsy();
    // MCP projects a deliberately smaller health summary and does not include
    // the free-form diagnostic at all; it must still be credential-free.
    expect(rpc.result?.content?.[0]?.text).not.toContain("lastErrorMessage");
    assertNoSecret(mcp.body, secret);

    const after = Object.fromEntries(
      watched.map((table) => [table, harness.ctx.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
    expect(after).toEqual(before);
  });

  it.each(["rotated", "deleted"] as const)(
    "withholds legacy diagnostics after the credential is %s",
    async (action) => {
      const harness = await startBatchHarness();
      harnesses.push(harness);
      const legacySecret = "CUSTOM_PROVIDER_TOKEN_1234567890";
      const providerId = await createProvider(harness.app, harness.write(), {
        name: `legacy-${action}-token`,
        type: "brave",
        baseUrl: "http://127.0.0.1:9",
      });
      await addKey(harness.app, harness.write(), providerId, "CURRENT_PROVIDER_TOKEN_9876543210");
      const keyId = harness.ctx.sqlite
        .prepare("SELECT id FROM api_keys WHERE provider_id = ?")
        .get(providerId) as { id: string };
      const now = new Date().toISOString();
      const leaked = `upstream echoed ${legacySecret}`;
      harness.ctx.sqlite
        .prepare(
          "INSERT INTO provider_health_checks (id, provider_id, key_id, kind, status, error_code, latency_ms, result_count, health_score, detail_json, trigger, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run("hc_legacy_rotated", providerId, keyId.id, "connect", "unhealthy", "auth_invalid", 1, null, 0, JSON.stringify({ cause: "auth_invalid", message: leaked }), "manual", now);
      harness.ctx.sqlite
        .prepare(
          "INSERT INTO search_tasks (id, query, mode, status, providers_json, errors_json, response_json, actor, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "task_legacy_rotated",
          "legacy",
          "basic",
          "failed",
          JSON.stringify([providerId]),
          JSON.stringify([{ providerId, code: "auth_invalid", message: leaked }]),
          JSON.stringify({
            taskId: "task_legacy_rotated",
            query: "legacy",
            mode: "basic",
            status: "failed",
            results: [],
            stats: {
              rawCount: 0,
              dedupedCount: 0,
              fusedCount: 0,
              providers: [],
              timing: { totalMs: 1, fanoutMs: 1, fusionMs: 0 },
              rerankApplied: false,
              embeddingApplied: false,
              summaryApplied: false,
              partial: true,
            },
            errors: [{ providerId, providerName: `legacy-${action}-token`, code: "auth_invalid", message: leaked }],
            failedSources: [{ id: providerId, code: "auth_invalid" }],
            debug: { rewrittenQueries: [] },
          }),
          null,
          now,
          now,
        );

      harness.ctx.sqlite
        .prepare(
          "INSERT INTO search_events (task_id, provider_id, provider_name, provider_type, key_id, ok, status_code, latency_ms, result_count, error_code, error_message, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run("task_legacy_rotated", providerId, `legacy-${action}-token`, "brave", keyId.id, 0, 401, 1, 0, "auth_invalid", leaked, now);

      if (action === "rotated") {
        const rotated = await harness.app.inject({
          method: "PATCH",
          url: `/api/admin/keys/${keyId.id}`,
          ...harness.write(),
          payload: { key: "ROTATED_PROVIDER_TOKEN_1234567890" },
        });
        expect(rotated.statusCode, rotated.body).toBe(200);
      } else {
        const deleted = await harness.app.inject({
          method: "DELETE",
          url: `/api/admin/keys/${keyId.id}`,
          ...harness.write(),
        });
        expect(deleted.statusCode, deleted.body).toBe(200);
      }

      for (const url of [
        `/api/admin/provider-health/history?providerId=${providerId}`,
        "/api/admin/provider-health",
        "/api/search/tasks/task_legacy_rotated",
        "/api/admin/logs",
      ]) {
        const response = await harness.app.inject({ method: "GET", url, ...harness.read() });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).not.toContain(legacySecret);
        expect(response.body).toContain("[redacted: legacy diagnostic]");
      }
    },
  );
});
