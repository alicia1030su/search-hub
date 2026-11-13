import { and, eq } from "drizzle-orm";
import {
  SearchHubError,
  type ModelConfig,
  type ModelKind,
  type ModelProviderType,
  type SafeFetch,
} from "@search-hub/shared";
import type { ChatModel as ChatModelImpl } from "@search-hub/models";
import { createChatModel, createEmbeddingModel, createRerankModel } from "@search-hub/models";
import type { SearchHubDb } from "@search-hub/db";
import { modelConfigs } from "@search-hub/db";
import type { SecretBox } from "../security/crypto.js";

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

/**
 * Model configuration + adapter factory. API keys are encrypted at rest and
 * never included in list responses.
 */
export class ModelService {
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

  getRow(id: string): typeof modelConfigs.$inferSelect | null {
    return this.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get() ?? null;
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
    const config = id ? this.get(id) : this.findDefault("chat");
    if (!config || config.kind !== "chat") {
      throw new SearchHubError("validation_error", "No chat model is configured. Add one in AI Models.");
    }
    return createChatModel(config, { fetch: this.fetchFor(), apiKey: this.apiKeyFor(config.id) });
  }

  embeddingModel(id?: string) {
    const config = id ? this.get(id) : this.findDefault("embedding");
    if (!config || config.kind !== "embedding") {
      throw new SearchHubError(
        "validation_error",
        "No embedding model is configured. Add one in AI Models.",
      );
    }
    return createEmbeddingModel(config, {
      fetch: this.fetchFor(),
      apiKey: this.apiKeyFor(config.id),
    });
  }

  rerankModel(id?: string) {
    const config = id ? this.get(id) : this.findDefault("rerank");
    if (!config || config.kind !== "rerank") {
      throw new SearchHubError("validation_error", "No rerank model is configured. Add one in AI Models.");
    }
    return createRerankModel(config, {
      fetch: this.fetchFor(),
      apiKey: this.apiKeyFor(config.id),
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
      const message = error instanceof Error ? error.message : String(error);
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
}
