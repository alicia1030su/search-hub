import { redactSecrets } from "@search-hub/shared";
import { CLI_VERSION } from "../version.js";
import { CliError, EXIT_CODES, redactUnknown, usageError } from "../errors/index.js";
import { joinServerUrl, sameOrigin } from "../security/url.js";
import type { HealthResponse } from "../types.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
  authenticated?: boolean;
  headers?: Record<string, string>;
}

export class HttpResponseError extends CliError {
  readonly status: number;
  readonly body: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    body: unknown,
    options: { details?: unknown; retryAfterMs?: number } = {},
  ) {
    const exitCode =
      status === 401
        ? EXIT_CODES.auth
        : status === 403
          ? EXIT_CODES.forbidden
          : status === 404 || status === 405 || status === 501
            ? EXIT_CODES.incompatible
            : status === 400 || status === 422
              ? EXIT_CODES.usage
              : status === 408 || status === 504
                ? EXIT_CODES.timeout
                : EXIT_CODES.server;
    super(code, message, exitCode, options);
    this.name = "HttpResponseError";
    this.status = status;
    this.body = body;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function errorEnvelope(body: unknown): { code?: string; message?: string; details?: unknown } {
  if (body !== null && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (error !== null && typeof error === "object") return error as { code?: string; message?: string; details?: unknown };
  }
  return {};
}

export class HttpClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string, token: string | undefined, defaultTimeoutMs: number, signal?: AbortSignal) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.signal = signal;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error("request timed out")), timeoutMs);
    const signals = [timeoutController.signal];
    if (this.signal) signals.push(this.signal);
    const signal = AbortSignal.any(signals);
    const secrets = this.token ? [this.token] : [];
    let currentUrl = joinServerUrl(this.baseUrl, path);
    let currentMethod = method;
    let currentBody = options.body;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (this.signal?.aborted) {
          throw new CliError("interrupted", "Interrupted by user", EXIT_CODES.interrupted);
        }
        const headers: Record<string, string> = {
          accept: "application/json",
          "user-agent": `shub/${CLI_VERSION}`,
          ...options.headers,
        };
        if (options.authenticated !== false && this.token) headers["authorization"] = `Bearer ${this.token}`;
        if (currentBody !== undefined) headers["content-type"] = "application/json";

        const response = await fetch(currentUrl, {
          method: currentMethod,
          headers,
          ...(currentBody === undefined ? {} : { body: JSON.stringify(currentBody) }),
          redirect: "manual",
          signal,
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new HttpResponseError(response.status, "invalid_redirect", "Redirect response has no Location header", null);
          if (currentMethod !== "GET") {
            throw new HttpResponseError(
              response.status,
              "unsafe_redirect",
              "Refusing to redirect a mutating request; retry against the final URL explicitly",
              null,
            );
          }
          const next = new URL(location, currentUrl);
          if (!sameOrigin(new URL(currentUrl), next)) {
            throw new CliError(
              "cross_origin_redirect",
              "Refusing a cross-origin redirect; credentials were not forwarded",
              EXIT_CODES.network,
            );
          }
          currentUrl = next.toString();
          continue;
        }

        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
          throw new CliError("response_too_large", "Search Hub response exceeds the 16 MiB CLI safety limit", EXIT_CODES.server);
        }
        let body: unknown = undefined;
        if (text.length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        if (secrets.length > 0) body = redactUnknown(body, secrets);
        if (response.ok) return body as T;

        const envelope = errorEnvelope(body);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const fallback = response.status === 429 ? "Rate limited by Search Hub" : `Search Hub returned HTTP ${response.status}`;
        const message = envelope.message ?? fallback;
        throw new HttpResponseError(
          response.status,
          envelope.code ?? `http_${response.status}`,
          retryAfterMs === undefined ? message : `${message} (retry after ${retryAfterMs} ms)`,
          body,
          { details: envelope.details, retryAfterMs },
        );
      }
      throw new CliError("too_many_redirects", `Search Hub exceeded ${MAX_REDIRECTS} same-origin redirects`, EXIT_CODES.network);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (this.signal?.aborted) {
        throw new CliError("interrupted", "Interrupted by user", EXIT_CODES.interrupted);
      }
      if (timeoutController.signal.aborted) {
        throw new CliError("timeout", `Request timed out after ${timeoutMs} ms`, EXIT_CODES.timeout, { cause: error });
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = redactSecrets(rawMessage, secrets);
      throw new CliError("network_error", `Cannot reach Search Hub: ${message}`, EXIT_CODES.network);
    } finally {
      clearTimeout(timer);
    }
  }

  health(timeoutMs?: number): Promise<HealthResponse> {
    return this.request<HealthResponse>("/api/health", { authenticated: false, timeoutMs });
  }
}

export function parseServerVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** v0.1.14 CLI uses only endpoints present since v0.1.12; 0.2 may break them. */
export function isCompatibleServerVersion(version: string): boolean {
  const parsed = parseServerVersion(version);
  return parsed !== null && parsed.major === 0 && parsed.minor === 1 && parsed.patch >= 12;
}

export async function ensureCompatible(client: HttpClient): Promise<HealthResponse> {
  const health = await client.health();
  if (!isCompatibleServerVersion(health.version)) {
    throw new CliError(
      "incompatible_server",
      `Search Hub server ${health.version} is incompatible with shub ${CLI_VERSION}; expected 0.1.12 or later within 0.1.x`,
      EXIT_CODES.incompatible,
      { details: { serverVersion: health.version, cliVersion: CLI_VERSION } },
    );
  }
  return health;
}

export function requireToken(token: string | undefined): string {
  if (!token) {
    throw new CliError(
      "token_required",
      "This command requires SEARCH_HUB_TOKEN (or --token-stdin)",
      EXIT_CODES.auth,
    );
  }
  return token;
}

export function validateTimeout(value: number | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1000 || value > 120_000) {
    throw usageError("--timeout must be between 1000 and 120000 milliseconds");
  }
  return value;
}
