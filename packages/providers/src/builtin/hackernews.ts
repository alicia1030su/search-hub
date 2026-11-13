import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectObject, mapItem } from "../http.js";

const FRESHNESS_SECONDS: Record<string, number> = {
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

interface HnHit {
  objectID?: string;
  title?: string;
  url?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  created_at?: string;
  points?: number;
  author?: string;
  num_comments?: number;
}

/**
 * Hacker News search via the official Algolia-hosted API.
 *
 * Documented at https://hn.algolia.com/api — keyless, JSON, real URLs.
 * This is a domain search (stories/comments), not a general web index; the
 * catalog labels it accordingly. It is included because it gives operators a
 * zero-credential way to verify the full search pipeline against a live API.
 */
export const hackerNewsAdapter: SearchProviderAdapter = {
  type: "hackernews",
  requiresKey: false,
  supportsTest: true,

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const base =
      (typeof ctx.config.config["baseUrl"] === "string" && ctx.config.config["baseUrl"]) ||
      ctx.config.baseUrl ||
      "https://hn.algolia.com";
    const tags =
      typeof ctx.config.config["tags"] === "string" && ctx.config.config["tags"]
        ? String(ctx.config.config["tags"])
        : "story";

    const url = new URL("/api/v1/search", base.replace(/\/+$/, ""));
    url.searchParams.set("query", input.query);
    url.searchParams.set("tags", tags);
    url.searchParams.set("hitsPerPage", String(Math.min(50, Math.max(1, input.limit))));

    if (input.freshness && input.freshness !== "all") {
      const seconds = FRESHNESS_SECONDS[input.freshness];
      if (seconds) {
        const since = Math.floor(Date.now() / 1000) - seconds;
        url.searchParams.set("numericFilters", `created_at_i>${since}`);
      }
    }

    const response = await callJson(ctx, { url: url.toString(), method: "GET" });
    const body = expectObject(ctx, response.data, "Hacker News response");
    const hits = body["hits"];
    if (!Array.isArray(hits)) {
      throw new ProviderError(
        ctx.config.id,
        "hackernews",
        "bad_request",
        "Hacker News response did not contain a hits array",
      );
    }

    const results = (hits as HnHit[])
      .map((hit) => {
        const objectId = hit.objectID ?? "";
        const link =
          typeof hit.url === "string" && /^https?:\/\//i.test(hit.url)
            ? hit.url
            : objectId
              ? `https://news.ycombinator.com/item?id=${objectId}`
              : "";
        return mapItem(
          {
            title: hit.title ?? (hit.comment_text ? `HN comment by ${hit.author ?? "unknown"}` : ""),
            url: link,
            snippet:
              hit.story_text ??
              hit.comment_text ??
              [
                hit.author ? `by ${hit.author}` : "",
                typeof hit.points === "number" ? `${hit.points} points` : "",
                typeof hit.num_comments === "number" ? `${hit.num_comments} comments` : "",
              ]
                .filter(Boolean)
                .join(" · "),
            created_at: hit.created_at,
            points: hit.points,
          },
          {
            titlePaths: ["title"],
            urlPaths: ["url"],
            snippetPaths: ["snippet"],
            publishedPaths: ["created_at"],
            scorePaths: ["points"],
          },
        );
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    return { results, requestUrl: response.url };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    const { results } = await hackerNewsAdapter.search(
      { query: "typescript", limit: 3, signal: ctx.signal },
      ctx,
    );
    const latencyMs = Date.now() - started;
    return {
      ok: true,
      latencyMs,
      resultCount: results.length,
      message: `Hacker News returned ${results.length} live result(s) in ${latencyMs}ms`,
      sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
    };
  },
};
