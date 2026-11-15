import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

const DEFAULT_BASE_URL = "https://www.ebi.ac.uk";

/**
 * Europe PMC REST API — life-science literature.
 *
 * Contract (from the published Europe PMC REST docs):
 * - `GET {baseUrl}/europepmc/webservices/rest/search?query=…&format=json&pageSize=…&resultType=lite`
 * - No authentication.
 * - Response: `resultList.result[]` with `id`, `source`, `title`, `authorString`,
 *   `journalTitle`, `pubYear`, `doi`, `abstractText`.
 * - Article URL: `https://europepmc.org/article/{source}/{id}`.
 *
 * `pageSize` caps at 1000 but the practical cap for a single page is 100; the
 * adapter stays at 100 and reports the real count.
 *
 * Verification: `documented`. The host was unreachable from this network; the
 * shape follows the reference only.
 */
interface EuropePmcRecord {
  id?: unknown;
  source?: unknown;
  title?: unknown;
  authorString?: unknown;
  journalTitle?: unknown;
  pubYear?: unknown;
  doi?: unknown;
  abstractText?: unknown;
}

export const europepmcAdapter: SearchProviderAdapter = {
  type: "europepmc",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const pageSize = Math.max(1, Math.min(100, Math.trunc(search?.targetResults ?? input.limit)));

    const url = new URL(`${baseUrl}/europepmc/webservices/rest/search`);
    url.searchParams.set("query", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("resultType", "core");
    url.searchParams.set("sort", "CITED desc");

    const response = await callJson(ctx, {
      url: url.toString(),
      method: "GET",
      headers: { accept: "application/json" },
    });

    const payload = response.data as Record<string, unknown>;
    const resultList = (payload["resultList"] ?? {}) as Record<string, unknown>;
    const items = Array.isArray(resultList["result"]) ? (resultList["result"] as EuropePmcRecord[]) : [];

    const results: RawSearchResult[] = [];
    for (const item of items) {
      const id = typeof item.id === "string" ? item.id : "";
      const source = typeof item.source === "string" ? item.source : "";
      const title = typeof item.title === "string" ? item.title.replace(/<[^>]+>/g, "").trim() : "";
      if (!id || !title) continue;
      const journal = typeof item.journalTitle === "string" ? item.journalTitle : "";
      const authors = typeof item.authorString === "string" ? item.authorString : "";
      results.push({
        title,
        url: `https://europepmc.org/article/${source || "MED"}/${id}`,
        snippet: [journal, authors].filter(Boolean).join(" · ").slice(0, 600),
        ...(typeof item.pubYear === "string" ? { publishedAt: item.pubYear } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url.toString(),
      warnings: ["Europe PMC indexes life-science literature, not general web pages."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await europepmcAdapter.search(
        { query: "transformer attention", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Europe PMC returned ${results.length} record(s).` : "Europe PMC returned no records.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Europe PMC probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as EUROPEPMC_DEFAULT_BASE_URL };
