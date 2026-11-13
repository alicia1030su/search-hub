import type { ProviderErrorCode } from "./types.js";

export type SearchHubErrorCode =
  | ProviderErrorCode
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_error"
  | "rate_limited"
  | "setup_required"
  | "already_initialized"
  | "not_implemented"
  | "internal_error";

const STATUS_BY_CODE: Record<SearchHubErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_error: 400,
  rate_limited: 429,
  setup_required: 428,
  already_initialized: 409,
  timeout: 504,
  network: 502,
  server_error: 502,
  bad_request: 400,
  blocked: 403,
  unsupported: 501,
  not_implemented: 400,
  quota_exceeded: 429,
  auth_invalid: 401,
  no_available_key: 503,
  queue_timeout: 503,
  circuit_open: 503,
  cancelled: 499,
  unknown: 500,
  internal_error: 500,
};

/** Stable machine-readable error codes surfaced by every REST/MCP entrypoint. */
export class SearchHubError extends Error {
  readonly code: SearchHubErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: SearchHubErrorCode,
    message: string,
    options: {
      status?: number;
      details?: unknown;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SearchHubError";
    this.code = code;
    this.status = options.status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }

  toJSON(): { error: { code: string; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export class ProviderError extends SearchHubError {
  readonly providerId: string;
  readonly providerType: string;
  readonly statusCode?: number;

  constructor(
    providerId: string,
    providerType: string,
    code: ProviderErrorCode,
    message: string,
    options: {
      statusCode?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(code, message, {
      ...options,
      details: options.details,
    });
    this.name = "ProviderError";
    this.providerId = providerId;
    this.providerType = providerType;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || error.message === "aborted")
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
