import { describe, expect, it, vi } from "vitest";
import {
  detectQueryLanguage,
  expandQuery,
  normalizeQueryIdentity,
  type ExpansionResult,
} from "../../packages/core/src/query/expansion.js";

const identity = (result: ExpansionResult): string[] => result.queries.map((item) => normalizeQueryIdentity(item.query));

describe("query expansion core", () => {
  it("always preserves the exact original as the first query", async () => {
    const result = await expandQuery({ query: "  What is RAG?  ", queryExpansion: true });
    expect(result.originalQuery).toBe("  What is RAG?  ");
    expect(result.queries[0]).toMatchObject({ query: "  What is RAG?  ", kind: "original", weight: 1, source: "original" });
  });

  it("normalizes NFKC, case and whitespace for deduplication without changing display", async () => {
    const modelExpander = vi.fn(async () => ["ＲＡＧ   retrieval", "rag retrieval", "RAG retrieval", "How does RAG retrieval work?"]);
    const result = await expandQuery({ query: "RAG retrieval", queryExpansion: true }, { modelExpander });
    const identities = identity(result);
    expect(new Set(identities).size).toBe(identities.length);
    expect(result.queries.some((item) => item.query === "How does RAG retrieval work?")).toBe(true);
  });

  it("defaults to three total queries and honors the configurable one-to-four budget", async () => {
    const modelExpander = vi.fn(async () => ["RAG architecture design patterns", "RAG architecture design tradeoffs", "RAG architecture design examples", "RAG architecture design fundamentals"]);
    const result = await expandQuery({ query: "RAG architecture design", queryExpansion: true }, { modelExpander });
    expect(result.queries).toHaveLength(3);
    expect(result.queries[0]?.kind).toBe("original");
    for (const budget of [1, 2, 3, 4]) {
      const bounded = await expandQuery({ query: "RAG architecture design", queryExpansion: true }, { maxQueries: budget, modelExpander });
      expect(bounded.queries).toHaveLength(budget);
    }
    const invalid = await expandQuery({ query: "RAG architecture design" }, { maxQueries: 99, modelExpander });
    expect(invalid.queries).toHaveLength(4);
  });

  it("extracts keywords from a long Chinese question", async () => {
    const result = await expandQuery({ query: "请问如何为机器学习项目选择合适的数据库？", queryExpansion: true });
    expect(result.queries.some((item) => item.kind === "keywords" && item.query === "为机器学习项目选择合适的数据库")).toBe(true);
  });

  it("preserves explicit proper nouns in rule and model candidates", async () => {
    const rule = await expandQuery({ query: "如何为 OpenAI API 选择数据库", queryExpansion: true });
    expect(rule.queries.slice(1).every((item) => item.query.includes("OpenAI API"))).toBe(true);
    const modelExpander = vi.fn(async () => ["OpenAI API 的缓存架构设计", "Claude API 的缓存架构设计"]);
    const model = await expandQuery({ query: "OpenAI API 缓存架构设计", queryExpansion: true }, { modelExpander });
    expect(model.queries.slice(1).some((item) => item.source === "model")).toBe(true);
    expect(model.queries.slice(1).every((item) => item.query.includes("OpenAI API"))).toBe(true);
    expect(model.queries.some((item) => item.query.includes("Claude"))).toBe(false);
  });

  it("supports deterministic Chinese-English and English-Chinese mapping", async () => {
    const zh = await expandQuery({ query: "deep learning tutorial", queryExpansion: true });
    expect(zh.queries.some((item) => item.kind === "translation" && item.query === "深度学习 教程")).toBe(true);
    const en = await expandQuery({ query: "深度学习教程", queryExpansion: true });
    expect(en.queries.some((item) => item.kind === "translation" && item.query === "deep learning tutorial")).toBe(true);
  });

  it("detects zh, en, ja, mixed and und without throwing", async () => {
    expect(detectQueryLanguage("机器学习")).toBe("zh");
    expect(detectQueryLanguage("machine learning")).toBe("en");
    expect(detectQueryLanguage("機械学習の検索")).toBe("ja");
    expect(detectQueryLanguage("RAG 检索")).toBe("zh-Latn");
    expect(detectQueryLanguage("123 !")).toBe("und");
    for (const query of ["日本語の検索", "mixed RAG 查询"]) {
      await expect(expandQuery({ query })).resolves.toBeDefined();
    }
  });

  it("rejects unrelated, too-long, control-character and language-mismatched model rewrites", async () => {
    const modelExpander = vi.fn(async () => [
      "banana bread recipe",
      `RAG ${"x".repeat(200)}`,
      "RAG\nretrieval architecture",
      "RAG retrieval 数据库架构",
      "RAG retrieval architecture design",
    ]);
    const result = await expandQuery({ query: "RAG retrieval architecture", queryExpansion: true }, { modelExpander });
    expect(result.queries.filter((item) => item.source === "model").map((item) => item.query)).toEqual(["RAG retrieval architecture design"]);
    expect(result.queries[0]?.query).toBe("RAG retrieval architecture");
  });

  it("reports rejected unrelated model output and keeps rule fallback", async () => {
    const modelExpander = vi.fn(async () => ["banana bread recipe", "quantum physics lecture"]);
    const result = await expandQuery({ query: "RAG retrieval architecture", queryExpansion: true }, { modelExpander });
    expect(result.queries.some((item) => item.source === "model")).toBe(false);
    expect(result.queries[0]?.kind).toBe("original");
    expect(result.skippedReason).toBe("model_output_rejected");
  });

  it("falls back to valid rule queries and the original when the model fails", async () => {
    const modelExpander = vi.fn(async () => { throw new Error("offline"); });
    const result = await expandQuery({ query: "RAG retrieval architecture", queryExpansion: true }, { modelExpander });
    expect(result.queries[0]?.kind).toBe("original");
    expect(result.queries.length).toBeGreaterThan(1);
    expect(result.skippedReason).toBe("model_failed");
  });

  it("does not call the model for pre-cancellation or explicit disable", async () => {
    const controller = new AbortController();
    controller.abort();
    const modelExpander = vi.fn(async () => "RAG retrieval architecture");
    const cancelled = await expandQuery({ query: "RAG retrieval architecture", queryExpansion: true }, { signal: controller.signal, modelExpander });
    expect(cancelled.queries).toHaveLength(1);
    expect(cancelled.skippedReason).toBe("cancelled");
    const disabled = await expandQuery({ query: "RAG retrieval architecture", queryExpansion: false }, { modelExpander });
    expect(disabled.queries).toHaveLength(1);
    expect(disabled.skippedReason).toBe("expansion_disabled");
    const fast = await expandQuery({ query: "RAG retrieval architecture", strategy: "fast" }, { modelExpander });
    expect(fast.skippedReason).toBe("fast_strategy");
    expect(modelExpander).not.toHaveBeenCalled();
  });

  it("propagates abort to an in-flight model and keeps only accepted bounded queries", async () => {
    const controller = new AbortController();
    const modelExpander = vi.fn((_query: string, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      controller.abort();
    }));
    const result = await expandQuery({ query: "RAG retrieval architecture", queryExpansion: true }, { signal: controller.signal, modelExpander });
    expect(modelExpander.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(result.skippedReason).toBe("cancelled");
    expect(result.queries[0]?.kind).toBe("original");
    expect(result.queries.length).toBeLessThanOrEqual(3);
  });

  it("is deterministic across repeated calls", async () => {
    const input = { query: "machine learning tutorial", queryExpansion: true };
    const first = await expandQuery(input);
    for (let index = 0; index < 20; index += 1) expect(await expandQuery(input)).toEqual(first);
  });

  it("returns only the original for empty input and when no model is available without safe rules", async () => {
    expect((await expandQuery({ query: "   " })).queries).toHaveLength(1);
    const result = await expandQuery({ query: "quartz", queryExpansion: true });
    expect(result.queries).toHaveLength(1);
    expect(result.skippedReasons).toContain("model_unavailable");
  });
});
