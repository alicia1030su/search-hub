import { SearchHubError, type EmbeddingResult, type ModelConfig, type SafeFetch } from "@search-hub/shared";
import { scrubbingFetch } from "./redact.js";

export interface EmbeddingDeps {
  fetch: SafeFetch;
  apiKey?: string;
}

export interface EmbeddingModel {
  config: ModelConfig;
  embed(texts: string[]): Promise<EmbeddingResult>;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
}

interface CustomEmbeddingResponse {
  [key: string]: unknown;
}

/**
 * Embedding adapter with dimension validation.
 * A vector whose length does not match the configured dimension is rejected,
 * which prevents mixing incompatible vectors in a later index.
 */
export function createEmbeddingModel(config: ModelConfig, deps: EmbeddingDeps): EmbeddingModel {
  const safeDeps: EmbeddingDeps = { ...deps, fetch: scrubbingFetch(deps.fetch, deps.apiKey) };
  return {
    config,
    async embed(texts) {
      if (texts.length === 0) return { vectors: [], modelId: config.modelId, dimensions: config.dimensions ?? 0 };
      const vectors =
        config.providerType === "custom-http"
          ? await embedCustom(config, safeDeps, texts)
          : await embedOpenAICompatible(config, safeDeps, texts);

      const dimension = vectors[0]?.length ?? 0;
      if (dimension === 0) {
        throw new SearchHubError("server_error", `Embedding model ${config.name} returned empty vectors`);
      }
      if (config.dimensions !== null && config.dimensions !== dimension) {
        throw new SearchHubError(
          "validation_error",
          `Embedding dimension mismatch: model returned ${dimension}, configuration expects ${config.dimensions}. ` +
            "Update the model configuration before indexing.",
        );
      }
      for (const vector of vectors) {
        if (vector.length !== dimension) {
          throw new SearchHubError(
            "server_error",
            `Embedding model ${config.name} returned inconsistent vector dimensions`,
          );
        }
      }
      return { vectors, modelId: config.modelId, dimensions: dimension };
    },
  };
}

async function embedOpenAICompatible(
  config: ModelConfig,
  deps: EmbeddingDeps,
  texts: string[],
): Promise<number[][]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.apiKey) headers["authorization"] = `Bearer ${deps.apiKey}`;

  const batchSize = Math.max(1, Math.min(config.batchSize, 256));
  const output: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const response = await deps.fetch<OpenAIEmbeddingResponse>(
      `${config.baseUrl.replace(/\/+$/, "")}/embeddings`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.modelId, input: batch }),
        timeoutMs: config.timeoutMs,
      },
    );
    const data = response.data?.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new SearchHubError(
        "server_error",
        `Embedding model ${config.name} returned ${Array.isArray(data) ? data.length : 0} vectors for ${batch.length} inputs`,
      );
    }
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const item of sorted) {
      if (!Array.isArray(item.embedding)) {
        throw new SearchHubError("server_error", `Embedding model ${config.name} returned a malformed vector`);
      }
      output.push(item.embedding);
    }
  }
  return output;
}

interface CustomEmbeddingConfig {
  path?: string;
  inputField?: string;
  itemsPath?: string;
  vectorPath?: string;
}

async function embedCustom(
  config: ModelConfig,
  deps: EmbeddingDeps,
  texts: string[],
): Promise<number[][]> {
  const cfg = config.params as CustomEmbeddingConfig;
  const path = cfg.path ?? "/embeddings";
  const inputField = cfg.inputField ?? "input";
  const itemsPath = cfg.itemsPath ?? "data";
  const vectorPath = cfg.vectorPath ?? "embedding";

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.apiKey) headers["authorization"] = `Bearer ${deps.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.modelId,
    [inputField]: texts,
  };

  const response = await deps.fetch<CustomEmbeddingResponse>(
    `${config.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
    { method: "POST", headers, body: JSON.stringify(body), timeoutMs: config.timeoutMs },
  );

  const resolved = resolvePath(response.data, itemsPath);
  const items = Array.isArray(resolved) ? resolved : null;
  if (!items || items.length === 0) {
    throw new SearchHubError(
      "server_error",
      `Custom embedding endpoint returned no items at "${itemsPath}"`,
    );
  }
  return items.map((item) => {
    const vector = resolvePath(item, vectorPath);
    if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
      throw new SearchHubError(
        "server_error",
        `Custom embedding endpoint returned an invalid vector at "${vectorPath}"`,
      );
    }
    return vector as number[];
  });
}

function resolvePath(input: unknown, path: string): unknown {
  if (!path) return input;
  const tokens = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current: unknown = input;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = current[Number(token)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
