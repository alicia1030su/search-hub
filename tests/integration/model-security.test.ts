import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/api/src/app.js";
import { createContext, type AppContext } from "../../apps/api/src/context.js";
import { loadConfig, type AppConfig } from "../../apps/api/src/config.js";

/**
 * P1-3 model enhancement chain: security + contract verification.
 *
 * Everything runs against a real Fastify app, the real SQLite database and a
 * local HTTP server that impersonates a model vendor. The local server proves
 * the *protocol contract* (paths, request/response shapes, mapping). It does
 * NOT prove any real vendor behaves like this — see
 * docs/model-integration-status.md.
 */

const KEY_FINGERPRINT = "sk-MODEL-LEAK-FINGERPRINT";
const METADATA_URL = "http://169.254.169.254/";

let app: FastifyInstance;
let ctx: AppContext;
let dir: string;
let cookie: string;
let csrf: string;
/** One always-enabled source so a search actually reaches the model stage. */
let defaultProviderId = "";
let modelServer: Server;
let modelPort = 0;

interface Hit {
  path: string;
  authorization: string;
  body: string;
}
const hits: Hit[] = [];

function testConfig(dataDir: string): AppConfig {
  return {
    ...loadConfig(),
    nodeEnv: "test",
    dataDir,
    dbPath: join(dataDir, "model-security.db"),
    staticDir: null,
    cookieSecure: false,
    setupToken: null,
    logLevel: "silent",
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

function sendJson(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

/** Deterministic fake vendor: behaviour is selected by the base path prefix. */
async function handleModelRequest(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const path = request.url ?? "/";
  const body = await readBody(request);
  hits.push({ path, authorization: String(request.headers.authorization ?? ""), body });

  // Chat completion shared by every OpenAI-compatible scenario.
  if (path.endsWith("/chat/completions")) {
    if (path.startsWith("/echo-chat/")) {
      // Simulates a proxy/gateway that echoes the credential back in its error body.
      sendJson(response, 401, {
        error: { message: `Unauthorized: request header authorization=${String(request.headers.authorization ?? "")}` },
      });
      return;
    }
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role: string; content: string }> };
    const user = payload.messages?.find((message) => message.role === "user")?.content ?? "";
    const content = user.includes("可引用资料")
      ? "摘要：[1] 第一条来自结果一。[2] 第二条来自结果二。[9] 这个编号并不存在，属于模型编造。"
      : "OK";
    sendJson(response, 200, {
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
      model: "fake-chat",
    });
    return;
  }

  if (path.endsWith("/embeddings")) {
    const payload = JSON.parse(body || "{}") as { input?: string[] };
    const input = payload.input ?? [];
    const dimensions = path.startsWith("/emb3/") ? 3 : 8;
    if (path.startsWith("/emb-badcount/")) {
      // Right width, wrong number of vectors: the adapter must reject the batch
      // rather than score a subset of the results.
      sendJson(response, 200, { data: [{ index: 0, embedding: Array.from({ length: 8 }, () => 0.1) }] });
      return;
    }
    const data = input.map((text, index) => ({
      index,
      embedding:
        dimensions === 3
          ? [0.1, 0.2, 0.3]
          : // Query and "结果 3" share a direction; everything else is orthogonal.
            index === 0 || text.includes("结果 3")
            ? [1, 0, 0, 0, 0, 0, 0, 0]
            : [0, 1, 0, 0, 0, 0, 0, 0],
    }));
    sendJson(response, 200, { data, model: "fake-embedding" });
    return;
  }

  if (path.endsWith("/v1/messages")) {
    // Anthropic: system prompt is hoisted out of `messages` and the key travels
    // in `x-api-key`, not `authorization`.
    const payload = JSON.parse(body || "{}") as {
      system?: string;
      messages?: Array<{ role: string; content: string }>;
    };
    if (path.startsWith("/anthropic-echo/")) {
      sendJson(response, 401, { error: { message: `bad key ${String(request.headers["x-api-key"] ?? "")}` } });
      return;
    }
    sendJson(response, 200, {
      content: [
        { type: "text", text: `anthropic ok (system=${Boolean(payload.system)}, turns=${payload.messages?.length ?? 0})` },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
    });
    return;
  }

  if (path.endsWith(":generateContent")) {
    // Gemini authenticates with `x-goog-api-key`, which is outside the header
    // list SafeFetch redacts — so this echo specifically exercises the
    // adapter-level scrub rather than the shared one.
    sendJson(response, 400, {
      error: { message: `API key not valid: ${String(request.headers["x-goog-api-key"] ?? "")}` },
    });
    return;
  }

  if (path.endsWith("/v1/rerank")) {
    if (path.startsWith("/rerank-bad/")) {
      // 200 with a body that is not JSON: the adapter must fail closed.
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not valid json at all");
      return;
    }
    if (path.startsWith("/echo-rerank/")) {
      sendJson(response, 403, {
        error: { message: `Forbidden: saw authorization=${String(request.headers.authorization ?? "")}` },
      });
      return;
    }
    const payload = JSON.parse(body || "{}") as { documents?: string[] };
    const documents = payload.documents ?? [];
    // Later documents in the fused list score higher, so a correct mapping
    // must invert the incoming order.
    const results = documents.map((_, index) => ({
      index,
      relevance_score: Number(((index + 1) / documents.length).toFixed(6)),
    }));
    sendJson(response, 200, { results, meta: { billed_units: 1 } });
    return;
  }

  if (path.startsWith("/custom-embed/score")) {
    // Self-hosted embedding endpoint with a non-OpenAI shape: the vector sits
    // under `output.embeddings[].values` and the input field is `sentences`.
    const payload = JSON.parse(body || "{}") as { sentences?: string[] };
    const sentences = payload.sentences ?? [];
    if (path.startsWith("/custom-embed/score-mismatch/")) {
      sendJson(response, 200, { output: { embeddings: [{ values: [0.5, 0.5] }] } });
      return;
    }
    sendJson(response, 200, {
      output: {
        embeddings: sentences.map((text, index) => ({
          values: index === 0 || text.includes("结果 2") ? [1, 0, 0] : [0, 1, 0],
        })),
      },
    });
    return;
  }

  if (path.startsWith("/custom-rerank/rank")) {
    // Self-hosted reranker with a nested, non-Cohere shape.
    const payload = JSON.parse(body || "{}") as { passages?: string[] };
    const passages = payload.passages ?? [];
    sendJson(response, 200, {
      payload: {
        scores: passages.map((_, index) => ({ doc: index, prob: Number(((index + 1) / passages.length).toFixed(6)) })),
      },
    });
    return;
  }

  sendJson(response, 404, { error: { message: `no fake route for ${path}` } });
}

async function setAllowlist(entries: string[]): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/api/admin/settings",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: { security: { privateHostAllowlist: entries } },
  });
  expect(response.statusCode).toBe(200);
}

interface CreateModelOptions {
  kind: "chat" | "embedding" | "rerank";
  providerType: "openai-compatible" | "anthropic" | "gemini" | "cohere" | "jina" | "custom-http";
  baseUrl: string;
  dimensions?: number;
  params?: Record<string, unknown>;
  apiKey?: string;
}

async function createModel(options: CreateModelOptions): Promise<{
  id: string;
  statusCode: number;
  raw: string;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/models",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: {
      kind: options.kind,
      name: `${options.kind}-${options.providerType}-${Math.random().toString(16).slice(2, 8)}`,
      providerType: options.providerType,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey ?? KEY_FINGERPRINT,
      modelId: `fake-${options.kind}`,
      ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
      batchSize: 8,
      timeoutMs: 3_000,
      maxConcurrency: 2,
      params: options.params ?? {},
      enabled: true,
      isDefault: true,
    },
  });
  const body = response.json() as { id?: string; model?: { id?: string } };
  return {
    id: body.id ?? body.model?.id ?? "",
    statusCode: response.statusCode,
    raw: response.body,
  };
}

async function testModel(id: string): Promise<{ ok: boolean; message: string; raw: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/admin/models/${id}/test`,
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
  });
  expect(response.statusCode).toBe(200);
  return { ok: response.json().ok as boolean, message: response.json().message as string, raw: response.body };
}

async function addProvider(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/providers",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    payload: {
      name: `model-security-source-${Math.random().toString(16).slice(2, 8)}`,
      type: "mock",
      enabled: true,
      maxConcurrency: 4,
      rpmLimit: 1000,
      config: { resultCount: 6, latencyMs: 2, namespace: "sec" },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().provider.id as string;
}

async function findModelId(name: string): Promise<string | null> {
  const response = await app.inject({
    method: "GET",
    url: "/api/admin/models",
    cookies: { sh_session: cookie },
  });
  const rows = response.json() as Array<{ id: string; name: string }>;
  return rows.find((row) => row.name === name)?.id ?? null;
}

interface ResultShape {
  url: string;
  title: string;
  rerankScore?: number;
  score: number;
  metadata?: Record<string, unknown>;
}

interface SearchBody {
  results: ResultShape[];
  stats: {
    rerankApplied: boolean;
    embeddingApplied: boolean;
    summaryApplied: boolean;
    degraded?: boolean;
    timing?: { rerankMs?: number; embeddingMs?: number; summaryMs?: number };
  };
  errors: Array<{ providerId: string; message: string }>;
  summary?: { text: string; citations: Array<{ index: number; title: string; url: string }> };
}

async function search(payload: Record<string, unknown>): Promise<{ statusCode: number; body: SearchBody; raw: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/search",
    cookies: { sh_session: cookie },
    headers: { "x-csrf-token": csrf },
    // A provider is required: `SearchService` rejects a request with no matching
    // source (`400 validation_error`) before any model stage runs, so a search
    // without one would prove nothing about the model chain.
    payload: { query: "model security chain", limit: 5, skipCache: true, providers: [defaultProviderId], ...payload },
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as SearchBody,
    raw: response.body,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "search-hub-model-sec-"));
  ctx = createContext(testConfig(dir));
  app = await buildApp(ctx);
  await app.ready();
  const setup = await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      email: "admin@example.com",
      password: "A-very-long-password-1",
      name: "Admin",
      setupToken: ctx.setupToken.value!,
    },
  });
  cookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
  csrf = setup.json().csrfToken as string;

  modelServer = createServer((request, response) => {
    void handleModelRequest(request, response);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (typeof address === "object" && address) modelPort = address.port;

  // Every search in this file needs at least one enabled source: SearchService
  // answers 400 "No enabled search provider matched this request" otherwise, and
  // that rejection happens *before* any model stage. Created after the model
  // server is listening so it can never be confused with a model call.
  defaultProviderId = await addProvider();
});

afterAll(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const localBase = (prefix: string): string => `http://127.0.0.1:${modelPort}${prefix}`;

describe("custom model base URL is protected by the SSRF policy", () => {
  it("refuses to store a loopback base URL until it is allowlisted, and only then reaches it", async () => {
    await setAllowlist([]);

    // Fail fast: a configuration that can never work is not stored at all.
    const rejected = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/v1"),
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.raw).toContain("blocked");
    expect(rejected.raw).toMatch(/private or reserved address/i);
    expect(hits).toHaveLength(0);

    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/v1"),
    });
    expect(created.statusCode).toBe(200);
    // Creating a model only stores configuration; it must never probe the network.
    expect(hits).toHaveLength(0);

    const allowed = await testModel(created.id);
    expect(allowed.ok).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe("/v1/chat/completions");
  });

  it("re-checks the policy on every call, so revoking the allowlist blocks a stored model", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/v1"),
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();

    await setAllowlist([]);
    const before = hits.length;
    const blocked = await testModel(created.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/private or reserved address|allowlist/i);
    expect(hits).toHaveLength(before);

    const failedSearch = await search({ providers: [providerId], mode: "rrf", summarize: true });
    expect(failedSearch.statusCode).toBe(200);
    expect(failedSearch.body.stats.degraded).toBe(true);
    expect(failedSearch.body.stats.summaryApplied).toBe(false);
    expect(failedSearch.body.results.length).toBeGreaterThan(0);
    expect(hits).toHaveLength(before);
  });

  it("never allows the cloud metadata endpoint, even when it is allowlisted", async () => {
    // Allowlisting the metadata address must not unlock it, in any spelling.
    for (const baseUrl of [
      METADATA_URL,
      "http://[::ffff:169.254.169.254]/",
      "http://100.100.100.200/",
    ]) {
      await setAllowlist(["169.254.169.254", "::ffff:a9fe:a9fe", "100.100.100.200"]);
      const rejected = await createModel({
        kind: "chat",
        providerType: "openai-compatible",
        baseUrl,
      });
      expect(rejected.statusCode, baseUrl).toBe(403);
      expect(rejected.raw).toMatch(/metadata/i);
    }

    // An imported config bypasses the route-level check, so the invariant has to
    // hold at call time as well.
    const imported = await app.inject({
      method: "POST",
      url: "/api/admin/config/import",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: {
        config: {
          models: [
            {
              kind: "chat",
              name: "imported-metadata-model",
              providerType: "openai-compatible",
              baseUrl: METADATA_URL,
              modelId: "metadata-probe",
              enabled: true,
              isDefault: true,
            },
          ],
        },
      },
    });
    expect(imported.statusCode).toBe(200);
    expect((imported.json() as { models: number }).models).toBe(1);

    const importedId = await findModelId("imported-metadata-model");
    expect(importedId).toBeTruthy();

    // Explicit provider: without one the search is rejected with 400 before any
    // model is reached, which would make this assertion prove nothing.
    const providerId = await addProvider();
    const before = hits.length;
    const result = await testModel(importedId!);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/metadata/i);
    expect(hits.length).toBe(before);

    const searchResult = await search({ providers: [providerId], mode: "rrf", summarize: true });
    expect(searchResult.statusCode).toBe(200);
    expect(searchResult.body.results.length).toBeGreaterThan(0);
    expect(searchResult.body.stats.degraded).toBe(true);
    expect(hits.length).toBe(before);
    await setAllowlist([]);
  });

  it("rejects non-http(s) base URLs at the schema layer", async () => {
    await setAllowlist([]);
    const before = hits.length;
    for (const baseUrl of ["file:///etc/passwd", "ftp://example.com/keys", "gopher://127.0.0.1:6379/"]) {
      const created = await createModel({
        kind: "chat",
        providerType: "openai-compatible",
        baseUrl,
      });
      expect(created.statusCode).toBe(400);
      expect(created.raw).toContain("must be an http(s) URL");
    }
    // Rejecting at the edge also means nothing was ever dialled.
    expect(hits.length).toBe(before);
  });
});

describe("model API keys never leave the server", () => {
  it("keeps the plaintext key out of the create response, model list, export and backup", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/v1"),
    });
    expect(created.statusCode).toBe(200);
    expect(created.raw).not.toContain(KEY_FINGERPRINT);

    const createdBody = JSON.parse(created.raw) as { hasKey: boolean; apiKeyHint: string };
    expect(createdBody.hasKey).toBe(true);
    // The hint may expose a short prefix/suffix for operator recognition, but no
    // contiguous fragment from the middle of the key and never the whole value.
    expect(createdBody.apiKeyHint.length).toBeLessThanOrEqual(9);
    expect(createdBody.apiKeyHint).not.toContain(KEY_FINGERPRINT);
    for (const offset of [4, 8, 12]) {
      const fragment = KEY_FINGERPRINT.slice(offset, offset + 8);
      expect(fragment).toHaveLength(8);
      expect(createdBody.apiKeyHint).not.toContain(fragment);
    }

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/models",
      cookies: { sh_session: cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(KEY_FINGERPRINT);

    const exported = await app.inject({
      method: "GET",
      url: "/api/admin/config/export",
      cookies: { sh_session: cookie },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(KEY_FINGERPRINT);

    const backup = await app.inject({
      method: "GET",
      url: "/api/admin/backup",
      cookies: { sh_session: cookie },
    });
    expect(backup.statusCode).toBe(200);
    const snapshotText = Buffer.from(backup.rawPayload).toString("latin1");
    expect(snapshotText).not.toContain(KEY_FINGERPRINT);
    // Sanity: the snapshot really is the database that holds the model row
    // (otherwise "no plaintext found" would be vacuously true).
    expect(snapshotText).toContain("api_key_ciphertext");
    expect(snapshotText).toContain(created.id);

    // The key is stored as AES-GCM ciphertext, not as the plaintext.
    const row = ctx.sqlite
      .prepare("SELECT api_key_ciphertext, api_key_iv, api_key_tag, api_key_hint FROM model_configs WHERE id = ?")
      .get(created.id) as
      | { api_key_ciphertext: string; api_key_iv: string; api_key_tag: string; api_key_hint: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.api_key_ciphertext.length).toBeGreaterThan(0);
    expect(row!.api_key_ciphertext).not.toBe(KEY_FINGERPRINT);
    expect(row!.api_key_ciphertext).not.toContain(KEY_FINGERPRINT);
    expect(row!.api_key_iv.length).toBeGreaterThan(0);
    expect(row!.api_key_tag.length).toBeGreaterThan(0);
    // The ciphertext is really in the downloaded snapshot byte stream.
    expect(snapshotText).toContain(row!.api_key_ciphertext);
    // …and it decrypts back to the key we stored, so the row is not a stub.
    expect(
      ctx.secrets.decrypt({
        ciphertext: row!.api_key_ciphertext,
        iv: row!.api_key_iv,
        tag: row!.api_key_tag,
        version: 1,
      }),
    ).toBe(KEY_FINGERPRINT);
  });

  it("scrubs an upstream that echoes the credential back in an error body", async () => {
    await setAllowlist(["127.0.0.1"]);
    const chat = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/echo-chat/v1"),
    });
    expect(chat.statusCode).toBe(200);
    const beforeChat = hits.length;
    const tested = await testModel(chat.id);
    expect(tested.ok).toBe(false);
    expect(tested.message).toContain("401");
    expect(tested.message).not.toContain(KEY_FINGERPRINT);
    expect(tested.raw).not.toContain(KEY_FINGERPRINT);
    // The raw echo did reach the fake vendor, so the scrub above is not vacuous.
    expect(hits.slice(beforeChat).some((hit) => hit.authorization === `Bearer ${KEY_FINGERPRINT}`)).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/models",
      cookies: { sh_session: cookie },
    });
    expect(list.body).not.toContain(KEY_FINGERPRINT);

    const rerank = await createModel({
      kind: "rerank",
      providerType: "cohere",
      baseUrl: localBase("/echo-rerank"),
    });
    expect(rerank.statusCode).toBe(200);
    const providerId = await addProvider();
    const searched = await search({ providers: [providerId], mode: "rerank", rerank: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.rerankApplied).toBe(false);
    expect(searched.body.stats.degraded).toBe(true);
    expect(searched.body.results.length).toBeGreaterThan(0);
    expect(JSON.stringify(searched.body.errors)).not.toContain(KEY_FINGERPRINT);
  });

  it("scrubs a key sent in a vendor-specific header (Gemini x-goog-api-key)", async () => {
    await setAllowlist(["127.0.0.1"]);
    // A key with no recognisable prefix, so only the exact-value scrub can
    // remove it — this is the gap SafeFetch's header list does not cover.
    const geminiKey = "Zm9vYmFyYmF6cXV1eGtleTEyMzQ1Njc4OTA";
    const gemini = await createModel({
      kind: "chat",
      providerType: "gemini",
      baseUrl: localBase("/gemini"),
      apiKey: geminiKey,
    });
    expect(gemini.statusCode).toBe(200);
    const tested = await testModel(gemini.id);
    expect(tested.ok).toBe(false);
    expect(tested.message).toMatch(/API key not valid/i);
    expect(tested.message).not.toContain(geminiKey);
    expect(tested.raw).not.toContain(geminiKey);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/models",
      cookies: { sh_session: cookie },
    });
    // last_test_error is persisted in SQLite and shown in the list.
    expect(list.body).not.toContain(geminiKey);
  });
});

describe("per-protocol request shape is correct (local contract only)", () => {
  it("speaks the Anthropic Messages contract", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "anthropic",
      baseUrl: localBase("/anthropic"),
    });
    expect(created.statusCode).toBe(200);
    const tested = await testModel(created.id);
    expect(tested.ok).toBe(true);
    const hit = hits.at(-1)!;
    expect(hit.path).toBe("/anthropic/v1/messages");
    // `x-api-key` is the Anthropic auth header; nothing may go via Bearer.
    expect(hit.authorization).toBe("");
    const body = JSON.parse(hit.body) as { system?: string; messages?: unknown[]; max_tokens?: number };
    expect(body.max_tokens).toBe(8);
    expect(body.system).toContain("health check");
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("speaks the Gemini generateContent contract", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "gemini",
      baseUrl: localBase("/gemini"),
      // The Gemini adapter authenticates with x-goog-api-key in the header,
      // which the hit record does not capture; the 400 body echo below proves
      // the header arrived.
      apiKey: "Zm9vYmFyYmF6cXV1eGtleTEyMzQ1Njc4OTA",
    });
    expect(created.statusCode).toBe(200);
    // This fixture answers 400 and echoes the header, so the test asserts both
    // that the call happened and that the key was scrubbed.
    const tested = await testModel(created.id);
    expect(tested.ok).toBe(false);
    const hit = hits.at(-1)!;
    expect(hit.path).toBe("/gemini/models/fake-chat:generateContent");
    const body = JSON.parse(hit.body) as {
      systemInstruction?: { parts?: Array<{ text?: string }> };
      contents?: unknown[];
      generationConfig?: { maxOutputTokens?: number };
    };
    expect(body.contents?.length).toBe(1);
    expect(body.generationConfig?.maxOutputTokens).toBe(8);
  });
});

describe("custom-http declarative mapping (self-hosted endpoints)", () => {
  it("maps a non-OpenAI embedding response onto the configured vector path", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "embedding",
      providerType: "custom-http",
      baseUrl: localBase("/custom-embed"),
      dimensions: 3,
      params: {
        path: "/score",
        inputField: "sentences",
        itemsPath: "output.embeddings",
        vectorPath: "values",
      },
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const searched = await search({ providers: [providerId], mode: "embedding", embedding: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.embeddingApplied).toBe(true);
    // The query and "结果 2" share a direction in this fixture.
    expect(searched.body.results[0]!.title).toContain("结果 2");
    const hit = hits.at(-1)!;
    expect(hit.path).toBe("/custom-embed/score");
    expect(JSON.parse(hit.body)).toMatchObject({ sentences: expect.any(Array) });
  });

  it("degrades when a custom embedding endpoint returns the wrong vector count", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "embedding",
      providerType: "custom-http",
      baseUrl: localBase("/custom-embed/score-mismatch"),
      dimensions: 3,
      params: {
        path: "/score",
        inputField: "sentences",
        itemsPath: "output.embeddings",
        vectorPath: "values",
      },
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const searched = await search({ providers: [providerId], mode: "embedding", embedding: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.embeddingApplied).toBe(false);
    expect(searched.body.stats.degraded).toBe(true);
    expect(searched.body.results.length).toBeGreaterThan(0);
  });

  it("maps a nested custom rerank response with a JSON-path config", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "rerank",
      providerType: "custom-http",
      baseUrl: localBase("/custom-rerank"),
      params: {
        path: "/rank",
        queryField: "question",
        documentField: "passages",
        resultsPath: "payload.scores",
        indexPath: "doc",
        scorePath: "prob",
      },
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const baseline = await search({ providers: [providerId], mode: "basic" });
    const fusedOrder = baseline.body.results.map((result) => result.url);
    const searched = await search({ providers: [providerId], mode: "rerank", rerank: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.rerankApplied).toBe(true);
    expect(searched.body.results[0]!.url).toBe(fusedOrder.at(-1));
    expect(JSON.parse(hits.at(-1)!.body)).toMatchObject({ question: expect.any(String), passages: expect.any(Array) });
  });
});

describe("embedding dimension contract", () => {
  it("fails and degrades when vectors do not match the configured dimension", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "embedding",
      providerType: "openai-compatible",
      baseUrl: localBase("/emb3"),
      dimensions: 8,
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const searched = await search({
      providers: [providerId],
      mode: "embedding",
      embedding: true,
    });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.embeddingApplied).toBe(false);
    expect(searched.body.stats.degraded).toBe(true);
    expect(searched.body.results.length).toBeGreaterThan(0);
    const message = searched.body.errors.find((item) => item.providerId === "embedding-model")?.message ?? "";
    expect(message).toMatch(/dimension mismatch/i);
    expect(message).toMatch(/returned 3/);
    expect(message).toMatch(/expects 8/);
    // A failed stage still costs time; the metric belongs in stats.timing.
    expect(searched.body.stats.timing?.embeddingMs).toBeGreaterThanOrEqual(0);
  });

  it("degrades when the embedding endpoint returns fewer vectors than inputs", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "embedding",
      providerType: "openai-compatible",
      baseUrl: localBase("/emb-badcount"),
      dimensions: 8,
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const searched = await search({ providers: [providerId], mode: "embedding", embedding: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.embeddingApplied).toBe(false);
    expect(searched.body.stats.degraded).toBe(true);
    const message = searched.body.errors.find((item) => item.providerId === "embedding-model")?.message ?? "";
    expect(message).toMatch(/1 vectors for \d+ inputs/);
  });

  it("applies matching vectors and re-orders results by similarity", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "embedding",
      providerType: "openai-compatible",
      baseUrl: localBase("/emb8"),
      dimensions: 8,
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const searched = await search({ providers: [providerId], mode: "embedding", embedding: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.embeddingApplied).toBe(true);
    expect(searched.body.stats.degraded).toBeUndefined();
    expect(searched.body.results[0]!.title).toContain("结果 3");
    expect(searched.body.results[0]!.metadata?.["embeddingScore"]).toBeCloseTo(1);
    expect(Number(searched.body.results[1]!.metadata?.["embeddingScore"])).toBeLessThan(1);
  });
});

describe("rerank response mapping", () => {
  it("maps Cohere-compatible results onto result URLs and scores", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "rerank",
      providerType: "cohere",
      baseUrl: localBase("/rerank"),
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();

    const baseline = await search({ providers: [providerId], mode: "basic" });
    expect(baseline.statusCode).toBe(200);
    const fusedOrder = baseline.body.results.map((result) => result.url);
    expect(fusedOrder.length).toBeGreaterThan(2);

    const searched = await search({ providers: [providerId], mode: "rerank", rerank: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.rerankApplied).toBe(true);
    expect(searched.body.stats.degraded).toBeUndefined();
    // The fake vendor scores later documents higher, so the mapping must invert.
    expect(searched.body.results[0]!.url).toBe(fusedOrder.at(-1));
    for (let index = 0; index < searched.body.results.length; index += 1) {
      const result = searched.body.results[index]!;
      expect(result.rerankScore).toBeGreaterThan(0);
      if (index > 0) {
        expect(result.rerankScore!).toBeLessThanOrEqual(searched.body.results[index - 1]!.rerankScore!);
      }
    }
  });

  it("degrades on a malformed rerank body without touching the base results", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "rerank",
      providerType: "cohere",
      baseUrl: localBase("/rerank-bad"),
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const baseline = await search({ providers: [providerId], mode: "basic" });
    const searched = await search({ providers: [providerId], mode: "rerank", rerank: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.rerankApplied).toBe(false);
    expect(searched.body.stats.degraded).toBe(true);
    expect(searched.body.results.map((result) => result.url)).toEqual(
      baseline.body.results.map((result) => result.url),
    );
    expect(searched.body.results.every((result) => result.rerankScore === undefined)).toBe(true);
  });
});

describe("AI summary citations only reference real results", () => {
  it("keeps [1]/[2] and drops a fabricated [9]", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/v1"),
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();
    const searched = await search({ providers: [providerId], mode: "rrf", summarize: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.summaryApplied).toBe(true);
    expect(searched.body.stats.degraded).toBeUndefined();
    const summary = searched.body.summary!;
    expect(summary.citations.map((citation) => citation.index)).toEqual([1, 2]);
    expect(summary.citations[0]!.url).toBe(searched.body.results[0]!.url);
    expect(summary.citations[0]!.title).toBe(searched.body.results[0]!.title);
    expect(summary.citations[1]!.url).toBe(searched.body.results[1]!.url);
    // The model text is preserved verbatim; only the citation list is filtered.
    expect(summary.text).toContain("[9]");
  });
});

describe("model traffic uses exactly one HTTP client", () => {
  it("obeys a non-URL policy switch, proving the call runs inside the shared SafeFetch", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/v1"),
    });
    expect(created.statusCode).toBe(200);

    // `allowHttp=false` is a policy only SafeFetch knows about, so a blocked
    // plain-HTTP call is direct evidence that model traffic is not using an
    // ad-hoc client of its own.
    const settings = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      cookies: { sh_session: cookie },
      headers: { "x-csrf-token": csrf },
      payload: { security: { allowHttp: false } },
    });
    expect(settings.statusCode).toBe(200);
    const before = hits.length;
    try {
      const blocked = await testModel(created.id);
      expect(blocked.ok).toBe(false);
      expect(blocked.message).toMatch(/plain HTTP destinations are disabled/i);
      expect(hits.length).toBe(before);
    } finally {
      await app.inject({
        method: "PUT",
        url: "/api/admin/settings",
        cookies: { sh_session: cookie },
        headers: { "x-csrf-token": csrf },
        payload: { security: { allowHttp: true } },
      });
    }
  });

  it("routes every model call through the injected SafeFetch (counting dispatcher)", async () => {
    await setAllowlist(["127.0.0.1"]);
    const created = await createModel({
      kind: "chat",
      providerType: "openai-compatible",
      baseUrl: localBase("/v1"),
    });
    expect(created.statusCode).toBe(200);
    const providerId = await addProvider();

    // Replace the client injected into ModelService with a counter that
    // delegates to the real one. An adapter holding its own HTTP client would
    // leave the counter at zero while still reaching the fake vendor.
    const original = ctx.fetch;
    let counted = 0;
    ctx.models.setFetch((url, init) => {
      counted += 1;
      return original(url, init);
    });
    const before = hits.length;
    try {
      const searched = await search({ providers: [providerId], mode: "rrf", summarize: true });
      expect(searched.statusCode).toBe(200);
      expect(searched.body.stats.summaryApplied).toBe(true);
      expect(counted).toBe(1);
      expect(hits.length).toBe(before + 1);
    } finally {
      ctx.models.setFetch(original);
    }
  });

  it("makes zero model calls for a basic search", async () => {
    await setAllowlist(["127.0.0.1"]);
    await createModel({ kind: "chat", providerType: "openai-compatible", baseUrl: localBase("/v1") });
    await createModel({
      kind: "embedding",
      providerType: "openai-compatible",
      baseUrl: localBase("/emb8"),
      dimensions: 8,
    });
    await createModel({ kind: "rerank", providerType: "cohere", baseUrl: localBase("/rerank") });
    const providerId = await addProvider();
    const before = hits.length;
    const searched = await search({
      providers: [providerId],
      mode: "basic",
      rerank: false,
      embedding: false,
      summarize: false,
    });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.results.length).toBeGreaterThan(0);
    expect(hits.length).toBe(before);
  });

  it("counts exactly one chat call when summarization is enabled", async () => {
    await setAllowlist(["127.0.0.1"]);
    await createModel({ kind: "chat", providerType: "openai-compatible", baseUrl: localBase("/v1") });
    const providerId = await addProvider();
    const before = hits.length;
    const searched = await search({ providers: [providerId], mode: "rrf", summarize: true });
    expect(searched.statusCode).toBe(200);
    expect(searched.body.stats.summaryApplied).toBe(true);
    const modelHits = hits.slice(before);
    expect(modelHits).toHaveLength(1);
    expect(modelHits[0]!.path).toBe("/v1/chat/completions");
    expect(modelHits[0]!.authorization).toBe(`Bearer ${KEY_FINGERPRINT}`);
  });

  it("routes model traffic through the deployment proxy, not a direct socket", async () => {
    // A forward proxy proves the model call leaves through the same egress path
    // as provider traffic: a private HTTP client would dial the origin directly
    // and never produce a CONNECT.
    const connectHits: string[] = [];
    const proxy = createServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "proxy expects CONNECT" } }));
    });
    proxy.on("connect", (request, clientSocket, head) => {
      connectHits.push(request.url ?? "");
      // Tunnel to the local fake vendor instead of the requested host so the
      // test needs no external network. The origin the adapter asked for is
      // recorded above.
      const upstream = netConnect(modelPort, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;

    const proxyDir = mkdtempSync(join(tmpdir(), "search-hub-model-proxy-"));
    const proxyCtx = createContext({
      ...testConfig(proxyDir),
      dbPath: join(proxyDir, "proxy.db"),
      outboundProxy: { proxy: `http://127.0.0.1:${proxyPort}`, source: "explicit" },
    });
    const proxyApp = await buildApp(proxyCtx);
    await proxyApp.ready();
    try {
      const setup = await proxyApp.inject({
        method: "POST",
        url: "/api/setup",
        payload: {
          email: "admin@example.com",
          password: "A-very-long-password-1",
          name: "Admin",
          setupToken: proxyCtx.setupToken.value!,
        },
      });
      const proxyCookie = setup.cookies.find((item) => item.name === "sh_session")!.value;
      const proxyCsrf = setup.json().csrfToken as string;
      const created = await proxyApp.inject({
        method: "POST",
        url: "/api/admin/models",
        cookies: { sh_session: proxyCookie },
        headers: { "x-csrf-token": proxyCsrf },
        payload: {
          kind: "chat",
          name: "proxied-chat",
          providerType: "openai-compatible",
          baseUrl: "http://1.2.3.4:8080/v1",
          apiKey: KEY_FINGERPRINT,
          modelId: "proxied-model",
          batchSize: 8,
          timeoutMs: 8_000,
          maxConcurrency: 1,
          enabled: true,
          isDefault: true,
        },
      });
      expect(created.statusCode).toBe(200);
      const hitsBefore = hits.length;
      const tested = await proxyApp.inject({
        method: "POST",
        url: `/api/admin/models/${(created.json() as { id: string }).id}/test`,
        cookies: { sh_session: proxyCookie },
        headers: { "x-csrf-token": proxyCsrf },
      });
      expect(tested.statusCode).toBe(200);
      expect(tested.json().ok, `model test said: ${String(tested.json().message)}`).toBe(true);
      // The proxy, not the process, resolved the destination.
      expect(connectHits).toEqual(["1.2.3.4:8080"]);
      expect(hits.slice(hitsBefore).map((hit) => hit.path)).toEqual(["/v1/chat/completions"]);
    } finally {
      await proxyApp.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      rmSync(proxyDir, { recursive: true, force: true });
    }
  });

  it("has no direct HTTP client inside the model package", () => {
    // Vitest may rewrite import.meta.url; the repo root is the process cwd.
    const root = join(process.cwd(), "packages", "models", "src");
    const adapters = ["chat.ts", "embeddings.ts", "rerank.ts"];
    // The real intent: there is exactly one HTTP client in the process, and the
    // model package must not bring its own.
    const forbidden = [
      /globalThis\.fetch\s*\(/,
      /\bundiciFetch\s*\(/,
      /from\s+["']undici["']/,
      /require\(\s*["']undici["']\s*\)/,
      /["']node:https?["']/,
      /from\s+["'](?:axios|got|node-fetch|superagent)["']/,
      /\bhttps?\.request\s*\(/,
    ];
    // `index.ts` is a barrel of re-exports, so it is only checked for imports.
    for (const file of [...adapters, "pipeline.ts", "index.ts", "redact.ts"]) {
      const source = readFileSync(join(root, file), "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} must not create its own HTTP client (${pattern})`).not.toMatch(pattern);
      }
    }
    // Every adapter must reach the network only through the injected SafeFetch.
    for (const file of adapters) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, `${file} must use the injected SafeFetch`).toMatch(/deps\.fetch/);
      expect(source, `${file} must scrub the API key from errors`).toMatch(
        /scrubbingFetch\(deps\.fetch, deps\.apiKey\)/,
      );
    }
    // The API service must obtain its fetch from the injected context, never construct one.
    const service = readFileSync(join(process.cwd(), "apps", "api", "src", "services", "models.ts"), "utf8");
    expect(service).toMatch(/this\.fetchFor\(\)|fetchImpl/);
    expect(service).not.toMatch(/createSafeFetch|globalThis\.fetch|from\s+["']undici["']/);
  });
});
