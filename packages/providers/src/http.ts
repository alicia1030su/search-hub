import {
  ProviderError,
  SearchHubError,
  getByPath,
  parseRetryAfter,
  stripHtml,
  truncateText,
  type ProviderContext,
  type RawSearchResult,
  type SafeFetchResponse,
} from "@search-hub/shared";

function mapHttpStatus(status: number): {
  code: "auth_invalid" | "rate_limited" | "quota_exceeded" | "timeout" | "server_error" | "bad_request" | "unknown";
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { code: "auth_invalid", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 402) return { code: "quota_exceeded", retryable: false };
  if (status === 408 || status === 504) return { code: "timeout", retryable: true };
  if (status >= 500) return { code: "server_error", retryable: true };
  if (status >= 400) return { code: "bad_request", retryable: false };
  return { code: "unknown", retryable: false };
}

export interface RequestSpec {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Shared request helper used by all builtin adapters.
 * It converts transport failures into ProviderError with the exact vendor
 * semantics so the scheduler can cool the right key.
 */
export async function callJson(
  ctx: ProviderContext,
  spec: RequestSpec,
): Promise<SafeFetchResponse<unknown>> {
  const headers = new Headers(spec.headers ?? {});
  if (!headers.has("accept")) headers.set("accept", "application/json");

  let body: string | undefined;
  if (spec.body !== undefined) {
    body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  try {
    return await ctx.fetch<unknown>(spec.url, {
      method: spec.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: ctx.signal,
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    });
  } catch (error) {
    if (error instanceof SearchHubError) {
      // validateOutboundUrl / size caps / timeouts already carry a code.
      if (error.code === "timeout") {
        throw new ProviderError(ctx.config.id, ctx.config.type, "timeout", error.message, {
          retryable: true,
          statusCode: 504,
          cause: error,
        });
      }
      if (error.code === "network") {
        throw new ProviderError(ctx.config.id, ctx.config.type, "network", error.message, {
          retryable: true,
          cause: error,
        });
      }
      if (error.status === 429) {
        throw new ProviderError(ctx.config.id, ctx.config.type, "rate_limited", error.message, {
          retryable: true,
          statusCode: 429,
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          cause: error,
        });
      }
      if (error.status >= 500 || error.status === 408) {
        throw new ProviderError(
          ctx.config.id,
          ctx.config.type,
          error.status === 408 ? "timeout" : "server_error",
          error.message,
          { retryable: true, statusCode: error.status, cause: error },
        );
      }
      const classified = mapHttpStatus(error.status);
      throw new ProviderError(ctx.config.id, ctx.config.type, classified.code, error.message, {
        statusCode: error.status,
        retryable: classified.retryable,
        cause: error,
      });
    }
    throw new ProviderError(
      ctx.config.id,
      ctx.config.type,
      "network",
      `Request to ${ctx.config.name} failed`,
      { retryable: true, cause: error },
    );
  }
}

/**
 * Validates a provider response envelope before mapping. Vendors differ, so
 * each adapter passes its own required shape predicate.
 */
export function expectObject(
  ctx: ProviderContext,
  data: unknown,
  what = "response",
): Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProviderError(
      ctx.config.id,
      ctx.config.type,
      "bad_request",
      `${ctx.config.name} returned an unexpected ${what} (expected a JSON object)`,
    );
  }
  return data as Record<string, unknown>;
}

export function expectArray(
  ctx: ProviderContext,
  value: unknown,
  what: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProviderError(
      ctx.config.id,
      ctx.config.type,
      "bad_request",
      `${ctx.config.name} response is missing the ${what} array`,
    );
  }
  return value;
}

export interface MapResultOptions {
  titlePaths: string[];
  urlPaths: string[];
  snippetPaths: string[];
  publishedPaths?: string[];
  scorePaths?: string[];
  languagePaths?: string[];
}

/** Reads the first non-empty string at any of the candidate paths. */
export function pickString(source: unknown, paths: string[]): string {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

export function pickNumber(source: unknown, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** Maps one vendor item to the shared RawSearchResult shape. */
export function mapItem(
  item: unknown,
  options: MapResultOptions,
  limits: { maxSnippetChars?: number } = {},
): RawSearchResult | null {
  const title = stripHtml(pickString(item, options.titlePaths));
  const url = pickString(item, options.urlPaths).trim();
  if (!title || !url) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  const snippetRaw = pickString(item, options.snippetPaths);
  const snippet = truncateText(stripHtml(snippetRaw), limits.maxSnippetChars ?? 600);
  const publishedRaw = options.publishedPaths ? pickString(item, options.publishedPaths) : "";
  const publishedAt = publishedRaw ? normalizeDate(publishedRaw) : undefined;
  const score = options.scorePaths ? pickNumber(item, options.scorePaths) : undefined;
  const language = options.languagePaths ? pickString(item, options.languagePaths) : "";

  return {
    title: truncateText(title, 300),
    url,
    snippet,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(score === undefined ? {} : { score }),
    ...(language ? { language: truncateText(language, 24) } : {}),
  };
}

export function normalizeDate(input: string): string | undefined {
  if (!input) return undefined;
  const numeric = Number(input);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    // Seconds vs milliseconds: both appear in search APIs.
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

export function retryAfterFromHeaders(headers: Headers): number | undefined {
  return parseRetryAfter(headers.get("retry-after"));
}
