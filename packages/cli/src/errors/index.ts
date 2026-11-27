import { redactSecrets } from "@search-hub/shared";

export const EXIT_CODES = {
  ok: 0,
  usage: 2,
  auth: 3,
  forbidden: 4,
  network: 5,
  server: 6,
  timeout: 7,
  incompatible: 8,
  content_unavailable: 9,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  constructor(
    code: string,
    message: string,
    exitCode: ExitCode,
    options: { details?: unknown; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
  }

  toJSON(): { error: { code: string; message: string; details?: unknown; retryAfterMs?: number } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      },
    };
  }
}

export function usageError(message: string): CliError {
  return new CliError("invalid_arguments", message, EXIT_CODES.usage);
}

export function interruptedError(): CliError {
  return new CliError("interrupted", "Interrupted by user", EXIT_CODES.interrupted);
}

export function redactUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactUnknown(item, secrets),
      ]),
    );
  }
  return value;
}

export function asCliError(error: unknown, secrets: string[] = []): CliError {
  if (error instanceof CliError) {
    if (secrets.length === 0) return error;
    return new CliError(
      error.code,
      redactSecrets(error.message, secrets),
      error.exitCode,
      {
        details: redactUnknown(error.details, secrets),
        retryAfterMs: error.retryAfterMs,
        cause: error.cause,
      },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(
    "unexpected_error",
    redactSecrets(message, secrets),
    EXIT_CODES.server,
    { cause: error },
  );
}
