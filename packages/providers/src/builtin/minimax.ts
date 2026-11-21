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

const DEFAULT_BASE_URL = "https://api.minimaxi.com";
const GLOBAL_BASE_URL = "https://api.minimax.io";

/**
 * MiniMax Coding Plan — `web_search`.
 *
 * Source of truth (not the marketing docs): the official MCP server
 * https://github.com/MiniMax-AI/MiniMax-Coding-Plan-MCP
 * - `minimax_mcp/server.py`: `api_client.post("/v1/coding_plan/search", {"q": query})`
 * - `minimax_mcp/client.py`: headers `Authorization: Bearer <key>` and
 *   `MM-API-Source: Minimax-MCP`
 * - response: `organic[]` (`title`, `link`, `snippet`, `date`),
 *   `related_searches[]` (`query`), `base_resp` (`status_code`, `status_msg`)
 *
 * `base_resp.status_code` is the *real* status: the HTTP call can be 200 while
 * the search failed. 1004 means the key is invalid **or** the key and host are
 * from different regions — that distinction matters, so it is surfaced as
 * "credential rejected / region mismatch" rather than "invalid key".
 * 2038 means the account needs real-name verification: a permissions problem,
 * not a bad key.
 *
 * Region: the key must match the host.
 * - Mainland: https://api.minimaxi.com
 * - Global:   https://api.minimax.io
 *
 * Verification: `documented`. Protocol confirmed against the official MCP source
 * on 2026-11-15, but no Coding Plan credential exists in this environment, so no
 * live call was made.
 */
interface MinimaxOrganic {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  date?: unknown;
}

interface MinimaxBaseResp {
  status_code?: unknown;
  status_msg?: unknown;
}

export const minimaxAdapter: SearchProviderAdapter = {
  type: "minimax",
  requiresKey: true,
  supportsTest: true,
  capability: "raw_search",

  async search(input: ProviderSearchInput, ctx: ProviderContext): Promise<ProviderSearchOutput> {
    if (!ctx.apiKey) {
      throw new ProviderError(ctx.config.id, "minimax", "auth_invalid", "MiniMax requires a Coding Plan API key.");
    }
    const baseUrl = resolveBaseUrl(ctx);
    const url = `${baseUrl}/v1/coding_plan/search`;

    const response = await callJson(ctx, {
      url,
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        // The official client sends this; keep it so server-side attribution
        // matches what MiniMax expects from an MCP client.
        "MM-API-Source": "Minimax-MCP",
        "content-type": "application/json",
      },
      // The search endpoint takes only `q`; paging parameters are not part of
      // this API, so they are deliberately not sent.
      body: { q: input.query },
    });

    const payload = response.data as Record<string, unknown>;
    assertBaseResp(ctx, payload["base_resp"]);

    const organic = Array.isArray(payload["organic"]) ? (payload["organic"] as MinimaxOrganic[]) : [];
    const results: RawSearchResult[] = [];
    for (const item of organic) {
      const link = typeof item.link === "string" ? item.link : "";
      if (!/^https?:\/\//i.test(link)) continue;
      results.push({
        title: typeof item.title === "string" && item.title ? item.title : link,
        url: link,
        snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 600) : "",
        ...(typeof item.date === "string" && item.date ? { publishedAt: item.date } : {}),
      });
      if (results.length >= input.limit) break;
    }

    return {
      results,
      requestUrl: url,
      ...(results.length === 0
        ? { warnings: ["MiniMax returned no organic result for this query; try rephrasing it."] }
        : {}),
    };
  },

  async test(ctx: ProviderContext): Promise<ProviderTestResult> {
    const started = Date.now();
    try {
      const { results } = await minimaxAdapter.search(
        { query: "search engine", limit: 5, signal: ctx.signal },
        ctx,
      );
      return {
        ok: results.length > 0,
        latencyMs: Date.now() - started,
        resultCount: results.length,
        message:
          results.length > 0
            ? `MiniMax returned ${results.length} organic result(s).`
            : "MiniMax responded without organic results.",
        sample: results.slice(0, 3).map((item) => ({ title: item.title, url: item.url })),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: `MiniMax probe failed: ${describe(error)}`,
      };
    }
  },
};

/**
 * Maps `base_resp.status_code` onto real causes.
 * MiniMax can answer HTTP 200 with a non-zero status code, so treating the HTTP
 * status as success would report a broken key as "no results".
 */
function assertBaseResp(ctx: ProviderContext, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const base = value as MinimaxBaseResp;
  const code = typeof base.status_code === "number" ? base.status_code : 0;
  if (code === 0) return;
  const message = typeof base.status_msg === "string" ? base.status_msg : `status ${code}`;

  if (code === 1004) {
    throw new ProviderError(
      ctx.config.id,
      "minimax",
      "auth_invalid",
      `MiniMax rejected the credential: ${message}. ` +
        "The key and the API host must be from the same region " +
        "(mainland https://api.minimaxi.com, global https://api.minimax.io).",
    );
  }
  if (code === 2038) {
    // Not a bad key: the account has not completed real-name verification, so
    // the Coding Plan search entitlement is missing.
    throw new ProviderError(
      ctx.config.id,
      "minimax",
      "blocked",
      `MiniMax account has no Coding Plan search entitlement: ${message}. ` +
        "Complete real-name verification (and confirm the plan includes web_search) before retrying.",
      { details: { permissionDenied: true, vendorCode: code } },
    );
  }
  throw new ProviderError(ctx.config.id, "minimax", "bad_request", `MiniMax error ${code}: ${message}`);
}

function resolveBaseUrl(ctx: ProviderContext): string {
  const explicit = (ctx.config.baseUrl ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const region = ctx.config.config["region"];
  return region === "global" ? GLOBAL_BASE_URL : DEFAULT_BASE_URL;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export { DEFAULT_BASE_URL as MINIMAX_DEFAULT_BASE_URL, GLOBAL_BASE_URL as MINIMAX_GLOBAL_BASE_URL };
