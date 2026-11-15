import {
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson } from "../http.js";

const DEFAULT_BASE_URL = "https://api.crossref.org";

/**
 * Crossref REST API — scholarly metadata (DOIs).
 *
 * Contract (from the published Crossref REST API docs):
 * - `GET {baseUrl}/works?query=…&rows=…&select=…&mailto=…`
 * - No authentication. A `mailto` in the query puts the caller in Crossref's
 *   "polite pool", which is the documented way to get better service.
 * - Response: `message.items[]` with `title[]`, `URL`, `abstract`,
 *   `published["date-parts"]`, `author[]`, `DOI`, `container-title[]`.
 *
 * A work without a usable URL falls back to `https://doi.org/{DOI}`, which is
 * the canonical resolver, rather than being dropped.
 *
 * Verification: `documented` and **live-tested** against the public API with a
 * real HTTP call (no credential needed).
 */
interface CrossrefWork {
  title?: unknown;
  URL?: unknown;
  DOI?: unknown;
  abstract?: unknown;
  published?: { "date-parts"?: unknown };
  "container-title"?: unknown;
  author?: unknown;
}

export const crossrefAdapter: SearchProviderAdapter = {
  type: "crossref",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const rows = Math.max(1, Math.min(100, Math.trunc(search?.targetResults ?? input.limit)));
    const mailto = (ctx.config.config["mailto"] as string | undefined) ?? "";

    const url = new URL(`${baseUrl}/works`);
    url.searchParams.set("query", input.query);
    url.searchParams.set("rows", String(rows));
    url.searchParams.set("select", "title,URL,DOI,abstract,published,container-title,author");
    if (mailto.trim()) url.searchParams.set("mailto", mailto.trim());
    if (input.freshness && input.freshness !== "all") {
      const days = input.freshness === "day" ? 1 : input.freshness === "week" ? 7 : input.freshness === "month" ? 30 : 365;
      const from = new Date(Date.now() - days * 86_400_000);
      url.searchParams.set("filter", `from-pub-date:${from.toISOString().slice(0, 10)}`);
    }

    const response = await callJson(ctx, {
      url: url.toString(),
      method: "GET",
      headers: { accept: "application/json" },
    });

    const payload = response.data as Record<string, unknown>;
    const message = (payload["message"] ?? {}) as Record<string, unknown>;
    const items = Array.isArray(message["items"]) ? (message["items"] as CrossrefWork[]) : [];

    const results: RawSearchResult[] = [];
    for (const item of items) {
      const title = Array.isArray(item.title) && typeof item.title[0] === "string" ? item.title[0] : "";
      const doi = typeof item.DOI === "string" ? item.DOI : "";
      const url_ = typeof item.URL === "string" && item.URL ? item.URL : doi ? `https://doi.org/${doi}` : "";
      if (!url_ || !/^https?:\/\//i.test(url_)) continue;
      const journal =
        Array.isArray(item["container-title"]) && typeof item["container-title"][0] === "string"
          ? item["container-title"][0]
          : "";
      results.push({
        title: title || url_,
        url: url_,
        snippet: (stripJats(item.abstract) || journal).slice(0, 600),
        ...(publishedAt(item.published) ? { publishedAt: publishedAt(item.published)! } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url.toString(),
      warnings: ["Crossref indexes scholarly works (DOIs), not general web pages."],
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await crossrefAdapter.search(
        { query: "transformer attention", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0 ? `Crossref returned ${results.length} work(s).` : "Crossref returned no works.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `Crossref probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function publishedAt(published: CrossrefWork["published"]): string | undefined {
  const parts = published?.["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const [year, month, day] = parts[0] as unknown[];
  if (typeof year !== "number") return undefined;
  const mm = typeof month === "number" ? String(month).padStart(2, "0") : "01";
  const dd = typeof day === "number" ? String(day).padStart(2, "0") : "01";
  return `${year}-${mm}-${dd}`;
}

function stripJats(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
