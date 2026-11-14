import {
  ProviderError,
  getByPath,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectObject, joinApiPath, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:44475";
const DEFAULT_PATH = "/api/search";

/**
 * Compatibility adapter for an **existing, independently deployed Search Hub**
 * (for example the legacy instance on port 44475).
 *
 * Design constraints, on purpose:
 * - The old service is never modified, migrated or written to. This adapter
 *   only issues `POST {path}` and reads the JSON response.
 * - Removing the provider instance in this platform fully reverts the
 *   integration: no schema change, no copied keys, no background jobs.
 * - The old service stays authoritative for its own providers and quotas; this
 *   platform only sees the results it returns.
 * - `path` is configurable because the legacy API may be mounted under
 *   `/api/search`, `/search` or a gateway prefix.
 *
 * Expected request body:
 *   { "query": "...", "mode": "rrf", "limit": 10, "freshness": "month", "language": "zh-CN" }
 * `freshness` / `language` are omitted when not set. `mode` defaults to `rrf`
 * and is configurable.
 *
 * Accepted response shapes:
 *   { "results": [ { title, url, snippet, publishedAt, provider, ... } ] }
 *   { "data": { "results": [ ... ] } }
 *
 * Errors: default HTTP mapping is correct here — 401/403 mean the legacy token
 * was rejected (auth_invalid), 429 is rate_limited with Retry-After, 5xx is
 * server_error, and transport timeouts surface as timeout.
 *
 * Verification status: `documented`. No real legacy instance was contacted from
 * this repository; the tests use a local fake.
 */
export const legacySearchHubAdapter: SearchProviderAdapter = {
  type: "search-hub-legacy",
  // A legacy instance may be open on a trusted network; when a token is set it
  // is sent as a Bearer header.
  requiresKey: false,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const configuredPath = ctx.config.config["path"];
    const path =
      typeof configuredPath === "string" && configuredPath.trim().startsWith("/")
        ? configuredPath.trim()
        : DEFAULT_PATH;
    const configuredMode = ctx.config.config["mode"];
    const mode =
      typeof configuredMode === "string" && configuredMode.trim()
        ? configuredMode.trim()
        : "rrf";

    const url = joinApiPath(baseUrl, path);
    const headers: Record<string, string> = { accept: "application/json" };
    if (ctx.apiKey) headers["authorization"] = `Bearer ${ctx.apiKey}`;

    const body: Record<string, unknown> = {
      query: input.query,
      mode,
      limit: input.limit,
    };
    if (input.freshness && input.freshness !== "all") body["freshness"] = input.freshness;
    if (input.language) body["language"] = input.language;

    const response = await callJson(ctx, { url, method: "POST", headers, body });
    const payload = expectObject(ctx, response.data, "legacy Search Hub response");
    const list = Array.isArray(payload["results"])
      ? payload["results"]
      : getByPath(payload, "data.results");
    if (!Array.isArray(list)) {
      throw new ProviderError(
        ctx.config.id,
        "search-hub-legacy",
        "bad_request",
        "Legacy Search Hub response has no results[] array. Expected {results:[]} or {data:{results:[]}}.",
        { statusCode: response.status },
      );
    }

    const results = list
      .map((item) =>
        mapItem(item, {
          titlePaths: ["title", "name"],
          urlPaths: ["url", "link"],
          snippetPaths: ["snippet", "content", "summary"],
          publishedPaths: ["publishedAt", "published_at", "datePublished", "date"],
          scorePaths: ["score"],
        }),
      )
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: response.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await legacySearchHubAdapter.search(
        { query: "search engine", limit: 3, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `Legacy Search Hub returned ${results.length} result(s).`
            : "Legacy Search Hub is reachable but returned no results for the probe query.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Legacy Search Hub probe failed: ${message}`,
      };
    }
  },
};
