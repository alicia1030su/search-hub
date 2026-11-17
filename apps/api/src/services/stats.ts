import { and, desc, gte, lte, sql } from "drizzle-orm";
import type { DashboardStats } from "@search-hub/shared";
import type { SearchHubDb } from "@search-hub/db";
import { apiKeys, modelConfigs, searchEvents, searchTasks } from "@search-hub/db";
import type { ProviderService } from "./providers.js";

export interface RangeInput {
  fromMs: number;
  toMs: number;
  bucketMs: number;
}

export function parseRange(query: {
  range?: string;
  from?: string;
  to?: string;
}): RangeInput {
  const now = Date.now();
  const range = query.range ?? "24h";
  const durationMs: Record<string, number> = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
    "30d": 2_592_000_000,
  };
  const fromMs = query.from
    ? Date.parse(query.from)
    : now - (durationMs[range] ?? 86_400_000);
  const toMs = query.to ? Date.parse(query.to) : now;
  const span = Math.max(1, toMs - fromMs);
  const bucketMs = span <= 3_600_000 ? 300_000 : span <= 86_400_000 ? 3_600_000 : 86_400_000;
  return {
    fromMs: Number.isNaN(fromMs) ? now - 86_400_000 : fromMs,
    toMs: Number.isNaN(toMs) ? now : toMs,
    bucketMs,
  };
}

export function dashboardStats(
  db: SearchHubDb,
  providers: ProviderService,
  range: RangeInput,
): DashboardStats {
  const fromIso = new Date(range.fromMs).toISOString();
  const toIso = new Date(range.toMs).toISOString();

  const tasks = db
    .select({
      status: searchTasks.status,
      durationMs: searchTasks.durationMs,
      resultCount: searchTasks.resultCount,
    })
    .from(searchTasks)
    .where(and(gte(searchTasks.createdAt, fromIso), lte(searchTasks.createdAt, toIso)))
    .all();

  const total = tasks.length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const partial = tasks.filter((task) => task.status === "partial").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  // Cancelled runs are excluded: the user stopped them, the service did not fail.
  const finished = completed + partial + failed;
  const durations = tasks
    .map((task) => task.durationMs ?? 0)
    .filter((value) => value > 0);
  const avgLatency = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : 0;

  const events = db
    .select({
      providerId: searchEvents.providerId,
      providerName: searchEvents.providerName,
      providerType: searchEvents.providerType,
      ok: searchEvents.ok,
      latencyMs: searchEvents.latencyMs,
      errorCode: searchEvents.errorCode,
      createdAt: searchEvents.createdAt,
    })
    .from(searchEvents)
    .where(and(gte(searchEvents.createdAt, fromIso), lte(searchEvents.createdAt, toIso)))
    .all();

  const providerMap = new Map<
    string,
    { providerId: string; providerName: string; providerType: string; calls: number; errors: number; latencySum: number }
  >();
  for (const event of events) {
    // A cancelled call says nothing about the provider: the caller stopped it
    // mid-flight. Counting it would show a 0% error-free rate for a source that
    // simply got interrupted.
    if (event.errorCode === "cancelled") continue;
    let entry = providerMap.get(event.providerId);
    if (!entry) {
      entry = {
        providerId: event.providerId,
        providerName: event.providerName,
        providerType: event.providerType,
        calls: 0,
        errors: 0,
        latencySum: 0,
      };
      providerMap.set(event.providerId, entry);
    }
    entry.calls += 1;
    if (!event.ok) entry.errors += 1;
    entry.latencySum += event.latencyMs;
  }

  const rows = providers.listRows();
  const providerStats = rows.map((row) => {
    const entry = providerMap.get(row.id);
    const calls = entry?.calls ?? 0;
    const errors = entry?.errors ?? 0;
    return {
      providerId: row.id,
      providerName: row.name,
      providerType: row.type,
      calls,
      errors,
      errorRate: calls === 0 ? 0 : Number((errors / calls).toFixed(4)),
      avgLatencyMs: calls === 0 ? 0 : Math.round((entry?.latencySum ?? 0) / calls),
      enabled: row.enabled,
    };
  });

  const keyRows = db.select().from(apiKeys).all();
  const live = new Map(
    providers
      .runtimeSnapshots()
      .flatMap((snapshot) => snapshot.keys.map((key) => [key.id, key.status] as const)),
  );
  const keyStatus = { total: keyRows.length, healthy: 0, rateLimited: 0, cooldown: 0, invalid: 0, disabled: 0 };
  for (const row of keyRows) {
    const status = live.get(row.id) ?? row.status;
    if (status === "healthy" || status === "unknown") keyStatus.healthy += 1;
    else if (status === "rate_limited") keyStatus.rateLimited += 1;
    else if (status === "cooldown") keyStatus.cooldown += 1;
    else if (status === "invalid") keyStatus.invalid += 1;
    else if (status === "disabled") keyStatus.disabled += 1;
  }

  const modelRows = db.select().from(modelConfigs).all();
  const modelStats = {
    total: modelRows.length,
    enabled: modelRows.filter((row) => row.enabled).length,
    chat: modelRows.filter((row) => row.kind === "chat").length,
    embedding: modelRows.filter((row) => row.kind === "embedding").length,
    rerank: modelRows.filter((row) => row.kind === "rerank").length,
    calls: events.length,
  };

  const buckets: Array<{ bucket: string; searches: number; errors: number; latencySum: number }> = [];
  const bucketCount = Math.min(200, Math.ceil((range.toMs - range.fromMs) / range.bucketMs));
  for (let index = 0; index < bucketCount; index += 1) {
    const start = range.fromMs + index * range.bucketMs;
    buckets.push({
      bucket: new Date(start).toISOString(),
      searches: 0,
      errors: 0,
      latencySum: 0,
    });
  }

  const taskRows = db
    .select({ status: searchTasks.status, durationMs: searchTasks.durationMs, createdAt: searchTasks.createdAt })
    .from(searchTasks)
    .where(and(gte(searchTasks.createdAt, fromIso), lte(searchTasks.createdAt, toIso)))
    .all();
  for (const row of taskRows) {
    const index = Math.min(
      buckets.length - 1,
      Math.max(0, Math.floor((Date.parse(row.createdAt) - range.fromMs) / range.bucketMs)),
    );
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.searches += 1;
    if (row.status === "failed" || row.status === "partial") bucket.errors += 1;
    bucket.latencySum += row.durationMs ?? 0;
  }

  return {
    range: { from: fromIso, to: toIso },
    totals: {
      searches: total,
      successRate: finished === 0 ? 0 : Number((completed / finished).toFixed(4)),
      partial,
      failed,
      cancelled,
      avgLatencyMs: avgLatency,
      resultCount: tasks.reduce((sum, task) => sum + task.resultCount, 0),
    },
    currentConcurrency: providers.currentConcurrency(),
    providers: providerStats,
    keys: keyStatus,
    models: modelStats,
    timeline: buckets.map((bucket) => ({
      bucket: bucket.bucket,
      searches: bucket.searches,
      errors: bucket.errors,
      avgLatencyMs: bucket.searches === 0 ? 0 : Math.round(bucket.latencySum / bucket.searches),
    })),
  };
}

export interface LogQuery {
  limit: number;
  offset: number;
  level?: string;
  providerId?: string;
}

export function recentEvents(db: SearchHubDb, query: LogQuery): Array<Record<string, unknown>> {
  const rows = db
    .select()
    .from(searchEvents)
    .orderBy(desc(searchEvents.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();
  return rows
    .filter((row) => (query.providerId ? row.providerId === query.providerId : true))
    .map((row) => ({
      id: row.id,
      taskId: row.taskId,
      providerId: row.providerId,
      providerName: row.providerName,
      ok: row.ok,
      latencyMs: row.latencyMs,
      resultCount: row.resultCount,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
    }));
}

export function taskCount(db: SearchHubDb): number {
  const row = db.select({ count: sql<number>`count(*)` }).from(searchTasks).all()[0];
  return Number(row?.count ?? 0);
}
