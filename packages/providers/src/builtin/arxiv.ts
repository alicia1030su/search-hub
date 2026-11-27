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
import { providerRateLimitKey, withProviderRateLimit } from "../rate-limit.js";


const DEFAULT_BASE_URL = "https://export.arxiv.org";

/**
 * arXiv Atom API — preprint search.
 *
 * Docs: https://info.arxiv.org/help/api/index.html
 * - `GET {baseUrl}/api/query?search_query=all:<terms>&start=0&max_results=N`
 * - No authentication. arXiv asks for at most one request every 3 seconds; this
 *   adapter makes a single request per search and does not page.
 * - Response is **Atom XML**, not JSON: `<entry>` with `<title>`, `<id>` (the
 *   abstract URL), `<summary>`, `<published>`, `<updated>`, `<author>`.
 *
 * Because the payload is XML, this adapter parses it with a small, strict
 * extractor rather than a general XML library. It only reads the fields it
 * needs, so a hostile feed cannot inject structure.
 */
const ENTRY_PATTERN = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;

export const arxivAdapter: SearchProviderAdapter = {
  type: "arxiv",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const max = Math.max(1, Math.min(100, search?.targetResults ?? input.limit));
    const category = ctx.config.config["category"];

    // arXiv query syntax: `all:` searches every field; `cat:` restricts to a
    // category. Terms are ANDed with `+AND+`.
    const terms = input.query.trim().split(/\s+/).slice(0, 8).map(encodeURIComponent).join("+AND+");
    const searchQuery = typeof category === "string" && category.trim()
      ? `all:${terms}+AND+cat:${encodeURIComponent(category.trim())}`
      : `all:${terms}`;

    const url = new URL(`${baseUrl}/api/query`);
    url.searchParams.set("search_query", searchQuery);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(max));
    url.searchParams.set("sortBy", "relevance");

    // arXiv answers Atom XML, not JSON, so the body is taken as raw text.
    const response = await withProviderRateLimit(
      providerRateLimitKey("arxiv", baseUrl),
      { minIntervalMs: 3_000, maxInFlight: 1 },
      () => callJson(ctx, {
        url: url.toString(),
        method: "GET",
        headers: { accept: "application/atom+xml" },
      }),
    );
    const xml = typeof response.data === "string" ? response.data : String(response.data ?? "");
    if (!/<feed\b/i.test(xml) || /<html\b/i.test(xml)) {
      throw new ProviderError(
        ctx.config.id,
        "arxiv",
        "bad_request",
        "arXiv returned an unexpected response (expected an Atom feed)",
      );
    }
    if (/<error\b/i.test(xml)) {
      const message = extract(xml, "error").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      throw new ProviderError(
        ctx.config.id,
        "arxiv",
        "bad_request",
        `arXiv returned a business error${message ? `: ${message.slice(0, 200)}` : ""}`,
      );
    }

    const results: RawSearchResult[] = [];
    for (const match of xml.matchAll(ENTRY_PATTERN)) {
      const block = match[1] ?? "";
      const title = decodeXml(extract(block, "title"));
      const rawUrl = decodeXml(extract(block, "id"));
      // arXiv's Atom feed still emits `http://` identifiers. The same article
      // is available over HTTPS, and returning the insecure scheme would make
      // every result fail downstream URL validation.
      const url_ = rawUrl.replace(/^http:\/\/arxiv\.org\//i, "https://arxiv.org/");
      const snippet = decodeXml(extract(block, "summary"));
      const published = decodeXml(extract(block, "published"));
      if (!title || !url_ || !/^https?:\/\//i.test(url_)) continue;
      results.push({
        title: truncate(title, 300),
        url: url_,
        snippet: truncate(snippet, 600),
        ...(published ? { publishedAt: published } : {}),
        language: "en",
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url.toString(),
      warnings: ["arXiv covers preprints in physics, maths, CS and related fields, not the general web."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await arxivAdapter.search(
        { query: "transformer attention", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `arXiv returned ${results.length} preprint(s).`
            : "arXiv responded but returned no entries.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `arXiv probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function extract(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return match ? match[1] ?? "" : "";
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export { DEFAULT_BASE_URL as ARXIV_DEFAULT_BASE_URL };
