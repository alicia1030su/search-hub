/** Fixed-size logarithmic latency histogram with O(1) updates. */
export class LatencyHistogram {
  readonly bucketCount: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly quantileMethod = "histogram_nearest_bucket" as const;
  private readonly counts: number[];
  private readonly logStep: number;
  private total = 0;

  constructor(bucketCount = 64, minMs = 0.001, maxMs = 60_000) {
    if (!Number.isInteger(bucketCount) || bucketCount < 48 || bucketCount > 64) {
      throw new TypeError("Latency histogram requires 48..64 buckets");
    }
    if (!Number.isFinite(minMs) || minMs <= 0 || !Number.isFinite(maxMs) || maxMs <= minMs) {
      throw new TypeError("Latency histogram bounds must be positive and ordered");
    }
    this.bucketCount = bucketCount;
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.counts = Array.from({ length: bucketCount }, () => 0);
    this.logStep = Math.log(maxMs / minMs) / (bucketCount - 1);
  }

  /** Record one non-negative duration in milliseconds. */
  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const index = durationMs <= this.minMs
      ? 0
      : durationMs >= this.maxMs
        ? this.bucketCount - 1
        : Math.min(this.bucketCount - 1, Math.floor(Math.log(durationMs / this.minMs) / this.logStep));
    this.counts[index] = (this.counts[index] ?? 0) + 1;
    this.total += 1;
  }

  private upperBound(index: number): number {
    if (index === 0) return this.minMs;
    if (index === this.bucketCount - 1) return this.maxMs;
    return Number((this.minMs * Math.exp((index + 1) * this.logStep)).toFixed(6));
  }

  private quantile(fraction: number): number | null {
    if (this.total === 0) return null;
    const rank = Math.max(1, Math.ceil(this.total * fraction));
    let cumulative = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      cumulative += this.counts[index] ?? 0;
      if (cumulative >= rank) return this.upperBound(index);
    }
    return this.maxMs;
  }

  /** Snapshot cost is O(bucketCount), never O(sampleCount). */
  snapshot(): LatencyHistogramSnapshot {
    return {
      count: this.total,
      p50Ms: this.quantile(0.50),
      p95Ms: this.quantile(0.95),
      quantileMethod: this.quantileMethod,
      buckets: this.counts.map((count, index) => ({ upperBoundMs: this.upperBound(index), count })),
    };
  }
}

export interface LatencyHistogramSnapshot {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  quantileMethod: "histogram_nearest_bucket";
  buckets: Array<{ upperBoundMs: number; count: number }>;
}

export interface CacheDiskSnapshot {
  dbFileBytes: number | null;
  walFileBytes: number | null;
  osPageCacheBytes: number | null;
  dbSource: string;
  walSource: string;
  osPageCacheSource: string;
  osPageCacheReason: string | null;
}

export interface CacheMaintenanceSnapshot {
  kind: string;
  durationMs: number;
  evicted: number;
  at: string;
}

export interface CacheDiagnosticsSnapshot {
  quantileMethod: "histogram_nearest_bucket";
  entries: number;
  bytes: number;
  evictedBytes: number;
  expiredRemoved: number;
  maintenanceCount: number;
  lastMaintenance: CacheMaintenanceSnapshot | null;
  query: LatencyHistogramSnapshot;
  read: LatencyHistogramSnapshot;
  write: LatencyHistogramSnapshot;
  maintenance: LatencyHistogramSnapshot;
  disk: CacheDiskSnapshot;
}

/** Bounded in-process diagnostics; no query text, keys, or raw samples are kept. */
export class CacheDiagnostics {
  private readonly query = new LatencyHistogram();
  private readonly read = new LatencyHistogram();
  private readonly write = new LatencyHistogram();
  private readonly maintenance = new LatencyHistogram();
  private evictedBytes = 0;
  private expiredRemoved = 0;
  private maintenanceCount = 0;
  private lastMaintenance: CacheMaintenanceSnapshot | null = null;

  recordQuery(durationMs: number): void {
    this.query.record(durationMs);
  }

  recordRead(durationMs: number): void {
    this.read.record(durationMs);
  }

  recordWrite(durationMs: number): void {
    this.write.record(durationMs);
  }

  recordEvictedBytes(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes > 0) this.evictedBytes += bytes;
  }

  recordExpiredRemoved(count: number): void {
    if (Number.isSafeInteger(count) && count > 0) this.expiredRemoved += count;
  }

  recordMaintenance(kind: string, durationMs: number, evicted = 0): void {
    this.maintenance.record(durationMs);
    this.maintenanceCount += 1;
    this.lastMaintenance = { kind, durationMs: Math.trunc(durationMs), evicted, at: new Date().toISOString() };
  }

  snapshot(input: { entries: number; bytes: number; disk: CacheDiskSnapshot }): CacheDiagnosticsSnapshot {
    return {
      quantileMethod: "histogram_nearest_bucket",
      entries: input.entries,
      bytes: input.bytes,
      evictedBytes: this.evictedBytes,
      expiredRemoved: this.expiredRemoved,
      maintenanceCount: this.maintenanceCount,
      lastMaintenance: this.lastMaintenance,
      query: this.query.snapshot(),
      read: this.read.snapshot(),
      write: this.write.snapshot(),
      maintenance: this.maintenance.snapshot(),
      disk: input.disk,
    };
  }
}
