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
import type { GroundedAnswer } from "@search-hub/shared";

/** Resolves the decrypted credential for a key id; implementation lives in the API layer. */
export interface CredentialResolver {
  getKeyValue(keyId: string): Promise<string | undefined>;
}

export interface ProviderRuntime {
  config: ProviderRuntimeConfig;
  adapter: SearchProviderAdapter;
  scheduler: KeyScheduler;
  enabled: boolean;
  /** Effective credential requirement for this instance (generic-http is config-driven). */
  requiresKey?: boolean;
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
  /**
   * Gate consulted immediately before every physical request this provider
   * makes — including each page of a paginated adapter and every redirect hop.
   *
   * If it throws, the request is not sent. This is what makes a request budget
   * a limit on the wire rather than a limit on intentions: the fan-out has no
   * idea how many pages an adapter will fetch.
   */
  beforeRequest?: (providerId: string, url: string) => void;
}

export interface FanoutResult {
  providerId: string;
  providerName: string;
  providerType: string;
  ok: boolean;
  results: RawSearchResult[];
  stat: ProviderAttemptStat;
  error?: SearchErrorSummary;
  /** Present only when the adapter returned a grounded answer. */
  answer?: GroundedAnswer;
}

function nowMs(): number {
  return Date.now();
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}

function isLocalPolicyBlock(error: unknown): boolean {
  const details = (error as { details?: unknown } | null)?.details;
  return typeof details === "object" && details !== null && (details as { localBlock?: unknown }).localBlock === true;
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
        errorCode: "circuit_open",
        errorMessage: `Circuit breaker open for another ${Math.round(remaining / 1000)}s`,
        attempts: 0,
      },
      error: {
        providerId: config.id,
        providerName: config.name,
        code: "circuit_open",
        message: `Circuit breaker open for another ${Math.round(remaining / 1000)}s`,
      },
    };
  }

  const maxAttempts = 1 + Math.max(0, config.maxRetries);
  let httpRequestsThisRun: number | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts += 1;
    if (options.signal.aborted) break;
    if (nowMs() >= deadline) break;

    let lease: KeyLease | null = null;
    // Set when the caller aborted while we were waiting for a lease; the
    // acquire path can resolve after the signal fires, so a lease obtained this
    // way must still be returned instead of leaking a slot.
    if (options.signal.aborted) break;
    if (runtime.requiresKey ?? adapter.requiresKey) {
      const acquired = await scheduler.acquireWithReason({
        // Queue for the request's remaining lifetime, not an arbitrary shorter
        // budget. Under parallel load a valid request can wait more than two
        // seconds for a key slot while still having time to execute.
        maxWaitMs: Math.max(0, deadline - nowMs()),
        signal: options.signal,
      });
      lease = acquired.lease;
      if (!lease) {
        if (acquired.reason === "account_quota") {
          // The vendor account itself is exhausted: another key in the same
          // group would not help, so this is a quota error rather than key
          // exhaustion.
          lastCode = "quota_exceeded";
          lastMessage =
            `Account-level quota for provider "${config.name}" is exhausted. ` +
            "Keys in the same account group share one vendor budget.";
          break;
        }
        const waiting = acquired.reason === "queue_timeout";
        lastCode = waiting ? "queue_timeout" : "no_available_key";
        lastMessage = waiting
          ? `All API key slots for provider "${config.name}" were busy beyond the queue budget`
          : `No available API key for provider "${config.name}" (cooldown, quota or rate limit reached)`;
        break;
      }
      usedKeyId = lease.keyId;
      // The wait can resolve after the caller aborted. Return the slot without
      // counting a failure; retrying a cancelled request is never correct.
      if (options.signal.aborted) {
        lease.release({ ok: false, notSent: true });
        lastCode = "cancelled";
        lastMessage = "Search cancelled by caller";
        break;
      }
    }

    let apiKey: string | undefined;
    if (lease) {
      try {
        apiKey = await options.credentials.getKeyValue(lease.keyId);
      } catch (error) {
        // A credential-store failure must not leak the slot.
        lease.release({ ok: false, notSent: true });
        throw error;
      }
      if (!apiKey) {
        lease.release({ ok: false, notSent: true });
        lastCode = "auth_invalid";
        lastMessage = "API key could not be decrypted (master key changed?)";
        break;
      }
    }

    if (options.signal.aborted || nowMs() >= deadline) {
      lease?.release({ ok: false, notSent: true });
      lastCode = options.signal.aborted ? "cancelled" : "timeout";
      lastMessage = options.signal.aborted ? "Search cancelled by caller" : "Provider deadline exceeded";
      break;
    }

    const timeoutMs = Math.min(config.timeoutMs, Math.max(500, deadline - nowMs()));
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error("provider timeout")), timeoutMs);
    const signal = combineSignals(options.signal, timeoutController.signal);

    const counted = { requests: 0 };
    let localBudgetRefusal = false;
    try {
      // Every physical request an adapter makes passes through here. Counting
      // is per-invocation so the count belongs to this provider and this
      // attempt; the gate itself is shared across the whole search.
      const gatedFetch: SafeFetch = (url, init) =>
        options.fetch(url, {
          ...init,
          onRequest: (target) => {
            try {
              options.beforeRequest?.(config.id, target);
            } catch (error) {
              localBudgetRefusal = true;
              throw error;
            }
            counted.requests += 1;
          },
        });
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
          fetch: gatedFetch,
          ...(apiKey === undefined ? {} : { apiKey }),
          config,
          signal,
          logger: options.logger,
        },
      );

      const latencyMs = nowMs() - started;
      lease?.release(
        counted.requests === 0
          ? { ok: false, notSent: true }
          : { ok: true, latencyMs },
      );
      runtime.breaker.failures = 0;
      runtime.breaker.openUntilMs = null;

      return {
        providerId: config.id,
        providerName: config.name,
        providerType: config.type,
        ok: true,
        results: output.results,
        ...(output.answer === undefined ? {} : { answer: output.answer }),
        stat: {
          providerId: config.id,
          providerName: config.name,
          providerType: config.type,
          ok: true,
          latencyMs,
          resultCount: output.results.length,
          ...(usedKeyId === undefined ? {} : { keyId: usedKeyId }),
          ...(output.warnings && output.warnings.length > 0
            ? { warning: output.warnings.join("; ").slice(0, 500) }
            : {}),
          attempts,
          httpRequests: counted.requests,
        },
      };
    } catch (error) {
      clearTimeout(timer);
      const classified = classifyError(error);
      const timedOutByDeadline = nowMs() >= deadline;
      // A per-provider timeout aborts through the combined signal, so the raw
      // error is a plain Error("provider timeout"), not an AbortError. Without
      // this mapping operators see "unknown" instead of "timeout".
      const timedOutByProvider = timeoutController.signal.aborted && !options.signal.aborted;
      lastCode =
        timedOutByProvider || (timedOutByDeadline && classified.code === "unknown")
          ? "timeout"
          : classified.code;
      lastMessage = timedOutByProvider ? "Provider exceeded its timeout budget" : classified.message;
      statusCode = error instanceof ProviderError ? error.statusCode : undefined;

      // Two cancellation paths reach this catch:
      //  - an undici AbortError (raw abort), and
      //  - a SearchHubError("cancelled") from safe-fetch (our structured abort).
      // Both must release the slot without counting a failure, otherwise a
      // user cancel pollutes key stats and can push a healthy key toward cooldown.
      // A third one is common in practice: an adapter that sleeps or awaits with
      // the caller's signal rejects with the abort *reason*, which is a plain
      // Error("cancelled by user") — not an AbortError. The caller's signal being
      // aborted is the authoritative fact here, so anything surfacing after that
      // point is a cancel, not a verdict about the provider.
      if (lastCode === "cancelled" || options.signal.aborted) {
        lease?.release({
          ok: false,
          ...(counted.requests === 0 ? { notSent: true } : { cancelled: true }),
        });
        lastCode = "cancelled";
        lastMessage = "Search cancelled by caller";
        break;
      }

      const localPolicyBlock = isLocalPolicyBlock(error);
      if (localBudgetRefusal || localPolicyBlock) {
        lease?.release(
          counted.requests === 0
            ? { ok: false, notSent: true }
            : { ok: false, code: "bad_response", message: lastMessage },
        );
        break;
      }

      lease?.release({
        ok: false,
        ...(counted.requests === 0
          ? { notSent: true }
          : {
              code: lastCode,
              message: lastMessage,
              ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
            }),
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
      // Retries each count from zero; the run total is what the operator is
      // billed for, so attempts accumulate rather than overwrite.
      httpRequestsThisRun = (httpRequestsThisRun ?? 0) + counted.requests;
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
      // Failed attempts still spent the requests they issued; reporting 0 here
      // would understate what the vendor billed.
      ...(httpRequestsThisRun === undefined ? {} : { httpRequests: httpRequestsThisRun }),
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
