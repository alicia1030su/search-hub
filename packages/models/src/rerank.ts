import {
  SearchHubError,
  type ModelConfig,
  type RerankDocument,
  type RerankResponse,
  type SafeFetch,
} from "@search-hub/shared";
import { scrubbingFetch } from "./redact.js";

export interface RerankDeps {
  fetch: SafeFetch;
  apiKey?: string;
}

export interface RerankModel {
  config: ModelConfig;
  rerank(query: string, documents: RerankDocument[], topK?: number): Promise<RerankResponse>;
}

interface CohereRerankResponse {
  results?: Array<{ index?: number; relevance_score?: number; document?: unknown }>;
}

interface CustomRerankConfig {
  path?: string;
  resultsPath?: string;
  indexPath?: string;
  scorePath?: string;
  documentField?: string;
  queryField?: string;
}

/**
 * Cohere/Jina/SiliconFlow share the same /v1/rerank contract.
 * A declarative custom-http mode covers other self-hosted rerankers.
 */
export function createRerankModel(config: ModelConfig, deps: RerankDeps): RerankModel {
  const safeDeps: RerankDeps = { ...deps, fetch: scrubbingFetch(deps.fetch, deps.apiKey) };
  return {
    config,
    async rerank(query, documents, topK) {
      if (documents.length === 0) return { results: [], modelId: config.modelId };
      const maxChars =
        typeof (config.params as Record<string, unknown>)["maxDocChars"] === "number"
          ? Number((config.params as Record<string, unknown>)["maxDocChars"])
          : 2000;
      const truncated = documents.map((doc) => ({
        id: doc.id,
        text: doc.text.length > maxChars ? `${doc.text.slice(0, maxChars)}…` : doc.text,
      }));

      const ranked =
        config.providerType === "custom-http"
          ? await rerankCustom(config, safeDeps, query, truncated, topK)
          : await rerankCohereCompatible(config, safeDeps, query, truncated, topK);

      const byId = new Map(documents.map((doc, index) => [doc.id, index] as const));
      const results = ranked
        .map((item) => {
          const fallbackIndex = item.index ?? 0;
          const id = documents[fallbackIndex]?.id ?? "";
          const index = byId.get(id) ?? fallbackIndex;
          return { id, score: item.score, index };
        })
        .filter((item) => item.id !== "" && Number.isFinite(item.score))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK ?? documents.length);

      return { results, modelId: config.modelId };
    },
  };
}

async function rerankCohereCompatible(
  config: ModelConfig,
  deps: RerankDeps,
  query: string,
  documents: Array<{ id: string; text: string }>,
  topK?: number,
): Promise<Array<{ index?: number; score: number }>> {
  if (!deps.apiKey) {
    throw new SearchHubError("validation_error", `Rerank model ${config.name} requires an API key`);
  }
  const response = await deps.fetch<CohereRerankResponse>(
    `${config.baseUrl.replace(/\/+$/, "")}/v1/rerank`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        query,
        documents: documents.map((doc) => doc.text),
        top_n: topK ?? documents.length,
        return_documents: false,
      }),
      timeoutMs: config.timeoutMs,
    },
  );

  const raw = response.data?.results;
  if (!Array.isArray(raw)) {
    throw new SearchHubError("server_error", `Rerank model ${config.name} returned no results array`);
  }
  return raw.map((item) => ({ index: item.index, score: Number(item.relevance_score ?? 0) }));
}

async function rerankCustom(
  config: ModelConfig,
  deps: RerankDeps,
  query: string,
  documents: Array<{ id: string; text: string }>,
  topK?: number,
): Promise<Array<{ index?: number; score: number }>> {
  const cfg = config.params as CustomRerankConfig;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.apiKey) headers["authorization"] = `Bearer ${deps.apiKey}`;
  const path = cfg.path ?? "/rerank";

  const response = await deps.fetch<Record<string, unknown>>(
    `${config.baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.modelId,
        [cfg.queryField ?? "query"]: query,
        [cfg.documentField ?? "documents"]: documents.map((doc) => doc.text),
        top_n: topK ?? documents.length,
      }),
      timeoutMs: config.timeoutMs,
    },
  );

  const resultsPath = cfg.resultsPath ?? "results";
  const rawResults = resolvePath(response.data, resultsPath);
  if (!Array.isArray(rawResults)) {
    throw new SearchHubError(
      "server_error",
      `Custom rerank endpoint returned no array at "${resultsPath}"`,
    );
  }
  return rawResults.map((item) => ({
    index: Number(resolvePath(item, cfg.indexPath ?? "index") ?? 0),
    score: Number(resolvePath(item, cfg.scorePath ?? "relevance_score") ?? 0),
  }));
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
