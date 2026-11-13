import { z } from "zod";

export const freshnessSchema = z.enum(["day", "week", "month", "year", "all"]);
export const searchModeSchema = z.enum([
  "basic",
  "rrf",
  "rerank",
  "embedding",
  "embedding_rerank",
  "rerank_summary",
  "deep",
]);
export const keyStrategySchema = z.enum([
  "round_robin",
  "random",
  "weighted_random",
  "least_used",
  "failover",
]);

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(2000),
  providers: z.array(z.string().min(1)).max(50).optional(),
  group: z.string().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  perProviderLimit: z.number().int().min(1).max(50).optional(),
  language: z.string().min(1).max(24).optional(),
  freshness: freshnessSchema.optional(),
  mode: searchModeSchema.default("basic"),
  rerank: z.boolean().optional(),
  embedding: z.boolean().optional(),
  summarize: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  includeRaw: z.boolean().optional(),
  rerankModelId: z.string().optional(),
  embeddingModelId: z.string().optional(),
  chatModelId: z.string().optional(),
});

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  baseUrl: httpUrl.nullish(),
  timeoutMs: z.number().int().min(500).max(120_000).default(12_000),
  maxConcurrency: z.number().int().min(1).max(64).default(4),
  priority: z.number().int().min(0).max(1000).default(100),
  weight: z.number().int().min(1).max(1000).default(100),
  maxRetries: z.number().int().min(0).max(5).default(1),
  language: z.string().max(24).nullish(),
  freshness: freshnessSchema.nullish(),
  resultsPerPage: z.number().int().min(1).max(50).default(10),
  rpmLimit: z.number().int().min(1).max(100_000).default(60),
  dailyQuota: z.number().int().min(1).max(10_000_000).nullish(),
  keyStrategy: keyStrategySchema.default("round_robin"),
  cooldownMs: z.number().int().min(1000).max(3_600_000).default(30_000),
  breakerThreshold: z.number().int().min(1).max(100).default(5),
  breakerCooldownMs: z.number().int().min(1000).max(3_600_000).default(60_000),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const providerUpdateSchema = providerCreateSchema.partial();

export const keyCreateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  key: z.string().trim().min(1).max(8192),
  weight: z.number().int().min(1).max(1000).default(100),
  enabled: z.boolean().default(true),
});

export const keyUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  key: z.string().trim().min(1).max(8192).optional(),
  weight: z.number().int().min(1).max(1000).optional(),
  enabled: z.boolean().optional(),
});

export const modelCreateSchema = z.object({
  kind: z.enum(["chat", "embedding", "rerank"]),
  name: z.string().trim().min(1).max(80),
  providerType: z.enum(["openai-compatible", "anthropic", "gemini", "cohere", "jina", "custom-http"]),
  baseUrl: httpUrl,
  apiKey: z.string().max(8192).optional(),
  modelId: z.string().trim().min(1).max(200),
  dimensions: z.number().int().min(1).max(16384).nullish(),
  batchSize: z.number().int().min(1).max(512).default(32),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxConcurrency: z.number().int().min(1).max(64).default(4),
  params: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export const modelUpdateSchema = modelCreateSchema.partial();

export const tokenCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.string().min(1)).min(1),
  rateLimitPerMin: z.number().int().min(1).max(100_000).default(120),
  expiresAt: z.string().datetime().nullish(),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const setupSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(12, "password must be at least 12 characters").max(200),
  name: z.string().trim().min(1).max(80).default("Admin"),
  setupToken: z.string().optional(),
});

export const groupCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullish(),
  providerIds: z.array(z.string().min(1)).default([]),
});

export const settingsUpdateSchema = z.object({
  defaults: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
      mode: searchModeSchema.optional(),
      language: z.string().max(24).optional(),
      freshness: freshnessSchema.optional(),
    })
    .optional(),
  security: z
    .object({
      privateHostAllowlist: z.array(z.string().max(253)).max(200).optional(),
      allowHttp: z.boolean().optional(),
      sessionTtlHours: z.number().int().min(1).max(720).optional(),
      loginRateLimitPerMin: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  retention: z
    .object({
      taskRetentionDays: z.number().int().min(1).max(365).optional(),
      logRetentionDays: z.number().int().min(1).max(365).optional(),
    })
    .optional(),
  cache: z
    .object({
      enabled: z.boolean().optional(),
      ttlSeconds: z.number().int().min(0).max(86_400).optional(),
    })
    .optional(),
  logging: z
    .object({
      level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
    })
    .optional(),
  instance: z
    .object({
      name: z.string().max(80).optional(),
      publicBaseUrl: z.string().max(500).optional(),
    })
    .optional(),
});

export type SearchRequestInput = z.infer<typeof searchRequestSchema>;
