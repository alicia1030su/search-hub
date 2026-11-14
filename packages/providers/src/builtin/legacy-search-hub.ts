import {
  ProviderError,
  type ProviderContext,
  type ProviderSearchInput,
  type ProviderSearchOutput,
  type ProviderTestResult,
  type RawSearchResult,
  type SearchProviderAdapter,
  type UpstreamAttribution,
} from "@search-hub/shared";
import { callJson, expectObject, joinApiPath, mapItem } from "../http.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:44475";
const DEFAULT_PATH = "/api/search";

/** Supported transports. Only `rest` is implemented today. */
const SUPPORTED_TRANSPORTS = new Set(["rest"]);

/**
 * Compatibility adapter for an **existing, independently deployed Search Hub**
 * (for example the legacy instance on port 44475).
 *
 * ## Protocol status: REST only, and that is a guess about the old server
 *
 * Nothing here has been verified against a real 44475 instance. The request
 * shape (`POST {path}` with `{query, mode, limit, freshness, language}`) is the
 * shape *this* project documents for `/api/search`; an older build may expose
 * a different path, a different body or only an MCP endpoint. Therefore:
 *
 * - `path` and `mode` are configurable, so a different REST mount point works
 *   without a code change.
 * - `transport` is an explicit config value with a closed allow-list. `rest` is
 *   the only accepted value today; any other value fails fast with
 *   `unsupported` and a message naming what is missing. That is deliberate: a
 *   silent fallback would make an unimplemented protocol look like a misconfigured
 *   endpoint.
 * - A future MCP transport belongs in a separate adapter file (the MCP client
 *   is already a dependency for `packages/mcp`) rather than as a branch inside
 *   this one, so this REST contract stays readable and testable.
 *
 * ## Read-only and reversible
 *
 * The old service is never modified, migrated or written to: this adapter only
 * issues one POST and reads the JSON response. Deleting the provider instance
 * fully reverts the integration — no schema change, no copied keys, no jobs.
 *
 * ## Accepted response shapes
 *
 *   { "status": "completed"|"partial"|"failed", "results": [...], "errors": [...] }
 *   { "data": { "status": ..., "results": [...] } }
 *
 * A `failed` envelope is an error, even when `results` is an empty array: a
 * gateway that admits failure must not be reported as "success, 0 results".
 *
 * Verification status: `documented`. No real legacy instance was contacted; the
 * tests drive a local fake.
 */
export const legacySearchHubAdapter: SearchProviderAdapter = {
  type: "search-hub-legacy",
  requiresKey: false,
  supportsTest: true,

  async search(
    input: ProviderSearchInput,
    ctx: ProviderContext,
  ): Promise<ProviderSearchOutput> {
    const transport = ctx.config.config["transport"];
    // Strict gate: a non-string value (number/boolean/object/array) must never
    // fall through to REST. Absent, null and "" mean "use the default".
    if (transport !== undefined && transport !== null && typeof transport !== "string") {
      throw new ProviderError(
        ctx.config.id,
        "search-hub-legacy",
        "unsupported",
        `Legacy transport must be a string; received ${Array.isArray(transport) ? "array" : typeof transport}. ` +
          'Only "rest" is supported today.',
        { statusCode: 501 },
      );
    }
    if (typeof transport === "string" && transport.trim() && !SUPPORTED_TRANSPORTS.has(transport.trim())) {
      throw new ProviderError(
        ctx.config.id,
        "search-hub-legacy",
        "unsupported",
        `Legacy transport "${transport}" is not implemented. Only "rest" is supported today; ` +
          "an MCP transport would be a separate adapter.",
        { statusCode: 501 },
      );
    }

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

    // Some builds wrap the envelope in `data`; accept both without guessing.
    const envelope = isRecord(payload["data"]) ? (payload["data"] as Record<string, unknown>) : payload;
    const status = typeof envelope["status"] === "string" ? envelope["status"] : "completed";
    const upstreamErrors = readUpstreamErrors(envelope["errors"]);

    // A gateway that reports `failed` must not be mapped to an empty success.
    // Check this BEFORE requiring results[]: a failed envelope may omit the
    // field entirely, and that must still surface as the upstream error rather
    // than as a generic "malformed response".
    if (status === "failed") {
      const first = upstreamErrors[0];
      throw new ProviderError(
        ctx.config.id,
        "search-hub-legacy",
        mapUpstreamErrorCode(first?.code),
        first?.message
          ? `Legacy Search Hub reported failure: ${first.message}`
          : "Legacy Search Hub reported status=failed with no usable results",
        {
          statusCode: response.status,
          retryable: mapUpstreamErrorCode(first?.code) === "server_error",
          details: { upstreamStatus: status, upstreamErrors },
        },
      );
    }

    const list = Array.isArray(envelope["results"])
      ? envelope["results"]
      : Array.isArray(payload["results"])
        ? payload["results"]
        : undefined;
    if (list === undefined) {
      throw new ProviderError(
        ctx.config.id,
        "search-hub-legacy",
        "bad_request",
        "Legacy Search Hub response has no results[] array. Expected {results:[]} or {data:{results:[]}}.",
        { statusCode: response.status },
      );
    }

    const results = list
      .map((item) => {
        const mapped = mapItem(item, {
          titlePaths: ["title", "name"],
          urlPaths: ["url", "link"],
          snippetPaths: ["snippet", "content", "summary"],
          publishedPaths: ["publishedAt", "published_at", "datePublished", "date"],
          scorePaths: ["score"],
        });
        if (!mapped) return null;
        const upstream = readUpstreamAttribution(item);
        const result: RawSearchResult = upstream === undefined ? mapped : { ...mapped, upstream };
        return result;
      })
      .filter((item): item is RawSearchResult => item !== null)
      .slice(0, input.limit);

    const warnings: string[] = [];
    if (status === "partial" || upstreamErrors.length > 0) {
      const detail = upstreamErrors
        .map((entry) => `${entry.provider ?? "upstream"}: ${entry.code ?? "error"}${entry.message ? ` (${entry.message})` : ""}`)
        .join("; ");
      warnings.push(
        `Legacy Search Hub reported status=${status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    return {
      results,
      requestUrl: response.url,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface UpstreamErrorEntry {
  provider?: string;
  code?: string;
  message?: string;
}

function readUpstreamErrors(raw: unknown): UpstreamErrorEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: UpstreamErrorEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const provider = typeof item["providerName"] === "string"
      ? item["providerName"]
      : typeof item["provider"] === "string"
        ? item["provider"]
        : undefined;
    const code = typeof item["code"] === "string" ? item["code"] : undefined;
    const message = typeof item["message"] === "string" ? item["message"] : undefined;
    entries.push({
      ...(provider === undefined ? {} : { provider }),
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message: message.slice(0, 300) }),
    });
  }
  return entries;
}

/**
 * Maps an upstream error code onto this platform's provider codes. Unknown
 * upstream codes become `server_error` only when they look like a 5xx; anything
 * else stays `bad_request` so a gateway misconfiguration is not retried.
 */
function mapUpstreamErrorCode(code: string | undefined): "server_error" | "bad_request" | "rate_limited" | "auth_invalid" {
  switch (code) {
    case "rate_limited":
      return "rate_limited";
    case "auth_invalid":
    case "unauthorized":
    case "invalid_token":
      return "auth_invalid";
    case "server_error":
    case "internal_error":
    case "upstream_error":
      return "server_error";
    default:
      return "bad_request";
  }
}

/**
 * Copies upstream attribution verbatim. Nothing is inferred: if the gateway did
 * not say which provider produced the row, `upstream` stays undefined rather
 * than borrowing the gateway's own name.
 */
function readUpstreamAttribution(item: unknown): UpstreamAttribution | undefined {
  if (!isRecord(item)) return undefined;
  const provider = typeof item["provider"] === "string" ? item["provider"] : undefined;
  const providerName = typeof item["providerName"] === "string" ? item["providerName"] : undefined;
  const source = typeof item["source"] === "string" ? item["source"] : undefined;
  const sources = Array.isArray(item["sources"])
    ? item["sources"]
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (isRecord(entry)) {
            const name = entry["providerName"] ?? entry["name"] ?? entry["source"];
            return typeof name === "string" ? name : undefined;
          }
          return undefined;
        })
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .slice(0, 12)
    : undefined;

  if (!provider && !providerName && !source && (sources === undefined || sources.length === 0)) {
    return undefined;
  }
  return {
    ...(provider === undefined ? {} : { provider: provider.slice(0, 80) }),
    ...(providerName === undefined ? {} : { providerName: providerName.slice(0, 120) }),
    ...(source === undefined ? {} : { source: source.slice(0, 120) }),
    ...(sources === undefined || sources.length === 0 ? {} : { sources }),
  };
}
