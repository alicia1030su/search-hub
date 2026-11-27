import { SearchHubError } from "@search-hub/shared";

export interface ProviderRateLimitPolicy {
  /** Minimum start-to-start interval for requests to this provider. */
  minIntervalMs?: number;
  /** Maximum number of requests that may be in flight at once. */
  maxInFlight?: number;
  /** Maximum request starts inside a sliding 60-second window. */
  maxPerMinute?: number;
  /** Maximum request starts inside a sliding 60-minute window. */
  maxPerHour?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Bucket {
  key: string;
  policy: Required<ProviderRateLimitPolicy>;
  nextStartAt: number;
  blockedUntil: number;
  inFlight: number;
  minuteStarts: number[];
  hourStarts: number[];
  lastNow: number;
  queue: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_POLICY: Required<ProviderRateLimitPolicy> = {
  minIntervalMs: 0,
  maxInFlight: 4,
  maxPerMinute: Number.MAX_SAFE_INTEGER,
  maxPerHour: Number.MAX_SAFE_INTEGER,
};

const buckets = new Map<string, Bucket>();
const MAX_QUEUED = 256;

/** Stable process-local identity for one provider endpoint and auth mode. */
export function providerRateLimitKey(
  type: string,
  baseUrl: string | null | undefined,
  mode = "default",
): string {
  let origin = "default";
  if (baseUrl) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = baseUrl.replace(/\/+$/, "");
    }
  }
  return `${type}:${origin}:${mode}`;
}

function resetBucket(bucket: Bucket): void {
  bucket.nextStartAt = 0;
  bucket.blockedUntil = 0;
  bucket.inFlight = 0;
  bucket.minuteStarts = [];
  bucket.hourStarts = [];
  bucket.lastNow = 0;
  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = null;
}

function getBucket(key: string, policy: ProviderRateLimitPolicy): Bucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      key,
      policy: { ...DEFAULT_POLICY, ...policy },
      nextStartAt: 0,
      blockedUntil: 0,
      inFlight: 0,
      minuteStarts: [],
      hourStarts: [],
      lastNow: 0,
      queue: [],
      timer: null,
    };
    buckets.set(key, bucket);
  } else {
    bucket.policy = { ...DEFAULT_POLICY, ...policy };
    // Fake clocks and wall-clock rollback must not leave a bucket permanently
    // blocked. A rollback larger than one second starts a fresh budget window.
    const now = Date.now();
    if (now + 1_000 < bucket.lastNow) resetBucket(bucket);
  }
  return bucket;
}

function schedule(bucket: Bucket, delay: number): void {
  if (bucket.timer) clearTimeout(bucket.timer);
  bucket.timer = setTimeout(() => {
    bucket.timer = null;
    pump(bucket);
  }, Math.max(0, delay));
}

function pump(bucket: Bucket): void {
  const now = Date.now();
  bucket.lastNow = now;

  bucket.minuteStarts = bucket.minuteStarts.filter((startedAt) => startedAt > now - 60_000);
  bucket.hourStarts = bucket.hourStarts.filter((startedAt) => startedAt > now - 3_600_000);

  while (bucket.queue.length > 0 && bucket.inFlight < bucket.policy.maxInFlight) {
    const minuteWait = bucket.minuteStarts.length >= bucket.policy.maxPerMinute
      ? bucket.minuteStarts[0]! + 60_000 - now
      : 0;
    const hourWait = bucket.hourStarts.length >= bucket.policy.maxPerHour
      ? bucket.hourStarts[0]! + 3_600_000 - now
      : 0;
    const wait = Math.max(
      bucket.nextStartAt - now,
      bucket.blockedUntil - now,
      minuteWait,
      hourWait,
    );
    if (wait > 0) {
      schedule(bucket, wait);
      return;
    }

    const waiter = bucket.queue.shift()!;
    bucket.inFlight += 1;
    bucket.minuteStarts.push(now);
    bucket.hourStarts.push(now);
    bucket.nextStartAt = now + bucket.policy.minIntervalMs;
    waiter.resolve();
  }
}

function release(bucket: Bucket): void {
  bucket.inFlight = Math.max(0, bucket.inFlight - 1);
  pump(bucket);
}

function retryAfterMs(error: unknown): number | null {
  const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/** Run one upstream operation under the provider's process-local budget. */
export async function withProviderRateLimit<T>(
  key: string,
  policy: ProviderRateLimitPolicy,
  operation: () => Promise<T>,
): Promise<T> {
  const bucket = getBucket(key, policy);
  if (bucket.queue.length >= MAX_QUEUED) {
    throw new SearchHubError("rate_limited", `Provider rate-limit queue is full for ${bucket.key}`);
  }

  await new Promise<void>((resolve, reject) => {
    bucket.queue.push({ resolve, reject });
    pump(bucket);
  });

  try {
    return await operation();
  } catch (error) {
    const delay = retryAfterMs(error);
    if (delay !== null) {
      bucket.blockedUntil = Math.max(bucket.blockedUntil, Date.now() + delay);
    }
    throw error;
  } finally {
    release(bucket);
  }
}

/** Test-only reset; production code must never call this. */
export function resetProviderRateLimitsForTests(): void {
  for (const bucket of buckets.values()) {
    if (bucket.timer) clearTimeout(bucket.timer);
  }
  buckets.clear();
}
