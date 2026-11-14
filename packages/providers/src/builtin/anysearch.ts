import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { callJson, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "https://api.anysearch.com";
const DEFAULT_PATH = "/v1/search";

/**
 * AnySearch — unified real-time search.
 *
 * Contract source: the vendor-maintained skill repository
 * (https://github.com/anysearch-ai/anysearch-skill, `scripts/shared/doc_spec.md`
 * and `scripts/anysearch_cli.js`), plus the live 404 on `GET /v1/search`
 * (POST-only). This is a **project/vendor-maintained skill**, not a public
 * cloud API page, and the catalog notes say so.
 *
 * - `POST https://api.anysearch.com/v1/search`, JSON body.
 * - Auth is **optional**: `Authorization: Bearer <KEY>`. Anonymous calls are
 *   allowed with stricter rate limits and quota; the two limit types are
 *   surfaced separately (429 → rate_limited with Retry-After; quota text in the
 *   envelope → quota_exceeded).
 * - Body: `query`, `max_results` (1–10), `language`, `tag`, `params`, `zone`.
 * - Envelope: `{ code, message, request_id, data: { results: [...], metadata } }`
 *   with `code !== 0` meaning a business error even on HTTP 200.
 * - Item fields used by the official client: `title`, `url`, `content`/`snippet`.
 *   `date` and `source` are documented but not rendered by the client; we pass
 *   them through when present.
 */
const MAX_RESULTS = 10;

interface AnySearchItem {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  content?: unknown;
  date?: unknown;
  source?: unknown;
  score?: unknown;
}

function mapError(code: unknown, message: unknown): "bad_request" | "rate_limited" | "quota_exceeded" | "auth_invalid" {
  const text = `${String(message ?? "")}`.toLowerCase();
  if (text.includes("rate limit") || text.includes("too many")) return "rate_limited";
  if (text.includes("quota") || text.includes("exhausted")) return "quota_exceeded";
  if (text.includes("unauthorized") || text.includes("invalid key")) return "auth_invalid";
  if (String(code) === "401") return "auth_invalid";
  if (String(code) === "429") return "rate_limited";
  return "bad_request";
}

export const anySearchAdapter: SearchProviderAdapter = {
  type: "anysearch",
  requiresKey: false,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    const baseUrl = (ctx.config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const configuredPath = ctx.config.config["path"];
    const path =
      typeof configuredPath === "string" && configuredPath.trim().startsWith("/")
        ? configuredPath.trim()
        : DEFAULT_PATH;

    const body: Record<string, unknown> = {
      query: input.query,
      max_results: Math.max(1, Math.min(MAX_RESULTS, Math.trunc(input.limit))),
    };
    const language = input.language ?? ctx.config.language ?? undefined;
    if (language) body["language"] = language;
    const tag = ctx.config.config["tag"];
    if (typeof tag === "string" && tag.trim()) body["tag"] = tag.trim();
    const zone = ctx.config.config["zone"];
    if (typeof zone === "string" && (zone === "cn" || zone === "intl")) body["zone"] = zone;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The official client always sends this; it lets the vendor attribute the
      // traffic to a skill build rather than an unknown script.
      "x-anysearch-client": "search-hub/0.1.4",
    };
    if (ctx.apiKey) headers["authorization"] = `Bearer ${ctx.apiKey}`;

    const response = await callJson(ctx, {
      url: `${baseUrl}${path}`,
      method: "POST",
      headers,
      body,
    });

    const payload = response.data as Record<string, unknown>;
    const code = payload["code"];
    if (code !== undefined && code !== 0) {
      throw new ProviderError(
        ctx.config.id,
        "anysearch",
        mapError(code, payload["message"]),
        String(payload["message"] ?? `AnySearch returned code ${String(code)}`),
        { details: { anysearchCode: code, requestId: payload["request_id"] } },
      );
    }

    const data = payload["data"] as Record<string, unknown> | undefined;
    const items = Array.isArray(data?.["results"]) ? (data!["results"] as AnySearchItem[]) : [];

    const results = items
      .map((item) => {
        const mapped = mapItem(item, {
          titlePaths: ["title"],
          urlPaths: ["url"],
          snippetPaths: ["content", "snippet"],
          publishedPaths: ["date"],
          scorePaths: ["score"],
        });
        if (!mapped) return null;
        const source = typeof item.source === "string" && item.source ? item.source : undefined;
        return { ...mapped, ...(source ? { upstream: { providerName: source } } : {}) };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, input.limit);

    const warnings: string[] = [];
    if (!ctx.apiKey) {
      warnings.push(
        "AnySearch is running anonymously: lower rate limits and quota than an API key. Add a key to raise them.",
      );
    }

    return { results, requestUrl: `${baseUrl}${path}`, ...(warnings.length > 0 ? { warnings } : {}) };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await anySearchAdapter.search(
        { query: "人工智能", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message: results.length > 0
          ? `AnySearch returned ${results.length} result(s)${ctx.apiKey ? "" : " (anonymous)"}.`
          : "AnySearch responded but returned no results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `AnySearch probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
