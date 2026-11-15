import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

/**
 * DuckDuckGo Instant Answer API — **not** a web search API.
 *
 * Contract (from https://duckduckgo.com/api):
 * - `GET https://api.duckduckgo.com/?q=…&format=json&no_html=1&skip_disambig=1`
 * - No authentication.
 * - Response: `AbstractText`, `AbstractURL`, `Heading`, `RelatedTopics[]`,
 *   `Results[]` — instant answers, **not** ranked web pages.
 *
 * DuckDuckGo has no official general web-search API; the HTML endpoint is
 * scraping and is against their terms. This adapter therefore returns the
 * abstact/related topic links that the documented API really provides and
 * labels them as instant answers, so nobody can mistake it for web search.
 *
 * Verification: `documented`; DuckDuckGo's API needs no credential but was not
 * reachable from this network.
 */
interface DdgTopic {
  Text?: unknown;
  FirstURL?: unknown;
  Name?: unknown;
  Topics?: unknown;
}

export const duckduckgoAdapter: SearchProviderAdapter = {
  type: "duckduckgo",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? "https://api.duckduckgo.com").replace(/\/+$/, "");
    const url = new URL(`${baseUrl}/`);
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("no_html", "1");
    url.searchParams.set("skip_disambig", "1");

    const response = await callJson(ctx, { url: url.toString(), method: "GET" });
    const payload = response.data as Record<string, unknown>;

    const results: RawSearchResult[] = [];
    const abstractText = typeof payload["AbstractText"] === "string" ? payload["AbstractText"] : "";
    const abstractUrl = typeof payload["AbstractURL"] === "string" ? payload["AbstractURL"] : "";
    const heading = typeof payload["Heading"] === "string" ? payload["Heading"] : "";
    if (abstractUrl && /^https?:\/\//i.test(abstractUrl)) {
      results.push({
        title: heading || abstractUrl,
        url: abstractUrl,
        snippet: abstractText.slice(0, 600),
      });
    }

    collectTopics(payload["RelatedTopics"], results, input.limit);
    collectTopics(payload["Results"], results, input.limit);

    return {
      results: results.slice(0, input.limit),
      requestUrl: url.toString(),
      warnings: [
        "DuckDuckGo's official API returns instant answers, not ranked web results. Use Generic HTTP for a licensed web-search gateway.",
      ],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await duckduckgoAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `DuckDuckGo returned ${results.length} instant-answer link(s).`
            : "DuckDuckGo returned no instant answer for this query.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `DuckDuckGo probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function collectTopics(value: unknown, out: RawSearchResult[], limit: number): void {
  if (!Array.isArray(value) || out.length >= limit) return;
  for (const entry of value) {
    if (out.length >= limit) return;
    if (!entry || typeof entry !== "object") continue;
    const topic = entry as DdgTopic;
    if (Array.isArray(topic.Topics)) {
      collectTopics(topic.Topics, out, limit);
      continue;
    }
    const link = typeof topic.FirstURL === "string" ? topic.FirstURL : "";
    if (!/^https?:\/\//i.test(link)) continue;
    if (out.some((item) => item.url === link)) continue;
    const text = typeof topic.Text === "string" ? topic.Text : "";
    out.push({
      title: (typeof topic.Name === "string" && topic.Name) || text.slice(0, 120) || link,
      url: link,
      snippet: text.slice(0, 600),
    });
  }
}
