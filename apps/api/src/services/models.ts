import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  SearchHubError,
  hostIsAllowlisted,
  isBlockedAddress,
  type ModelConfig,
  type ModelKind,
  type ModelProviderType,
  type SafeFetch,
  type SsrfPolicy,
} from "@search-hub/shared";
import type { ChatModel as ChatModelImpl } from "@search-hub/models";
import { createChatModel, createEmbeddingModel, createRerankModel, scrubSecrets } from "@search-hub/models";
import type { SearchHubDb } from "@search-hub/db";
import { modelConfigs } from "@search-hub/db";
import type { SecretBox } from "../security/crypto.js";
import type { ResourceBudgetController } from "./resource-budget.js";

export interface ModelRowShape {
  id: string;
  kind: string;
  name: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  dimensions: number | null;
  batchSize: number;
  timeoutMs: number;
  maxConcurrency: number;
  paramsJson: string;
  enabled: boolean;
  isDefault: boolean;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
  apiKeyHint: string | null;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Cloud metadata endpoints. Never reachable, allowlisted or not. */
const ALWAYS_BLOCKED_ADDRESSES = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);

/**
 * Decodes an IPv4-mapped IPv6 literal (`::ffff:a9fe:a9fe`) so the metadata check
 * sees the same address as the dotted form. The URL parser emits the compressed
 * hex spelling for `[::ffff:169.254.169.254]`, which no string comparison
 * against a dotted quad would match.
 */
function normalizedHostname(hostname: string): string {
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (!mapped) return hostname;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** Hostnames that are private by construction, so no DNS answer can save them. */
function isLocalName(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal"
  );
}

/**
 * Fail-fast check applied when a model configuration is created or updated.
 *
 * This is deliberately **static**: it only judges what can be decided without a
 * DNS lookup (IP literals, localhost-style names, metadata addresses). Hostnames
 * are still resolved and validated on every request by `SafeFetch`, so a
 * temporarily unreachable DNS server never blocks an operator from saving a
 * configuration, and a hostname that later resolves to a private address is
 * still rejected at call time.
 *
 * Storing a configuration that can never work is a footgun: the operator sees a
 * successful save and a degraded search later. Rejecting it here turns that into
 * one actionable error message. The decision matches the runtime policy exactly
 * (private / reserved / metadata are blocked unless allowlisted; public
 * addresses are untouched), so nothing that used to work is refused.
 */
export function assertModelBaseUrlAllowed(baseUrl: string, policy: SsrfPolicy): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new SearchHubError("validation_error", `Model base URL is not a valid URL: ${baseUrl}`);
  }
  const rawHostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  // A cloud metadata address is never reachable, allowlisted or not. Check both
  // the literal and the decoded IPv4-mapped spelling.
  if (
    ALWAYS_BLOCKED_ADDRESSES.has(rawHostname) ||
    ALWAYS_BLOCKED_ADDRESSES.has(normalizedHostname(rawHostname))
  ) {
    throw new SearchHubError(
      "blocked",
      `Model base URL ${rawHostname} is a cloud metadata endpoint and is never allowed, allowlist or not.`,
      { details: { host: rawHostname } },
    );
  }

  const family = isIP(rawHostname);
  const privateByNature = family !== 0 ? isBlockedAddress(rawHostname) : isLocalName(rawHostname);
  if (!privateByNature) return; // public address or a hostname checked per request
  if (hostIsAllowlisted(rawHostname, policy.allowPrivateHosts)) return;
  throw new SearchHubError(
    "blocked",
    `Model base URL ${rawHostname} is a private or reserved address. ` +
      "Add it to the private host allowlist in Settings if this is intentional.",
    { details: { host: rawHostname } },
  );
}

/**
 * Model configuration + adapter factory. API keys are encrypted at rest and
 * never included in list responses.
 */
export class ModelService {
  private resourceBudget?: Pick<ResourceBudgetController, "budgetFor">;

  constructor(
    private readonly db: SearchHubDb,
    private readonly secrets: SecretBox,
  ) {}

  list(kind?: ModelKind): ModelConfig[] {
    const rows = kind
      ? this.db.select().from(modelConfigs).where(eq(modelConfigs.kind, kind)).all()
      : this.db.select().from(modelConfigs).all();
    return rows.map((row) => this.toModel(row));
  }

  get(id: string): ModelConfig | null {
    const row = this.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get();
    return row ? this.toModel(row) : null;
  }

  /**
   * Resolves an explicitly requested model **only if it is enabled**.
   *
   * `get()` returns a disabled row as-is, so `?chatModelId=<disabled>` used to
   * bypass the enable switch entirely and spend money on a model an operator had
   * turned off. The admin-only test endpoint still uses `get()` on purpose: an
   * administrator must be able to probe a disabled model before enabling it.
   */
  getEnabled(id: string, kind: ModelKind): ModelConfig {
    const config = this.get(id);
    if (!config) {
      throw new SearchHubError("not_found", `Model ${id} not found`);
    }
    if (config.kind !== kind) {
      throw new SearchHubError(
        "validation_error",
        `Model ${id} is a ${config.kind} model, not ${kind}.`,
      );
    }
    if (!config.enabled) {
      throw new SearchHubError(
        "validation_error",
        `Model "${config.name}" is disabled. Enable it in AI Models before using it in a request.`,
      );
    }
    return config;
  }

  getRow(id: string): typeof modelConfigs.$inferSelect | null {
    return this.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get() ?? null;
  }

  /**
   * Resolves the model a request would actually use, without building it.
   *
   * Used by the cache key: the fingerprint must describe the model that runs,
   * including the default selected when the caller passed no id. Returning
   * `null` (rather than throwing) keeps the key path free of side effects when
   * an optional stage is disabled.
   */
  resolveConfig(id: string | undefined, kind: ModelKind): ModelConfig | null {
    return id ? this.getEnabled(id, kind) : this.findDefault(kind);
  }

  findDefault(kind: ModelKind): ModelConfig | null {
    const row = this.db
      .select()
      .from(modelConfigs)
      .where(and(eq(modelConfigs.kind, kind), eq(modelConfigs.enabled, true)))
      .all()
      .find((item) => item.isDefault);
    if (row) return this.toModel(row);
    const fallback = this.db
      .select()
      .from(modelConfigs)
      .where(and(eq(modelConfigs.kind, kind), eq(modelConfigs.enabled, true)))
      .all()[0];
    return fallback ? this.toModel(fallback) : null;
  }

  chatModel(id?: string): ChatModelImpl {
    const config = id ? this.getEnabled(id, "chat") : this.findDefault("chat");
    if (!config || config.kind !== "chat") {
      throw new SearchHubError("validation_error", "No chat model is configured. Add one in AI Models.");
    }
    return createChatModel(config, { fetch: this.fetchFor(), apiKey: this.apiKeyFor(config.id) });
  }

  embeddingModel(id?: string) {
    const config = id ? this.getEnabled(id, "embedding") : this.findDefault("embedding");
    if (!config || config.kind !== "embedding") {
      throw new SearchHubError(
        "validation_error",
        "No embedding model is configured. Add one in AI Models.",
      );
    }
    return createEmbeddingModel(config, {
      fetch: this.fetchFor(),
      apiKey: this.apiKeyFor(config.id),
      ...(this.resourceBudget ? { batchSize: () => this.resourceBudget!.budgetFor("embeddingBatch") } : {}),
    });
  }

  rerankModel(id?: string) {
    const config = id ? this.getEnabled(id, "rerank") : this.findDefault("rerank");
    if (!config || config.kind !== "rerank") {
      throw new SearchHubError("validation_error", "No rerank model is configured. Add one in AI Models.");
    }
    return createRerankModel(config, {
      fetch: this.fetchFor(),
      apiKey: this.apiKeyFor(config.id),
      ...(this.resourceBudget ? { batchSize: () => this.resourceBudget!.budgetFor("embeddingBatch") } : {}),
    });
  }

  /** Used by the model test endpoint; always exercises the real network path. */
  async test(id: string, fetchImpl: SafeFetch): Promise<{
    ok: boolean;
    latencyMs: number;
    message: string;
    detail?: unknown;
  }> {
    const config = this.get(id);
    if (!config) throw new SearchHubError("not_found", "Model not found");
    const started = Date.now();
    try {
      if (config.kind === "chat") {
        const chat = createChatModel(config, {
          fetch: fetchImpl,
          apiKey: this.apiKeyFor(id),
        });
        const result = await chat.complete(
          [
            { role: "system", content: "You are a health check. Reply with the single word OK." },
            { role: "user", content: "ping" },
          ],
          { temperature: 0, maxTokens: 8 },
        );
        this.recordTest(id, true, null);
        return {
          ok: true,
          latencyMs: Date.now() - started,
          message: `Chat model responded in ${Date.now() - started}ms`,
          detail: { sample: result.text.slice(0, 80) },
        };
      }
      if (config.kind === "embedding") {
        const embedding = createEmbeddingModel(config, {
          fetch: fetchImpl,
          apiKey: this.apiKeyFor(id),
        });
        const result = await embedding.embed(["search hub health check"]);
        this.recordTest(id, true, null);
        return {
          ok: true,
          latencyMs: Date.now() - started,
          message: `Embedding model returned ${result.dimensions} dimensions`,
          detail: { dimensions: result.dimensions },
        };
      }
      const rerank = createRerankModel(config, {
        fetch: fetchImpl,
        apiKey: this.apiKeyFor(id),
      });
      const result = await rerank.rerank(
        "search hub",
        [
          { id: "a", text: "Search Hub is a search aggregation platform" },
          { id: "b", text: "A recipe for chocolate cake" },
        ],
        2,
      );
      this.recordTest(id, true, null);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `Rerank model returned ${result.results.length} scored documents`,
        detail: { results: result.results },
      };
    } catch (error) {
      // Defence in depth: the adapters already scrub, but a vendor (or a proxy
      // in front of it) may echo the credential in an error body. This message
      // is shown in the UI *and* persisted to SQLite, so it is scrubbed again
      // against the decrypted key before it is stored.
      const apiKey = this.apiKeyFor(id);
      const message = scrubSecrets(error instanceof Error ? error.message : String(error), [apiKey]);
      this.recordTest(id, false, message.slice(0, 500));
      return { ok: false, latencyMs: Date.now() - started, message };
    }
  }

  apiKeyFor(id: string): string | undefined {
    const row = this.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get();
    if (!row?.apiKeyCiphertext || !row.apiKeyIv || !row.apiKeyTag) return undefined;
    try {
      return this.secrets.decrypt({
        ciphertext: row.apiKeyCiphertext,
        iv: row.apiKeyIv,
        tag: row.apiKeyTag,
        version: 1,
      });
    } catch {
      return undefined;
    }
  }

  private recordTest(id: string, ok: boolean, error: string | null): void {
    this.db
      .update(modelConfigs)
      .set({
        lastTestOk: ok,
        lastTestAt: new Date().toISOString(),
        lastTestError: error,
      })
      .where(eq(modelConfigs.id, id))
      .run();
  }

  private toModel(row: typeof modelConfigs.$inferSelect): ModelConfig {
    return {
      id: row.id,
      kind: row.kind as ModelKind,
      name: row.name,
      providerType: row.providerType as ModelProviderType,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      dimensions: row.dimensions,
      batchSize: row.batchSize,
      timeoutMs: row.timeoutMs,
      maxConcurrency: row.maxConcurrency,
      params: parseJson<Record<string, unknown>>(row.paramsJson, {}),
      enabled: row.enabled,
      isDefault: row.isDefault,
      lastTestOk: row.lastTestOk,
      lastTestAt: row.lastTestAt,
      lastTestError: row.lastTestError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private fetchFor(): SafeFetch {
    return this.fetchImpl;
  }

  private fetchImpl!: SafeFetch;

  /** Injected once by the runtime so model calls share the SSRF policy. */
  setFetch(fetchImpl: SafeFetch): void {
    this.fetchImpl = fetchImpl;
  }

  /** Injected once by the runtime so model batches share the resource budget. */
  setResourceBudget(budget: Pick<ResourceBudgetController, "budgetFor">): void {
    this.resourceBudget = budget;
  }
}
