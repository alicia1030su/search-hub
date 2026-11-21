import {
  ProviderError,
  SearchHubError,
  errorMessage,
  isAbortError,
  type ProviderErrorCode,
  type Logger,
} from "@search-hub/shared";

export interface ErrorClassification {
  code: ProviderErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
}

/**
 * Maps an HTTP status + provider-specific error body onto the shared error
 * vocabulary. Provider adapters may override the mapping because vendors use
 * different status codes for "quota" versus "auth".
 */
export function classifyHttpStatus(
  status: number,
  body?: unknown,
  retryAfterMs?: number,
): ErrorClassification {
  const message = extractMessage(body) || `Upstream HTTP ${status}`;
  if (status === 401) {
    return { code: "auth_invalid", retryable: false, message };
  }
  if (status === 403) {
    return { code: "blocked", retryable: false, message };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      message,
    };
  }
  if (status === 402 || status === 432) {
    return { code: "quota_exceeded", retryable: false, message };
  }
  if (status === 408) {
    return { code: "timeout", retryable: true, message };
  }
  if (status >= 500) {
    return { code: "server_error", retryable: true, message };
  }
  if (status === 400 || status === 422) {
    return { code: "bad_request", retryable: false, message };
  }
  if (status === 404) {
    return { code: "bad_request", retryable: false, message };
  }
  return { code: "unknown", retryable: false, message };
}

function extractMessage(body: unknown): string {
  if (!body) return "";
  if (typeof body === "string") return body.slice(0, 300);
  if (typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  for (const key of ["error", "message", "detail", "error_description", "msg"]) {
    const value = record[key];
    if (typeof value === "string") return value.slice(0, 300);
    if (value && typeof value === "object") {
      const nested = extractMessage(value);
      if (nested) return nested;
    }
  }
  return "";
}

export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof ProviderError) {
    return {
      code: normalizeCode(error.code),
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      message: error.message,
    };
  }
  if (error instanceof SearchHubError) {
    return {
      code: normalizeCode(error.code),
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      message: error.message,
    };
  }
  if (isAbortError(error)) {
    return { code: "cancelled", retryable: false, message: "Request cancelled" };
  }
  if (error instanceof Error && error.message.includes("SSRF guard")) {
    return { code: "blocked", retryable: false, message: error.message };
  }
  return { code: "unknown", retryable: false, message: errorMessage(error) };
}

function normalizeCode(code: string): ProviderErrorCode {  switch (code) {
    case "timeout":
    case "network":
    case "server_error":
    case "bad_request":
    case "blocked":
    case "rate_limited":
    case "auth_invalid":
    case "quota_exceeded":
    case "no_available_key":
    case "queue_timeout":
    case "circuit_open":
    case "unsupported":
    case "cancelled":
    case "unknown":
      return code;
    case "validation_error":
      return "bad_request";
    case "forbidden":
      return "blocked";
    default:
      return "unknown";
  }
}

/**
 * Retry budget shared by one search request. Prevents a single query from
 * producing an unbounded request storm across providers and keys.
 */
export class RetryBudget {
  private remaining: number;

  constructor(total: number) {
    this.remaining = Math.max(0, total);
  }

  get left(): number {
    return this.remaining;
  }

  consume(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }
}

export function backoffDelay(attempt: number, baseMs = 250, maxMs = 4000): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  // Full jitter avoids synchronised retries across providers.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

export function logProviderFailure(
  logger: Logger,
  providerId: string,
  providerType: string,
  code: ProviderErrorCode,
  message: string,
): void {
  logger.warn({ providerId, providerType, code }, `provider call failed: ${message}`);
}
