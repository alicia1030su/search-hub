import {
  SearchHubError,
  type ChatCompletionOptions,
  type ChatMessage,
  type ChatResult,
  type ModelConfig,
  type SafeFetch,
} from "@search-hub/shared";
import { scrubbingFetch } from "./redact.js";

export interface ModelDeps {
  fetch: SafeFetch;
  apiKey?: string;
}

export interface ChatModel {
  config: ModelConfig;
  complete(messages: ChatMessage[], options?: ChatCompletionOptions): Promise<ChatResult>;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Chat adapters. Each returns plain text; callers own prompt construction and
 * citation handling so retriever content is always treated as untrusted data.
 */
export function createChatModel(config: ModelConfig, deps: ModelDeps): ChatModel {
  // Every error that escapes this adapter is scrubbed of the API key first; a
  // vendor or proxy that echoes the Authorization header must not turn an error
  // message into a credential leak.
  const safeDeps: ModelDeps = { ...deps, fetch: scrubbingFetch(deps.fetch, deps.apiKey) };
  return {
    config,
    async complete(messages, options = {}) {
      const params = config.params as Record<string, unknown>;
      const temperature =
        options.temperature ?? (typeof params["temperature"] === "number" ? params["temperature"] : 0.2);
      const maxTokens =
        options.maxTokens ?? (typeof params["maxTokens"] === "number" ? params["maxTokens"] : 800);

      if (config.providerType === "anthropic") {
        return callAnthropic(config, safeDeps, messages, { temperature, maxTokens, ...options });
      }
      if (config.providerType === "gemini") {
        return callGemini(config, safeDeps, messages, { temperature, maxTokens, ...options });
      }
      return callOpenAICompatible(config, safeDeps, messages, { temperature, maxTokens, ...options });
    },
  };
}

async function callOpenAICompatible(
  config: ModelConfig,
  deps: ModelDeps,
  messages: ChatMessage[],
  options: ChatCompletionOptions & { temperature: number; maxTokens: number },
): Promise<ChatResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.apiKey) headers["authorization"] = `Bearer ${deps.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.modelId,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: false,
  };
  if (options.json) body["response_format"] = { type: "json_object" };

  const response = await deps.fetch<OpenAIChatResponse>(joinUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs: config.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

    const data = response.data;
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) {
    throw new SearchHubError("server_error", `Model ${config.name} returned an empty completion`);
  }
  return {
    text: text.trim(),
    modelId: config.modelId,
    usage: {
      ...(data?.usage?.prompt_tokens === undefined ? {} : { promptTokens: data.usage.prompt_tokens }),
      ...(data?.usage?.completion_tokens === undefined
        ? {}
        : { completionTokens: data.usage.completion_tokens }),
    },
  };
}

async function callAnthropic(
  config: ModelConfig,
  deps: ModelDeps,
  messages: ChatMessage[],
  options: ChatCompletionOptions & { temperature: number; maxTokens: number },
): Promise<ChatResult> {
  if (!deps.apiKey) {
    throw new SearchHubError("validation_error", `Model ${config.name} requires an API key`);
  }
  const system = messages.filter((message) => message.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((message) => message.role !== "system");

  const response = await deps.fetch<AnthropicResponse>(joinUrl(config.baseUrl, "/v1/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": deps.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      ...(system ? { system } : {}),
      messages: rest.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
    }),
    timeoutMs: config.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const data = response.data;
  const text = (data?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!text) throw new SearchHubError("server_error", `Model ${config.name} returned an empty completion`);
  return {
    text,
    modelId: config.modelId,
    usage: {
      ...(data?.usage?.input_tokens === undefined ? {} : { promptTokens: data.usage.input_tokens }),
      ...(data?.usage?.output_tokens === undefined
        ? {}
        : { completionTokens: data.usage.output_tokens }),
    },
  };
}

async function callGemini(
  config: ModelConfig,
  deps: ModelDeps,
  messages: ChatMessage[],
  options: ChatCompletionOptions & { temperature: number; maxTokens: number },
): Promise<ChatResult> {
  if (!deps.apiKey) {
    throw new SearchHubError("validation_error", `Model ${config.name} requires an API key`);
  }
  const base = config.baseUrl.replace(/\/+$/, "");
  const url = `${base}/models/${encodeURIComponent(config.modelId)}:generateContent`;
  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const contents = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const response = await deps.fetch<GeminiResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": deps.apiKey },
    body: JSON.stringify({
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      contents,
      generationConfig: { temperature: options.temperature, maxOutputTokens: options.maxTokens },
    }),
    timeoutMs: config.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const data = response.data;
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("").trim();
  if (!text) throw new SearchHubError("server_error", `Model ${config.name} returned an empty completion`);
  return {
    text,
    modelId: config.modelId,
    usage: {
      ...(data?.usageMetadata?.promptTokenCount === undefined
        ? {}
        : { promptTokens: data.usageMetadata.promptTokenCount }),
      ...(data?.usageMetadata?.candidatesTokenCount === undefined
        ? {}
        : { completionTokens: data.usageMetadata.candidatesTokenCount }),
    },
  };
}
