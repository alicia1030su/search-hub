import { afterEach, describe, expect, it } from "vitest";
import {
  batchJob,
  batchPreview,
  cleanupEnvironment,
  cliEnvironment,
  health,
  json,
  runCli,
  startStub,
  type StubHandler,
} from "./support.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handler: StubHandler) {
  const server = await startStub(handler);
  const env = cliEnvironment(server.url);
  cleanups.push(() => cleanupEnvironment(env), () => server.close());
  return { server, env };
}

function probeResponse(overrides: Record<string, unknown> = {}) {
  return {
    result: {
      ok: true,
      latencyMs: 12,
      resultCount: 3,
      message: "ok",
      status: "healthy",
      cause: "ok",
      errorCode: null,
      requests: 1,
      billingUnit: "unknown",
      spent: false,
      kind: "search",
      keyId: null,
      checkedAt: "2026-11-21T00:00:00.000Z",
      ...overrides,
    },
    budget: { remainingRun: 2 },
  };
}

describe("CLI provider health commands", () => {
  it("C25 tests one provider through the server HealthService endpoint", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url?.startsWith("/api/admin/provider-health/batch-test/preview")) return json(response, 200, batchPreview());
      if (request.url === "/api/admin/provider-health/prv_1/probe") return json(response, 200, probeResponse());
      return json(response, 404, { error: { code: "not_found", message: "not found" } });
    });
    const result = await runCli(["providers", "test", "prv_1", "--json"], env);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.result.requests).toBe(1);
    expect(body.result.billingUnit).toBe("unknown");
    expect(server.requests.find((request) => request.url === "/api/admin/provider-health/prv_1/probe")?.body).toEqual({ kind: "search" });
  });

  it("C26 skips a source with no key without calling the probe endpoint", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, batchPreview({ counts: { eligible: 0, noKey: 1, noEnabledKey: 0, configError: 0, disabled: 0, keylessSkipped: 0, coolingSkipped: 0 } }));
    });
    const result = await runCli(["providers", "test", "prv_1", "--json"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).skipped).toBe(true);
    expect(server.requests.some((request) => request.url.endsWith("/probe"))).toBe(false);
  });

  it("C27 skips a source whose keys are all disabled", async () => {
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, batchPreview({ counts: { eligible: 0, noKey: 0, noEnabledKey: 1, configError: 0, disabled: 0, keylessSkipped: 0, coolingSkipped: 0 } }));
    });
    const result = await runCli(["providers", "test", "prv_1", "--json"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).preview.counts.noEnabledKey).toBe(1);
  });

  it("C28 skips keyless sources by default", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, batchPreview({ counts: { eligible: 0, noKey: 0, noEnabledKey: 0, configError: 0, disabled: 0, keylessSkipped: 1, coolingSkipped: 0 } }));
    });
    const result = await runCli(["providers", "test", "--all", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url?.startsWith("/api/admin/provider-health/batch-test/preview"))?.url).toContain("includeKeyless=false");
    expect(server.requests.some((request) => request.url === "/api/admin/provider-health/batch-test" && request.method === "POST")).toBe(false);
  });

  it("C29 includes keyless sources only when explicitly requested", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url?.startsWith("/api/admin/provider-health/batch-test/preview")) return json(response, 200, batchPreview({ estimatedAnonymousProbes: 1 }));
      if (request.url === "/api/admin/provider-health/batch-test" && request.method === "POST") return json(response, 201, { jobId: "job_123", status: "running", total: 1, concurrency: 1 });
      if (request.url === "/api/admin/provider-health/batch-test/job_123") return json(response, 200, batchJob({ includeKeyless: true }));
      return json(response, 404, { error: { code: "not_found", message: "not found" } });
    });
    const result = await runCli(["providers", "test", "--all", "--include-keyless", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url?.startsWith("/api/admin/provider-health/batch-test/preview"))?.url).toContain("includeKeyless=true");
    expect(server.requests.find((request) => request.url === "/api/admin/provider-health/batch-test" && request.method === "POST")?.body).toMatchObject({ includeKeyless: true });
  });

  it("C30 refuses potentially paid probes without --confirm-cost", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, batchPreview({ paidRisk: true, estimatedPaidProbes: 2 }));
    });
    const result = await runCli(["providers", "test", "--all", "--json"], env);
    expect(result.status).toBe(2);
    expect(server.requests.some((request) => request.url === "/api/admin/provider-health/batch-test" && request.method === "POST")).toBe(false);
  });

  it("C30 sends the batch only after explicit cost confirmation", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url?.startsWith("/api/admin/provider-health/batch-test/preview")) return json(response, 200, batchPreview({ paidRisk: true, estimatedPaidProbes: 1 }));
      if (request.url === "/api/admin/provider-health/batch-test" && request.method === "POST") return json(response, 201, { jobId: "job_123", status: "running", total: 1, concurrency: 1 });
      if (request.url === "/api/admin/provider-health/batch-test/job_123") return json(response, 200, batchJob());
      return json(response, 404, { error: { code: "not_found", message: "not found" } });
    });
    const result = await runCli(["providers", "test", "--all", "--confirm-cost", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.filter((request) => request.url === "/api/admin/provider-health/batch-test" && request.method === "POST")).toHaveLength(1);
  });

  it("C31 does not let a search-only token bypass admin permission", async () => {
    const { env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 403, { error: { code: "forbidden", message: "Token is missing admin scope" } });
    });
    const result = await runCli(["providers", "test", "prv_1", "--json"], env);
    expect(result.status).toBe(4);
  });

  it("C33 cancels an existing batch job through the server API", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, { ok: true, jobId: "job_123", status: "cancelled", skippedRemaining: 2 });
    });
    const result = await runCli(["providers", "test", "--cancel", "job_123", "--json"], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).skippedRemaining).toBe(2);
    expect(server.requests.find((request) => request.url?.endsWith("/cancel"))?.method).toBe("POST");
  });

  it("C34 stops locally when the preview says the budget is exhausted", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      return json(response, 200, batchPreview({ counts: { eligible: 0, noKey: 0, noEnabledKey: 0, configError: 0, disabled: 0, keylessSkipped: 0, coolingSkipped: 1 } }));
    });
    const result = await runCli(["providers", "test", "--all", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.some((request) => request.url === "/api/admin/provider-health/batch-test" && request.method === "POST")).toBe(false);
  });

  it("C35 does not retry a same-source lock conflict", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url?.startsWith("/api/admin/provider-health/batch-test/preview")) return json(response, 200, batchPreview());
      return json(response, 409, { error: { code: "already_running", message: "A probe is already running" } });
    });
    const result = await runCli(["providers", "test", "prv_1", "--json"], env);
    expect(result.status).toBe(6);
    expect(server.requests.filter((request) => request.url?.endsWith("/probe"))).toHaveLength(1);
  });

  it("passes --kind connect to both preview and probe", async () => {
    const { server, env } = await fixture((request, response) => {
      if (request.url === "/api/health") return json(response, 200, health());
      if (request.url?.startsWith("/api/admin/provider-health/batch-test/preview")) return json(response, 200, batchPreview({ kind: "connect" }));
      return json(response, 200, probeResponse({ kind: "connect" }));
    });
    const result = await runCli(["providers", "test", "prv_1", "--kind", "connect", "--json"], env);
    expect(result.status).toBe(0);
    expect(server.requests.find((request) => request.url?.endsWith("/probe"))?.body).toEqual({ kind: "connect" });
  });
});
