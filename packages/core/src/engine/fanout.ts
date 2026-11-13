import {
  ProviderError,
  SearchHubError,
  errorMessage,
  isAbortError,
  type Freshness,
  type Logger,
  type ProviderAttemptStat,
  type ProviderErrorCode,
  type ProviderRuntimeConfig,
  type ProviderSearchOutput,
  type RawSearchResult,
  type SearchErrorSummary,
  type SafeFetch,
  type SearchProviderAdapter,
} from "@search-hub/shared";
import { backoffDelay, classifyError, RetryBudget } from "../errors/classify.js";
import type { KeyLease, KeyScheduler } from "../scheduler/key-scheduler.js";

/** Resolves the decrypted credential for a key id; implementation lives in the API layer. */
export interface CredentialResolver {
  getKeyValue(keyId: string): Promise<string | undefined>;
}

export interface ProviderRuntime {
  config: ProviderRuntimeConfig;
  adapter: SearchProviderAdapter;
  scheduler: KeyScheduler;
  enabled: boolean;
  /** Provider-level circuit breaker bookkeeping. */
  breaker: {
    failures: number;
    openUntilMs: number | null;
  };
}

export interface FanoutOptions {
  query: string;
  limitPerProvider: number;
  language?: string;
  freshness?: Freshness;
  deadlineMs: number;
  retryBudget: RetryBudget;
  signal: AbortSignal;
  logger: Logger;
  fetch: SafeFetch;
  credentials: CredentialResolver;
}

export interface FanoutResult {
  providerId: string;
  providerName: string;
  providerType: string;
  ok: boolean;
  results: RawSearchResult[];
  stat: ProviderAttemptStat;
  error?: SearchErrorSummary;
}

function nowMs(): number {
  return Date.now();
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}

/**
 * Runs one provider with key leasing, bounded retries, per-request timeout and
 * error mapping. A failing provider never rejects: it returns a result object
 * so the caller can keep the healthy providers' results.
 */
export async function runProvider(
  runtime: ProviderRuntime,
  options: FanoutOptions,
): Promise<FanoutResult> {
  const { config, adapter, scheduler } = runtime;
  const started = nowMs();
  const deadline = started + options.deadlineMs;
  let attempts = 0;
  let lastCode: ProviderErrorCode | undefined;
  let lastMessage: string | undefined;
  let statusCode: number | undefined;
  let usedKeyId: string | undefined;

  if (!runtime.enabled) {
    return {
      providerId: config.id,
      providerName: config.name,
      providerType: config.type,
      ok: false,
      results: [],
      stat: {
        providerId: config.id,
        providerName: config.name,
        providerType: config.type,
        ok: false,
        latencyMs: 0,
        resultCount: 0,
        errorCode: "unsupported",
        errorMessage: "Provider is disabled",
        attempts: 0,
      },
      error: {
        providerId: config.id,
        providerName: config.name,
        code: "unsupported",
        message: "Provider is disabled",
      },
    };
  }

  if (runtime.breaker.openUntilMs !== null && runtime.breaker.openUntilMs > nowMs()) {
    const remaining = runtime.breaker.openUntilMs - nowMs();
    return {
      providerId: config.id,
      providerName: config.name,
      providerType: config.type,
      ok: false,
      results: [],
      stat: {
        providerId: config.id,
        providerName: config.name,
        providerType: config.type,
        ok: false,
        latencyMs: 0,
        resultCount: 0,
        errorCode: "server_error",
        errorMessage: `Circuit breaker open for another ${Math.round(remaining / 1000)}s`,
        attempts: 0,
      },
      error: {
        providerId: config.id,
        providerName: config.name,
        code: "server_error",
        message: `Circuit breaker open for another ${Math.round(remaining / 1000)}s`,
      },
    };
  }

  const maxAttempts = 1 + Math.max(0, config.maxRetries);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts += 1;
    if (options.signal.aborted) break;
    if (nowMs() >= deadline) break;

    let lease: KeyLease | null = null;
    if (adapter.requiresKey || scheduler.hasKeys()) {
      lease = await scheduler.acquire({
        maxWaitMs: Math.min(2_000, Math.max(0, deadline - nowMs())),
        signal: options.signal,
      });
      if (!lease) {
        lastCode = "no_available_key";
        lastMessage = `No available API key for provider "${config.name}" (cooldown, concurrency or quota limit reached)`;
        break;
      }
      usedKeyId = lease.keyId;
    }

    let apiKey: string | undefined;
    if (lease) {
      apiKey = await options.credentials.getKeyValue(lease.keyId);
      if (!apiKey) {
        lease.release({ ok: false, code: "auth_invalid", message: "API key not found" });
        lastCode = "auth_invalid";
        lastMessage = "API key could not be decrypted (master key changed?)";
        break;
      }
    }

    const timeoutMs = Math.min(config.timeoutMs, Math.max(500, deadline - nowMs()));
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error("provider timeout")), timeoutMs);
    const signal = combineSignals(options.signal, timeoutController.signal);

    try {
      const output: ProviderSearchOutput = await adapter.search(
        {
          query: options.query,
          limit: options.limitPerProvider,
          ...(options.language === undefined ? {} : { language: options.language }),
          ...(options.freshness === undefined || options.freshness === "all"
            ? {}
            : { freshness: options.freshness }),
          signal,
        },
        {
          fetch: options.fetch,
          ...(apiKey === undefined ? {} : { apiKey }),
          config,
          signal,
          logger: options.logger,
        },
      );

      const latencyMs = nowMs() - started;
      lease?.release({ ok: true, latencyMs });
      runtime.breaker.failures = 0;
      runtime.breaker.openUntilMs = null;

      return {
        providerId: config.id,
        providerName: config.name,
        providerType: config.type,
        ok: true,
        results: output.results,
        stat: {
          providerId: config.id,
          providerName: config.name,
          providerType: config.type,
          ok: true,
          latencyMs,
          resultCount: output.results.length,
          ...(usedKeyId === undefined ? {} : { keyId: usedKeyId }),
          attempts,
        },
      };
    } catch (error) {
      clearTimeout(timer);
      const classified = classifyError(error);
      const timedOutByDeadline = nowMs() >= deadline;
      lastCode = timedOutByDeadline && !classified.code ? "timeout" : classified.code;
      lastMessage = classified.message;
      statusCode = error instanceof ProviderError ? error.statusCode : undefined;

      if (isAbortError(error) && options.signal.aborted) {
        lease?.release({ ok: false, cancelled: true });
        lastCode = "cancelled";
        lastMessage = "Search cancelled by caller";
        break;
      }

      lease?.release({
        ok: false,
        code: lastCode,
        message: lastMessage,
        ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
      });

      if (!classified.retryable || lastCode === "auth_invalid" || lastCode === "quota_exceeded") {
        break;
      }
      if (attempt + 1 >= maxAttempts) break;
      if (!options.retryBudget.consume()) break;

      const retryDelay = classified.retryAfterMs ?? backoffDelay(attempt + 1);
      const wait = Math.min(retryDelay, Math.max(0, deadline - nowMs()));
      if (wait <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastCode === "server_error" || lastCode === "network" || lastCode === "timeout") {
    runtime.breaker.failures += 1;
    if (runtime.breaker.failures >= config.breakerThreshold) {
      runtime.breaker.openUntilMs = nowMs() + config.breakerCooldownMs;
      runtime.breaker.failures = 0;
    }
  }

  const latencyMs = nowMs() - started;
  const code: ProviderErrorCode = lastCode ?? "unknown";
  const message = lastMessage ?? "Provider failed";

  return {
    providerId: config.id,
    providerName: config.name,
    providerType: config.type,
    ok: false,
    results: [],
    stat: {
      providerId: config.id,
      providerName: config.name,
      providerType: config.type,
      ok: false,
      latencyMs,
      resultCount: 0,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(usedKeyId === undefined ? {} : { keyId: usedKeyId }),
      errorCode: code,
      errorMessage: message,
      attempts,
    },
    error: {
      providerId: config.id,
      providerName: config.name,
      code,
      message,
    },
  };
}

/**
 * Fans a query out to all selected providers concurrently. Individual failures
 * are isolated; partial results are returned with an error summary per source.
 */
export async function fanoutProviders(
  runtimes: ProviderRuntime[],
  options: FanoutOptions,
): Promise<FanoutResult[]> {
  if (runtimes.length === 0) return [];
  const tasks = runtimes.map(async (runtime) => {
    try {
      return await runProvider(runtime, options);
    } catch (error) {
      const code: ProviderErrorCode = isAbortError(error) ? "cancelled" : "unknown";
      return {
        providerId: runtime.config.id,
        providerName: runtime.config.name,
        providerType: runtime.config.type,
        ok: false,
        results: [],
        stat: {
          providerId: runtime.config.id,
          providerName: runtime.config.name,
          providerType: runtime.config.type,
          ok: false,
          latencyMs: 0,
          resultCount: 0,
          errorCode: code,
          errorMessage: errorMessage(error),
          attempts: 0,
        },
        error: {
          providerId: runtime.config.id,
          providerName: runtime.config.name,
          code,
          message: errorMessage(error),
        },
      } satisfies FanoutResult;
    }
  });

  return Promise.all(tasks);
}

export function assertProvidersAvailable(runtimes: ProviderRuntime[]): void {
  if (runtimes.length === 0) {
    throw new SearchHubError(
      "validation_error",
      "No search providers are enabled. Add and enable at least one provider in Search Sources.",
    );
  }
}
