import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

const DEFAULT_BASE_URL = "https://api.dataforseo.com";

/**
 * DataForSEO — Google Organic SERP (Live Advanced).
 *
 * Contract (from the published DataForSEO v3 docs):
 * - `POST {baseUrl}/v3/serp/google/organic/live/advanced`
 * - Auth: `Authorization: Basic base64(login:password)`. The platform stores a
 *   credential pair, so the user enters `login:password` and the adapter builds
 *   the Basic header itself (never a bearer token, which DataForSEO rejects).
 * - Body: an **array** of task objects, each with `keyword`, `location_code` or
 *   `location_name`, `language_code`, `depth` (10–700), `device`, `os`.
 * - Response: `tasks[].result[].items[]` where `type === "organic"` and each
 *   item has `rank_absolute`, `rank_group`, `title`, `url`, `description`,
 *   `breadcrumb`, `timestamp`.
 *
 * `depth` is a single-request row count (max 700), so DataForSEO is not paged
 * by offset; the adapter maps `targetResults` onto `depth` and declares
 * pagination unsupported.
 *
 * Verification: `documented`. The endpoint answered `401` here (no credential),
 * which confirms host and path.
 */
interface DfsItem {
  type?: unknown;
  rank_absolute?: unknown;
  rank_group?: unknown;
  title?: unknown;
  url?: unknown;
  description?: unknown;
  timestamp?: unknown;
  breadcrumb?: unknown;
}

interface DfsTask {
  status_code?: unknown;
  status_message?: unknown;
  result?: Array<{ items?: unknown; se_results_count?: unknown }>;
}

const MAX_DEPTH = 700;

export const dataforseoAdapter: SearchProviderAdapter = {
  type: "dataforseo",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "dataforseo",
        "auth_invalid",
        "DataForSEO requires a credential pair: enter `login:password` as the key.",
      );
    }
    const separator = ctx.apiKey.indexOf(":");
    if (separator <= 0) {
      throw new ProviderError(
        ctx.config.id,
        "dataforseo",
        "auth_invalid",
        "DataForSEO credential must be `login:password`.",
      );
    }
    const login = ctx.apiKey.slice(0, separator);
    const password = ctx.apiKey.slice(separator + 1);
    // Base64 of `login:password` — the only auth scheme DataForSEO accepts.
    const basic = Buffer.from(`${login}:${password}`, "utf8").toString("base64");

    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const depth = Math.max(10, Math.min(MAX_DEPTH, Math.trunc(search?.targetResults ?? input.limit)));

    const locationCode = ctx.config.config["locationCode"];
    const languageCode =
      (ctx.config.config["languageCode"] as string | undefined) ??
      (input.language ? input.language : "en");

    const task: Record<string, unknown> = {
      keyword: input.query,
      language_code: languageCode,
      depth,
      device: ctx.config.config["device"] === "mobile" ? "mobile" : "desktop",
      os: "windows",
    };
    if (typeof locationCode === "number" && Number.isFinite(locationCode)) {
      task["location_code"] = Math.trunc(locationCode);
    } else {
      // 2840 = United States in DataForSEO's location list; the default keeps
      // the request valid when the operator has not picked a location yet.
      task["location_code"] = 2840;
    }

    const response = await callJson(ctx, {
      url: `${baseUrl}/v3/serp/google/organic/live/advanced`,
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
      },
      // The API takes an array of tasks even for a single keyword.
      body: [task],
    });

    const payload = response.data as Record<string, unknown>;
    const tasks = Array.isArray(payload["tasks"]) ? (payload["tasks"] as DfsTask[]) : [];
    const first = tasks[0];
    if (!first) {
      throw new ProviderError(ctx.config.id, "dataforseo", "bad_request", "DataForSEO returned no task result.");
    }
    if (typeof first.status_code === "number" && first.status_code >= 40000) {
      throw new ProviderError(
        ctx.config.id,
        "dataforseo",
        first.status_code === 40100 ? "auth_invalid" : "bad_request",
        String(first.status_message ?? `DataForSEO task failed with ${first.status_code}`),
      );
    }

    const result = Array.isArray(first.result) ? first.result[0] : undefined;
    const items = Array.isArray(result?.items) ? (result!.items as DfsItem[]) : [];
    const results: RawSearchResult[] = [];
    for (const item of items) {
      if (item.type !== "organic") continue;
      const link = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(link)) continue;
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : link,
        url: link,
        snippet: typeof item.description === "string" ? item.description.slice(0, 600) : "",
        ...(typeof item.rank_absolute === "number" ? { upstreamRank: item.rank_absolute } : {}),
      });
      if (results.length >= input.limit) break;
    }

    const warnings: string[] = [];
    if (search && search.targetResults > MAX_DEPTH) {
      warnings.push(`DataForSEO accepts at most ${MAX_DEPTH} rows per request; the target was clamped.`);
    }

    return {
      results,
      requestUrl: `${baseUrl}/v3/serp/google/organic/live/advanced`,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await dataforseoAdapter.search(
        { query: "search engine", limit: 10, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `DataForSEO returned ${results.length} organic item(s).` : "DataForSEO returned no organic items.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `DataForSEO probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as DATAFORSEO_DEFAULT_BASE_URL };
