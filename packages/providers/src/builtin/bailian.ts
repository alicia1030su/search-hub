import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";
import { buildAnswer, textOf } from "../grounded.js";

/**
 * Alibaba Bailian (DashScope) — web search with **sources**.
 *
 * Official docs (verified 2026-11-15):
 * https://help.aliyun.com/zh/model-studio/web-search
 *
 * Critical protocol fact: the OpenAI-compatible
 * `/compatible-mode/v1/chat/completions` channel **cannot return search
 * sources** ("OpenAI 兼容协议因协议限制，不支持搜索来源返回和角标标注").
 * Only the DashScope native endpoint returns `search_info.search_results`.
 * This adapter therefore uses:
 *
 *   POST {baseUrl}/api/v1/services/aigc/text-generation/generation
 *   { model, input:{messages:[{role:"user",content}]},
 *     parameters:{ result_format:"message", enable_search:true,
 *                  search_options:{ enable_source:true, enable_citation:true } } }
 *
 * and reads `output.choices[0].message.content` plus
 * `output.search_info.search_results[]` (`index`, `title`, `url`, `site_name`,
 * `icon` — there is no snippet field).
 *
 * `baseUrl` must be the workspace endpoint
 * `https://{WorkspaceId}.{region}.maas.aliyuncs.com`; it is NOT hardcoded to one
 * region because the workspace id and region differ per account.
 */
const DEFAULT_MODEL = "qwen-plus";

interface DashScopeSearchResult {
  index?: unknown;
  title?: unknown;
  url?: unknown;
  site_name?: unknown;
}

export const bailianAdapter: SearchProviderAdapter = {
  type: "bailian",
  requiresKey: true,
  supportsTest: true,
  capability: "grounded_answer",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "bailian", "auth_invalid", "Bailian requires a DashScope API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new ProviderError(
        ctx.config.id,
        "bailian",
        "bad_request",
        "Bailian requires the workspace endpoint, e.g. https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com",
      );
    }
    const model =
      (typeof ctx.config.config["model"] === "string" ? ctx.config.config["model"].trim() : "") ||
      ctx.config.model?.trim() ||
      DEFAULT_MODEL;

    const strategyRaw = ctx.config.config["searchStrategy"];
    const strategy =
      typeof strategyRaw === "string" && ["turbo", "max", "agent", "agent_max"].includes(strategyRaw)
        ? strategyRaw
        : "turbo";
    const forced = ctx.config.config["forcedSearch"] === true;
    const assigned = ctx.config.config["assignedSites"];

    const searchOptions: Record<string, unknown> = {
      search_strategy: strategy,
      // Required for `search_info` to come back at all.
      enable_source: true,
      enable_citation: true,
    };
    if (forced) searchOptions["forced_search"] = true;
    if (typeof assigned === "string" && assigned.trim()) {
      const sites = assigned
        .split(/[,|\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 25);
      if (sites.length > 0) searchOptions["assigned_site_list"] = sites;
    }

    const body: Record<string, unknown> = {
      model,
      input: { messages: [{ role: "user", content: input.query }] },
      parameters: {
        // `message` is mandatory: the default `text` format drops search_info.
        result_format: "message",
        enable_search: true,
        search_options: searchOptions,
      },
    };

    const response = await callJson(ctx, {
      url: `${baseUrl}/api/v1/services/aigc/text-generation/generation`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const output = (payload["output"] ?? {}) as Record<string, unknown>;
    const choices = Array.isArray(output["choices"]) ? output["choices"] : [];
    const message = (choices[0] as Record<string, unknown> | undefined)?.["message"] as
      | Record<string, unknown>
      | undefined;
    const text = typeof message?.["content"] === "string" ? message["content"] : "";

    const searchInfo = (output["search_info"] ?? {}) as Record<string, unknown>;
    const rawResults = Array.isArray(searchInfo["search_results"])
      ? (searchInfo["search_results"] as DashScopeSearchResult[])
      : [];
    const citations = rawResults
      .map((item) => ({
        title: textOf(item.title) ?? "",
        url: textOf(item.url) ?? "",
        ...(textOf(item.site_name) ? { snippet: textOf(item.site_name)! } : {}),
      }))
      .filter((item) => item.url.length > 0);

    const toolInvoked = citations.length > 0;
    const answer = buildAnswer("bailian", text, citations, toolInvoked, model);

    return {
      results: [],
      requestUrl: `${baseUrl}/api/v1/services/aigc/text-generation/generation`,
      ...(toolInvoked ? {} : { warnings: ["Bailian answered without search_results; this is not a search result."] }),
      answer,
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const output = await bailianAdapter.search(
        { query: "杭州明天天气", limit: 10, signal: ctx.signal },
        ctx,
      );
      const answer = output.answer;
      return {
        ok: Boolean(answer?.toolInvoked && answer.citations.length > 0),
        latencyMs: Date.now() - started,
        resultCount: answer?.citations.length ?? 0,
        message: !answer?.toolInvoked
          ? "Bailian responded without search_results (enable_source may be ignored by this model)."
          : `Bailian grounded answer with ${answer.citations.length} source(s).`,
        sample: (answer?.citations ?? []).slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Bailian probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_MODEL as BAILIAN_DEFAULT_MODEL };
