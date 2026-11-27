import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, expectArray, expectObject, mapItem } from "../http.js";
import { providerRateLimitKey, withProviderRateLimit } from "../rate-limit.js";

const DEFAULT_BASE_URL = "https://api.github.com";

/**
 * GitHub Search (repositories).
 *
 * Docs: https://docs.github.com/en/rest/search/search
 * - `GET {baseUrl}/search/repositories?q=…&per_page=…&page=…`
 * - Auth is optional. Unauthenticated requests are limited to 10 requests/min
 *   and 60/hour; an authenticated token raises that substantially. The manifest
 *   therefore marks the credential as optional.
 * - Response: `{ total_count, incomplete_results, items: [{ full_name, html_url,
 *   description, pushed_at, stargazers_count, language }] }`.
 * - `per_page` max is 100, `page` is 1-based.
 *
 * This is a **vertical** index (code hosting), not general web search. The
 * catalog marks it as such so the UI cannot imply full-web coverage.
 */
interface GithubRepo {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  pushed_at?: unknown;
  updated_at?: unknown;
  stargazers_count?: unknown;
  language?: unknown;
  owner?: { login?: unknown };
}

export const githubAdapter: SearchProviderAdapter = {
  type: "github",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const search = ctx.config.search;
    const target = Math.max(1, Math.min(100, search?.targetResults ?? input.limit));
    const kindRaw = ctx.config.config["kind"];
    const kind = kindRaw === "code" || kindRaw === "issues" ? kindRaw : "repositories";
    if (kind === "code" && !ctx.apiKey) {
      throw new ProviderError(
        ctx.config.id,
        "github",
        "auth_invalid",
        "GitHub code search requires an access token; repository search remains available without one.",
      );
    }

    const url = new URL(`${baseUrl}/search/${kind}`);
    url.searchParams.set("q", input.query);
    url.searchParams.set("per_page", String(target));
    url.searchParams.set("page", "1");
    const sort = ctx.config.config["sortBy"];
    if (typeof sort === "string" && sort) url.searchParams.set("sort", sort);

    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (ctx.apiKey) headers["authorization"] = `Bearer ${ctx.apiKey}`;

    const mode = ctx.apiKey ? "authenticated" : "keyless";
    const policy = kind === "code"
      ? { maxPerMinute: 10, maxInFlight: 1 }
      : ctx.apiKey
        ? { maxPerMinute: 30, maxInFlight: 2 }
        : { maxPerMinute: 10, maxPerHour: 60, maxInFlight: 1 };
    const response = await withProviderRateLimit(
      providerRateLimitKey("github", baseUrl, `${mode}:${kind}`),
      policy,
      () => callJson(ctx, { url: url.toString(), method: "GET", headers }),
    );
    const payload = expectObject(ctx, response.data, "GitHub response");
    if (typeof payload["message"] === "string" && payload["items"] === undefined) {
      if (/rate limit/i.test(payload["message"])) {
        throw new ProviderError(ctx.config.id, "github", "rate_limited", "GitHub API rate limit exceeded.", {
          retryable: true,
        });
      }
      throw new ProviderError(ctx.config.id, "github", "bad_request", "GitHub returned a business error.", {
        retryable: false,
      });
    }
    const items = expectArray(ctx, payload["items"], "GitHub items") as GithubRepo[];

    const results = items
      .map((item) => {
        const mapped = mapItem(item, {
          titlePaths: ["full_name", "name", "title"],
          urlPaths: ["html_url", "url"],
          snippetPaths: ["description", "body"],
          publishedPaths: ["pushed_at", "updated_at", "created_at"],
          languagePaths: ["language"],
        });
        if (!mapped) return null;
        const stars = item.stargazers_count;
        return typeof stars === "number" ? { ...mapped, score: stars } : mapped;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    const warnings: string[] = ["GitHub search covers repositories/issues/code only, not the general web."];
    if (payload["incomplete_results"] === true) {
      warnings.push("GitHub reported incomplete_results; the result set may be partial.");
    }
    if (!ctx.apiKey) {
      warnings.push("Unauthenticated GitHub search is limited to 10 requests/minute; add a token for a higher limit.");
    }

    return { results, requestUrl: url.toString(), warnings };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await githubAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `GitHub returned ${results.length} repo result(s).`
            : "GitHub responded but returned no repositories.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `GitHub probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { DEFAULT_BASE_URL as GITHUB_DEFAULT_BASE_URL };
