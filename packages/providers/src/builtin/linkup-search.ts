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

const DEFAULT_BASE_URL = "https://api.linkup.so";

/**
 * Linkup Search API.
 *
 * Contract (from the published Linkup reference):
 * - `POST {baseUrl}/v1/search`, `Authorization: Bearer`.
 * - Body: `q`, `depth` (`standard` | `deep`), `outputType` (`searchResults` |
 *   `sourcedAnswer` | `structured`), `includeImages`, optional `fromDate` /
 *   `toDate` (`DD-MM-YYYY`).
 * - Response for `outputType=searchResults`: `results[]` with `name`, `url`,
 *   `content`, `type`.
 *
 * `depth` is the vendor's own cost knob; it is mapped from our `searchDepth`
 * platform parameter rather than invented.
 *
 * Verification: `documented`. Documented path is `/v1/search`; the bare
 * `/v1/search` answered 404 here because the route needs a body, so no live
 * call was possible without a key.
 */
interface LinkupResult {
  name?: unknown;
  url?: unknown;
  content?: unknown;
}

const DEPTHS = new Set(["standard", "deep"]);

export const linkupSearchAdapter: SearchProviderAdapter = {
  type: "linkup-search",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "linkup-search", "auth_invalid", "Linkup requires an API key.");
    }
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const depthRaw = ctx.config.config["depth"];
    const depth =
      typeof depthRaw === "string" && DEPTHS.has(depthRaw)
        ? depthRaw
        : search?.searchDepth === "deep"
          ? "deep"
          : "standard";

    const body: Record<string, unknown> = {
      q: input.query,
      depth,
      // Ask for the page list, not a synthesized answer: this provider is
      // registered as raw_search and must not smuggle an AI answer in.
      outputType: "searchResults",
    };

    const response = await callJson(ctx, {
      url: `${baseUrl}/v1/search`,
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const raw = Array.isArray(payload["results"]) ? (payload["results"] as LinkupResult[]) : [];
    const results: RawSearchResult[] = [];
    for (const item of raw) {
      const link = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(link)) continue;
      results.push({
        title: typeof item.name === "string" && item.name ? item.name : link,
        url: link,
        snippet: typeof item.content === "string" ? item.content.slice(0, 600) : "",
      });
      if (results.length >= input.limit) break;
    }

    return { results, requestUrl: `${baseUrl}/v1/search` };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await linkupSearchAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Linkup returned ${results.length} result(s).` : "Linkup returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Linkup probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as LINKUP_DEFAULT_BASE_URL };
